"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Accounts } from "./accounts";
import { ApiError, createApi, errorMessage, type Account, type Api, type RiskGroup } from "./api";
import { RiskGroups } from "./risk-groups";
import { Register, type InitialRegister } from "./register";
import { sections, type View } from "./navigation";

type Session = Account | "password" | "guest" | null;

export type InitialPage = {
  session: Session;
  view: View;
  error?: string;
  retry?: boolean;
  accounts?: Account[];
  groups?: RiskGroup[];
  register?: InitialRegister;
};

export function Home({ initial }: { initial: InitialPage }) {
  const [session, setSession] = useState(initial.session);
  const [view, setView] = useState(initial.view);
  const [error, setError] = useState(initial.error ?? "");
  const [signingOut, setSigningOut] = useState(false);
  const endSession = useCallback(() => {
    setSession("guest");
    setView("active");
    setError("");
  }, []);
  const api = useMemo(() => createApi(endSession), [endSession]);

  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await api.signOut();
      endSession();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setError(errorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  if (!session || session === "guest" || session === "password" || session.mustChangePassword) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <Brand />
          {error && <p role="alert" className="error">{error}</p>}
          {!session && (error
            ? <button onClick={() => window.location.reload()}>Повторить загрузку</button>
            : <p role="status">Проверяем сессию…</p>)}
          {session === "guest" && <SignIn api={api} onSuccess={() => window.location.reload()} />}
          {session && session !== "guest" && <>
            <PasswordForm api={api} required onSuccess={() => window.location.reload()} />
            <button className="quiet" disabled={signingOut} onClick={signOut}>Выйти</button>
          </>}
        </div>
      </main>
    );
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Разделы реестра">
          {sections.filter(({ id }) => (id !== "review" || session.isReviewer)
            && (id !== "accounts" || session.isAdmin)).map(({ id, label, icon }) => (
              <a key={id} className={view === id ? "nav-link selected" : "nav-link"}
                aria-current={view === id ? "page" : undefined} href={`/?view=${id}`}>
                <span aria-hidden="true">{icon}</span>{label}
              </a>
            ))}
        </nav>
        <div className="profile">
          <span className="avatar" aria-hidden="true">{session.displayName.slice(0, 1).toUpperCase()}</span>
          <div><strong>{session.displayName}</strong><small>{[
            session.isAdmin && "Администратор", session.isReviewer && "Ревьюер",
          ].filter(Boolean).join(" · ") || "Участник"}</small></div>
          <button className="quiet" onClick={signOut} disabled={signingOut}>Выйти</button>
        </div>
      </aside>
      <main className="content">
        {error && <p role="alert" className="error">{error}</p>}
        {initial.retry && <button onClick={() => window.location.reload()}>Повторить загрузку</button>}
        {view === "accounts" && session.isAdmin && initial.accounts && <Accounts api={api} account={session}
          initialAccounts={initial.accounts} onSessionRevoked={endSession} />}
        {view === "groups" && initial.groups && <RiskGroups api={api} canManage={session.isAdmin}
          initialGroups={initial.groups} />}
        {view === "password" && <div className="panel form-panel">
          <PasswordForm api={api} onSuccess={() => window.location.replace(new URL("/", window.location.href))} />
        </div>}
        {view !== "accounts" && view !== "groups" && view !== "password" && initial.register && <Register initial={initial.register} api={api} account={session}
          view={view} onViewChange={setView} label={sections.find(({ id }) => id === view)!.label} />}
      </main>
    </div>
  );
}

function Brand() {
  return <div className="brand"><span aria-hidden="true" className="brand-mark">◈</span>Реестр рисков</div>;
}

function SignIn({ api, onSuccess }: { api: Api; onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api.signIn(String(data.get("login")), String(data.get("password")));
      onSuccess();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <h1>Вход в реестр</h1>
    <form className="stack" onSubmit={submit}>
      <label>Логин<input name="login" autoComplete="username" required /></label>
      <label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>Войти</button>
    </form>
  </>;
}

function PasswordForm({ api, required, onSuccess }: { api: Api; required?: boolean; onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("newPassword"));
    setError("");
    if (password !== data.get("repeatPassword")) {
      setError("Новые пароли не совпадают.");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(String(data.get("currentPassword")), password);
      form.reset();
      onSuccess();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <h1>{required ? "Смена временного пароля" : "Смена пароля"}</h1>
    {required && <p className="muted">Задайте новый пароль, чтобы открыть реестр.</p>}
    <form className="stack" onSubmit={submit}>
      <label>{required ? "Временный пароль" : "Текущий пароль"}
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label>Новый пароль<input name="newPassword" type="password" autoComplete="new-password" required /></label>
      <label>Повторите новый пароль<input name="repeatPassword" type="password" autoComplete="new-password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>Сохранить пароль</button>
    </form>
  </>;
}
