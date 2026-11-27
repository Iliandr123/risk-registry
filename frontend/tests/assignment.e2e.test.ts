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
  }), 201);
  const saved = await read<Proposal>(await reviewer.send(`${path}/draft`, "PATCH", {
    ...revision(edit), fields: { decisionNote: "Действующая мера" },
  }), 200);
  verifyResponse("saveRiskDraft", 200, saved);
  const changed = await read<Published>(await assign(admin, candidate.member.id, 2), 200);
  assert.equal(changed.assignmentRevision, 3);
  assert.equal(changed.hasOpenDraft, true);
  assert.deepEqual(changed.snapshot, initial.snapshot);
  assert.deepEqual(changed.assessment, initial.assessment);
  assert.equal((await author.send(`${path}/draft`)).status, 404);
  const submittedEdit = await read<Proposal>(await draftAction(reviewer, "submit", saved), 200);
  const duringEdit = await history();
  assert.equal(duringEdit.events.some((event) => event.versionId === edit.versionId), false);
  const transitions = duringEdit.events.filter((event) => event.action === "ASSIGNMENT_CHANGED");
  assert.deepEqual(transitions, [
    { action: "ASSIGNMENT_CHANGED", versionId: draft.versionId, occurredAt: transitions[0].occurredAt,
      actor: reviewer.member, previousAssignee: null, newAssignee: author.member },
    { action: "ASSIGNMENT_CHANGED", versionId: draft.versionId, occurredAt: transitions[1].occurredAt,
      actor: admin.member, previousAssignee: author.member, newAssignee: candidate.member },
  ]);
  assert.equal((await draftAction(reviewer, "approve", submittedEdit)).status, 200);
  const updated = await card();
  assert.equal(updated.snapshot.versionId, edit.versionId);
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
    action: "ASSIGNMENT_CHANGED", versionId: edit.versionId, occurredAt: assignmentEvents[2].occurredAt,
    actor: admin.member, previousAssignee: candidate.member, newAssignee: null,
  });
  assert.deepEqual(afterRemoval.publishedVersions.map((snapshot) => snapshot.owner), [null, null]);

  const retained = await read<Published>(await assign(reviewer, author.member.id, 4), 200);
  const closure = await read<Proposal>(await author.send(`${path}/draft`, "POST", {
    expectedPublishedVersionId: updated.snapshot.versionId,
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
