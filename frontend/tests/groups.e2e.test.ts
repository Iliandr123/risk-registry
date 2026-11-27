import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { components, operations } from "../src/app/api.generated";
import { verifyResponse } from "./contract-backend.ts";

type Schemas = components["schemas"];
type Group = Schemas["RiskGroup"];
type Proposal = Schemas["Proposal"];
type Draft = Pick<Proposal, "versionId" | "revision">;
type Fields = Schemas["DraftFields"];
type Published = Schemas["PublishedRisk"];
type History = Schemas["RiskHistory"];
type Member = Schemas["Participant"];

const base = process.env.PILOT_API_URL ?? process.env.PILOT_UI_URL ?? "http://localhost:3000";

function request(path: string, method = "GET", body?: unknown, cookie?: string, token?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (token) headers.set("x-csrf-token", token);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(new URL(`/api${path}`, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read<T>(response: Response, status: number, operation?: keyof operations): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, `${response.url}: ${JSON.stringify(body)}`);
  if (operation) verifyResponse(operation, status, body);
  return body as T;
}

function cookie(response: Response, name: string) {
  const value = response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function signIn(login: string, password: string, newPassword?: string) {
  const context = await request("/csrf");
  const { token } = await read<{ token: string }>(context, 200);
  const response = await request("/session", "POST", { login, password }, cookie(context, "__Host-risk_csrf"), token);
  const { id, displayName } = await read<Member>(response, 200);
  let session = cookie(response, "__Host-risk_session");
  const csrf = async () => (await read<{ token: string }>(await request("/csrf", "GET", undefined, session), 200)).token;
  let sessionToken = await csrf();
  if (newPassword) {
    const change = await request("/me/password", "POST", { currentPassword: password, newPassword }, session, sessionToken);
    assert.equal(change.status, 204);
    session = cookie(change, "__Host-risk_session");
    sessionToken = await csrf();
  }
  return {
    member: { id, displayName },
    send: (path: string, method = "GET", data?: unknown, withCsrf = true) =>
      request(path, method, data, session, withCsrf ? sessionToken : undefined),
  };
}

async function error(response: Response, status: number, code: string, operation: keyof operations) {
  const body = await read<{ code: string }>(response, status, operation);
  assert.equal(body.code, code);
}

test("API групп рисков: справочник, публикация, перенос, история и фильтры", { timeout: 90_000 }, async () => {
  const login = process.env.PILOT_ADMIN_LOGIN;
  const password = process.env.PILOT_NEW_ADMIN_PASSWORD ?? process.env.PILOT_ADMIN_PASSWORD;
  assert.ok(login && password, "Укажите аккаунт администратора отдельного тестового стенда.");
  const admin = await signIn(login, password);
  const profile = await read<{ isAdmin: boolean; isReviewer: boolean }>(await admin.send("/me"), 200);
  assert.equal(profile.isAdmin, true);
  assert.equal(profile.isReviewer, false);

  const suffix = randomUUID().slice(0, 8);
  async function participant(role: string, isReviewer = false) {
    const login = `groups-${role}-${suffix}`;
    const { temporaryPassword } = await read<{ temporaryPassword: string }>(
      await admin.send("/admin/accounts", "POST", { login, displayName: login, isReviewer }), 201);
    return signIn(login, temporaryPassword, `Groups E2E password ${suffix}!`);
  }
  const author = await participant("author");
  const reviewer = await participant("reviewer", true);
  const other = await participant("other");
  const newGroup = (name: string) => admin.send("/admin/risk-groups", "POST", { name });
  const rename = (group: Group, name: string) => admin.send(`/admin/risk-groups/${group.id}`, "PATCH", { name });
  const directory = async () => read<Group[]>(await author.send("/risk-groups"), 200, "listRiskGroups");
  const payments = `Оплаты ${suffix}`;
  const tips = `Чаевые ${suffix}`;

  await error(await request("/risk-groups"), 401, "AUTHENTICATION_REQUIRED", "listRiskGroups");
  await error(await author.send("/admin/risk-groups", "POST", { name: payments }), 403, "FORBIDDEN", "createRiskGroup");
  await error(await admin.send("/admin/risk-groups", "POST", { name: payments }, false), 403, "CSRF_REJECTED", "createRiskGroup");
  for (const name of [" \t\u00a0", "  бЕз ГрУпПы  "]) {
    await error(await newGroup(name), 400, "INVALID_REQUEST", "createRiskGroup");
  }
  const results = await Promise.all([newGroup(` \t${payments}\u00a0`), newGroup(`\t${payments.toUpperCase()} `)]);
  const [created, duplicate] = results.sort((a, b) => a.status - b.status);
  let firstGroup = await read<Group>(created, 201, "createRiskGroup");
  assert.ok([payments, payments.toUpperCase()].includes(firstGroup.name));
  await error(duplicate, 409, "RISK_GROUP_NAME_CONFLICT", "createRiskGroup");
  firstGroup = await read<Group>(await rename(firstGroup, `  ${payments}  `), 200, "renameRiskGroup");
  assert.equal(firstGroup.name, payments);
  const secondGroup = await read<Group>(await newGroup(tips), 201, "createRiskGroup");
  await error(await rename(secondGroup, payments.toUpperCase()), 409, "RISK_GROUP_NAME_CONFLICT", "renameRiskGroup");
  await error(await rename(secondGroup, "Без группы"), 400, "INVALID_REQUEST", "renameRiskGroup");
  await error(await admin.send(`/admin/risk-groups/${randomUUID()}`, "PATCH", { name: tips }), 404, "NOT_FOUND", "renameRiskGroup");
  await error(await reviewer.send(`/admin/risk-groups/${secondGroup.id}`, "PATCH", { name: "Другое" }),
    403, "FORBIDDEN", "renameRiskGroup");
  assert.deepEqual((await directory()).filter((group) => group.name.endsWith(suffix)).sort((a, b) => a.id.localeCompare(b.id)),
    [firstGroup, secondGroup].sort((a, b) => a.id.localeCompare(b.id)));

  const fields = {
    title: `Риск ${suffix}`, cause: "Ручная обработка", possibleEvent: "Очередь растёт",
    productConsequences: "Оплаты задерживаются", likelihood: 4, impact: 5,
  };
  const revision = (draft: Draft) => ({ versionId: draft.versionId, expectedRevision: draft.revision });
  const action = (path: string, name: string, draft: Draft, actor = reviewer) =>
    actor.send(`${path}/draft/${name}`, "POST", revision(draft));
  const submit = async (path: string, draft: Draft) => read<Draft>(await action(path, "submit", draft, author), 200);
  const create = async (input: Fields) => read<Proposal>(await author.send("/risks", "POST", input), 201, "createRisk");
  const save = (path: string, draft: Draft, fields: Fields) =>
    author.send(`${path}/draft`, "PATCH", { ...revision(draft), fields });
  const card = async (path: string) => read<Published>(await other.send(path), 200, "getRisk");
  const history = async (path: string) => read<History>(await other.send(`${path}/history`), 200, "getRiskHistory");
  const move = (path: string, groupId: string | null, expectedGroupRevision: number, actor = reviewer, csrf = true) =>
    actor.send(`${path}/group`, "PATCH", { groupId, expectedGroupRevision }, csrf);
  const openCompletion = async (path: string, published: Published) => read<Proposal>(await author.send(`${path}/draft`, "POST", {
    expectedPublishedVersionId: published.snapshot.versionId, riskState: "REMOVED",
  }), 201, "openRiskDraft");
  const list = async (filter: Record<string, string>) => {
    const query = new URLSearchParams({ q: suffix, ...filter });
    return (await read<Schemas["PublishedRiskList"]>(await other.send(`/risks?${query}`), 200, "listRisks")).items;
  };
  const ids = async (filter: Record<string, string>) => (await list(filter)).map((item) => item.riskId).sort();

  await error(await author.send("/risks", "POST", { ...fields, groupId: randomUUID() }), 400, "INVALID_REQUEST", "createRisk");
  const draft = await create({ ...fields, groupId: firstGroup.id });
  const path = `/risks/${draft.riskId}`;
  assert.equal(draft.fields.groupId, firstGroup.id);
  await error(await move(path, secondGroup.id, 1, admin), 404, "NOT_FOUND", "updateRiskGroup");
  await error(await move(path, secondGroup.id, 1, author), 404, "NOT_FOUND", "updateRiskGroup");
  assert.equal((await reviewer.send(`${path}/draft`)).status, 404);
  assert.equal((await admin.send(`${path}/draft`)).status, 404);
  assert.equal((await other.send(`${path}/history`)).status, 404);
  assert.deepEqual(await ids({ group: firstGroup.id }), []);
  await error(await save(path, draft, { groupId: randomUUID() }), 400, "INVALID_REQUEST", "saveRiskDraft");
  const cleared = await read<Proposal>(await save(path, draft, { groupId: null }), 200, "saveRiskDraft");
  assert.equal(cleared.fields.groupId, null);
  assert.equal(cleared.revision, draft.revision + 1);
  const chosen = await read<Proposal>(await save(path, cleared, { groupId: firstGroup.id }), 200, "saveRiskDraft");
  const saved = await read<Proposal>(await save(path, chosen, { decisionNote: "Уточнение" }), 200, "saveRiskDraft");
  assert.equal(saved.fields.groupId, firstGroup.id);
  const submitted = await submit(path, saved);
  const inReview = await read<Proposal>(await reviewer.send(`${path}/draft`), 200, "getRiskDraft");
  assert.equal(inReview.fields.groupId, firstGroup.id);
  assert.equal((await other.send(`${path}/draft`)).status, 404);
  assert.equal((await other.send(path)).status, 404);
  assert.equal((await action(path, "approve", submitted)).status, 200);
  const initial = await card(path);
  assert.deepEqual(initial.group, firstGroup);
  assert.equal(initial.groupRevision, 1);
  assert.equal((await history(path)).events.find((event) => event.action === "APPROVE")?.initialGroupName, payments);

  const ungrouped = await create({ ...fields, title: `Без назначения ${suffix}` });
  assert.equal(ungrouped.fields.groupId, null);
  const ungroupedPath = `/risks/${ungrouped.riskId}`;
  assert.equal((await action(ungroupedPath, "approve", await submit(ungroupedPath, ungrouped))).status, 200);
  assert.equal((await card(ungroupedPath)).group, null);
  assert.equal((await history(ungroupedPath)).events.find((event) => event.action === "APPROVE")?.initialGroupName, null);
  assert.deepEqual(await ids({ group: "ungrouped" }), [ungrouped.riskId]);
  assert.deepEqual(await ids({ group: firstGroup.id, category: "MEDIUM", assignee: "needs-assignment" }), [draft.riskId]);
  assert.deepEqual(await ids({ group: firstGroup.id, category: "LOW" }), []);
  assert.deepEqual(await ids({ group: firstGroup.id, q: ungrouped.fields.title! }), []);
  assert.deepEqual(await ids({ group: randomUUID() }), []);
  await error(await other.send("/risks?group=wrong"), 400, "INVALID_REQUEST", "listRisks");
  const renamedFirst = await read<Group>(await rename(firstGroup, `Платежи ${suffix}`), 200, "renameRiskGroup");
  assert.equal(renamedFirst.id, firstGroup.id);
  assert.deepEqual((await list({ group: firstGroup.id })).map((item) => item.group), [renamedFirst]);
  assert.deepEqual((await card(path)).group, renamedFirst);

  await error(await move(path, null, 1, author), 403, "FORBIDDEN", "updateRiskGroup");
  await error(await move(path, null, 1, reviewer, false), 403, "CSRF_REJECTED", "updateRiskGroup");
  await error(await move(path, randomUUID(), 1), 400, "INVALID_REQUEST", "updateRiskGroup");
  const edit = await openCompletion(path, initial);
  assert.equal(Object.hasOwn(edit.fields, "groupId"), false);
  await error(await save(path, edit, { groupId: null }), 400, "INVALID_REQUEST", "saveRiskDraft");
  const [winner, stale] = (await Promise.all([move(path, secondGroup.id, 1), move(path, secondGroup.id, 1, admin)]))
    .sort((a, b) => a.status - b.status);
  const moved = await read<Published>(winner, 200, "updateRiskGroup");
  await error(stale, 409, "RISK_CONFLICT", "updateRiskGroup");
  assert.equal(moved.groupRevision, 2);
  assert.deepEqual(moved.group, secondGroup);
  assert.deepEqual(moved.snapshot, initial.snapshot);
  assert.deepEqual(moved.assessment, initial.assessment);
  assert.equal(moved.hasOpenDraft, true);
  assert.deepEqual(await read<Proposal>(await author.send(`${path}/draft`), 200, "getRiskDraft"), edit);
  assert.deepEqual(await read<Published>(await move(path, secondGroup.id, 2, admin), 200, "updateRiskGroup"), await card(path));
  const firstMove = (await history(path)).events.filter((event) => event.action === "GROUP_CHANGED");
  assert.equal(firstMove.length, 1);
  assert.equal(firstMove[0].versionId, initial.snapshot.versionId);
  assert.ok([reviewer.member.id, admin.member.id].includes(firstMove[0].actor!.id));
  assert.equal(firstMove[0].previousGroupName, renamedFirst.name);
  assert.equal(firstMove[0].newGroupName, tips);

  assert.equal((await action(path, "withdraw", edit, author)).status, 200);
  assert.deepEqual((await card(path)).group, secondGroup);
  const renamedSecond = await read<Group>(await rename(secondGroup, `Чай ${suffix}`), 200, "renameRiskGroup");
  assert.deepEqual((await history(path)).events.filter((event) => event.action === "GROUP_CHANGED"), firstMove);
  assert.equal((await history(path)).events.find((event) => event.action === "APPROVE")?.initialGroupName, payments);
  const removed = await read<Published>(await move(path, null, 2, admin), 200, "updateRiskGroup");
  assert.equal(removed.group, null);
  assert.equal(removed.groupRevision, 3);
  const removal = (await history(path)).events.at(-1)!;
  assert.equal(removal.action, "GROUP_CHANGED");
  assert.deepEqual(removal.actor, admin.member);
  assert.equal(removal.previousGroupName, renamedSecond.name);
  assert.equal(removal.newGroupName, null);
  assert.deepEqual(await ids({ group: "ungrouped" }), [draft.riskId, ungrouped.riskId].sort());

  async function closing(path: string, state: Published) {
    const edit = await openCompletion(path, state);
    const updated = await read<Proposal>(await save(path, edit, {
      riskState: "REMOVED", closureReason: "Работа завершена",
    }), 200, "saveRiskDraft");
    return submit(path, updated);
  }
  const chosenAgain = await read<Published>(await move(path, secondGroup.id, 3), 200, "updateRiskGroup");
  await read<Published>(await reviewer.send(`${path}/assignment`, "PATCH", {
    assigneeId: author.member.id, expectedAssignmentRevision: chosenAgain.assignmentRevision,
  }), 200, "updateRiskAssignment");
  const finish = await closing(path, chosenAgain);
  const [transfer, approval] = await Promise.all([
    move(path, firstGroup.id, 4), action(path, "approve", finish),
  ]);
  assert.equal(approval.status, 200);
  assert.equal(Object.hasOwn((await history(path)).events.filter((event) => event.action === "APPROVE").at(-1)!,
    "initialGroupName"), false);
  const archivedGroup = transfer.status === 200 ? renamedFirst : renamedSecond;
  if (transfer.status === 200) {
    assert.equal((await read<Published>(transfer, 200, "updateRiskGroup")).groupRevision, 5);
  } else {
    await error(transfer, 409, "RISK_CONFLICT", "updateRiskGroup");
  }
  const archived = await card(path);
  assert.equal(archived.snapshot.riskState, "REMOVED");
  assert.equal(archived.groupRevision, transfer.status === 200 ? 5 : 4);
  assert.deepEqual(archived.group, archivedGroup);
  await error(await move(path, null, archived.groupRevision, admin), 409, "RISK_CONFLICT", "updateRiskGroup");
  assert.equal((await action(ungroupedPath, "approve", await closing(ungroupedPath, await card(ungroupedPath)))).status, 200);
  const archiveFilter = { view: "archive", group: archivedGroup.id, assignee: author.member.id, category: "MEDIUM" };
  assert.deepEqual(await ids(archiveFilter), [draft.riskId]);
  assert.deepEqual(await ids({ view: "archive", group: "ungrouped" }), [ungrouped.riskId]);
  assert.deepEqual(await ids({ group: archivedGroup.id }), []);
  const renamedArchive = await read<Group>(await rename(archivedGroup, `Архив ${suffix}`), 200, "renameRiskGroup");
  assert.deepEqual((await list(archiveFilter)).map((item) => item.group), [renamedArchive]);
  assert.deepEqual((await card(path)).group, renamedArchive);
});
