import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError, errorMessage, ifVisible, type Account, type Api, type DraftAction, type Participant,
  type Proposal, type PublishedRisk, type RiskHistory,
} from "./api";
import { dateLabel, FieldDetails, FieldEditor, OwnerName, proposalStatuses } from "./risk-fields";

export type Selection = { riskId: string; proposal?: Proposal };
type Card = { published: PublishedRisk | null; draft: Proposal | null; history: RiskHistory | null };
type Update = (selection: Selection, message: string, refreshCard?: boolean) => void;

const events: Record<RiskHistory["events"][number]["action"], string> = {
  SUBMIT: "Отправлено на ревью", RETURN: "Возвращено автору", APPROVE: "Утверждено",
  WITHDRAW: "Отозвано", UNBLOCK: "Предложение закрыто", CONFIRM_ASSESSMENT: "Оценка подтверждена",
};
const actionMessages: Record<DraftAction, string> = {
  submit: "Предложение отправлено на ревью.", return: "Предложение возвращено автору.",
  approve: "Версия утверждена.", withdraw: "Предложение отозвано.", unblock: "Предложение закрыто.",
};
const terminal = (proposal: Proposal) => ["APPROVED", "WITHDRAWN", "CLOSED"].includes(proposal.status);
const eventDate = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });

export function RiskCard({ api, selection, account, participants, onUpdate }: {
  api: Api; selection: Selection; account: Account; participants: Participant[]; onUpdate: Update;
}) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const { riskId, proposal } = selection;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [published, current, history] = await Promise.all([
        ifVisible(api.risk(riskId)), ifVisible(api.draft(riskId)), ifVisible(api.history(riskId)),
      ]);
      let draft = !proposal || current?.versionId === proposal.versionId ? current : null;
      if (!draft && proposal?.author.id === account.id && history) {
        const mine = await api.risks(new URLSearchParams({ view: "mine" }));
        if (mine.view === "mine") draft = mine.items.find((item) => item.versionId === proposal.versionId) ?? null;
      }
      if (!cancelled) setCard({ published, draft, history });
    }
    load().catch((error) => { if (!cancelled) setLoadingError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [api, riskId, proposal, account.id]);

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

  const reload = () => onUpdate(selection, "");
  if (loadingError) return <div role="alert" className="error">{loadingError} <button onClick={reload}>Повторить</button></div>;
  if (!card) return <p role="status">Загружаем карточку…</p>;
  const { published, draft, history } = card;
  const snapshot = published?.snapshot;
  const unblock = published?.unblock;

  return <div className="stack">
    <div className="card-id">ID риска <code>{riskId}</code></div>
    {!published && !draft && !history && <p className="notice" role="status">Карточка больше недоступна.</p>}
    {proposal && !draft && (published || history) && <p className="notice">Предложение вышло из работы. Результат указан в истории.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {conflict && <button onClick={reload}>Обновить карточку</button>}
    {published && snapshot && <section className="panel risk-panel stack">
      <div><div className="section-label">Опубликованная версия</div><h2>{snapshot.title}</h2></div>
      <FieldDetails fields={snapshot} owner={<OwnerName owner={snapshot.owner} />} priority={snapshot.priority} />
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
    {draft && <ProposalCard key={`${draft.versionId}/${draft.revision}`} api={api} account={account} proposal={draft}
      owner={snapshot?.owner} participants={participants} disabled={busy || conflict} history={history}
      onUpdate={onUpdate} onReload={reload} showUnblock={!unblock} />}
    {history && <History history={history} />}
  </div>;
}

function ProposalCard({ api, account, proposal, owner, participants, disabled, history, onUpdate, onReload, showUnblock }: {
  api: Api; account: Account; proposal: Proposal; owner?: PublishedRisk["snapshot"]["owner"]; participants: Participant[];
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
  const assignee = participants.find(({ id }) => id === fields.ownerId);

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
    onUpdate({ riskId, proposal: { ...current, ...result } }, actionMessages[action]);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submit = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "submit";
    if (submit && (!fields.title?.trim() || !fields.cause?.trim() || !fields.possibleEvent?.trim()
      || !fields.productConsequences?.trim() || !fields.ownerId || !fields.likelihood || !fields.impact
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
        <FieldEditor fields={fields} setFields={setFields} participants={participants} currentOwner={owner}
          existingOwnerId={version.fields.ownerId} allowClosure={proposal.kind === "EDIT"} />
        <div className="actions">
          <button className="primary" value="submit">Отправить на ревью</button>
          <button value="save">Сохранить черновик</button>
        </div>
      </fieldset>
    </form> : <FieldDetails fields={version.fields}
      owner={fields.ownerId && owner?.id === fields.ownerId ? <OwnerName owner={owner} />
        : assignee?.displayName ?? (fields.ownerId ? "Участник отключён" : "—")} />}
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
        <small>{event.actor.displayName} · {eventDate.format(new Date(event.occurredAt))}</small>
        {event.comment && <p>{event.comment}</p>}
      </li>)}</ol>}
    {history.publishedVersions.length > 0 && <h3>Утверждённые версии</h3>}
    {history.publishedVersions.slice().reverse().map((snapshot, index, versions) =>
      <details key={snapshot.versionId} className="disclosure">
        <summary>Версия {versions.length - index} · {snapshot.title}</summary>
        <FieldDetails fields={snapshot} owner={<OwnerName owner={snapshot.owner} />} priority={snapshot.priority} />
      </details>)}
  </section>;
}
