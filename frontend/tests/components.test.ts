import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import next from "next";
import { chromium, type Browser } from "playwright-core";
import type {
  Account, Proposal, PublishedRisk, RiskGroup, RiskHistory, RiskList, RiskOccurrence, RiskOccurrencePage,
} from "../src/app/api";
import { contractBackend, type Exchange } from "./contract-backend.ts";

const authorId = "11111111-1111-4111-8111-111111111111";
const riskId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const cookie = "__Host-risk_session=mock-session";
const title = "Задержка обработки заявок";
const participant = { id: authorId, displayName: "Автор первого предложения" };
const assignee = { ...participant, active: true };
const replacement = { id: "44444444-4444-4444-8444-444444444444", displayName: "Другой участник" };
const payments = { id: "88888888-8888-4888-8888-888888888888", name: "Оплаты" };
const signIn = { id: "99999999-9999-4999-8999-999999999999", name: "Аутентификация" };
const disabledAssignee = { ...replacement, active: false };
const account: Account = {
  ...assignee, login: "author", isAdmin: false, isReviewer: false, mustChangePassword: false,
};
const published: PublishedRisk = {
  riskId, hasOpenDraft: false, author: participant, assignee: null, assignmentRevision: 1,
  group: null, groupRevision: 1,
  snapshot: {
    versionId, title, likelihood: 4, impact: 10,
    priority: { score: 40, category: "HIGH", criticalImpact: true },
    riskState: "ACTIVE", cause: "Ручные операции", possibleEvent: "Очередь растёт",
    productConsequences: "Клиенты ждут ответа",
  },
  assessment: { date: "2026-03-31", reviewDueDate: "2026-06-30", reviewRequired: true },
};
const summary = {
  riskId, publishedVersionId: versionId, title, assignee: null, group: null, likelihood: 4, impact: 10,
  riskState: "ACTIVE", priority: published.snapshot.priority, assessment: published.assessment, hasOpenDraft: false,
} as const;
const list: RiskList = {
  view: "active",
  items: [summary],
};
const firstProposal: Proposal = {
  riskId, versionId, revision: 3, status: "IN_REVIEW", kind: "FIRST", author: participant,
  fields: {
    title, likelihood: 4, impact: 10, riskState: "ACTIVE", cause: "Ручные операции",
    possibleEvent: "Очередь растёт", productConsequences: "Клиенты ждут ответа",
    trackerUrl: null, decisionNote: null, closureReason: null, groupId: null,
  },
};
const history: RiskHistory = { riskId, publishedVersions: [{ ...published.snapshot, owner: null }], events: [] };
const path = { id: riskId };
const notFound = { code: "NOT_FOUND", message: "Карточка не найдена." };
const occurredAt = "2026-04-01T12:00:00Z";
const occurrence = {
  id: "66666666-6666-4666-8666-666666666666", revision: 1, author: participant,
  text: "Очередь выросла после обновления", url: "https://example.test/bugs/42", createdAt: occurredAt,
} satisfies RiskOccurrence;
const olderOccurrence = {
  ...occurrence, id: "77777777-7777-4777-8777-777777777777", text: "Время обработки удвоилось",
  url: null, createdAt: "2026-03-31T08:30:00Z",
} satisfies RiskOccurrence;

function occurrencesExchange(items: RiskOccurrence[] = [], nextCursor: string | null = null, cursor?: string): Exchange {
  return { operation: "listRiskOccurrences", path, cookie, query: cursor ? { cursor } : undefined,
    status: 200, reply: { items, nextCursor } satisfies RiskOccurrencePage };
}

function cardExchanges(card: PublishedRisk | null, draft: Proposal | null, journal: RiskHistory,
  occurrences = occurrencesExchange()): Exchange[] {
  return [
    { operation: "getRisk", path, cookie, status: card ? 200 : 404, reply: card ?? notFound },
    { operation: "getRiskDraft", path, cookie, status: draft ? 200 : 404, reply: draft ?? notFound },
    { operation: "getRiskHistory", path, cookie, status: 200, reply: journal },
    ...(card ? [occurrences] : []),
  ];
}

function pageExchanges(profile: Account, result: RiskList, query: Record<string, string> = { view: result.view },
  people = [participant], groups: RiskGroup[] = []): Exchange[] {
  return [
    { operation: "getProfile", cookie, status: 200, reply: profile },
    { operation: "listRisks", query, cookie, status: 200, reply: result },
    { operation: "listParticipants", cookie, status: 200, reply: people },
    { operation: "listRiskGroups", cookie, status: 200, reply: groups },
  ];
}

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

  async function signedInPage(browser: Browser) {
    const page = await browser.newPage();
    await page.context().addCookies([{ url: "https://localhost/", name: "__Host-risk_session", value: "mock-session",
      secure: true, httpOnly: true, sameSite: "Lax" }]);
    return page;
  }

  async function groupScreenshot(page: Awaited<ReturnType<typeof signedInPage>>, name: string) {
    const directory = process.env.PILOT_GROUP_SCREENSHOTS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, name), fullPage: true });
  }

  await t.test("сервер показывает фильтры и карточку в HTML без выполнения JavaScript", async () => {
    const query = { view: "active", q: "заявок", assignee: authorId, category: "HIGH" };
    backend.expect([
      ...pageExchanges(account, { ...list, items: [{ ...summary, assignee }] }, query),
      ...cardExchanges({ ...published, assignee }, null, history),
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
    assert.match(html, /Предложил<\/dt><dd>Автор первого предложения/);
    assert.doesNotMatch(html, /Изменить назначение/);
  });

  await t.test("первая страница случаев доступна в HTML, следующая загружается по курсору", async () => {
    const cursor = "older+page/2=";
    const opening = [...pageExchanges(account, list),
      ...cardExchanges(published, null, history, occurrencesExchange([occurrence], cursor))];
    const url = `${base}/?view=active&risk=${riskId}`;
    backend.expect(opening);
    const response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<h2[^>]*>Случаи проявления риска<\/h2>/);
    const timestamp = html.match(/<time datetime="2026-04-01T12:00:00Z">(.*?)<\/time>/i)?.[1];
    assert.match(timestamp?.replaceAll("<!-- -->", "") ?? "", /12:00:00 UTC$/);
    assert.match(html, /href="https:\/\/example\.test\/bugs\/42"/);
    assert.ok(html.includes(occurrence.text!));
    backend.assertComplete();

    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      backend.expect(opening);
      await page.goto(url);
      const section = page.getByRole("region", { name: "Случаи проявления риска" });
      const more = section.getByRole("button", { name: "Загрузить ещё случаи" });
      backend.expect([occurrencesExchange([olderOccurrence], null, cursor)]);
      await more.click();
      await section.getByText(olderOccurrence.text!).waitFor();
      assert.equal(await section.getByRole("listitem").count(), 2);
      assert.equal(await more.count(), 0);
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("карточка учитывает роль участника и состояние риска при работе со случаями", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      const section = page.getByRole("region", { name: "Случаи проявления риска" });
      const teammate = { ...account, ...replacement };
      const screenshotDir = process.env.PILOT_OCCURRENCE_SCREENSHOTS;
      const archived: PublishedRisk = {
        ...published, snapshot: { ...published.snapshot, riskState: "REMOVED", closureReason: "Приняты меры" },
      };
      const archive: RiskList = { view: "archive", items: [{ ...summary, riskState: "REMOVED" }] };
      for (const profile of [account, teammate, { ...teammate, isReviewer: true }, { ...teammate, isAdmin: true }]) {
        backend.expect([...pageExchanges(profile, list),
          ...cardExchanges(published, null, history, occurrencesExchange([occurrence, olderOccurrence]))]);
        await page.goto(`${base}/?view=active&risk=${riskId}`);
        await section.getByRole("button", { name: "Добавить случай" }).waitFor();
        const actions = profile === teammate ? 0 : 2;
        assert.equal(await section.getByRole("button", { name: "Исправить" }).count(), actions);
        assert.equal(await section.getByRole("button", { name: "Удалить" }).count(), actions);
        if (profile === account && screenshotDir) {
          await page.screenshot({ path: join(screenshotDir, "risk-occurrences-active.png"), fullPage: true });
        }
        backend.assertComplete();
      }
      backend.expect([...pageExchanges({ ...teammate, isReviewer: true, isAdmin: true }, archive),
        ...cardExchanges(archived, null, history, occurrencesExchange([occurrence, olderOccurrence]))]);
      await page.goto(`${base}/?view=archive&risk=${riskId}`);
      await section.getByText(occurrence.text!).waitFor();
      assert.equal(await section.getByRole("button", { name: /Добавить случай|Исправить|Удалить/ }).count(), 0);
      if (screenshotDir) {
        await page.screenshot({ path: join(screenshotDir, "risk-occurrences-archive.png"), fullPage: true });
      }
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("форма случая сохраняет ввод при ошибке и перечитывает список после записи", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      const section = page.getByRole("region", { name: "Случаи проявления риска" });
      const add = section.getByRole("button", { name: "Добавить случай" });
      const save = section.getByRole("button", { name: "Сохранить случай" });
      const text = section.getByLabel("Описание случая");
      const url = section.getByLabel("Ссылка на случай");
      const csrf = "occurrence-csrf";
      const write = (exchange: Omit<Exchange, "cookie" | "csrf">): Exchange[] => [
        { operation: "getCsrfToken", cookie, status: 200, reply: { token: csrf } },
        { ...exchange, cookie, csrf },
      ];
      const cardUrl = `${base}/?view=active&risk=${riskId}`;
      backend.expect([...pageExchanges(account, list), ...cardExchanges(published, null, history)]);
      await page.goto(cardUrl);
      await section.getByText("Случаев пока нет.").waitFor();
      await add.click();
      await save.click();
      await section.getByRole("alert").filter({ hasText: "Введите описание случая или ссылку." }).waitFor();
      await text.fill(occurrence.text!);
      await url.fill("/bugs/42");
      await save.click();
      await section.getByRole("alert").filter({ hasText: "Укажите абсолютную ссылку" }).waitFor();
      assert.equal(await text.inputValue(), occurrence.text);
      assert.equal(await url.inputValue(), "/bugs/42");

      const entries: RiskOccurrence[] = [
        { ...occurrence, url: null },
        { ...olderOccurrence, text: null, url: "http://example.test/bugs/43" },
        { ...occurrence, id: replacement.id },
      ];
      const items: RiskOccurrence[] = [];
      for (const [index, item] of entries.entries()) {
        if (index > 0) await add.click();
        await text.fill(item.text ?? "");
        await url.fill(item.url ?? "");
        const create = { operation: "createRiskOccurrence" as const, path, body: { text: item.text, url: item.url } };
        if (index === 2) {
          backend.expect(write({ ...create, status: 400, reply: { code: "INVALID_REQUEST", message: "Проверьте ссылку." } }));
          await save.click();
          await section.getByRole("alert").filter({ hasText: "Проверьте ссылку." }).waitFor();
          assert.equal(await text.inputValue(), item.text);
          assert.equal(await url.inputValue(), item.url);
        }
        items.unshift(item);
        backend.expect([...write({ ...create, status: 201, reply: item }), occurrencesExchange(items.slice())]);
        await save.click();
        await section.getByRole("listitem").nth(index).waitFor();
        assert.equal(await section.getByRole("listitem").count(), index + 1);
        backend.assertComplete();
      }

      const entry = section.getByRole("listitem").first();
      const edit = entry.getByRole("button", { name: "Исправить" });
      const remove = entry.getByRole("button", { name: "Удалить" });
      const edited = { ...items[0], text: "Уточнённое описание", url: null, revision: 2 };
      const occurrencePath = { ...path, occurrenceId: edited.id };
      const patch = { operation: "updateRiskOccurrence" as const, path: occurrencePath,
        body: { text: edited.text, url: edited.url, expectedRevision: 1 } };
      await edit.click();
      assert.equal(await text.inputValue(), items[0].text);
      await text.fill(edited.text);
      await url.fill("");
      backend.expect(write({ ...patch, status: 409, reply: { code: "RISK_CONFLICT", message: "Случай уже изменён." } }));
      await save.click();
      const reload = section.getByRole("button", { name: "Обновить карточку" });
      await reload.waitFor();
      assert.equal(await text.inputValue(), edited.text);
      assert.equal(await save.isDisabled(), true);
      backend.expect([...cardExchanges(published, null, history, occurrencesExchange(items.slice())),
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        { operation: "listRisks", query: { view: "active" }, cookie, status: 200, reply: list }]);
      await reload.click();
      await edit.click();
      await text.fill(edited.text);
      await url.fill("");
      items[0] = edited;
      backend.expect([...write({ ...patch, status: 200, reply: edited }), occurrencesExchange(items.slice())]);
      await save.click();
      await entry.getByText(edited.text).waitFor();
      page.once("dialog", (dialog) => dialog.dismiss());
      await remove.click();
      await entry.getByText(edited.text).waitFor();
      backend.assertComplete();

      page.once("dialog", (dialog) => dialog.accept());
      backend.expect([...write({ operation: "deleteRiskOccurrence", path: occurrencePath,
        query: { expectedRevision: "2" }, status: 204 }), occurrencesExchange(items.slice(1))]);
      await remove.click();
      await section.getByText(edited.text).waitFor({ state: "detached" });
      assert.equal(await section.getByRole("listitem").count(), 2);
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("реестр показывает три состояния назначения, фильтр и исторический перенос", async () => {
    const query = { view: "active", assignee: "needs-assignment" };
    const disabledRisk = { ...summary, riskId: replacement.id, title: "Старый риск", assignee: disabledAssignee };
    const migrated: RiskHistory = {
      ...history,
      publishedVersions: [{ ...published.snapshot, owner: disabledAssignee }],
      events: [{ action: "ASSIGNMENT_MIGRATED", versionId, actor: null, occurredAt,
        previousAssignee: null, newAssignee: replacement }],
    };
    backend.expect([
      ...pageExchanges(account, { ...list, items: [summary, disabledRisk] }, query),
    ]);
    const needing = await (await fetch(`${base}/?${new URLSearchParams(query)}`, { headers: { cookie } })).text();
    assert.match(needing, /<th>Ответственный<\/th>/);
    assert.match(needing, /<td>Не назначен<\/td>/);
    assert.match(needing, /<td>Другой участник<small[^>]*>Требуется замена/);
    assert.match(needing, /value="needs-assignment" selected="">Требует назначения/);
    backend.assertComplete();

    const assignedQuery = { view: "active", assignee: authorId };
    backend.expect(pageExchanges(account, { ...list, items: [{ ...summary, assignee }] }, assignedQuery));
    const assigned = await (await fetch(`${base}/?${new URLSearchParams(assignedQuery)}`, { headers: { cookie } })).text();
    assert.match(assigned, /<td>Автор первого предложения<\/td>/);
    backend.assertComplete();

    const archive: RiskList = { view: "archive", items: [{ ...disabledRisk, riskState: "REMOVED" }] };
    const archived = { ...published, assignee: disabledAssignee,
      snapshot: { ...published.snapshot, riskState: "REMOVED" as const, closureReason: "Риск устранён" } };
    backend.expect(pageExchanges({ ...account, isAdmin: true }, archive));
    const archiveList = await (await fetch(`${base}/?view=archive`, { headers: { cookie } })).text();
    assert.doesNotMatch(archiveList, /Требует назначения/);
    backend.assertComplete();
    backend.expect([
      ...pageExchanges({ ...account, isAdmin: true }, archive, { view: "archive", assignee: replacement.id }),
      ...cardExchanges(archived, null, migrated),
    ]);
    const response = await fetch(`${base}/?view=archive&assignee=${replacement.id}&risk=${riskId}`, { headers: { cookie } });
    const html = (await response.text()).replaceAll("<!-- -->", "");
    assert.match(html, /Предложил<\/dt><dd>Автор первого предложения/);
    assert.match(html, /Ответственный<\/dt><dd>Другой участник<small[^>]*>Требуется замена/);
    assert.match(html, /Прежний владелец<\/dt><dd>Другой участник/);
    assert.match(html, /Перенесено из прежнего реестра/);
    assert.match(html, /Система · /);
    assert.match(html, /Не назначен → Другой участник/);
    assert.doesNotMatch(html, /Изменить назначение/);
    backend.assertComplete();
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
      { operation: "listRiskGroups", cookie, status: 200, reply: [] },
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
    const proposal = firstProposal;
    const conflict = "Обновите карточку и повторите действие.";
    backend.expect([
      { operation: "getProfile", cookie, status: 200, reply: { ...account, isReviewer: true } },
      { operation: "listRisks", query: { view: "review" }, cookie, status: 200,
        reply: { view: "review", items: [proposal] } },
      { operation: "listParticipants", cookie, status: 200, reply: [participant] },
      { operation: "listRiskGroups", cookie, status: 200, reply: [] },
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
      const page = await signedInPage(browser);
      await page.goto(`${base}/?view=review&risk=${riskId}&version=${versionId}`);
      assert.equal(await page.getByRole("button", { name: "Назначить ответственного" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Изменить группу" }).count(), 0);
      await page.getByRole("button", { name: "Утвердить", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: conflict }).waitFor();
      await page.getByRole("button", { name: "Обновить карточку" }).waitFor();
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("автор отправляет предложение с группой или без неё, ревьюер открывает опубликованную карточку", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const emptyHistory = { ...history, publishedVersions: [] };
      for (const groupId of [null, payments.id]) {
        const proposal = { ...firstProposal, fields: { ...firstProposal.fields, groupId } };
        const draft: Proposal = { ...firstProposal, status: "DRAFT", revision: 1, fields: { ...firstProposal.fields, title: null } };
        const saved: Proposal = { ...proposal, status: "DRAFT", revision: 2 };
        const author = await signedInPage(browser);
        backend.expect([
          ...pageExchanges(account, { view: "mine", items: [draft] }, undefined, undefined, [payments]),
          ...cardExchanges(null, draft, emptyHistory),
          { operation: "getCsrfToken", cookie, status: 200, reply: { token: "draft-csrf" } },
          { operation: "saveRiskDraft", path, cookie, csrf: "draft-csrf", status: 200, reply: saved,
            body: { versionId, expectedRevision: 1, fields: saved.fields } },
          { operation: "getCsrfToken", cookie, status: 200, reply: { token: "submit-csrf" } },
          { operation: "actOnRiskDraft", path: { ...path, action: "submit" }, cookie, csrf: "submit-csrf",
            body: { versionId, expectedRevision: 2 }, status: 200, reply: { riskId, versionId, revision: 3, status: "IN_REVIEW" } },
          { operation: "listRisks", query: { view: "mine" }, cookie, status: 200, reply: { view: "mine", items: [proposal] } },
          { operation: "listParticipants", cookie, status: 200, reply: [participant] },
          ...cardExchanges(null, proposal, emptyHistory),
        ]);
        await author.goto(`${base}/?view=mine&risk=${riskId}&version=${versionId}`);
        assert.equal(await author.getByLabel(/Владелец|Ответственный/).count(), 0);
        assert.equal(await author.getByLabel("Группа риска").inputValue(), "");
        if (groupId) await author.getByLabel("Группа риска").selectOption(groupId);
        await author.getByLabel("Название *", { exact: true }).fill(title);
        await author.getByRole("button", { name: "Отправить на ревью" }).click();
        await author.getByText("Предложение отправлено на ревью.").waitFor();
        await author.getByText("На ревью", { exact: true }).waitFor();
        await author.waitForLoadState("networkidle");
        backend.assertComplete();
        await author.close();
      }

      const reviewer = await signedInPage(browser);
      const reviewerAccount = { ...account, ...replacement, isReviewer: true };
      const groupedProposal = { ...firstProposal, fields: { ...firstProposal.fields, groupId: payments.id } };
      backend.expect([
        ...pageExchanges(reviewerAccount, { view: "review", items: [groupedProposal] }, undefined, undefined, [payments]),
        ...cardExchanges(null, groupedProposal, emptyHistory),
        { operation: "getCsrfToken", cookie, status: 200, reply: { token: "approve-csrf" } },
        { operation: "actOnRiskDraft", path: { ...path, action: "approve" }, cookie, csrf: "approve-csrf",
          body: { versionId, expectedRevision: 3 }, status: 200, reply: { riskId, versionId, revision: 4, status: "APPROVED" } },
        { operation: "listRisks", query: { view: "review" }, cookie, status: 200, reply: { view: "review", items: [] } },
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        ...cardExchanges({ ...published, group: payments }, null, history),
      ]);
      await reviewer.goto(`${base}/?view=review&risk=${riskId}&version=${versionId}`);
      await reviewer.getByText(payments.name, { exact: true }).waitFor();
      await reviewer.getByRole("button", { name: "Утвердить", exact: true }).click();
      await reviewer.getByRole("heading", { name: title }).waitFor();
      await reviewer.getByText("Предложил", { exact: true }).waitFor();
      await reviewer.getByText("Не назначен", { exact: true }).waitFor();
      await reviewer.getByText(payments.name, { exact: true }).waitFor();
      assert.equal(new URL(reviewer.url()).searchParams.get("version"), null);
      await reviewer.getByRole("button", { name: "Назначить ответственного" }).click();
      assert.equal(await reviewer.getByRole("option", { name: participant.displayName }).count(), 1);
      await reviewer.waitForLoadState("networkidle");
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("справочник загружается на сервере, администратор создаёт и переименовывает группы", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      const url = `${base}/?view=groups`;
      const directory = (profile: Account): Exchange[] => [
        { operation: "getProfile", cookie, status: 200, reply: profile },
        { operation: "listRiskGroups", cookie, status: 200, reply: [signIn] },
      ];
      backend.expect(directory(account));
      const html = await fetch(url, { headers: { cookie } }).then((response) => response.text());
      assert.match(html, /<h2>Аутентификация<\/h2>/);
      assert.doesNotMatch(html, /Создать группу|Переименовать/);
      backend.assertComplete();

      backend.expect(directory({ ...account, isAdmin: true }));
      await page.goto(url);
      const name = page.getByLabel("Название новой группы");
      const create = page.getByRole("button", { name: "Создать группу" });
      await name.fill("   ");
      await create.click();
      await page.getByRole("alert").filter({ hasText: "Введите название группы." }).waitFor();
      assert.equal(await name.inputValue(), "   ");

      const write = (exchange: Omit<Exchange, "cookie" | "csrf">): Exchange[] => [
        { operation: "getCsrfToken", cookie, status: 200, reply: { token: "group-csrf" } },
        { ...exchange, cookie, csrf: "group-csrf" },
      ];
      await name.fill("  Оплаты  ");
      backend.expect(write({ operation: "createRiskGroup", body: { name: "  Оплаты  " }, status: 201, reply: payments }));
      await create.click();
      const row = page.locator("section").filter({ has: page.getByRole("heading", { name: payments.name, exact: true }) });
      await row.getByRole("button", { name: "Переименовать" }).click();
      const newName = row.getByLabel("Новое название");
      const rename = row.getByRole("button", { name: "Сохранить название" });
      const renameRequest = { operation: "renameRiskGroup" as const, path: { id: payments.id } };
      const duplicate = "аутентификация";
      backend.expect(write({ ...renameRequest, body: { name: duplicate }, status: 409,
        reply: { code: "RISK_GROUP_NAME_CONFLICT", message: "Группа с таким названием уже существует." } }));
      await newName.fill(duplicate);
      await rename.click();
      await row.getByRole("alert").waitFor();
      assert.equal(await newName.inputValue(), duplicate);

      const renamed = { ...payments, name: "Платежи" };
      backend.expect(write({ ...renameRequest, body: { name: renamed.name }, status: 200, reply: renamed }));
      await newName.fill(renamed.name);
      await rename.click();
      await page.getByRole("heading", { name: renamed.name }).waitFor();
      await groupScreenshot(page, "groups-admin.png");
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("группу можно сменить при открытой правке, конфликт предлагает обновить карточку", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      const reviewer = { ...account, isReviewer: true };
      const admin = { ...account, isAdmin: true };
      const grouped = { ...published, group: payments, hasOpenDraft: true };
      const active: RiskList = { view: "active", items: [{ ...summary, group: payments, hasOpenDraft: true }] };
      const firstEvent = { versionId, actor: participant, action: "APPROVE", occurredAt } as const;
      const initialHistory: RiskHistory = { ...history, events: [firstEvent, { ...firstEvent, initialGroupName: "Платежи v1" }] };
      const groups = [payments, signIn];
      const url = `${base}/?view=active&risk=${riskId}`;
      const edit = page.getByRole("button", { name: "Изменить группу" });
      for (const profile of [account, reviewer, admin]) {
        backend.expect([...pageExchanges(profile, active, undefined, undefined, groups), ...cardExchanges(grouped, null, initialHistory)]);
        await page.goto(url);
        await page.getByText("Платежи v1", { exact: true }).waitFor();
        assert.equal(await page.getByText("Группа при публикации", { exact: true }).count(), 1);
        assert.equal(await edit.count(), profile === account ? 0 : 1);
        backend.assertComplete();
      }

      const patch = (groupId: string | null, revision: number, status: number, reply: unknown): Exchange[] => [
        { operation: "getCsrfToken", cookie, status: 200, reply: { token: "change-group-csrf" } },
        { operation: "updateRiskGroup", path, cookie, csrf: "change-group-csrf", status, reply,
          body: { groupId, expectedGroupRevision: revision } },
      ];
      const moved = { ...grouped, group: signIn, groupRevision: 2 };
      const groupEvent = { ...firstEvent, action: "GROUP_CHANGED", previousGroupName: payments.name,
        newGroupName: signIn.name } as const;
      const journal = { ...initialHistory, events: [...initialHistory.events, groupEvent] };
      backend.expect([
        ...patch(signIn.id, 1, 200, moved),
        { operation: "getRiskHistory", path, cookie, status: 200, reply: journal },
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        { operation: "listRisks", query: { view: "active" }, cookie, status: 200,
          reply: { view: "active", items: [{ ...summary, group: signIn, hasOpenDraft: true }] } },
      ]);
      await edit.click();
      await page.getByLabel("Группа риска").selectOption(signIn.id);
      await page.getByRole("button", { name: "Сохранить группу" }).click();
      await page.getByText(signIn.name, { exact: true }).waitFor();
      await page.getByText("Оплаты → Аутентификация", { exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      await groupScreenshot(page, "risk-card.png");
      backend.assertComplete();

      const conflict = "Обновите карточку и повторите действие.";
      backend.expect(patch(null, 2, 409, { code: "RISK_CONFLICT", message: conflict }));
      await edit.click();
      await page.getByLabel("Группа риска").selectOption("");
      await page.getByRole("button", { name: "Сохранить группу" }).click();
      await page.getByRole("alert").filter({ hasText: conflict }).waitFor();
      const archived = { ...moved, snapshot: { ...moved.snapshot, riskState: "REMOVED", closureReason: "Приняты меры" } } as const;
      backend.expect([
        ...cardExchanges(archived, null, journal),
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        { operation: "listRisks", query: { view: "active" }, cookie, status: 200, reply: { view: "active", items: [] } },
      ]);
      await page.getByRole("button", { name: "Обновить карточку" }).click();
      await page.getByText("Приняты меры", { exact: true }).waitFor();
      assert.equal(await edit.count(), 0);
      await page.waitForLoadState("networkidle");
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });

  await t.test("активные риски сгруппированы, архив сохраняет таблицу и оба списка сохраняют фильтры", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      const groups = [payments, signIn, { ...signIn, id: olderOccurrence.id, name: "Чаевые" }];
      const payment = { ...summary, group: payments, assignee };
      const otherPayment = { ...payment, riskId: replacement.id, title: "Повторная оплата" };
      const lowPayment = { ...payment, riskId: occurrence.id, title: "Автовозврат", likelihood: 1, impact: 4,
        priority: { score: 4, category: "LOW", criticalImpact: false } } as const;
      const active: RiskList = { view: "active", items: [
        { ...summary, riskId: versionId, title: "Авария сети" },
        { ...summary, riskId: authorId, title: "Вход недоступен", group: signIn },
        payment, otherPayment, lowPayment,
      ] };
      backend.expect(pageExchanges(account, active, undefined, undefined, groups));
      await page.goto(`${base}/?view=active`);
      assert.deepEqual(await page.getByRole("heading", { level: 2 }).allTextContents(), ["Аутентификация", "Оплаты", "Без группы"]);
      assert.deepEqual(await page.getByRole("table", { name: "Оплаты" }).getByRole("rowheader").allTextContents(),
        [title, otherPayment.title, lowPayment.title]);
      await groupScreenshot(page, "active-register.png");
      backend.assertComplete();

      const filters = { q: "заявок", assignee: authorId, category: "HIGH", group: payments.id };
      const groupedCard = { ...published, group: payments, assignee };
      for (const view of ["active", "archive"] as const) {
        const item = { ...payment, riskState: view === "archive" ? "REMOVED" as const : "ACTIVE" as const };
        const result: RiskList = { view, items: [item] };
        const startingList: RiskList = view === "active" ? active : { view, items: [item, { ...item,
          riskId: olderOccurrence.id, group: null, title: "Перебой связи" }] };
        const startQuery = { view };
        const query = { view, ...filters };
        backend.expect(pageExchanges(account, startingList, startQuery, undefined, groups));
        await page.goto(`${base}/?view=${view}`);
        if (view === "archive") {
          assert.equal(await page.getByRole("table").count(), 1);
          await page.getByRole("columnheader", { name: "Группа", exact: true }).waitFor();
          await page.getByRole("cell", { name: "Без группы", exact: true }).waitFor();
          await groupScreenshot(page, "archive.png");
        }
        backend.expect(pageExchanges(account, result, query, undefined, groups));
        await page.getByRole("searchbox", { name: "Поиск" }).fill(filters.q);
        await page.getByLabel("Ответственный", { exact: true }).selectOption(filters.assignee);
        await page.getByLabel("Категория", { exact: true }).selectOption(filters.category);
        await page.getByLabel("Группа", { exact: true }).selectOption(filters.group);
        await page.getByRole("button", { name: "Найти" }).click();
        assert.equal(await page.getByRole("table").count(), 1);
        if (view === "active") assert.deepEqual(await page.getByRole("heading", { level: 2 }).allTextContents(), [payments.name]);
        backend.assertComplete();
        const card: PublishedRisk = view === "active" ? groupedCard : { ...groupedCard,
          snapshot: { ...groupedCard.snapshot, riskState: "REMOVED", closureReason: "Приняты меры" } };
        backend.expect([...pageExchanges(account, result, query, undefined, groups), ...cardExchanges(card, null, history)]);
        await page.getByRole("link", { name: title }).click();
        await page.getByText(payments.name, { exact: true }).waitFor();
        const back = page.getByRole("link", { name: /К списку/ });
        const expectedUrl = new URL(await back.getAttribute("href") ?? "", base);
        assert.deepEqual(Object.fromEntries(expectedUrl.searchParams), query);
        backend.expect(pageExchanges(account, result, query, undefined, groups));
        await back.click();
        assert.equal(await page.getByLabel("Группа", { exact: true }).inputValue(), payments.id);
        backend.assertComplete();

        backend.expect(pageExchanges(account, { view, items: [] }, { ...query, group: "ungrouped" }, undefined, groups));
        await page.getByLabel("Группа", { exact: true }).selectOption("ungrouped");
        await page.getByRole("button", { name: "Найти" }).click();
        await page.getByRole("heading", { name: "Записей пока нет" }).waitFor();
        assert.equal(await page.getByRole("table").count(), 0);
        backend.assertComplete();
      }
    } finally {
      await browser.close();
    }
  });

  await t.test("администратор назначает, заменяет и снимает ответственного, обрабатывая ошибки", async () => {
    const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
    try {
      const page = await signedInPage(browser);
      const profile = { ...account, id: "55555555-5555-4555-8555-555555555555", displayName: "Администратор", isAdmin: true };
      const actor = { id: profile.id, displayName: profile.displayName };
      const people = [participant, replacement];
      const query = { view: "active", assignee: "needs-assignment", q: "заявок", category: "HIGH" };
      const selection = { ...query, risk: riskId };
      const choose = page.getByLabel("Выбор ответственного");
      const save = page.getByRole("button", { name: "Сохранить назначение" });
      const assign = page.getByRole("button", { name: "Назначить ответственного" });
      const edit = page.getByRole("button", { name: "Изменить назначение" });
      const details = page.locator(".detail-metrics").first();
      const patch = (assigneeId: string | null, revision: number, status: number, reply: unknown): Exchange[] => [
        { operation: "getCsrfToken", cookie, status: 200, reply: { token: "assignment-csrf" } },
        { operation: "updateRiskAssignment", path, cookie, csrf: "assignment-csrf",
          body: { assigneeId, expectedAssignmentRevision: revision }, status, reply },
      ];
      const unassignedListRefresh: Exchange = {
        operation: "listRisks", query, cookie, status: 200, reply: list,
      };
      const assignedListRefresh: Exchange = { ...unassignedListRefresh, reply: { ...list, items: [] } };
      backend.expect([...pageExchanges(profile, list, query, people), ...cardExchanges(published, null, history)]);
      await page.goto(`${base}/?${new URLSearchParams(selection)}`);
      await assign.click();
      await choose.selectOption(replacement.id);
      backend.expect([
        ...patch(replacement.id, 1, 409, { code: "ASSIGNEE_INACTIVE", message: "Выберите активного участника." }),
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
      ]);
      await save.click();
      await page.getByRole("alert").filter({ hasText: "Выбранный участник больше недоступен" }).waitFor();
      assert.equal(await choose.locator("option").filter({ hasText: replacement.displayName }).count(), 0);
      assert.equal(await save.isDisabled(), true);
      backend.assertComplete();

      await choose.selectOption(authorId);
      backend.expect(patch(authorId, 1, 409, { code: "RISK_CONFLICT", message: "Назначение уже изменено." }));
      await save.click();
      const reload = page.getByRole("button", { name: "Обновить карточку" });
      await reload.waitFor();
      assert.equal(await save.isDisabled(), true);
      const migrated = { ...published, assignee: disabledAssignee, assignmentRevision: 2 };
      backend.expect([
        ...cardExchanges(migrated, null, history),
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        { ...unassignedListRefresh, reply: { ...list, items: [{ ...summary, assignee: disabledAssignee }] } },
      ]);
      await reload.click();
      await details.getByText("Требуется замена").waitFor();
      await edit.click();
      assert.equal(await save.isDisabled(), true);
      await choose.selectOption(authorId);
      await page.waitForLoadState("networkidle");
      backend.assertComplete();

      const changed = { ...published, assignee, assignmentRevision: 3 };
      const change: RiskHistory["events"][number] = {
        action: "ASSIGNMENT_CHANGED", versionId, actor, occurredAt,
        previousAssignee: replacement, newAssignee: participant,
      };
      backend.expect([
        ...patch(authorId, 2, 200, changed),
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        assignedListRefresh,
        { operation: "getRiskHistory", path, cookie, status: 200, reply: { ...history, events: [change] } },
      ]);
      await save.click();
      await page.getByText("Другой участник → Автор первого предложения").waitFor();
      assert.equal(await details.getByText("Требуется замена").count(), 0);
      assert.equal(await details.getByText(participant.displayName, { exact: true }).count(), 2);
      await page.waitForLoadState("networkidle");
      backend.assertComplete();

      await edit.click();
      if (process.env.PILOT_ASSIGNMENT_SCREENSHOT) {
        await page.screenshot({ path: process.env.PILOT_ASSIGNMENT_SCREENSHOT, fullPage: true });
      }
      await choose.selectOption("");
      const removed = { ...change, previousAssignee: participant, newAssignee: null };
      backend.expect([
        ...patch(null, 3, 200, { ...published, assignmentRevision: 4 }),
        { operation: "listParticipants", cookie, status: 200, reply: [participant] },
        unassignedListRefresh,
        { operation: "getRiskHistory", path, cookie, status: 200, reply: { ...history, events: [change, removed] } },
      ]);
      await save.click();
      await details.getByText("Не назначен", { exact: true }).waitFor();
      await page.getByText("Автор первого предложения → Не назначен").waitFor();
      await page.waitForLoadState("networkidle");
      backend.assertComplete();

      backend.expect(pageExchanges(profile, list, query));
      await page.getByRole("link", { name: "← К списку" }).click();
      assert.equal(await page.getByLabel("Ответственный", { exact: true }).inputValue(), "needs-assignment");
      assert.equal(await page.getByLabel("Поиск").inputValue(), query.q);
      assert.equal(await page.getByLabel("Категория").inputValue(), query.category);
      await page.getByRole("row").filter({ hasText: title }).getByText("Не назначен", { exact: true }).waitFor();
      backend.assertComplete();
    } finally {
      await browser.close();
    }
  });
});
