import { useId, useState, type FormEvent } from "react";
import { errorMessage, type Api, type RiskGroup } from "./api";

export const noGroup = "Без группы";
const groupNames = new Intl.Collator("ru");

export function byGroupName(left: RiskGroup, right: RiskGroup) {
  return groupNames.compare(left.name, right.name);
}

export function GroupOptions({ groups }: { groups: RiskGroup[] }) {
  return groups.toSorted(byGroupName).map(({ id, name }) => <option key={id} value={id}>{name}</option>);
}

export function GroupSelect({ groups, value, onChange }: {
  groups: RiskGroup[]; value: string | null; onChange: (value: string | null) => void;
}) {
  const labelId = useId();
  return <label><span id={labelId}>Группа риска</span>
    <select aria-labelledby={labelId} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{noGroup}</option>
      <GroupOptions groups={groups} />
    </select>
  </label>;
}

export function RiskGroups({ api, canManage, initialGroups }: {
  api: Api; canManage: boolean; initialGroups: RiskGroup[];
}) {
  const [groups, setGroups] = useState(initialGroups);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function save(group: RiskGroup) {
    setGroups((current) => [...current.filter(({ id }) => id !== group.id), group]);
    setEditing(null);
    setMessage("Группа сохранена.");
  }

  return <>
    <header className="page-header"><h1>Группы рисков</h1></header>
    {canManage && <section className="panel form-panel stack">
      <h2>Новая группа</h2>
      <GroupNameForm label="Название новой группы" action="Создать группу"
        onSave={async (name) => save(await api.createGroup(name))} />
    </section>}
    {message && <p className="notice" role="status">{message}</p>}
    {groups.length === 0 ? <div className="panel empty"><p>Групп пока нет.</p></div> :
      <div className="stack">{groups.toSorted(byGroupName).map((group) =>
        <section key={group.id} className="panel account-row">
          <h2>{group.name}</h2>
          {canManage && (editing === group.id
            ? <GroupNameForm label="Новое название" action="Сохранить название" initialName={group.name}
                onSave={async (name) => save(await api.renameGroup(group.id, name))} onCancel={() => setEditing(null)} />
            : <button onClick={() => { setEditing(group.id); setMessage(""); }}>Переименовать</button>)}
        </section>)}</div>}
  </>;
}

function GroupNameForm({ label, action, initialName = "", onSave, onCancel }: {
  label: string; action: string; initialName?: string;
  onSave: (name: string) => Promise<void>; onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Введите название группы.");
      return;
    }
    setBusy(true);
    try {
      await onSave(name);
      setName("");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={submit}>
    <fieldset className="stack" disabled={busy}>
      <label>{label}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button className="primary">{action}</button>
        {onCancel && <button type="button" onClick={onCancel}>Отмена</button>}
      </div>
    </fieldset>
  </form>;
}
