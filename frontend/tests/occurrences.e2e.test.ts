import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { components, operations } from "../src/app/api.generated";
import { verifyResponse } from "./contract-backend.ts";

type Schemas = components["schemas"];
type Proposal = Schemas["Proposal"];
type Occurrence = Schemas["RiskOccurrence"];
type Page = Schemas["RiskOccurrencePage"];
type Content = Schemas["CreateRiskOccurrenceRequest"];

const base = process.env.PILOT_API_URL ?? process.env.PILOT_UI_URL ?? "http://localhost:3000";

async function read<T>(response: Response, status: number, operation?: keyof operations): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, `${response.url}: ${JSON.stringify(body)}`);
  if (operation) verifyResponse(operation, status, body);
  return body as T;
}

function cookieFrom(response: Response, name: string) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie);
  return cookie.split(";", 1)[0];
}

async function signIn(login: string, password: string, newPassword?: string) {
  let cookie: string | undefined;
  let csrf: string | undefined;
  const send = (path: string, method = "GET", body?: unknown, withCsrf = true) => {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    if (csrf && withCsrf) headers.set("x-csrf-token", csrf);
    if (body !== undefined) headers.set("content-type", "application/json");
    return fetch(new URL(`/api${path}`, base), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const loadCsrf = async (response: Response) => (await read<{ token: string }>(response, 200)).token;
  const context = await send("/csrf");
  cookie = cookieFrom(context, "__Host-risk_csrf");
  csrf = await loadCsrf(context);
  const session = await send("/session", "POST", { login, password });
  const { id, displayName, isAdmin, isReviewer } = await read<Schemas["Account"]>(session, 200);
  cookie = cookieFrom(session, "__Host-risk_session");
  csrf = await loadCsrf(await send("/csrf"));
  if (newPassword) {
    const changed = await send("/me/password", "POST", { currentPassword: password, newPassword });
    assert.equal(changed.status, 204);
    cookie = cookieFrom(changed, "__Host-risk_session");
    csrf = await loadCsrf(await send("/csrf"));
  }
  return { member: { id, displayName }, isAdmin, isReviewer, send };
}

test("API случаев проявления риска: хранение, пагинация, права и ревизии", { timeout: 60_000 }, async () => {
  const login = process.env.PILOT_ADMIN_LOGIN;
  const password = process.env.PILOT_NEW_ADMIN_PASSWORD ?? process.env.PILOT_ADMIN_PASSWORD;
  assert.ok(login && password, "Настройте PILOT_ADMIN_LOGIN и пароль тестового администратора.");
  const admin = await signIn(login, password);
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.isReviewer, false);

  const suffix = randomUUID().slice(0, 8);
  async function addMember(role: string, isReviewer = false) {
    const login = `occurrence-${role}-${suffix}`;
    const created = await read<{ temporaryPassword: string }>(
      await admin.send("/admin/accounts", "POST", { login, displayName: login, isReviewer }), 201);
    return signIn(login, created.temporaryPassword, `Occurrence E2E password ${suffix}!`);
  }
  const author = await addMember("author");
  const reviewer = await addMember("reviewer", true);
  const teammate = await addMember("teammate");

  const newRisk = (title: string) => author.send("/risks", "POST", {
    title: `${title} ${suffix}`, cause: "Ручная очередь", possibleEvent: "Очередь растёт",
    productConsequences: "Заявки обрабатываются позже", likelihood: 4, impact: 5,
  }).then((response) => read<Proposal>(response, 201));
  const revision = ({ versionId, revision }: Pick<Proposal, "versionId" | "revision">) =>
    ({ versionId, expectedRevision: revision });
  const submit = (path: string, proposal: Proposal) =>
    author.send(`${path}/draft/submit`, "POST", revision(proposal)).then((response) => read<Proposal>(response, 200));
  async function approve(path: string, submitted: Proposal) {
    assert.equal((await reviewer.send(`${path}/draft/approve`, "POST", revision(submitted))).status, 200);
  }
  async function publish(path: string, proposal: Proposal) {
    await approve(path, await submit(path, proposal));
  }
  const openCompletion = (path: string, expectedPublishedVersionId: string) =>
    author.send(`${path}/draft`, "POST", { expectedPublishedVersionId, riskState: "REMOVED" })
      .then((response) => read<Proposal>(response, 201, "openRiskDraft"));
  const saveDraft = (path: string, proposal: Proposal, fields: Schemas["DraftFields"]) =>
    author.send(`${path}/draft`, "PATCH", { ...revision(proposal), fields }).then((response) => read<Proposal>(response, 200));
  const getPublished = (path: string) => teammate.send(path).then((response) => read<Schemas["PublishedRisk"]>(response, 200));
  async function error(response: Response, status: number, code: string, operation: keyof operations) {
    assert.equal((await read<{ code: string }>(response, status, operation)).code, code);
  }

  const draft = await newRisk("Случаи");
  const path = `/risks/${draft.riskId}`;
  const collection = `${path}/occurrences`;
  const resource = (occurrence: Occurrence) => `${collection}/${occurrence.id}`;
  const list = (cursor?: string, actor = teammate) =>
    actor.send(cursor === undefined ? collection : `${collection}?${new URLSearchParams({ cursor })}`)
      .then((response) => read<Page>(response, 200, "listRiskOccurrences"));
  async function listAll() {
    let page = await list();
    const items = [...page.items];
    while (page.nextCursor) {
      page = await list(page.nextCursor);
      items.push(...page.items);
    }
    return items;
  }
  const create = (body: Content) => author.send(collection, "POST", body)
    .then((response) => read<Occurrence>(response, 201, "createRiskOccurrence"));
  const patch = (actor: typeof author, occurrence: Occurrence, content: Content, csrf = true) =>
    actor.send(resource(occurrence), "PATCH", { ...content, expectedRevision: occurrence.revision }, csrf);
  const remove = (actor: typeof author, occurrence: Occurrence, csrf = true) =>
    actor.send(`${resource(occurrence)}?expectedRevision=${occurrence.revision}`, "DELETE", undefined, csrf);
  const history = () => author.send(`${path}/history`).then((response) => read<Schemas["RiskHistory"]>(response, 200));

  await error(await author.send(collection), 404, "NOT_FOUND", "listRiskOccurrences");
  await error(await reviewer.send(collection, "POST", { text: "Приватный риск" }),
    404, "NOT_FOUND", "createRiskOccurrence");
  await publish(path, draft);
  const published = await getPublished(path);
  const initialHistory = await history();
  assert.deepEqual(await list(), { items: [], nextCursor: null });

  const text = "  Очередь выросла\nПроверена вручную  ";
  const url = "https://example.test/bugs/42?q=queue#details";
  const httpUrl = "http://example.test/bugs/43";
  const textOnly = await create({ text });
  const linkOnly = await read<Occurrence>(await teammate.send(collection, "POST", { text: null, url: httpUrl }),
    201, "createRiskOccurrence");
  const both = await create({ text, url });
  const duplicate = await create({ text, url });
  assert.deepEqual([textOnly, linkOnly, both, duplicate].map(({ text, url }) => [text, url]),
    [[text, null], [null, httpUrl], [text, url], [text, url]]);
  assert.notEqual(duplicate.id, both.id);
  for (const item of [textOnly, linkOnly, both, duplicate]) {
    assert.deepEqual(item.author, item.id === linkOnly.id ? teammate.member : author.member);
    assert.equal(item.revision, 1);
    assert.match(item.createdAt, /Z$/);
  }
  assert.deepEqual((await list()).items, [duplicate, both, linkOnly, textOnly]);
  assert.deepEqual(await getPublished(path), published);

  for (const invalid of [{}, { text: null, url: null }, { text: " \t\n" }, { url: "/bugs/42" },
    { url: "ftp://example.test/42" }, { url: "https:///bugs/42" }, { url: "http://example.test:bad/" },
    { url: "https://user@:80/" }, { url: "https://example.test/%xx" }, { text: 42 }, { text, author: "spoof" }]) {
    await error(await author.send(collection, "POST", invalid), 400, "INVALID_REQUEST", "createRiskOccurrence");
  }
  await error(await author.send(collection, "POST", { text }, false), 403, "CSRF_REJECTED", "createRiskOccurrence");
  for (const cursor of ["", "invalid!"]) {
    await error(await teammate.send(`${collection}?cursor=${cursor}`), 400, "INVALID_REQUEST", "listRiskOccurrences");
  }

  const additions = [];
  for (let index = 0; index < 18; index++) additions.push(await create({ text: `Случай ${index}` }));
  const firstPage = await list();
  assert.equal(firstPage.items.length, 20);
  assert.ok(firstPage.nextCursor);
  const insertedAfterFirstPage = await create({ text: "Новая запись между запросами страниц" });
  const secondPage = await list(firstPage.nextCursor);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual([...firstPage.items, ...secondPage.items], [...additions.reverse(), duplicate, both, linkOnly, textOnly]);
  assert.deepEqual((await list()).items[0], insertedAfterFirstPage);

  await error(await patch(teammate, textOnly, { text: "Чужая правка" }), 403, "FORBIDDEN", "updateRiskOccurrence");
  await error(await remove(teammate, textOnly), 403, "FORBIDDEN", "deleteRiskOccurrence");
  await error(await patch(author, textOnly, { text }, false), 403, "CSRF_REJECTED", "updateRiskOccurrence");
  await error(await remove(author, textOnly, false), 403, "CSRF_REJECTED", "deleteRiskOccurrence");
  await error(await author.send(resource(textOnly), "DELETE"), 400, "INVALID_REQUEST", "deleteRiskOccurrence");
  await error(await author.send(resource(textOnly), "PATCH", { text }), 400, "INVALID_REQUEST", "updateRiskOccurrence");
  await error(await author.send(resource(textOnly), "PATCH", { text: null, url: null, expectedRevision: 1 }),
    400, "INVALID_REQUEST", "updateRiskOccurrence");

  const otherDraft = await newRisk("Другой риск");
  const otherPath = `/risks/${otherDraft.riskId}`;
  await publish(otherPath, otherDraft);
  const wrongRisk = `${otherPath}/occurrences/${textOnly.id}`;
  await error(await reviewer.send(wrongRisk, "PATCH", { text, expectedRevision: 1 }),
    404, "NOT_FOUND", "updateRiskOccurrence");
  await error(await reviewer.send(`${wrongRisk}?expectedRevision=1`, "DELETE"),
    404, "NOT_FOUND", "deleteRiskOccurrence");
  await error(await teammate.send(`${otherPath}/occurrences?${new URLSearchParams({ cursor: firstPage.nextCursor })}`),
    400, "INVALID_REQUEST", "listRiskOccurrences");

  const updated = await read<Occurrence>(await patch(author, textOnly, { url }), 200, "updateRiskOccurrence");
  assert.deepEqual(updated, { ...textOnly, revision: 2, text: null, url });
  await error(await patch(reviewer, textOnly, { text }), 409, "RISK_CONFLICT", "updateRiskOccurrence");
  await error(await remove(admin, textOnly), 409, "RISK_CONFLICT", "deleteRiskOccurrence");
  const reviewed = await read<Occurrence>(await patch(reviewer, updated, { text, url: null }), 200, "updateRiskOccurrence");
  assert.deepEqual(reviewed, { ...updated, revision: 3, text, url: null });
  const adminEdit = await read<Occurrence>(await patch(admin, reviewed, { text: "Исправлено администратором" }),
    200, "updateRiskOccurrence");
  assert.deepEqual(adminEdit, { ...reviewed, revision: 4, text: "Исправлено администратором" });
  const competing = await Promise.all([patch(author, adminEdit, { text }), patch(reviewer, adminEdit, { url })]);
  const [winner, stale] = competing.sort((a, b) => a.status - b.status);
  const winnerItem = await read<Occurrence>(winner, 200, "updateRiskOccurrence");
  assert.equal(winnerItem.revision, 5);
  await error(stale, 409, "RISK_CONFLICT", "updateRiskOccurrence");
  assert.equal((await remove(author, winnerItem)).status, 204);
  assert.equal((await remove(reviewer, duplicate)).status, 204);
  assert.equal((await remove(admin, both)).status, 204);
  await error(await remove(author, winnerItem), 404, "NOT_FOUND", "deleteRiskOccurrence");
  const remaining = [...additions, linkOnly];
  assert.deepEqual(await list(), { items: [insertedAfterFirstPage, ...remaining], nextCursor: null });
  assert.deepEqual(await history(), initialHistory);

  await error(await author.send(`${path}/draft`, "POST", { expectedPublishedVersionId: draft.versionId }),
    400, "INVALID_REQUEST", "openRiskDraft");
  const closure = await openCompletion(path, draft.versionId);
  await error(await author.send(`${path}/draft`, "PATCH", { ...revision(closure), fields: { title: "Обычная правка" } }),
    400, "INVALID_REQUEST", "saveRiskDraft");
  await error(await author.send(`${path}/draft/submit`, "POST", revision(closure)),
    400, "INVALID_REQUEST", "actOnRiskDraft");
  const duringEdit = await create({ text: "Зафиксировано при открытой правке" });
  const edited = await read<Occurrence>(await patch(author, duringEdit, { url }), 200, "updateRiskOccurrence");
  const temporaryDuringEdit = await create({ text: "Запись для удаления при открытой правке" });
  assert.equal((await remove(author, temporaryDuringEdit)).status, 204);
  const beforePublish = [edited, insertedAfterFirstPage, ...remaining];
  assert.deepEqual(await listAll(), beforePublish);
  const saved = await saveDraft(path, closure, { riskState: "REMOVED", closureReason: "Приняты меры" });
  const submitted = await submit(path, saved);
  const latest = await read<Schemas["PublishedRisk"]>(await reviewer.send(path, "PATCH", {
    expectedPublishedVersionId: draft.versionId,
    fields: { title: "Актуальное название", decisionNote: "Уточнены меры", likelihood: 8 },
  }), 200, "updatePublishedRisk");
  assert.deepEqual(await listAll(), beforePublish);
  const beforeOccurrence = await getPublished(path);
  const duringClosure = await create({ text: "Зафиксировано при согласовании завершения" });
  assert.deepEqual(await getPublished(path), beforeOccurrence);
  const closureOccurrence = await read<Occurrence>(await patch(reviewer, duringClosure, { text, url }),
    200, "updateRiskOccurrence");
  assert.equal((await remove(admin, edited)).status, 204);
  const archivedOccurrences = [closureOccurrence, insertedAfterFirstPage, ...remaining];
  assert.deepEqual(await listAll(), archivedOccurrences);
  await approve(path, submitted);
  const archived = await getPublished(path);
  assert.deepEqual(archived.snapshot, { ...latest.snapshot, versionId: closure.versionId,
    riskState: "REMOVED", closureReason: "Приняты меры" });
  assert.equal(archived.assessment.date, latest.assessment.date);
  await error(await reviewer.send(path, "PATCH", {
    expectedPublishedVersionId: archived.snapshot.versionId, fields: { title: "Архив" },
  }), 409, "RISK_CONFLICT", "updatePublishedRisk");
  assert.deepEqual(await listAll(), archivedOccurrences);
  await error(await author.send(collection, "POST", { text }), 409, "RISK_CONFLICT", "createRiskOccurrence");
  await error(await patch(reviewer, linkOnly, { text }), 409, "RISK_CONFLICT", "updateRiskOccurrence");
  await error(await remove(admin, linkOnly), 409, "RISK_CONFLICT", "deleteRiskOccurrence");
  assert.deepEqual(await listAll(), archivedOccurrences);

  const emptyClosure = await openCompletion(otherPath, otherDraft.versionId);
  assert.deepEqual(await read<Page>(await teammate.send(`${otherPath}/occurrences`), 200, "listRiskOccurrences"),
    { items: [], nextCursor: null });
  await publish(otherPath, await saveDraft(otherPath, emptyClosure, {
    riskState: "MATERIALIZED", closureReason: "Последствия подтверждены",
  }));
  assert.equal((await getPublished(otherPath)).snapshot.riskState, "MATERIALIZED");
});
