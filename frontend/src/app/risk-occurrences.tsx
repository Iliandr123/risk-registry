import { useState, type FormEvent } from "react";
import { ApiError, errorMessage, type Account, type Api, type RiskOccurrence, type RiskOccurrencePage } from "./api";

const utcDate = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
});

export function RiskOccurrences({ api, riskId, account, active, initial, onReload }: {
  api: Api; riskId: string; account: Account; active: boolean; initial: RiskOccurrencePage; onReload: () => void;
}) {
  const [page, setPage] = useState(initial);
  const [editor, setEditor] = useState<{ occurrence?: RiskOccurrence; text: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const locked = busy || reloadRequired;
  const { nextCursor } = page;

  function edit(occurrence?: RiskOccurrence) {
    setError("");
    setEditor({ occurrence, text: occurrence?.text ?? "", url: occurrence?.url ?? "" });
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && (error.code === "RISK_CONFLICT" || error.status === 404)) {
        setReloadRequired(true);
      }
    } finally {
      setBusy(false);
    }
  }

  function mutate(operation: () => Promise<unknown>) {
    if (!active || locked) return;
    void run(async () => {
      await operation();
      setEditor(null);
      try {
        setPage(await api.occurrences(riskId));
      } catch {
        setError("Изменение сохранено. Не удалось обновить список случаев.");
        setReloadRequired(true);
      }
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || locked) return;
    const text = editor.text.trim() ? editor.text : null;
    const url = editor.url.trim() || null;
    const fields = text ? { text, url } : url ? { text, url } : null;
    if (!fields) {
      setError("Введите описание случая или ссылку.");
      return;
    }
    if (url && (!/^https?:\/\/[^/\s?#]/i.test(url)
      || !URL.canParse(url) || !new URL(url).hostname)) {
      setError("Укажите абсолютную ссылку HTTP или HTTPS.");
      return;
    }
    const { occurrence } = editor;
    mutate(() => occurrence ? api.updateOccurrence(riskId, occurrence, fields) : api.createOccurrence(riskId, fields));
  }

  function loadMore(cursor: string) {
    if (locked) return;
    void run(async () => {
      const next = await api.occurrences(riskId, cursor);
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor });
    });
  }

  return <section className="panel risk-panel stack" aria-labelledby="risk-occurrences-heading">
    <h2 id="risk-occurrences-heading">Случаи проявления риска</h2>
    {active && !editor && <button disabled={locked} onClick={() => edit()}>Добавить случай</button>}
    {active && editor && <form onSubmit={save}>
      <fieldset className="stack" disabled={locked}>
        <legend>{editor.occurrence ? "Исправление случая" : "Новый случай"}</legend>
        <label>Описание случая
          <textarea rows={3} value={editor.text} onChange={(event) => setEditor({ ...editor, text: event.target.value })} />
        </label>
        <label>Ссылка на случай
          <input inputMode="url" value={editor.url} onChange={(event) => setEditor({ ...editor, url: event.target.value })} />
        </label>
        <div className="actions">
          <button className="primary">Сохранить случай</button>
          <button type="button" onClick={() => { setEditor(null); setError(""); }}>Отмена</button>
        </div>
      </fieldset>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {reloadRequired && <button onClick={onReload}>Обновить карточку</button>}
    {page.items.length === 0 && <p className="muted">Случаев пока нет.</p>}
    {page.items.length > 0 && <ul className="occurrences">{page.items.map((occurrence) =>
      <li key={occurrence.id} className="stack">
        <small className="muted">{occurrence.author.displayName} ·{" "}
          <time dateTime={occurrence.createdAt}>{utcDate.format(new Date(occurrence.createdAt))} UTC</time>
        </small>
        {occurrence.text && <p>{occurrence.text}</p>}
        {occurrence.url && <a href={occurrence.url} target="_blank" rel="noreferrer">{occurrence.url}</a>}
        {active && (account.id === occurrence.author.id || account.isReviewer || account.isAdmin) &&
          <div className="actions">
            <button disabled={locked || !!editor} onClick={() => edit(occurrence)}>Исправить</button>
            <button disabled={locked || !!editor} onClick={() => {
              if (window.confirm("Удалить случай проявления риска?")) mutate(() => api.deleteOccurrence(riskId, occurrence));
            }}>Удалить</button>
          </div>}
      </li>)}</ul>}
    {nextCursor && <button disabled={locked} onClick={() => loadMore(nextCursor)}>
      Загрузить ещё случаи
    </button>}
  </section>;
}
