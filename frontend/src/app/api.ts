import type { components, operations } from "./api.generated";

type Schemas = components["schemas"];
type Body<Operation extends keyof operations> =
  NonNullable<operations[Operation]["requestBody"]> extends { content: { "application/json": infer Json } }
    ? Json
    : never;

export type Participant = Schemas["Participant"];
export type Account = Schemas["Account"];
export type AccountSettings = Required<Body<"updateAccount">>;
export type TemporaryPassword = Schemas["TemporaryPasswordResult"];
export type Category = Schemas["Category"];
export type RiskState = Schemas["RiskState"];
export type ProposalStatus = Schemas["ProposalStatus"];
export type DraftAction = operations["actOnRiskDraft"]["parameters"]["path"]["action"];
export type Fields = Schemas["ProposalFields"];
export type Identity = Schemas["DraftActionResult"];
export type Proposal = Schemas["Proposal"];
export type Priority = Schemas["Priority"];
export type Assignee = Schemas["Assignee"];
export type PublishedRisk = Schemas["PublishedRisk"];
export type RiskHistory = Schemas["RiskHistory"];
export type RiskGroup = Schemas["RiskGroup"];
export type RiskSummary = Schemas["PublishedRiskSummary"];
export type RiskOccurrence = Schemas["RiskOccurrence"];
export type RiskOccurrencePage = Schemas["RiskOccurrencePage"];
export type RiskOccurrenceContent = Body<"createRiskOccurrence">;
export type RiskList = operations["listRisks"]["responses"][200]["content"]["application/json"];
type Version = Pick<Identity, "versionId" | "revision">;

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

export function createApi(onSessionEnded: () => void, transport: (path: string, init: RequestInit) => Promise<Response> = fetch) {
  async function request<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (method !== "GET") {
      const { token } = await request<Schemas["CsrfToken"]>("/csrf");
      headers.set("X-CSRF-Token", token);
    }
    if (body) headers.set("Content-Type", "application/json");
    const response = await transport(`/api${path}`, {
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

  const riskPath = (id: string) => `/risks/${encodeURIComponent(id)}`;
  const occurrencesPath = (id: string) => `${riskPath(id)}/occurrences`;
  const occurrencePath = (id: string, occurrenceId: string) =>
    `${occurrencesPath(id)}/${encodeURIComponent(occurrenceId)}`;
  return {
    profile: (signal?: AbortSignal) => request<Account>("/me", "GET", undefined, signal),
    signIn: (login: string, password: string) => request<Account>("/session", "POST", { login, password } satisfies Body<"createSession">),
    signOut: () => request<void>("/session", "DELETE"),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<void>("/me/password", "POST", { currentPassword, newPassword } satisfies Body<"changePassword">),
    accounts: () => request<Account[]>("/admin/accounts"),
    createAccount: (fields: Body<"createAccount">) =>
      request<TemporaryPassword>("/admin/accounts", "POST", fields),
    updateAccount: (id: string, settings: AccountSettings) =>
      request<Account>(`/admin/accounts/${id}`, "PATCH", settings),
    resetPassword: (id: string) => request<TemporaryPassword>(`/admin/accounts/${id}/reset-password`, "POST"),
    participants: () => request<Participant[]>("/participants"),
    groups: () => request<RiskGroup[]>("/risk-groups"),
    createGroup: (name: string) =>
      request<RiskGroup>("/admin/risk-groups", "POST", { name } satisfies Body<"createRiskGroup">),
    renameGroup: (id: string, name: string) =>
      request<RiskGroup>(`/admin/risk-groups/${encodeURIComponent(id)}`, "PATCH", { name } satisfies Body<"renameRiskGroup">),
    risks: (query: URLSearchParams, signal?: AbortSignal) =>
      request<RiskList>(`/risks?${query}`, "GET", undefined, signal),
    risk: (id: string) => request<PublishedRisk>(riskPath(id)),
    assign: (id: string, assignment: Body<"updateRiskAssignment">) =>
      request<PublishedRisk>(`${riskPath(id)}/assignment`, "PATCH", assignment),
    changeGroup: (id: string, group: Body<"updateRiskGroup">) =>
      request<PublishedRisk>(`${riskPath(id)}/group`, "PATCH", group),
    history: (id: string) => request<RiskHistory>(`${riskPath(id)}/history`),
    occurrences: (id: string, cursor?: string) =>
      request<RiskOccurrencePage>(occurrencesPath(id) + (cursor === undefined ? "" : `?${new URLSearchParams({ cursor })}`)),
    createOccurrence: (id: string, fields: RiskOccurrenceContent) =>
      request<RiskOccurrence>(occurrencesPath(id), "POST", fields),
    updateOccurrence: (id: string, occurrence: RiskOccurrence, fields: RiskOccurrenceContent) =>
      request<RiskOccurrence>(occurrencePath(id, occurrence.id), "PATCH",
        { ...fields, expectedRevision: occurrence.revision } satisfies Body<"updateRiskOccurrence">),
    deleteOccurrence: (id: string, occurrence: RiskOccurrence) =>
      request<void>(`${occurrencePath(id, occurrence.id)}?expectedRevision=${occurrence.revision}`, "DELETE"),
    draft: (id: string) => request<Proposal>(`${riskPath(id)}/draft`),
    createRisk: () => request<Proposal>("/risks", "POST", {}),
    openDraft: (id: string, expectedPublishedVersionId: string) =>
      request<Proposal>(`${riskPath(id)}/draft`, "POST", { expectedPublishedVersionId } satisfies Body<"openRiskDraft">),
    saveDraft: ({ riskId, versionId, revision }: Proposal, fields: Fields) =>
      request<Proposal>(`${riskPath(riskId)}/draft`, "PATCH", { versionId, expectedRevision: revision, fields } satisfies Body<"saveRiskDraft">),
    act: (id: string, { versionId, revision }: Version, action: DraftAction, comment?: string) =>
      request<Identity>(`${riskPath(id)}/draft/${action}`, "POST", { versionId, expectedRevision: revision, comment } satisfies Body<"actOnRiskDraft">),
    confirm: (id: string, expectedPublishedVersionId: string) =>
      request<PublishedRisk>(`${riskPath(id)}/assessment/confirm`, "POST", { expectedPublishedVersionId } satisfies Body<"confirmRiskAssessment">),
  };
}

export type Api = ReturnType<typeof createApi>;
