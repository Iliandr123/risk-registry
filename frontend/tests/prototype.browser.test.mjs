import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("автономный HTML: все шесть сценариев проходят без сети", async () => {
  const browser = await chromium.launch({ channel: process.env.PILOT_BROWSER ?? "chrome" });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    const errors = [];
    const remoteRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.goto(new URL("../public/risk-register.prototype.html", import.meta.url).href);
    const scenarios = page.locator("[data-scenario]:not([data-scenario='-1'])");
    assert.equal(await scenarios.count(), 6);
    for (let index = 0; index < 6; index++) {
      await scenarios.nth(index).click();
      const next = page.locator("[data-step]:enabled");
      while (await next.count()) await next.click();
      await page.getByText("Сценарий завершён.", { exact: false }).waitFor();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(remoteRequests, []);
  } finally {
    await browser.close();
  }
});
