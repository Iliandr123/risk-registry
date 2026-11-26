import { useState, type FormEvent } from "react";
import { errorMessage, type Account, type AccountSettings, type Api, type TemporaryPassword } from "./api";

export function Accounts({ api, account, initialAccounts, onSessionRevoked }: {
  api: Api; account: Account; initialAccounts: Account[]; onSessionRevoked: () => void;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<TemporaryPassword | null>(null);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function register(updated: Account) {
    setAccounts((current) => current.some(({ id }) => id === updated.id)
      ? current.map((item) => item.id === updated.id ? updated : item)
      : [...current, updated]);
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const result = await api.createAccount({
        login: String(data.get("login")), displayName: String(data.get("displayName")),
        isAdmin: data.has("isAdmin"), isReviewer: data.has("isReviewer"),
      });
      register(result.account);
      setCreating(false);
      setIssued(result);
    });
  }

  return <>
    <header className="page-header"><h1>Участники</h1>
      <button className="primary" disabled={busy || !!issued} onClick={() => setCreating(!creating)}>
        {creating ? "Отмена" : "Добавить участника"}
      </button>
    </header>
    {error && <p role="alert" className="error">{error}</p>}
    {issued && <section className="notice stack" aria-label="Временный пароль">
      <strong>Временный пароль для {issued.account.displayName}</strong>
      <p>Передайте пароль участнику лично. После закрытия он больше не отобразится.</p>
      <code>{issued.temporaryPassword}</code>
      <button onClick={() => {
        setIssued(null);
        if (issued.account.id === account.id) onSessionRevoked();
      }}>Закрыть</button>
    </section>}
    {creating && <form className="panel form-panel stack" onSubmit={create}>
      <h2>Новый участник</h2>
      <fieldset disabled={busy} className="stack">
        <div className="form-grid">
          <label>Имя<input name="displayName" required /></label>
          <label>Логин<input name="login" autoComplete="off" required /></label>
        </div>
        <div className="actions">
          <label className="check"><input type="checkbox" name="isAdmin" />Администратор</label>
          <label className="check"><input type="checkbox" name="isReviewer" />Ревьюер</label>
        </div>
        <button className="primary">Создать аккаунт</button>
      </fieldset>
    </form>}
    <div className="stack">
      {accounts.map((item) => <AccountRow key={JSON.stringify(item)} account={item} disabled={busy || !!issued}
        onSave={(settings) => run(async () => {
          register(await api.updateAccount(item.id, settings));
          if (item.id === account.id) onSessionRevoked();
        })}
        onReset={() => run(async () => {
          const result = await api.resetPassword(item.id);
          register(result.account);
          setIssued(result);
        })} />)}
    </div>
  </>;
}

function AccountRow({ account, disabled, onSave, onReset }: {
  account: Account; disabled: boolean;
  onSave: (settings: AccountSettings) => void; onReset: () => void;
}) {
  const [settings, setSettings] = useState<AccountSettings>({
    active: account.active, isAdmin: account.isAdmin, isReviewer: account.isReviewer,
  });
  const labels = { active: "Активен", isAdmin: "Администратор", isReviewer: "Ревьюер" };
  const keys = Object.keys(labels) as (keyof AccountSettings)[];
  return <form className="panel account-row" onSubmit={(event) => { event.preventDefault(); onSave(settings); }}>
    <div><strong>{account.displayName}</strong><small>{account.login}{account.active ? "" : " · Отключён"}</small></div>
    <fieldset className="actions" disabled={disabled}>
      {keys.map((key) => <label key={key} className="check">
        <input type="checkbox" checked={settings[key]}
          onChange={(event) => setSettings({ ...settings, [key]: event.target.checked })} />{labels[key]}
      </label>)}
      <button disabled={keys.every((key) => settings[key] === account[key])}>Сохранить</button>
      <button type="button" onClick={() => {
        if (window.confirm(`Сбросить пароль участника «${account.displayName}» и завершить его сессии?`)) onReset();
      }}>Сбросить пароль</button>
    </fieldset>
  </form>;
}
