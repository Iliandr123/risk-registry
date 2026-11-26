import { useEffect, useState } from "react";
import { errorMessage, type Account, type Api, type Owner, type Participant, type RiskList } from "./api";
import { RiskCard } from "./risk-card";
import type { Card, Selection } from "./read-card";
import { registerUrl, type RegisterView } from "./navigation";
import { categories, dateLabel, OwnerName, PriorityBadge, proposalStatuses, riskStates } from "./risk-fields";

export type InitialRegister = {
  list: RiskList;
  participants: Participant[];
  filters: Record<string, string>;
  selection?: Selection;
  card?: Card;
};

export function Register({ api, account, view, onViewChange, label, initial }: {
  api: Api; account: Account; view: RegisterView; onViewChange: (view: RegisterView) => void; label: string;
  initial: InitialRegister;
}) {
  const filters = initial.filters;
  const [selection, setSelection] = useState<Selection | null>(initial.selection ?? null);
  const [participants, setParticipants] = useState(initial.participants);
  const [list, setList] = useState(initial.list);
  const [knownOwners, setKnownOwners] = useState<Map<string, Owner>>(new Map());
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [message, setMessage] = useState("");
  const [period, setPeriod] = useState(0);
  const [cardPeriod, setCardPeriod] = useState(0);
  const [creating, setCreating] = useState(false);
  const publishedView = view === "active" || view === "archive";

  useEffect(() => {
    if (period === 0) return;
    let cancelled = false;
    api.participants().then((items) => { if (!cancelled) setParticipants(items); })
      .catch((error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [api, period]);

  useEffect(() => {
    if (period === 0) return;
    const controller = new AbortController();
    const query = registerUrl(view, filters);
    api.risks(query, controller.signal).then((data) => {
      if (!controller.signal.aborted) {
        setList(data);
        setListError("");
        if (data.view === "active" || data.view === "archive") {
          const owners = data.items.map(({ owner }) => [owner.id, owner] as const);
          setKnownOwners((previous) => new Map([...previous, ...owners]));
        }
      }
    }).catch((error) => {
      if (!controller.signal.aborted) setListError(errorMessage(error));
    });
    return () => controller.abort();
  }, [api, view, filters, period]);

  async function createRisk() {
    setError("");
    setCreating(true);
    try {
      const proposal = await api.createRisk();
      onViewChange("mine");
      setSelection({ riskId: proposal.riskId, proposal });
      setMessage("Черновик создан.");
      setPeriod((previous) => previous + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function update(next: Selection, message: string, refreshCard = true) {
    setSelection(next);
    setMessage(message);
    setPeriod((previous) => previous + 1);
    if (refreshCard) setCardPeriod((previous) => previous + 1);
  }

  function riskLink(riskId?: string, versionId?: string) {
    const query = registerUrl(view, filters);
    if (riskId) query.set("risk", riskId);
    if (versionId) query.set("version", versionId);
    return `/?${query}`;
  }

  const currentList = list.view === view ? list : null;
  const owners = new Map(Array.from(knownOwners, ([id, owner]) => [
    id, owner.displayName + (owner.active ? "" : " (Отключён)"),
  ]));
  if (currentList?.view === "active" || currentList?.view === "archive") {
    for (const { owner } of currentList.items) {
      owners.set(owner.id, owner.displayName + (owner.active ? "" : " (Отключён)"));
    }
  }
  for (const { id, displayName } of participants) owners.set(id, displayName);
  if (filters.ownerId && !owners.has(filters.ownerId)) owners.set(filters.ownerId, "Выбранный владелец");

  return <>
    <header className="page-header">
      <h1>{label}</h1>
      {!selection && <button className="primary" onClick={createRisk} disabled={creating}>＋ Предложить риск</button>}
    </header>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {selection ? <>
      {initial.selection && <a className="quiet back" href={riskLink()}>← К списку</a>}
      {!initial.selection && <button className="quiet back" onClick={() => { setSelection(null); setMessage(""); }}>← К списку</button>}
      <RiskCard key={`${selection.riskId}/${selection.proposal?.versionId ?? "published"}/${cardPeriod}`}
        initial={cardPeriod === 0 && selection === initial.selection ? initial.card : undefined}
        api={api} selection={selection} account={account} participants={participants} onUpdate={update} />
    </> : <>
      {publishedView && <form className="panel filters" method="get" action="/" key={view}>
        <input type="hidden" name="view" value={view} />
        <label>Поиск<input name="q" type="search" placeholder="Название или описание" defaultValue={filters.q} /></label>
        <label><span id="filter-owner">Владелец</span><select aria-labelledby="filter-owner" name="ownerId" defaultValue={filters.ownerId}>
          <option value="">Все владельцы</option>
          {Array.from(owners, ([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label><span id="filter-category">Категория</span><select aria-labelledby="filter-category" name="category" defaultValue={filters.category}>
          <option value="">Все категории</option>
          {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <button className="primary">Найти</button>
      </form>}
      {listError && <div className="error" role="alert">{listError}{" "}
        <button onClick={() => { setListError(""); setPeriod(period + 1); }}>Повторить</button>
      </div>}
      {!currentList && !listError && <p role="status">Загружаем список…</p>}
      {currentList?.items.length === 0 && <div className="panel empty">
        <h2>{view === "review" ? "Очередь пуста" : "Записей пока нет"}</h2>
        {publishedView && ["q", "ownerId", "category"].some((key) => filters[key]) && <p className="muted">Попробуйте изменить поиск или фильтры.</p>}
      </div>}
      {(currentList?.view === "active" || currentList?.view === "archive") && currentList.items.length > 0 &&
        <div className="panel table-wrap">
          <table aria-label={label}>
            <thead><tr><th>Риск</th><th>Владелец</th><th>Вероятность</th><th>Влияние</th><th>Приоритет</th>
              <th>Дата оценки</th><th>{view === "archive" ? "Состояние" : "Пересмотр"}</th></tr></thead>
            <tbody>{currentList.items.map((item) => <tr key={item.riskId}>
              <th scope="row"><a className="text-button" href={riskLink(item.riskId)}>{item.title}</a>{item.hasOpenDraft && <small>Правка в работе</small>}</th>
              <td><OwnerName owner={item.owner} /></td>
              <td>{item.likelihood}</td><td>{item.impact}</td>
              <td><PriorityBadge priority={item.priority} /></td>
              <td>{dateLabel(item.assessment.date)}</td>
              <td>{view === "archive" ? riskStates[item.riskState] : <>
                {dateLabel(item.assessment.reviewDueDate)}
                {item.assessment.reviewRequired && <small className="overdue">Требует пересмотра</small>}
              </>}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      {(currentList?.view === "mine" || currentList?.view === "review") && currentList.items.length > 0 &&
        <div className="panel table-wrap">
          <table aria-label={label}>
            <thead><tr><th>Предложение</th><th>Вид</th><th>Автор</th><th>Статус</th></tr></thead>
            <tbody>{currentList.items.map((proposal) => <tr key={proposal.versionId}>
              <th scope="row"><a className="text-button" href={riskLink(proposal.riskId, proposal.versionId)}>
                {proposal.fields.title || "Без названия"}</a></th>
              <td>{proposal.kind === "FIRST" ? "Новый риск" : "Правка"}</td>
              <td>{proposal.author.displayName}</td><td><span className="badge">{proposalStatuses[proposal.status]}</span></td>
            </tr>)}</tbody>
          </table>
        </div>}
    </>}
  </>;
}
