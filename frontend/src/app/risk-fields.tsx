import type { Assignee, Category, Fields, Priority, ProposalStatus, PublishedRisk, RiskState } from "./api";

export const categories: Record<Category, string> = { LOW: "Низкий", MEDIUM: "Средний", HIGH: "Высокий" };
export const riskStates: Record<RiskState, string> = { ACTIVE: "Активен", REMOVED: "Снят", MATERIALIZED: "Реализовался" };
export const proposalStatuses: Record<ProposalStatus, string> = {
  DRAFT: "Черновик", IN_REVIEW: "На ревью", RETURNED: "Возвращено",
  APPROVED: "Утверждено", WITHDRAWN: "Отозвано", CLOSED: "Закрыто",
};

const calendar = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });
export const dateLabel = (value: string) => calendar.format(new Date(value + "T00:00:00Z"));

export function AssigneeName({ assignee }: { assignee: Assignee | null }) {
  return assignee ? <>{assignee.displayName}{!assignee.active && <small className="overdue">Требуется замена</small>}</>
    : <>Не назначен</>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <><span className={`badge ${priority.category.toLowerCase()}`}>{priority.score} · {categories[priority.category]}</span>
    {priority.criticalImpact && <small className="overdue">Критические последствия</small>}</>;
}

function previewPriority({ likelihood, impact }: Pick<Fields, "likelihood" | "impact">): Priority | null {
  if (likelihood === null || impact === null || ![likelihood, impact].every((score) =>
    Number.isInteger(score) && score >= 1 && score <= 10)) return null;
  const score = likelihood * impact;
  return { score, category: score < 20 ? "LOW" : score < 40 ? "MEDIUM" : "HIGH", criticalImpact: impact >= 9 };
}

const textFields = [
  ["cause", "Причина"], ["possibleEvent", "Возможное событие"], ["productConsequences", "Последствия для продукта"],
] as const;

function Tracker({ value }: { value: string }) {
  return /^https?:\/\//i.test(value)
    ? <a href={value} target="_blank" rel="noreferrer">{value}</a>
    : <>{value}</>;
}

export function FieldDetails({ fields, owner, priority }: {
  fields: Fields | PublishedRisk["snapshot"]; owner?: Assignee | null; priority?: Priority;
}) {
  const score = priority ?? previewPriority(fields);
  return <div className="details">
    <dl className="details">
      {textFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{fields[key] || "—"}</dd></div>)}
    </dl>
    <dl className="detail-metrics">
      {owner && <div><dt>Прежний владелец</dt><dd>{owner.displayName}{!owner.active && <small className="overdue">Отключён</small>}</dd></div>}
      <div><dt>Вероятность</dt><dd>{fields.likelihood ?? "—"}</dd></div>
      <div><dt>Влияние</dt><dd>{fields.impact ?? "—"}</dd></div>
      <div><dt>Приоритет</dt><dd>{score ? <PriorityBadge priority={score} /> : "—"}</dd></div>
    </dl>
    <dl className="details">
      <div><dt>Решение и меры</dt><dd>{fields.decisionNote || "—"}</dd></div>
      {fields.trackerUrl && <div><dt>Ссылка на трекер</dt><dd><Tracker value={fields.trackerUrl} /></dd></div>}
      <div><dt>Состояние риска</dt><dd>{riskStates[fields.riskState]}</dd></div>
      {fields.closureReason && <div><dt>Причина завершения</dt><dd>{fields.closureReason}</dd></div>}
    </dl>
  </div>;
}

export function FieldEditor({ fields, setFields, allowClosure }: {
  fields: Fields;
  setFields: (fields: Fields) => void;
  allowClosure: boolean;
}) {
  const [likelihood, impact] = [fields.likelihood, fields.impact];
  const priority = previewPriority({ likelihood, impact });

  function textInput(key: keyof Pick<Fields, "title" | "cause" | "possibleEvent" | "productConsequences" |
    "decisionNote" | "trackerUrl" | "closureReason">) {
    return { value: fields[key] ?? "", onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setFields({ ...fields, [key]: event.target.value || null }) };
  }

  function scoreInput(key: "likelihood" | "impact", description: string) {
    return <input type="number" min={1} max={10} step={1} value={fields[key] ?? ""} aria-describedby={description}
      onChange={(event) => setFields({ ...fields, [key]: event.target.value === "" ? null : event.target.valueAsNumber })} />;
  }

  return <>
    <p className="muted">Поля со звёздочкой нужны для отправки на ревью. Черновик можно сохранить частично.</p>
    <label>Название *<input {...textInput("title")} /></label>
    {textFields.map(([key, label]) => <label key={key}><span id={key}>{label} *</span>
      <textarea aria-labelledby={key} rows={2} {...textInput(key)} /></label>)}
    <div className="form-grid">
      <div className="stack">
        <label>Вероятность *{scoreInput("likelihood", "likelihood-guide")}</label>
        <small id="likelihood-guide">На ближайшие три месяца. 1 ≈ 10%, 5 ≈ 50%, 10 ≈ 100%.</small>
      </div>
      <div className="stack">
        <label>Влияние *{scoreInput("impact", "impact-guide")}</label>
        <small id="impact-guide">1 — единичное неудобство, 3 — ограниченное ухудшение, 5 — существенное ухудшение ключевого сценария,
          7 — недоступность ключевого сценария для многих, 10 — угроза жизнеспособности продукта.</small>
      </div>
    </div>
    <p className="muted">Учитывайте действующие меры. Запланированные меры учитываются после внедрения.</p>
    {priority && <p><PriorityBadge priority={priority} /></p>}
    <label><span id="decision-note">Решение и меры</span>
      <textarea aria-labelledby="decision-note" rows={3} {...textInput("decisionNote")} /></label>
    <label>Ссылка на трекер<input type="url" {...textInput("trackerUrl")} /></label>
    <label><span id="draft-state">Состояние риска</span><select aria-labelledby="draft-state" value={fields.riskState} onChange={(event) => {
      const riskState = event.target.value as RiskState;
      setFields({ ...fields, riskState, closureReason: riskState === "ACTIVE" ? null : fields.closureReason });
    }}>
      {Object.entries(riskStates).filter(([value]) => allowClosure || value === "ACTIVE" || value === fields.riskState)
        .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {fields.riskState !== "ACTIVE" && <label><span id="closure-reason">Причина завершения *</span>
      <textarea aria-labelledby="closure-reason" rows={2} {...textInput("closureReason")} /></label>}
  </>;
}
