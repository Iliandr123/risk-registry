import { useState, type FormEvent } from "react";
import { ApiError, errorMessage, type Account, type Api, type Fields, type PublishedRisk, type PublishedRiskUpdate } from "./api";
import { dateLabel, FieldEditor } from "./risk-fields";

type Field = keyof PublishedRiskUpdate["fields"];

export const publishedFieldLabels: Record<Field, string> = {
  title: "Название",
  cause: "Причина",
  possibleEvent: "Возможное событие",
  productConsequences: "Последствия для продукта",
  likelihood: "Вероятность",
  impact: "Влияние",
  decisionNote: "Решение и меры",
  trackerUrl: "Ссылка на трекер",
};

const fieldNames = Object.keys(publishedFieldLabels) as Field[];

export function publishedValue(value: string | number | null | undefined) {
  return value == null || value === "" ? "Не указано" : value;
}

export const manualReviewDateLabel = "Ручная дата пересмотра";

export function reviewDateValue(value: string | number | null) {
  return typeof value === "string" ? dateLabel(value) : "Автоматический срок";
}

export function canEditPublished(account: Account, risk: PublishedRisk) {
  return account.active && risk.snapshot.riskState === "ACTIVE"
    && (account.isReviewer || account.isAdmin || risk.assignee?.id === account.id);
}

export function PublishedEditor({ api, risk, account, onSaved, onCancel }: {
  api: Api; risk: PublishedRisk; account: Account; onSaved: (updated: PublishedRisk, changed: boolean) => Promise<void>;
  onCancel: (refresh: boolean) => void;
}) {
  const [base, setBase] = useState(risk.snapshot);
  const [baseReviewDate, setBaseReviewDate] = useState(risk.assessment.manualReviewDate);
  const [manualReviewDate, setManualReviewDate] = useState(baseReviewDate);
  const [fields, setFields] = useState<Fields>(() => ({
    ...risk.snapshot,
    decisionNote: risk.snapshot.decisionNote ?? null,
    trackerUrl: risk.snapshot.trackerUrl ?? null,
    closureReason: risk.snapshot.closureReason ?? null,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [latest, setLatest] = useState<PublishedRisk | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  async function loadLatest() {
    try {
      const current = await api.risk(risk.riskId);
      setLatest(current);
      setManualReviewDate((entered) => entered === baseReviewDate ? current.assessment.manualReviewDate : entered);
      setFields((entered) => ({
        ...entered,
        ...Object.fromEntries(fieldNames.filter((key) => entered[key] === (base[key] ?? null))
          .map((key) => [key, current.snapshot[key] ?? null])),
      }));
      setUnavailable(!canEditPublished(account, current));
    } catch (error) {
      setUnavailable(error instanceof ApiError && (error.status === 403 || error.status === 404));
      setError(errorMessage(error));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reconciling || unavailable) return;
    if (!fields.title?.trim() || !fields.cause?.trim() || !fields.possibleEvent?.trim()
      || !fields.productConsequences?.trim()) {
      setError("Заполните обязательные поля риска.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const changed = fieldNames.filter((key) => fields[key] !== (base[key] ?? null));
      const updated = await api.updatePublished(risk.riskId, {
        expectedPublishedVersionId: base.versionId,
        fields: Object.fromEntries(changed.map((key) => [key, fields[key]])),
        ...(manualReviewDate !== baseReviewDate && { manualReviewDate, expectedManualReviewDate: baseReviewDate }),
      });
      await onSaved(updated, updated.snapshot.versionId !== base.versionId);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.code === "RISK_CONFLICT") {
        setReconciling(true);
        setLatest(null);
        await loadLatest();
      }
      if (error instanceof ApiError && (error.code === "FORBIDDEN" || error.status === 404)) {
        setUnavailable(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return <form className="stack" onSubmit={save} aria-label="Редактирование опубликованного риска">
    <fieldset className="stack" disabled={busy || unavailable}>
      <FieldEditor fields={fields} setFields={setFields} published />
      <div className="stack">
        <label>{manualReviewDateLabel}
          <input type="date" value={manualReviewDate ?? ""} aria-describedby="manual-review-date-help"
            onChange={(event) => setManualReviewDate(event.target.value || null)} />
        </label>
        <small id="manual-review-date-help" className="muted">Пустое поле возвращает срок через три месяца от даты оценки.</small>
        {manualReviewDate && <button type="button" onClick={() => setManualReviewDate(null)}>Сбросить ручную дату</button>}
      </div>
    </fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    {reconciling && latest && <section className="notice stack" aria-label="Сверка полей">
      <h3>Сверьте поля с текущей версией</h3>
      {unavailable && <p>Сохранение больше недоступно.</p>}
      <dl className="details">{fieldNames.filter((key) => fields[key] !== (latest.snapshot[key] ?? null)).map((key) =>
        <div key={key}>
          <dt>{publishedFieldLabels[key]}</dt>
          <dd>Ваш ввод · {publishedValue(fields[key])}</dd>
          <dd>Текущее значение · {publishedValue(latest.snapshot[key])}</dd>
          {!unavailable && <dd><button type="button" disabled={busy}
            onClick={() => setFields({ ...fields, [key]: latest.snapshot[key] ?? null })}>
            Взять текущее значение
          </button></dd>}
        </div>)}
        {manualReviewDate !== latest.assessment.manualReviewDate && <div>
          <dt>{manualReviewDateLabel}</dt>
          <dd>Ваш ввод · {reviewDateValue(manualReviewDate)}</dd>
          <dd>Текущее значение · {reviewDateValue(latest.assessment.manualReviewDate)}</dd>
          {!unavailable && <dd><button type="button" disabled={busy}
            onClick={() => setManualReviewDate(latest.assessment.manualReviewDate)}>
            Взять текущее значение
          </button></dd>}
        </div>}
      </dl>
      {!unavailable && <button type="button" disabled={busy} onClick={() => {
        setBase(latest.snapshot);
        setBaseReviewDate(latest.assessment.manualReviewDate);
        setReconciling(false);
        setError("");
      }}>Подтвердить сверку</button>}
    </section>}
    {reconciling && !latest && !unavailable && <button type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      await loadLatest();
      setBusy(false);
    }}>Загрузить текущую версию</button>}
    <div className="actions">
      <button className="primary" disabled={busy || reconciling || unavailable}>Сохранить изменения</button>
      <button type="button" disabled={busy} onClick={() => onCancel(reconciling || latest !== null || unavailable)}>Отмена</button>
    </div>
  </form>;
}
