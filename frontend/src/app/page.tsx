"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Accounts } from "./accounts";
import { ApiError, createApi, errorMessage, type Account, type Api } from "./api";
import { Register, type RegisterView } from "./register";

type View = RegisterView | "accounts" | "password";
type Session = Account | "password" | "guest" | null;

const sections: { id: View; label: string; icon: string }[] = [
  { id: "active", label: "Активные риски", icon: "▤" },
  { id: "mine", label: "Мои предложения", icon: "▱" },
  { id: "review", label: "На ревью", icon: "✓" },
  { id: "archive", label: "Архив", icon: "▣" },
  { id: "accounts", label: "Участники", icon: "♙" },
  { id: "password", label: "Сменить пароль", icon: "⚿" },
];

export default function Home() {
  const [session, setSession] = useState<Session>(null);
  const [view, setView] = useState<View>("active");
  const [navigation, setNavigation] = useState(0);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const endSession = useCallback(() => {
    setSession("guest");
    setView("active");
    setError("");
  }, []);
  const api = useMemo(() => createApi(endSession), [endSession]);

  const loadProfile = useCallback((signal?: AbortSignal) => api.profile(signal).then((account) => {
    if (signal?.aborted) return;
    setSession(account);
    setError("");
  }).catch((error) => {
    if (signal?.aborted) return;
    if (error instanceof ApiError && error.status === 401) endSession();
    else if (error instanceof ApiError && error.code === "PASSWORD_CHANGE_REQUIRED") {
      setError("");
      setSession("password");
    } else setError(errorMessage(error));
  }), [api, endSession]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProfile(controller.signal);
    return () => controller.abort();
  }, [loadProfile]);

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
            ? <button onClick={() => void loadProfile()}>Повторить загрузку</button>
            : <p role="status">Проверяем сессию…</p>)}
          {session === "guest" && <SignIn api={api} onSuccess={setSession} />}
          {session && session !== "guest" && <>
            <PasswordForm api={api} required onSuccess={loadProfile} />
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
              <button key={id} className={view === id ? "nav-link selected" : "nav-link"}
                aria-current={view === id ? "page" : undefined} onClick={() => {
                  setView(id);
                  setNavigation((previous) => previous + 1);
                }}>
                <span aria-hidden="true">{icon}</span>{label}
              </button>
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
        {view === "accounts" && session.isAdmin && <Accounts api={api} account={session} onSessionRevoked={endSession} />}
        {view === "password" && <div className="panel form-panel">
          <PasswordForm api={api} onSuccess={async () => { await loadProfile(); setView("active"); }} />
        </div>}
        {view !== "accounts" && view !== "password" && <Register key={navigation} api={api} account={session}
          view={view} onViewChange={setView} label={sections.find(({ id }) => id === view)!.label} />}
      </main>
    </div>
  );
}

function Brand() {
  return <div className="brand"><span aria-hidden="true" className="brand-mark">◈</span>Реестр рисков</div>;
}

function SignIn({ api, onSuccess }: { api: Api; onSuccess: (account: Account) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      onSuccess(await api.signIn(String(data.get("login")), String(data.get("password"))));
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

function PasswordForm({ api, required, onSuccess }: { api: Api; required?: boolean; onSuccess: () => Promise<void> }) {
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
      await onSuccess();
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
