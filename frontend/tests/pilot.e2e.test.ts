import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Locator } from "playwright-core";

const base = process.env.PILOT_UI_URL ?? "http://localhost:3000";
const button = (page: Page | Locator, name: string) => page.getByRole("button", { name, exact: true });
const link = (page: Page | Locator, name: string) => page.getByRole("link", { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
const text = (page: Page | Locator, value: string) => page.getByText(value, { exact: true });
const dateLabel = (date: string) => new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium", timeZone: "UTC",
}).format(new Date(date));

async function signIn(page: Page, login: string, password: string) {
  await page.goto(base);
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await button(page, "Войти").click();
}

async function changePassword(page: Page, temporary: string, password: string) {
  await heading(page, "Смена временного пароля").waitFor();
  assert.equal(await page.getByRole("navigation").count(), 0);
  await page.reload();
  await heading(page, "Смена временного пароля").waitFor();
  await page.getByLabel("Временный пароль").fill(temporary);
  await page.getByLabel("Новый пароль", { exact: true }).fill(password);
  await page.getByLabel("Повторите новый пароль").fill(password);
  await button(page, "Сохранить пароль").click();
  await heading(page, "Активные риски").waitFor();
}

async function createAccount(admin: Page, login: string, name: string) {
  await button(admin, "Добавить участника").click();
  await admin.getByLabel("Имя", { exact: true }).fill(name);
  await admin.getByLabel("Логин", { exact: true }).fill(login);
  await button(admin, "Создать аккаунт").click();
  const notice = admin.getByRole("region", { name: "Временный пароль" });
  const password = await notice.locator("code").innerText();
  await button(notice, "Закрыть").click();
  await notice.waitFor({ state: "hidden" });
  return password;
}

async function openListedRisk(page: Page, section: string, title: string) {
  await link(page.getByRole("navigation"), section).click();
  await link(page, title).click();
}

async function withBrowser(run: (browser: Browser) => Promise<void>) {
  const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
}

test("рабочий пилот: первый вход, роли, отзыв сессии и полный цикл риска", { timeout: 120_000 }, async () => {
  const adminLogin = process.env.PILOT_ADMIN_LOGIN;
  const adminPassword = process.env.PILOT_ADMIN_PASSWORD;
  assert.ok(adminLogin && adminPassword, "Настройте PILOT_ADMIN_LOGIN и PILOT_ADMIN_PASSWORD для отдельной тестовой базы.");
  await withBrowser(async (browser) => {
    const admin = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const author = await browser.newPage();
    const reviewer = await browser.newPage();
    const stale = await browser.newPage();
    const suffix = randomUUID().slice(0, 8);
    const authorName = `Автор ${suffix}`;
    const reviewerName = `Ревьюер ${suffix}`;
    const authorLogin = `author-${suffix}`;
    const reviewerLogin = `reviewer-${suffix}`;
    const password = `Pilot local password ${suffix}!`;
    const title = `Задержка регистрации ${suffix}`;
    const note = "Проверить очередь заявок и вернуться к оценке 15 декабря.";

    await signIn(admin, adminLogin, adminPassword);
    if (process.env.PILOT_NEW_ADMIN_PASSWORD) {
      await changePassword(admin, adminPassword, process.env.PILOT_NEW_ADMIN_PASSWORD);
    }
    await link(admin, "Участники").click();
    const authorTemp = await createAccount(admin, authorLogin, authorName);
    const reviewerTemp = await createAccount(admin, reviewerLogin, reviewerName);
    await signIn(author, authorLogin, authorTemp);
    await changePassword(author, authorTemp, password);
    await signIn(reviewer, reviewerLogin, reviewerTemp);
    await changePassword(reviewer, reviewerTemp, password);
    assert.equal(await link(reviewer, "На ревью").count(), 0);

    const reviewerAccount = admin.locator(".account-row").filter({ hasText: reviewerName });
    await reviewerAccount.getByLabel("Ревьюер", { exact: true }).check();
    const roleChange = admin.waitForResponse((response) =>
      response.url().includes("/api/admin/accounts/") && response.request().method() === "PATCH");
    await button(reviewerAccount, "Сохранить").click();
    assert.equal((await roleChange).status(), 200);
    await link(admin.getByRole("navigation"), "Активные риски").click();
    await link(reviewer, "Архив").click();
    await heading(reviewer, "Вход в реестр").waitFor();
    await signIn(reviewer, reviewerLogin, password);
    await signIn(stale, reviewerLogin, password);
    await link(reviewer, "На ревью").waitFor();
    assert.equal(await link(reviewer, "Участники").count(), 0);

    await button(author, "＋ Предложить риск").click();
    await author.getByLabel("Название *", { exact: true }).fill(title);
    assert.equal(await author.getByLabel(/Владелец|Ответственный/).count(), 0);
    await button(author, "Сохранить черновик").click();
    await text(author, "Черновик сохранён.").waitFor();
    const riskId = await author.locator(".card-id code").innerText();
    const privateDraft = await reviewer.request.get(`${base}/api/risks/${riskId}/draft`);
    assert.equal(privateDraft.status(), 404);
    const privateHistory = await reviewer.request.get(`${base}/api/risks/${riskId}/history`);
    assert.equal(privateHistory.status(), 404);
    await button(author, "Отправить на ревью").click();
    await text(author, "Заполните поля со звёздочкой перед отправкой на ревью.").waitFor();
    await author.getByLabel("Причина *", { exact: true }).fill("Ручная сортировка заявок.");
    await author.getByLabel("Возможное событие *", { exact: true }).fill("Очередь заявок растёт.");
    await author.getByLabel("Последствия для продукта *", { exact: true }).fill("Пользователи поздно получают доступ.");
    await author.getByLabel("Вероятность *", { exact: true }).fill("2");
    await author.getByLabel("Влияние *", { exact: true }).fill("9");
    await author.getByLabel("Решение и меры", { exact: true }).fill(note);
    await text(author, "18 · Низкий").waitFor();
    await text(author, "Критические последствия").waitFor();
    await button(author, "Отправить на ревью").click();
    await text(author, "Предложение отправлено на ревью.").waitFor();

    await openListedRisk(reviewer, "На ревью", title);
    await openListedRisk(stale, "На ревью", title);
    await button(stale, "Утвердить").waitFor();
    const returnForm = reviewer.locator("details").filter({ has: reviewer.locator("summary").filter({ hasText: "Вернуть автору" }) });
    await returnForm.locator("summary").click();
    const explanation = "Уточните, какой срок считается задержкой.";
    await returnForm.getByLabel("Пояснение").fill(explanation);
    await button(returnForm, "Вернуть автору").click();
    await text(reviewer, "Предложение возвращено автору.").waitFor();
    await button(stale, "Утвердить").click();
    await button(stale, "Обновить карточку").click();
    await text(stale, "Возвращено").waitFor();
    assert.equal(await button(stale, "Утвердить").count(), 0);

    await openListedRisk(author, "Мои предложения", title);
    await author.getByRole("heading", { name: title, exact: true }).waitFor();
    await author.getByText(explanation, { exact: false }).first().waitFor();
    await author.getByLabel("Возможное событие *", { exact: true }).fill("Очередь заявок превышает два дня.");
    await button(author, "Отправить на ревью").click();
    await text(author, "Предложение отправлено на ревью.").waitFor();
    await openListedRisk(reviewer, "На ревью", title);
    await button(reviewer, "Утвердить").click();
    await text(reviewer, "Версия утверждена.").waitFor();
    await reviewer.reload();
    await text(reviewer, "Не назначен").waitFor();
    await button(reviewer, "Назначить ответственного").click();
    await reviewer.getByLabel("Выбор ответственного").selectOption({ label: authorName });
    await button(reviewer, "Сохранить назначение").click();
    await text(reviewer, `Не назначен → ${authorName}`).waitFor();

    await link(author.getByRole("navigation"), "Активные риски").click();
    await author.getByLabel("Поиск").fill("превышает два дня");
    await author.getByLabel("Категория").selectOption("LOW");
    await author.getByLabel("Ответственный").selectOption({ label: authorName });
    await button(author, "Найти").click();
    await link(author, title).waitFor();
    if (process.env.PILOT_SCREENSHOT) await author.screenshot({ path: process.env.PILOT_SCREENSHOT, fullPage: true });
    await link(author, title).click();
    await text(author, note).first().waitFor();
    const mitigation = "Установлена автоматическая сортировка заявок.";
    await button(author, "Редактировать").click();
    await author.getByLabel("Решение и меры", { exact: true }).fill(mitigation);
    await button(author, "Сохранить изменения").click();
    await text(author, "Изменения опубликованы.").waitFor();
    await text(author, `${note} → ${mitigation}`).waitFor();
    const manualDate = new Date(Date.now() + 150 * 86_400_000).toISOString().slice(0, 10);
    const manualLabel = dateLabel(manualDate);
    const assessment = author.locator(".assessment");
    const historyChange = text(author, `Автоматический срок → ${manualLabel}`);
    await button(author, "Редактировать").click();
    await author.getByLabel("Ручная дата пересмотра", { exact: true }).fill(manualDate);
    await button(author, "Сохранить изменения").click();
    await text(assessment, manualLabel).waitFor();
    await historyChange.waitFor();

    await button(author, "Редактировать").click();
    await author.getByLabel("Вероятность *", { exact: true }).fill("3");
    await button(author, "Сохранить изменения").click();
    await text(author, "2 → 3").waitFor();
    await text(assessment, manualLabel).waitFor();

    const composeProject = process.env.PILOT_E2E_RESTART_PROJECT;
    if (composeProject) {
      const cwd = fileURLToPath(new URL("../..", import.meta.url));
      const compose = ["compose", "-p", composeProject, "-f", "compose.yaml"];
      execFileSync("docker", [...compose, "stop"], { cwd, timeout: 30_000 });
      execFileSync("docker", [...compose, "up", "--wait", "--wait-timeout", "45"], { cwd, timeout: 55_000 });
      await author.reload();
      await text(assessment, manualLabel).waitFor();
      await historyChange.waitFor();
      await text(author, `${note} → ${mitigation}`).waitFor();
      await text(author, "2 → 3").waitFor();
    }

    await link(reviewer.getByRole("navigation"), "Активные риски").click();
    const reviewerRow = reviewer.getByRole("row").filter({ has: link(reviewer, title) });
    await reviewerRow.getByRole("cell", { name: manualLabel, exact: true }).waitFor();
    await link(reviewerRow, title).click();
    const reviewerAssessment = reviewer.locator(".assessment");
    await text(reviewerAssessment, manualLabel).waitFor();
    await button(reviewer, "Подтвердить оценку").click();
    const dateDialog = reviewer.getByRole("dialog", { name: "Снять ручную дату пересмотра?" });
    await dateDialog.getByText(`При подтверждении оценки дата ${manualLabel} будет снята.`, { exact: false }).waitFor();
    const confirmation = reviewer.waitForResponse((response) =>
      response.url().includes(`/api/risks/${riskId}/`) && response.request().method() === "POST");
    await button(dateDialog, "Подтвердить оценку и снять дату").click();
    const confirmed = await confirmation;
    assert.equal(confirmed.status(), 200);
    const { assessment: automatic } = await confirmed.json();
    const comparisonDate = new Date(automatic.date);
    const day = comparisonDate.getUTCDate();
    comparisonDate.setUTCMonth(comparisonDate.getUTCMonth() + 3, 1);
    const endOfMonth = new Date(Date.UTC(comparisonDate.getUTCFullYear(), comparisonDate.getUTCMonth() + 1, 0));
    comparisonDate.setUTCDate(Math.min(day, endOfMonth.getUTCDate()));
    assert.equal(automatic.manualReviewDate, null);
    assert.equal(automatic.reviewRequired, false);
    assert.equal(automatic.reviewDueDate, comparisonDate.toISOString().slice(0, 10));
    assert.ok(automatic.reviewDueDate < manualDate);
    await text(reviewer, "Оценка подтверждена.").waitFor();
    await text(reviewerAssessment, dateLabel(automatic.reviewDueDate)).waitFor();
    await text(reviewer, `Снята ручная дата пересмотра · ${manualLabel}`).waitFor();
    await link(reviewer, "← К списку").click();
    await reviewerRow.getByRole("cell", { name: dateLabel(automatic.reviewDueDate), exact: true }).waitFor();
    await author.reload();
    await text(assessment, dateLabel(automatic.reviewDueDate)).waitFor();

    const occurrences = (page: Page) => page.getByRole("region", { name: "Случаи проявления риска" });
    const occurrence = "Сортировка заявок заняла два дня.";
    await button(occurrences(author), "Добавить случай").click();
    await occurrences(author).getByLabel("Описание случая").fill(occurrence);
    await button(occurrences(author), "Сохранить случай").click();
    await text(occurrences(author), occurrence).waitFor();
    await button(author, "Завершить риск").click();
    await author.getByLabel("Состояние риска").selectOption("REMOVED");
    await author.getByLabel("Причина завершения *", { exact: true }).fill("Ручная очередь устранена.");
    assert.equal(await author.getByLabel("Название *", { exact: true }).count(), 0);
    await button(author, "Создать черновик завершения").click();
    await button(author, "Отправить на ревью").click();
    await text(author, "Предложение отправлено на ревью.").waitFor();
    await openListedRisk(reviewer, "Активные риски", title);
    await text(reviewer, "Опубликованная версия").waitFor();
    await text(reviewer, mitigation).first().waitFor();
    await button(reviewer, "Подтвердить оценку").click();
    await text(reviewer, "Оценка подтверждена.").waitFor();
    await openListedRisk(reviewer, "На ревью", title);
    await text(occurrences(reviewer), occurrence).waitFor();
    await button(occurrences(reviewer), "Исправить").waitFor();
    await button(reviewer, "Утвердить").click();
    await text(reviewer, "Версия утверждена.").waitFor();
    await openListedRisk(author, "Архив", title);
    await text(author, mitigation).first().waitFor();
    await text(author, authorName).first().waitFor();
    await text(occurrences(author), occurrence).waitFor();
    assert.equal(await occurrences(author).getByRole("button", { name: /Добавить случай|Исправить|Удалить/ }).count(), 0);
    await text(author, "Ручная очередь устранена.").first().waitFor();
    await author.locator("summary").filter({ hasText: `Версия 1 · ${title}` }).click();
    await text(author.locator("details[open]"), note).waitFor();
    if (process.env.PILOT_COMPLETION_SCREENSHOT) {
      await author.screenshot({ path: process.env.PILOT_COMPLETION_SCREENSHOT, fullPage: true });
    }

    await link(admin, "Участники").click();
    await reviewerAccount.getByLabel("Активен", { exact: true }).uncheck();
    await button(reviewerAccount, "Сохранить").click();
    await reviewerAccount.getByText(`${reviewerLogin} · Отключён`).waitFor();
    await link(reviewer, "Мои предложения").click();
    await heading(reviewer, "Вход в реестр").waitFor();
  });
});
