export type Participant = { id: string; displayName: string };
export type Account = Participant & {
  login: string;
  active: boolean;
  isAdmin: boolean;
  isReviewer: boolean;
  mustChangePassword: boolean;
};
export type AccountSettings = Pick<Account, "active" | "isAdmin" | "isReviewer">;
export type TemporaryPassword = { account: Account; temporaryPassword: string };

export type Category = "LOW" | "MEDIUM" | "HIGH";
export type RiskState = "ACTIVE" | "REMOVED" | "MATERIALIZED";
export type ProposalStatus = "DRAFT" | "IN_REVIEW" | "RETURNED" | "APPROVED" | "WITHDRAWN" | "CLOSED";
export type DraftAction = "submit" | "return" | "approve" | "withdraw" | "unblock";

export type Fields = {
  title: string | null;
  cause: string | null;
  possibleEvent: string | null;
  productConsequences: string | null;
  ownerId: string | null;
  likelihood: number | null;
  impact: number | null;
  decisionNote: string | null;
  trackerUrl: string | null;
  riskState: RiskState;
  closureReason: string | null;
};

type Version = { versionId: string; revision: number };
export type Identity = Version & { riskId: string; status: ProposalStatus };
export type Proposal = Identity & { kind: "FIRST" | "EDIT"; author: Participant; fields: Fields };
export type Priority = { score: number; category: Category; criticalImpact: boolean };
export type Owner = Participant & { active: boolean };
type Snapshot = Omit<Fields, "ownerId"> & {
  versionId: string;
  title: string;
  owner: Owner;
  likelihood: number;
  impact: number;
  priority: Priority;
};
export type Assessment = { date: string; reviewDueDate: string; reviewRequired: boolean };
export type PublishedRisk = {
  riskId: string;
  snapshot: Snapshot;
  assessment: Assessment;
  hasOpenDraft: boolean;
  unblock?: Version & { authorDisplayName: string };
};
export type RiskSummary = Pick<Snapshot, "title" | "owner" | "likelihood" | "impact" | "priority" | "riskState">
  & Pick<PublishedRisk, "riskId" | "assessment" | "hasOpenDraft"> & { publishedVersionId: string };
export type RiskHistory = {
  publishedVersions: Snapshot[];
  events: {
    versionId: string;
    actor: Participant;
    action: "SUBMIT" | "RETURN" | "APPROVE" | "WITHDRAW" | "UNBLOCK" | "CONFIRM_ASSESSMENT";
    occurredAt: string;
    comment?: string | null;
  }[];
};
export type RiskList = { view: "active" | "archive"; items: RiskSummary[] }
  | { view: "mine" | "review"; items: Proposal[] };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "Не удалось связаться с сервером. Повторите попытку.";
}

export async function ifVisible<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function createApi(onSessionEnded: () => void) {
  async function request<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (method !== "GET") {
      const { token } = await request<{ token: string }>("/csrf");
      headers.set("X-CSRF-Token", token);
    }
    if (body) headers.set("Content-Type", "application/json");
    const response = await fetch(`/api${path}`, {
      method, headers, body: body && JSON.stringify(body), signal, cache: "no-store",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 401 && path !== "/me" && !(path === "/session" && method === "POST")) {
        onSessionEnded();
      }
      throw new ApiError(response.status, error.code ?? "", error.message ?? "Сервер не смог выполнить запрос.");
    }
    return response.status === 204 ? undefined as T : response.json();
  }

  const riskPath = (id: string) => `/risks/${id}`;
  return {
    profile: (signal?: AbortSignal) => request<Account>("/me", "GET", undefined, signal),
    signIn: (login: string, password: string) => request<Account>("/session", "POST", { login, password }),
    signOut: () => request<void>("/session", "DELETE"),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<void>("/me/password", "POST", { currentPassword, newPassword }),
    accounts: () => request<Account[]>("/admin/accounts"),
    createAccount: (fields: Pick<Account, "login" | "displayName" | "isAdmin" | "isReviewer">) =>
      request<TemporaryPassword>("/admin/accounts", "POST", fields),
    updateAccount: (id: string, settings: AccountSettings) =>
      request<Account>(`/admin/accounts/${id}`, "PATCH", settings),
    resetPassword: (id: string) => request<TemporaryPassword>(`/admin/accounts/${id}/reset-password`, "POST"),
    participants: () => request<Participant[]>("/participants"),
    risks: (query: URLSearchParams, signal?: AbortSignal) =>
      request<RiskList>(`/risks?${query}`, "GET", undefined, signal),
    risk: (id: string) => request<PublishedRisk>(riskPath(id)),
    history: (id: string) => request<RiskHistory>(`${riskPath(id)}/history`),
    draft: (id: string) => request<Proposal>(`${riskPath(id)}/draft`),
    createRisk: () => request<Proposal>("/risks", "POST", {}),
    openDraft: (id: string, expectedPublishedVersionId: string) =>
      request<Proposal>(`${riskPath(id)}/draft`, "POST", { expectedPublishedVersionId }),
    saveDraft: ({ riskId, versionId, revision }: Proposal, fields: Fields) =>
      request<Proposal>(`${riskPath(riskId)}/draft`, "PATCH", { versionId, expectedRevision: revision, fields }),
    act: (id: string, { versionId, revision }: Version, action: DraftAction, comment?: string) =>
      request<Identity>(`${riskPath(id)}/draft/${action}`, "POST", { versionId, expectedRevision: revision, comment }),
    confirm: (id: string, expectedPublishedVersionId: string) =>
      request<PublishedRisk>(`${riskPath(id)}/assessment/confirm`, "POST", { expectedPublishedVersionId }),
  };
}

export type Api = ReturnType<typeof createApi>;
