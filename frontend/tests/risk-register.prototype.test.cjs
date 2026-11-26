const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "../public/risk-register.prototype.html"), "utf8");
const context = vm.createContext({});
vm.runInContext(html.match(/<script id="risk-model">([\s\S]*?)<\/script>/)[1] + "\nglobalThis.model = RiskModel;", context);
const M = context.model;
const today = "2026-11-23";
const complete = { ...M.blank("anna"), title: "Риск", cause: "Причина", event: "Событие", consequence: "Ухудшение активации", probability: 5, impact: 8 };
const action = (state, type, id, actor = "anna", extra = {}) => M.transition(state, { type, id, actor, today, ...extra });
function submitted() {
  const created = action(M.initial(today), "create");
  return action(created.state, "submit", created.id, "anna", { data: complete });
}

test("category boundaries and critical impact remain independent", () => {
  for (const [score, key] of [[1,"low"],[19,"low"],[20,"medium"],[39,"medium"],[40,"high"],[100,"high"]]) assert.equal(M.category(score).key, key);
  for (const impact of [9,10]) {
    const result = M.assessment({ probability: 1, impact });
    assert.equal(result.critical, true);
    assert.equal(result.key, "low");
  }
  assert.equal(M.assessment({ probability: 5, impact: 8 }).critical, false);
  for (const n of [0,11,1.5,"5",NaN]) assert.equal(M.assessment({ probability: n, impact: 5 }), null);
});

test("incomplete drafts save; invalid submissions are atomic", () => {
  const created = action(M.initial(today), "create");
  assert.equal(created.state.risks.at(-1).proposal.data.owner, "anna");
  const saved = action(created.state, "save", created.id, "anna", { data: { title: "Только название" } });
  assert.equal(saved.state.risks.at(-1).proposal.status, "draft");
  const before = JSON.stringify(saved.state);
  assert.throws(() => action(saved.state, "submit", created.id), /Заполните/);
  assert.equal(JSON.stringify(saved.state), before);
  assert.throws(() => action(saved.state, "save", created.id, "ivan"), /только автор/);
  assert.throws(() => action(saved.state, "approve", created.id, "maria"), /отправьте/);
  for (const data of [{ probability: 2.5 }, { impact: 11 }, { owner: "missing" }, { link: "javascript:alert(1)" }]) {
    assert.throws(() => action(saved.state, "submit", created.id, "anna", { data: { ...complete, ...data } }));
  }
});

test("drafts, submitted and returned proposals have role-aware visibility", () => {
  const p = { author: "anna", status: "draft" };
  assert.equal(M.canSee(p,"anna"), true);
  for (const actor of ["ivan","maria","oleg"]) assert.equal(M.canSee(p,actor), false);
  for (const status of ["submitted","returned"]) {
    p.status = status;
    for (const actor of ["anna","maria","oleg"]) assert.equal(M.canSee(p,actor), true);
    assert.equal(M.canSee(p,"ivan"), false);
  }
});

test("return requires explanation, author resubmits, reviewer publishes", () => {
  let r = submitted();
  assert.throws(() => action(r.state,"approve",r.id), /только ревьюеру/);
  assert.throws(() => action(r.state,"return",r.id,"maria",{comment:"  "}), /пояснение/);
  r = action(r.state,"return",r.id,"maria",{comment:"Уточнить последствия"});
  assert.equal(r.state.risks.at(-1).proposal.comment,"Уточнить последствия");
  r = action(r.state,"submit",r.id,"anna",{data:{consequence:"Потеря новых пользователей"}});
  assert.throws(() => action(r.state,"save",r.id), /только автор/);
  r = action(r.state,"approve",r.id,"oleg");
  const risk = r.state.risks.at(-1);
  assert.equal(risk.proposal,null);
  assert.equal(risk.published.consequence,"Потеря новых пользователей");
  assert.equal(risk.reviewedAt,today);
  assert.equal(risk.history.length,1);
  assert.throws(() => action(r.state,"approve",r.id,"maria"), /отправьте/);
});

test("published version stays unchanged until approval, only one unfinished edit", () => {
  let r = action(M.initial(today),"propose","r1","ivan");
  const old = JSON.stringify(r.state.risks[0].published);
  assert.throws(() => action(r.state,"propose","r1","anna"), /незавершённая/);
  r = action(r.state,"submit","r1","ivan",{data:{probability:2,notes:"Мера уже внедрена"}});
  assert.equal(JSON.stringify(r.state.risks[0].published),old);
  r = action(r.state,"approve","r1","maria");
  assert.equal(r.state.risks[0].published.probability,2);
  assert.equal(JSON.stringify(r.state.risks[0].history[0].data),old);
  assert.equal(r.state.risks[0].history[1].kind,"Пересмотр с изменениями");
  assert.equal(r.state.risks[0].reviewedAt,today);
});

test("quarterly confirmation requires reviewer and records unchanged snapshot", () => {
  const state = M.initial(today);
  assert.throws(() => action(state,"confirm","r1"), /только ревьюер/);
  const r = action(state,"confirm","r1","maria").state.risks[0];
  assert.equal(JSON.stringify(r.published),JSON.stringify(state.risks[0].published));
  assert.equal(r.reviewedAt,today);
  assert.equal(r.history.length,2);
  assert.equal(r.history[1].kind,"Оценка подтверждена без изменений");
  assert.throws(() => action(state,"confirm","r5","maria"), /активному/);
});

test("completion requires reason and approval; archives retain history", () => {
  for (const status of ["withdrawn","realized"]) {
    let r = action(M.initial(today),"propose","r1");
    assert.throws(() => action(r.state,"submit","r1","anna",{data:{status}}), /причину/);
    r = action(r.state,"submit","r1","anna",{data:{status,reason:"Причина завершения"}});
    assert.equal(r.state.risks[0].published.status,"active");
    r = action(r.state,"approve","r1","maria");
    assert.equal(r.state.risks[0].published.status,status);
    assert.equal(r.state.risks[0].history.length,2);
    assert.throws(() => action(r.state,"propose","r1"), /активного/);
  }
});

test("self-review is permitted", () => {
  let r = action(M.initial(today),"create",undefined,"maria");
  r = action(r.state,"submit",r.id,"maria",{data:complete});
  r = action(r.state,"approve",r.id,"maria");
  assert.equal(r.state.risks.at(-1).history[0].actor,"maria");
});

test("three calendar months clamp month ends and handle leap years", () => {
  for (const [input,expected] of [["2026-01-31","2026-04-30"],["2026-11-30","2027-02-28"],["2023-11-30","2024-02-29"],["2024-02-29","2024-05-29"],["2026-12-31","2027-03-31"]]) assert.equal(M.dueDate(input),expected);
  assert.equal(M.overdue("2026-01-31","2026-04-29"),false);
  assert.equal(M.overdue("2026-01-31","2026-04-30"),true);
});

test("standalone file has no external scripts, styles, requests or storage", () => {
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b[^>]*(?:src|href)\s*=/i);
  assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/);
  for (const [,code] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(code);
});
