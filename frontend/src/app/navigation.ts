import type { RiskList } from "./api";

export type RegisterView = RiskList["view"];
export type View = RegisterView | "accounts" | "password";
export type Query = Record<string, string | string[] | undefined>;

export const sections: { id: View; label: string; icon: string }[] = [
  { id: "active", label: "Активные риски", icon: "▤" },
  { id: "mine", label: "Мои предложения", icon: "▱" },
  { id: "review", label: "На ревью", icon: "✓" },
  { id: "archive", label: "Архив", icon: "▣" },
  { id: "accounts", label: "Участники", icon: "♙" },
  { id: "password", label: "Сменить пароль", icon: "⚿" },
];

export function registerUrl(view: RegisterView, query: Query) {
  const params = new URLSearchParams({ view });
  if (view === "active" || view === "archive") {
    for (const name of ["q", "assignee", "category"]) {
      const value = query[name];
      if (typeof value !== "string" || !value.trim()) continue;
      if (view === "archive" && name === "assignee" && value.trim() === "needs-assignment") continue;
      params.set(name, value.trim());
    }
  }
  return params;
}
