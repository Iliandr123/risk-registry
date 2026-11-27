import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError, errorMessage, type Account, type Api, type DraftAction, type Participant,
  type Proposal, type PublishedRisk, type RiskHistory,
} from "./api";
import { AssigneeName, dateLabel, FieldDetails, FieldEditor, proposalStatuses } from "./risk-fields";
import { RiskOccurrences } from "./risk-occurrences";

import { readCard, type Card, type Selection } from "./read-card";

type Update = (selection: Selection, message: string, refreshCard?: boolean) => void;

const events: Record<RiskHistory["events"][number]["action"], string> = {
  SUBMIT: "Отправлено на ревью", RETURN: "Возвращено автору", APPROVE: "Утверждено",
  WITHDRAW: "Отозвано", UNBLOCK: "Предложение закрыто", CONFIRM_ASSESSMENT: "Оценка подтверждена",
  ASSIGNMENT_CHANGED: "Назначение изменено", ASSIGNMENT_MIGRATED: "Перенесено из прежнего реестра",
};
const actionMessages: Record<DraftAction, string> = {
  submit: "Предложение отправлено на ревью.", return: "Предложение возвращено автору.",
  approve: "Версия утверждена.", withdraw: "Предложение отозвано.", unblock: "Предложение закрыто.",
};
const terminal = (proposal: Proposal) => ["APPROVED", "WITHDRAWN", "CLOSED"].includes(proposal.status);
const eventDate = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "long", timeZone: "UTC" });

export function RiskCard({ api, selection, account, participants, refreshParticipants, onUpdate, initial }: {
  api: Api; selection: Selection; account: Account; participants: Participant[]; onUpdate: Update; initial?: Card;
  refreshParticipants: () => Promise<void>;
}) {
  const [card, setCard] = useState<Card | null>(initial ?? null);
  const [error, setError] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const { riskId, proposal } = selection;

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    readCard(api, selection, account.id)
      .then((data) => { if (!cancelled) setCard(data); })
      .catch((error) => { if (!cancelled) setLoadingError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [api, selection, initial, account.id]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && (error.code === "RISK_CONFLICT" || error.status === 404)) setConflict(true);
    } finally {
      setBusy(false);
    }
  }

  function saveAssignment(published: PublishedRisk, assigneeId: string | null) {
    return run(async () => {
      let updated: PublishedRisk;
      try {
        updated = await api.assign(riskId, { assigneeId, expectedAssignmentRevision: published.assignmentRevision });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "ASSIGNEE_INACTIVE") throw error;
        setCandidate(null);
        const message = "Выбранный участник больше недоступен. Выберите активного участника или снимите назначение.";
        try {
          await refreshParticipants();
          setError(message);
        } catch {
          setError(message + " Не удалось обновить список участников.");
          setConflict(true);
        }
        return;
      }
      setCard((current) => current?.published ? { ...current, published: updated } : current);
      setEditingAssignment(false);
      onUpdate(selection, "Назначение сохранено.", false);
      try {
        const history = await api.history(riskId);
        setCard((current) => current && { ...current, history });
      } catch (error) {
        setError(errorMessage(error));
        setConflict(true);
      }
    });
  }

  const reload = () => onUpdate(selection, "");
  if (loadingError) return <div role="alert" className="error">{loadingError} <button onClick={reload}>Повторить</button></div>;
  if (!card) return <p role="status">Загружаем карточку…</p>;
  const { published, draft, history, occurrences } = card;
  const snapshot = published?.snapshot;
  const unblock = published?.unblock;
  const candidates = participants.filter(({ id }) => id !== published?.assignee?.id || published.assignee.active);
  const selectedCandidate = candidate === "" || candidates.some(({ id }) => id === candidate) ? candidate : null;

  return <div className="stack">
    <div className="card-id">ID риска <code>{riskId}</code></div>
    {!published && !draft && !history && <p className="notice" role="status">Карточка больше недоступна.</p>}
    {proposal && !draft && (published || history) && <p className="notice">Предложение вышло из работы. Результат указан в истории.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {conflict && <button onClick={reload}>Обновить карточку</button>}
    {published && snapshot && <section className="panel risk-panel stack">
      <div><div className="section-label">Опубликованная версия</div><h2>{snapshot.title}</h2></div>
      <dl className="detail-metrics">
        <div><dt>Ответственный</dt><dd><AssigneeName assignee={published.assignee} /></dd></div>
        <div><dt>Предложил</dt><dd>{published.author.displayName}</dd></div>
      </dl>
      {snapshot.riskState === "ACTIVE" && (account.isReviewer || account.isAdmin) && (
        editingAssignment ? <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          if (selectedCandidate !== null) void saveAssignment(published, selectedCandidate || null);
        }}>
          <fieldset className="stack" disabled={busy || conflict}>
            <label>Выбор ответственного
              <select value={selectedCandidate ?? "choose"} onChange={(event) => setCandidate(event.target.value)}>
                <option value="choose" disabled>Выберите участника</option>
                <option value="">Снять назначение</option>
                {candidates.map(({ id, displayName }) => <option key={id} value={id}>{displayName}</option>)}
              </select>
            </label>
            <div className="actions">
              <button className="primary" disabled={selectedCandidate === null}>Сохранить назначение</button>
              <button type="button" onClick={() => { setEditingAssignment(false); setError(""); }}>Отмена</button>
            </div>
          </fieldset>
        </form> : <div className="actions"><button disabled={busy || conflict} onClick={() => {
          const current = candidates.find(({ id }) => id === published.assignee?.id);
          setCandidate(current?.id ?? null);
          setEditingAssignment(true);
        }}>{published.assignee ? "Изменить назначение" : "Назначить ответственного"}</button></div>
      )}
      <FieldDetails fields={snapshot} priority={snapshot.priority} />
      <div className="assessment">
        <span>Дата оценки <strong>{dateLabel(published.assessment.date)}</strong></span>
        {snapshot.riskState === "ACTIVE" && <span>Следующий пересмотр <strong>{dateLabel(published.assessment.reviewDueDate)}</strong></span>}
        {published.assessment.reviewRequired && <strong className="overdue">Требует пересмотра</strong>}
      </div>
      {published.hasOpenDraft && <p className="notice">Правка в работе{unblock && ` · ${unblock.authorDisplayName}`}</p>}
      <div className="actions">
        {snapshot.riskState === "ACTIVE" && !published.hasOpenDraft && <button className="primary" disabled={busy || conflict}
          onClick={() => run(async () => {
            const draft = await api.openDraft(riskId, snapshot.versionId);
            onUpdate({ riskId, proposal: draft }, "Черновик правки создан.");
          })}>Предложить правку</button>}
        {snapshot.riskState === "ACTIVE" && account.isReviewer && <button disabled={busy || conflict}
          onClick={() => run(async () => {
            const confirmed = await api.confirm(riskId, snapshot.versionId);
            setCard({ ...card, published: confirmed });
            onUpdate(selection, "Оценка подтверждена.", false);
            setCard({ ...card, published: confirmed, history: await api.history(riskId) });
          })}>Подтвердить оценку</button>}
      </div>
      {unblock && <CommentAction label="Снять блокировку правки" disabled={busy || conflict} onSubmit={(comment) =>
        run(async () => {
          await api.act(riskId, unblock, "unblock", comment);
          onUpdate({ riskId }, "Блокировка правки снята.");
        })} />}
    </section>}
    {published && occurrences && <RiskOccurrences api={api} riskId={riskId} account={account}
      active={published.snapshot.riskState === "ACTIVE"} initial={occurrences} onReload={reload} />}
    {draft && <ProposalCard key={`${draft.versionId}/${draft.revision}`} api={api} account={account} proposal={draft}
      disabled={busy || conflict} history={history}
      onUpdate={onUpdate} onReload={reload} showUnblock={!unblock} />}
    {history && <History history={history} />}
  </div>;
}

function ProposalCard({ api, account, proposal, disabled, history, onUpdate, onReload, showUnblock }: {
  api: Api; account: Account; proposal: Proposal;
  disabled: boolean; history: RiskHistory | null; onUpdate: Update; onReload: () => void; showUnblock: boolean;
}) {
  const [version, setVersion] = useState(proposal);
  const [fields, setFields] = useState(proposal.fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const { riskId, status } = version;
  const isAuthor = version.author.id === account.id;
  const editable = isAuthor && (status === "DRAFT" || status === "RETURNED");
  const reviewable = account.isReviewer && status === "IN_REVIEW";
  const locked = disabled || busy || conflict;
  const lastEvent = history?.events.filter((item) => item.versionId === version.versionId).at(-1);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && (error.code === "RISK_CONFLICT" || error.status === 404)) setConflict(true);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: DraftAction, comment?: string, current = version) {
    const result = await api.act(riskId, current, action, comment);
    onUpdate(action === "approve" ? { riskId } : { riskId, proposal: { ...current, ...result } }, actionMessages[action]);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submit = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "submit";
    if (submit && (!fields.title?.trim() || !fields.cause?.trim() || !fields.possibleEvent?.trim()
      || !fields.productConsequences?.trim() || !fields.likelihood || !fields.impact
      || (fields.riskState !== "ACTIVE" && !fields.closureReason?.trim()))) {
      setError("Заполните поля со звёздочкой перед отправкой на ревью.");
      return;
    }
    void run(async () => {
      const saved = JSON.stringify(fields) === JSON.stringify(version.fields) ? version : await api.saveDraft(version, fields);
      setVersion(saved);
      if (submit) await act("submit", undefined, saved);
      else onUpdate({ riskId, proposal: saved }, "Черновик сохранён.");
    });
  }

  return <section className="panel risk-panel stack">
    <header className="proposal-heading">
      <div><div className="section-label">{proposal.kind === "FIRST" ? "Предложение нового риска" : "Предложение правки"}</div>
        <h2>{version.fields.title || "Без названия"}</h2><small>Автор · {version.author.displayName}</small></div>
      <span className="badge">{proposalStatuses[status]}</span>
    </header>
    {lastEvent?.comment && <p className="notice"><strong>{events[lastEvent.action]}</strong><br />{lastEvent.comment}</p>}
    {editable ? <form onSubmit={save}>
      <fieldset className="stack" disabled={locked}>
        <FieldEditor fields={fields} setFields={setFields} allowClosure={proposal.kind === "EDIT"} />
        <div className="actions">
          <button className="primary" value="submit">Отправить на ревью</button>
          <button value="save">Сохранить черновик</button>
        </div>
      </fieldset>
    </form> : <FieldDetails fields={version.fields} />}
    {error && <p className="error" role="alert">{error}</p>}
    {conflict && <button onClick={onReload}>Обновить карточку</button>}
    <div className="actions">
      {reviewable && <button className="primary" disabled={locked} onClick={() => run(() => act("approve"))}>Утвердить</button>}
      {isAuthor && !terminal(version) && <button disabled={locked} onClick={() => {
        if (window.confirm("Отозвать предложение?")) void run(() => act("withdraw"));
      }}>Отозвать предложение</button>}
    </div>
    {reviewable && <CommentAction label="Вернуть автору" disabled={locked} onSubmit={(comment) => run(() => act("return", comment))} />}
    {showUnblock && account.isReviewer && proposal.kind === "FIRST" && (status === "IN_REVIEW" || status === "RETURNED")
      && <CommentAction label="Закрыть предложение" disabled={locked} onSubmit={(comment) => run(() => act("unblock", comment))} />}
  </section>;
}

function CommentAction({ label, disabled, onSubmit }: {
  label: string; disabled: boolean; onSubmit: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  return <details className="disclosure">
    <summary>{label}</summary>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); onSubmit(comment.trim()); }}>
      <label>Пояснение<textarea rows={2} value={comment} required disabled={disabled}
        onChange={(event) => setComment(event.target.value)} /></label>
      <button disabled={disabled || !comment.trim()}>{label}</button>
    </form>
  </details>;
}

function History({ history }: { history: RiskHistory }) {
  return <section className="panel risk-panel stack">
    <h2>История</h2>
    {history.events.length === 0 && <p className="muted">Событий пока нет.</p>}
    {history.events.length > 0 && <ol className="timeline">{history.events.slice().reverse().map((event, index) =>
      <li key={`${event.versionId}/${index}`}>
        <strong>{events[event.action]}</strong>
        <small>{event.actor?.displayName ?? "Система"} · {eventDate.format(new Date(event.occurredAt))}</small>
        {(event.action === "ASSIGNMENT_CHANGED" || event.action === "ASSIGNMENT_MIGRATED") &&
          <p>{event.previousAssignee?.displayName ?? "Не назначен"} → {event.newAssignee?.displayName ?? "Не назначен"}</p>}
        {event.comment && <p>{event.comment}</p>}
      </li>)}</ol>}
    {history.publishedVersions.length > 0 && <h3>Утверждённые версии</h3>}
    {history.publishedVersions.slice().reverse().map((snapshot, index, versions) =>
      <details key={snapshot.versionId} className="disclosure">
        <summary>Версия {versions.length - index} · {snapshot.title}</summary>
        <FieldDetails fields={snapshot} owner={snapshot.owner} priority={snapshot.priority} />
      </details>)}
  </section>;
}
