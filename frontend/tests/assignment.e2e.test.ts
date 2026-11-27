import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { components } from "../src/app/api.generated";
import { verifyResponse } from "./contract-backend.ts";

type Schemas = components["schemas"];
type Published = Schemas["PublishedRisk"];
type Proposal = Schemas["Proposal"];
type History = Schemas["RiskHistory"];
type Listing = Schemas["PublishedRiskList"];
type Member = { id: string; displayName: string };

const base = process.env.PILOT_API_URL ?? process.env.PILOT_UI_URL ?? "http://localhost:3000";

async function request(path: string, method: string, body?: unknown, cookie?: string, csrf?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (csrf) headers.set("x-csrf-token", csrf);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(new URL(`/api${path}`, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read<T>(response: Response, status: number): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, `${response.url}: ${JSON.stringify(body)}`);
  return body as T;
}

function sessionCookie(response: Response, name: string) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie);
  return cookie.split(";", 1)[0];
}

async function signIn(login: string, password: string, newPassword?: string) {
  const context = await request("/csrf", "GET");
  const { token } = await read<{ token: string }>(context, 200);
  const response = await request("/session", "POST", { login, password },
    sessionCookie(context, "__Host-risk_csrf"), token);
  const member = await read<Member>(response, 200);
  let cookie = sessionCookie(response, "__Host-risk_session");
  const loadCsrf = async () => (await read<{ token: string }>(await request("/csrf", "GET", undefined, cookie), 200)).token;
  let csrf = await loadCsrf();
  if (newPassword) {
    const change = await request("/me/password", "POST", { currentPassword: password, newPassword }, cookie, csrf);
    assert.equal(change.status, 204);
    cookie = sessionCookie(change, "__Host-risk_session");
    csrf = await loadCsrf();
  }
  return {
    member: { id: member.id, displayName: member.displayName },
    send: (path: string, method = "GET", data?: unknown, withCsrf = true) =>
      request(path, method, data, cookie, withCsrf ? csrf : undefined),
  };
}

test("API опубликованного риска: назначение, история, права и конкуренция с архивированием", { timeout: 60_000 }, async () => {
  const login = process.env.PILOT_ADMIN_LOGIN;
  const password = process.env.PILOT_ADMIN_PASSWORD;
  assert.ok(login && password, "Настройте PILOT_ADMIN_LOGIN и PILOT_ADMIN_PASSWORD для тестового стенда.");
  // The browser scenario changes the bootstrap password when running the full E2E suite.
  const admin = await signIn(login, process.env.PILOT_NEW_ADMIN_PASSWORD ?? password);
  const profile = await read<{ isAdmin: boolean; isReviewer: boolean }>(await admin.send("/me"), 200);
  assert.equal(profile.isAdmin, true);
  assert.equal(profile.isReviewer, false);

  const suffix = randomUUID().slice(0, 8);
  async function addMember(role: string, isReviewer = false) {
    const login = `assignment-${role}-${suffix}`;
    const created = await read<{ temporaryPassword: string }>(
      await admin.send("/admin/accounts", "POST", { login, displayName: login, isReviewer }), 201);
    return signIn(login, created.temporaryPassword, `Assignment E2E password ${suffix}!`);
  }
  const author = await addMember("author");
  const reviewer = await addMember("reviewer", true);
  const candidate = await addMember("candidate");
  const fields = {
    title: `Назначение ${suffix}`,
    cause: "Ручная сортировка",
    possibleEvent: "Очередь растёт",
    productConsequences: "Заявки обрабатываются позже",
    likelihood: 4,
    impact: 5,
  };
  const draft = await read<Proposal>(await author.send("/risks", "POST", fields), 201);
  verifyResponse("createRisk", 201, draft);
  const path = `/risks/${draft.riskId}`;
  const revision = (proposal: Pick<Proposal, "versionId" | "revision">) =>
    ({ versionId: proposal.versionId, expectedRevision: proposal.revision });
  const draftAction = (actor: typeof author, action: string, proposal: Pick<Proposal, "versionId" | "revision">) =>
    actor.send(`${path}/draft/${action}`, "POST", revision(proposal));
  const assign = (actor: typeof author, assigneeId: string | null, expectedAssignmentRevision: number, csrf = true) =>
    actor.send(`${path}/assignment`, "PATCH", { assigneeId, expectedAssignmentRevision }, csrf);
  const card = async () => {
    const result = await read<Published>(await author.send(path), 200);
    verifyResponse("getRisk", 200, result);
    return result;
  };
  const history = async (actor = author) => {
    const result = await read<History>(await actor.send(`${path}/history`), 200);
    verifyResponse("getRiskHistory", 200, result);
    return result;
  };
  const list = async (assignee: string, view = "active") => {
    const result = await read<Listing>(await author.send(`/risks?${new URLSearchParams({ assignee, view, q: fields.title })}`), 200);
    verifyResponse("listRisks", 200, result);
    return result.items.map((item) => item.riskId);
  };
  async function error(response: Response, status: number, code: string) {
    const body = await read<{ code: string }>(response, status);
    assert.equal(body.code, code);
    verifyResponse("updateRiskAssignment", status, body);
  }

  await error(await assign(reviewer, author.member.id, 1), 404, "NOT_FOUND");
  await error(await assign(author, author.member.id, 1), 404, "NOT_FOUND");
  assert.equal((await reviewer.send(`${path}/history`)).status, 404);
  const submitted = await read<Proposal>(await draftAction(author, "submit", draft), 200);
  assert.equal((await draftAction(reviewer, "approve", submitted)).status, 200);
  const initial = await card();
  assert.equal(initial.riskId, draft.riskId);
  assert.equal(initial.snapshot.versionId, draft.versionId);
  assert.deepEqual(initial.author, author.member);
  assert.equal(initial.assignee, null);
  assert.equal(initial.assignmentRevision, 1);
  assert.deepEqual(await list("needs-assignment"), [draft.riskId]);

  await error(await assign(author, author.member.id, 1), 403, "FORBIDDEN");
  await error(await assign(reviewer, author.member.id, 1, false), 403, "CSRF_REJECTED");
  await error(await assign(reviewer, randomUUID(), 1), 409, "ASSIGNEE_INACTIVE");
  await error(await reviewer.send(`${path}/assignment`, "PATCH", { expectedAssignmentRevision: 1 }), 400, "INVALID_REQUEST");
  assert.equal((await history()).events.filter((event) => event.action === "ASSIGNMENT_CHANGED").length, 0);

  const simultaneous = await Promise.all([assign(reviewer, author.member.id, 1), assign(reviewer, author.member.id, 1)]);
  const [winner, stale] = simultaneous.sort((a, b) => a.status - b.status);
  const first = await read<Published>(winner, 200);
  verifyResponse("updateRiskAssignment", 200, first);
  assert.deepEqual(first.assignee, { ...author.member, active: true });
  assert.equal(first.assignmentRevision, 2);
  await error(stale, 409, "RISK_CONFLICT");
  await error(await assign(reviewer, author.member.id, 1), 409, "RISK_CONFLICT");
  assert.deepEqual(await read<Published>(await assign(reviewer, author.member.id, 2), 200), first);
  assert.deepEqual(await list(author.member.id), [draft.riskId]);
  assert.deepEqual(await list("needs-assignment"), []);
  assert.equal((await history()).events.filter((event) => event.action === "ASSIGNMENT_CHANGED").length, 1);

  const edit = await read<Proposal>(await reviewer.send(`${path}/draft`, "POST", {
    expectedPublishedVersionId: initial.snapshot.versionId,
    riskState: "REMOVED", closureReason: "Черновик завершения",
  }), 201);
  const changed = await read<Published>(await assign(admin, candidate.member.id, 2), 200);
  assert.equal(changed.assignmentRevision, 3);
  assert.equal(changed.hasOpenDraft, true);
  assert.deepEqual(changed.snapshot, initial.snapshot);
  assert.deepEqual(changed.assessment, initial.assessment);
  assert.equal((await author.send(`${path}/draft`)).status, 404);
  const submittedEdit = await read<Proposal>(await draftAction(reviewer, "submit", edit), 200);
  const duringEdit = await history();
  assert.equal(duringEdit.events.some((event) => event.versionId === edit.versionId), false);
  const transitions = duringEdit.events.filter((event) => event.action === "ASSIGNMENT_CHANGED");
  assert.deepEqual(transitions, [
    { action: "ASSIGNMENT_CHANGED", versionId: draft.versionId, occurredAt: transitions[0].occurredAt,
      actor: reviewer.member, previousAssignee: null, newAssignee: author.member },
    { action: "ASSIGNMENT_CHANGED", versionId: draft.versionId, occurredAt: transitions[1].occurredAt,
      actor: admin.member, previousAssignee: author.member, newAssignee: candidate.member },
  ]);
  assert.equal((await draftAction(reviewer, "withdraw", submittedEdit)).status, 200);
  const updated = await read<Published>(await reviewer.send(path, "PATCH", {
    expectedPublishedVersionId: initial.snapshot.versionId, fields: { decisionNote: "Действующая мера" },
  }), 200);
  assert.deepEqual(updated.author, initial.author);
  assert.deepEqual(updated.assignee, changed.assignee);
  assert.equal(updated.assignmentRevision, changed.assignmentRevision);
  assert.deepEqual(updated.assessment, initial.assessment);

  assert.equal((await admin.send(`/admin/accounts/${candidate.member.id}`, "PATCH", { active: false })).status, 200);
  await error(await assign(admin, candidate.member.id, 3), 409, "ASSIGNEE_INACTIVE");
  assert.deepEqual((await card()).assignee, { ...candidate.member, active: false });
  assert.deepEqual(await list("needs-assignment"), [draft.riskId]);
  assert.deepEqual(await list(candidate.member.id), [draft.riskId]);
  const removed = await read<Published>(await assign(admin, null, 3), 200);
  assert.equal(removed.assignee, null);
  assert.equal(removed.assignmentRevision, 4);
  assert.deepEqual(await list("needs-assignment"), [draft.riskId]);
  assert.deepEqual(await list(candidate.member.id), []);
  const afterRemoval = await history();
  const assignmentEvents = afterRemoval.events.filter((event) => event.action === "ASSIGNMENT_CHANGED");
  assert.equal(assignmentEvents.length, 3);
  assert.deepEqual(assignmentEvents[2], {
    action: "ASSIGNMENT_CHANGED", versionId: updated.snapshot.versionId, occurredAt: assignmentEvents[2].occurredAt,
    actor: admin.member, previousAssignee: candidate.member, newAssignee: null,
  });
  assert.deepEqual(afterRemoval.publishedVersions.map((snapshot) => snapshot.owner), [null, null]);

  const retained = await read<Published>(await assign(reviewer, author.member.id, 4), 200);
  const closure = await read<Proposal>(await author.send(`${path}/draft`, "POST", {
    expectedPublishedVersionId: updated.snapshot.versionId,
    riskState: "REMOVED",
  }), 201);
  const preparedClosure = await read<Proposal>(await author.send(`${path}/draft`, "PATCH", {
    ...revision(closure), fields: { riskState: "REMOVED", closureReason: "Мера устранила риск" },
  }), 200);
  const submittedClosure = await read<Proposal>(await draftAction(author, "submit", preparedClosure), 200);
  const [closing, racing] = await Promise.all([
    draftAction(reviewer, "approve", submittedClosure),
    assign(admin, reviewer.member.id, retained.assignmentRevision),
  ]);
  assert.equal(closing.status, 200);
  const archived = await card();
  const archivedHistory = await history();
  const archiveEvent = archivedHistory.events.findIndex((event) => event.action === "APPROVE"
    && event.versionId === closure.versionId);
  assert.ok(archiveEvent >= 0);
  assert.equal(archived.snapshot.riskState, "REMOVED");
  assert.equal(archived.snapshot.versionId, closure.versionId);
  assert.equal(archived.snapshot.decisionNote, "Действующая мера");
  if (racing.status === 200) {
    const assigned = await read<Published>(racing, 200);
    assert.deepEqual(archived.assignee, { ...reviewer.member, active: true });
    assert.equal(archived.assignmentRevision, assigned.assignmentRevision);
    const lastAssignment = archivedHistory.events[archiveEvent - 1];
    assert.equal(lastAssignment.action, "ASSIGNMENT_CHANGED");
    assert.equal(lastAssignment.versionId, edit.versionId);
    assert.deepEqual(lastAssignment.newAssignee, reviewer.member);
  } else {
    await error(racing, 409, "RISK_CONFLICT");
    assert.deepEqual(archived.assignee, retained.assignee);
    assert.equal(archived.assignmentRevision, retained.assignmentRevision);
  }
  assert.equal(archivedHistory.events.length, archiveEvent + 1);
  assert.equal(archivedHistory.events.filter((event) => event.action === "ASSIGNMENT_CHANGED").length,
    racing.status === 200 ? 5 : 4);
  assert.deepEqual(await list(archived.assignee!.id, "archive"), [draft.riskId]);
  await error(await assign(admin, null, archived.assignmentRevision), 409, "RISK_CONFLICT");
  assert.deepEqual(await history(), archivedHistory);
});

test("API опубликованных полей: права, история, дата оценки и конфликт", { timeout: 60_000 }, async () => {
  const login = process.env.PILOT_ADMIN_LOGIN;
  const password = process.env.PILOT_NEW_ADMIN_PASSWORD ?? process.env.PILOT_ADMIN_PASSWORD;
  assert.ok(login && password, "Настройте аккаунт администратора тестового стенда.");
  const admin = await signIn(login, password);
  const suffix = randomUUID().slice(0, 8);
  async function member(role: string, isReviewer = false) {
    const login = `fields-${role}-${suffix}`;
    const created = await read<{ temporaryPassword: string }>(
      await admin.send("/admin/accounts", "POST", { login, displayName: login, isReviewer }), 201);
    return signIn(login, created.temporaryPassword, `Published fields E2E ${suffix}!`);
  }

  const owner = await member("owner");
  const reviewer = await member("reviewer", true);
  const teammate = await member("teammate");
  const fields = {
    title: `Редактирование ${suffix}`, cause: "Ручные операции", possibleEvent: "Очередь растёт",
    productConsequences: "Клиент ждёт", likelihood: 3, impact: 5, decisionNote: "Уточнить меры",
    trackerUrl: "https://example.test/risks/42",
  };
  const draft = await read<Proposal>(await owner.send("/risks", "POST", fields), 201);
  const path = `/risks/${draft.riskId}`;
  const revision = ({ versionId, revision }: Proposal) => ({ versionId, expectedRevision: revision });
  const patch = (actor: typeof owner, expectedPublishedVersionId: string, fields: unknown, csrf = true) =>
    actor.send(path, "PATCH", { expectedPublishedVersionId, fields }, csrf);
  const result = async (response: Response, status = 200) => {
    const body = await read<Published>(response, status);
    verifyResponse("updatePublishedRisk", status, body);
    return body;
  };
  const error = async (response: Response, status: number, code: string) => {
    const body = await read<{ code: string }>(response, status);
    verifyResponse("updatePublishedRisk", status, body);
    assert.equal(body.code, code);
  };
  const card = async () => read<Published>(await teammate.send(path), 200);
  const history = async () => {
    const journal = await read<History>(await teammate.send(`${path}/history`), 200);
    verifyResponse("getRiskHistory", 200, journal);
    return journal;
  };

  await error(await patch(reviewer, draft.versionId, { title: "Недоступно" }), 404, "NOT_FOUND");
  await error(await patch(owner, draft.versionId, {}), 404, "NOT_FOUND");
  const submitted = await read<Proposal>(await owner.send(`${path}/draft/submit`, "POST", revision(draft)), 200);
  assert.equal((await reviewer.send(`${path}/draft/approve`, "POST", revision(submitted))).status, 200);
  const first = await card();
  await error(await patch(owner, first.snapshot.versionId, {}), 403, "FORBIDDEN");
  await error(await patch(teammate, first.snapshot.versionId, {}), 403, "FORBIDDEN");
  await error(await patch(admin, first.snapshot.versionId, {}, false), 403, "CSRF_REJECTED");
  for (const invalid of [{ title: "   " }, { cause: null }, { likelihood: 0 }, { impact: 3.5 },
    { likelihood: 11 }, { trackerUrl: "/relative" }, { riskState: "REMOVED" }, null]) {
    await error(await patch(reviewer, first.snapshot.versionId, invalid), 400, "INVALID_REQUEST");
  }
  assert.deepEqual(await card(), first);

  const assigned = await read<Published>(await admin.send(`${path}/assignment`, "PATCH", {
    assigneeId: owner.member.id, expectedAssignmentRevision: first.assignmentRevision,
  }), 200);
  const revised = await result(await patch(owner, first.snapshot.versionId, {
    title: `${fields.title} обновлено`, decisionNote: null, trackerUrl: null,
  }));
  assert.notEqual(revised.snapshot.versionId, first.snapshot.versionId);
  assert.deepEqual(revised.assessment, first.assessment);
  assert.deepEqual(revised.author, owner.member);
  assert.deepEqual(revised.assignee, assigned.assignee);
  assert.equal(revised.hasOpenDraft, false);
  assert.deepEqual(await card(), revised);
  const active = await read<Listing>(await teammate.send(`/risks?view=active&q=${suffix}`), 200);
  assert.equal(active.items.find((item) => item.riskId === draft.riskId)?.title, revised.snapshot.title);
  const firstHistory = await history();
  assert.equal(firstHistory.publishedVersions[0].versionId, first.snapshot.versionId);
  assert.equal(firstHistory.publishedVersions[0].title, fields.title);
  const direct = firstHistory.events.filter((event) => event.action === "FIELDS_UPDATED");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].versionId, revised.snapshot.versionId);
  assert.deepEqual(direct[0].actor, owner.member);
  assert.match(direct[0].occurredAt, /Z$/);
  assert.deepEqual(direct[0].changes, [
    { field: "title", previousValue: fields.title, newValue: revised.snapshot.title },
    { field: "decisionNote", previousValue: fields.decisionNote, newValue: null },
    { field: "trackerUrl", previousValue: fields.trackerUrl, newValue: null },
  ]);
  assert.deepEqual(await result(await patch(owner, revised.snapshot.versionId, { decisionNote: null })), revised);
  assert.deepEqual(await history(), firstHistory);

  const removed = await read<Published>(await admin.send(`${path}/assignment`, "PATCH", {
    assigneeId: null, expectedAssignmentRevision: assigned.assignmentRevision,
  }), 200);
  await error(await patch(owner, revised.snapshot.versionId, { cause: "Больше не ответственный" }), 403, "FORBIDDEN");
  const start = (await history()).events.length;
  const [won, stale] = (await Promise.all([
    patch(admin, removed.snapshot.versionId, { impact: 9 }),
    patch(reviewer, removed.snapshot.versionId, { impact: 10 }),
  ])).sort((a, b) => a.status - b.status);
  const reassessed = await result(won);
  await error(stale, 409, "RISK_CONFLICT");
  assert.ok([9, 10].includes(reassessed.snapshot.impact));
  assert.equal(reassessed.snapshot.priority.score, reassessed.snapshot.impact * fields.likelihood);
  assert.equal((await history()).events.length, start + 1);
  assert.deepEqual(await card(), reassessed);
  const date = new Date(reassessed.assessment.date + "T00:00:00Z");
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 4, 0)).getUTCDate();
  const due = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, Math.min(lastDay, date.getUTCDate())));
  assert.equal(reassessed.assessment.reviewDueDate, due.toISOString().slice(0, 10));
  await result(await patch(admin, reassessed.snapshot.versionId, { cause: "Автоматизация" }));

  const current = await card();
  const confirm = (actor: typeof owner, expectedPublishedVersionId: string) =>
    actor.send(`${path}/assessment/confirm`, "POST", { expectedPublishedVersionId });
  assert.equal((await confirm(admin, current.snapshot.versionId)).status, 403);
  assert.equal((await confirm(reviewer, reassessed.snapshot.versionId)).status, 409);
  const confirmation = await read<Published>(await confirm(reviewer, current.snapshot.versionId), 200);
  assert.deepEqual(confirmation.snapshot, current.snapshot);
  assert.equal(confirmation.assessment.reviewRequired, false);
  assert.equal((await history()).events.at(-1)?.action, "CONFIRM_ASSESSMENT");

  const closing = await read<Proposal>(await owner.send(`${path}/draft`, "POST", {
    expectedPublishedVersionId: current.snapshot.versionId,
    riskState: "REMOVED",
  }), 201);
  const prepared = await read<Proposal>(await owner.send(`${path}/draft`, "PATCH", {
    ...revision(closing), fields: { riskState: "REMOVED", closureReason: "Риск устранён" },
  }), 200);
  const queued = await read<Proposal>(await owner.send(`${path}/draft/submit`, "POST", revision(prepared)), 200);
  assert.equal((await reviewer.send(`${path}/draft/approve`, "POST", revision(queued))).status, 200);
  const archived = await card();
  const archivedHistory = await history();
  await error(await patch(admin, archived.snapshot.versionId, { cause: "Архив" }), 409, "RISK_CONFLICT");
  assert.deepEqual(await card(), archived);
  assert.deepEqual(await history(), archivedHistory);
});
