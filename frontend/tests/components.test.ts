import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import next from "next";
import { chromium } from "playwright-core";
import type { Account, Proposal, PublishedRisk, RiskList } from "../src/app/api";
import { contractBackend } from "./contract-backend.ts";

const ownerId = "11111111-1111-4111-8111-111111111111";
const riskId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const cookie = "__Host-risk_session=mock-session";
const title = "Задержка обработки заявок";
const owner = { id: ownerId, displayName: "Участник пилота", active: true };
const participant = { id: owner.id, displayName: owner.displayName };
const account: Account = {
  ...owner, login: "author", isAdmin: false, isReviewer: false, mustChangePassword: false,
};
const published: PublishedRisk = {
  riskId, hasOpenDraft: false,
  snapshot: {
    versionId, title, owner, likelihood: 4, impact: 10,
    priority: { score: 40, category: "HIGH", criticalImpact: true },
    riskState: "ACTIVE", cause: "Ручные операции", possibleEvent: "Очередь растёт",
    productConsequences: "Клиенты ждут ответа",
  },
  assessment: { date: "2026-03-31", reviewDueDate: "2026-06-30", reviewRequired: true },
};
const list: RiskList = {
  view: "active",
  items: [{
    riskId, publishedVersionId: versionId, title, owner, likelihood: 4, impact: 10,
    riskState: "ACTIVE", priority: published.snapshot.priority, assessment: published.assessment, hasOpenDraft: false,
  }],
};

test("компоненты пилота через сервер Next.js и контрактную HTTP-заглушку", { timeout: 120_000 }, async (t) => {
  const backend = await contractBackend();
  t.after(() => backend.close());
  t.after(() => backend.assertComplete());
  process.env.RISK_API_ORIGIN = backend.origin;
  const frontend = next({ dev: false });
  t.after(() => frontend.close());
  await frontend.prepare();
  const server = createServer(frontend.getRequestHandler());
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://localhost:${address.port}`;

  await t.test("сервер показывает фильтры и карточку в HTML без выполнения JavaScript", async () => {
    const query = { view: "active", q: "заявок", ownerId, category: "HIGH" };
    backend.expect([
      { operation: "getProfile", cookie, status: 200, reply: account },
      { operation: "listRisks", query, cookie, status: 200, reply: list },
      { operation: "listParticipants", cookie, status: 200, reply: [participant] },
      { operation: "getRisk", path: { id: riskId }, cookie, status: 200, reply: published },
      { operation: "getRiskDraft", path: { id: riskId }, cookie, status: 404,
        reply: { code: "NOT_FOUND", message: "Карточка не найдена." } },
      { operation: "getRiskHistory", path: { id: riskId }, cookie, status: 200,
        reply: { riskId, publishedVersions: [published.snapshot], events: [] } },
    ]);
    const response = await fetch(`${base}/?${new URLSearchParams({ ...query, risk: riskId })}`, {
      headers: { cookie: `unrelated=ignore; ${cookie}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const html = await response.text();
    backend.assertComplete();
    assert.match(html, /<h2>Задержка обработки заявок<\/h2>/);
    assert.match(html, /Опубликованная версия/);
    assert.match(html, /Критические последствия/);
  });

  await t.test("сервер ограничивает прямой переход по роли", async () => {
    backend.expect([{ operation: "getProfile", cookie, status: 200, reply: account }]);
    const response = await fetch(`${base}/?view=review`, { headers: { cookie } });
    assert.match(await response.text(), /Раздел недоступен для вашей роли/);
    backend.assertComplete();
  });

  await t.test("форма входа передаёт CSRF и сохраняет обе cookie ответа", async () => {
    const csrfCookie = "__Host-risk_csrf=mock-context";
    const attributes = "; Path=/; Secure; HttpOnly; SameSite=Lax";
    const unauthenticated = { code: "UNAUTHORIZED", message: "Войдите в реестр." };
    backend.expect([
      { operation: "getProfile", status: 401, reply: unauthenticated },
      { operation: "getCsrfToken", status: 200, reply: { token: "mock-csrf" }, setCookies: [csrfCookie + attributes] },
      { operation: "createSession", cookie: csrfCookie, csrf: "mock-csrf",
        body: { login: "author", password: "test fixture password" }, status: 200, reply: account,
        setCookies: [cookie + attributes, "__Host-risk_csrf=; Max-Age=0" + attributes] },
      { operation: "getProfile", cookie, status: 200, reply: account },
      { operation: "listRisks", query: { view: "active" }, cookie, status: 200, reply: list },
      { operation: "listParticipants", cookie, status: 200, reply: [participant] },
    ]);
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      await page.getByLabel("Логин", { exact: true }).fill("author");
      await page.getByLabel("Пароль", { exact: true }).fill("test fixture password");
      const session = page.waitForResponse((response) => response.url().endsWith("/api/session"));
      await page.getByRole("button", { name: "Войти" }).click();
      const response = await session;
      assert.equal(response.status(), 200);
      assert.deepEqual((await response.headerValues("set-cookie")).sort(),
        [cookie + attributes, "__Host-risk_csrf=; Max-Age=0" + attributes].sort());
      await page.getByRole("link", { name: title }).waitFor();
      const cookies = await page.context().cookies();
      assert.deepEqual(cookies.map(({ name, secure, httpOnly, sameSite }) => ({ name, secure, httpOnly, sameSite })), [
        { name: "__Host-risk_session", secure: true, httpOnly: true, sameSite: "Lax" },
      ]);
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("действие ревью передаёт ревизию и показывает конфликт", async () => {
    const proposal: Proposal = {
      riskId, versionId, revision: 3, status: "IN_REVIEW", kind: "FIRST", author: participant,
      fields: {
        title, ownerId, likelihood: 4, impact: 10, riskState: "ACTIVE", cause: "Ручные операции",
        possibleEvent: "Очередь растёт", productConsequences: "Клиенты ждут ответа",
        trackerUrl: null, decisionNote: null, closureReason: null,
      },
    };
    const conflict = "Обновите карточку и повторите действие.";
    backend.expect([
      { operation: "getProfile", cookie, status: 200, reply: { ...account, isReviewer: true } },
      { operation: "listRisks", query: { view: "review" }, cookie, status: 200,
        reply: { view: "review", items: [proposal] } },
      { operation: "listParticipants", cookie, status: 200, reply: [participant] },
      { operation: "getRisk", path: { id: riskId }, cookie, status: 404,
        reply: { code: "NOT_FOUND", message: "Карточка не найдена." } },
      { operation: "getRiskDraft", path: { id: riskId }, cookie, status: 200, reply: proposal },
      { operation: "getRiskHistory", path: { id: riskId }, cookie, status: 200,
        reply: { riskId, publishedVersions: [], events: [] } },
      { operation: "getCsrfToken", cookie, status: 200, reply: { token: "review-csrf" } },
      { operation: "actOnRiskDraft", path: { id: riskId, action: "approve" }, cookie, csrf: "review-csrf",
        body: { versionId, expectedRevision: 3 }, status: 409,
        reply: { code: "RISK_CONFLICT", message: conflict } },
    ]);
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await browser.newPage();
      await page.context().addCookies([{ url: "https://localhost/", name: "__Host-risk_session", value: "mock-session",
        secure: true, httpOnly: true, sameSite: "Lax" }]);
      await page.goto(`${base}/?view=review&risk=${riskId}&version=${versionId}`);
      await page.getByRole("button", { name: "Утвердить", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: conflict }).waitFor();
      await page.getByRole("button", { name: "Обновить карточку" }).waitFor();
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });
});
