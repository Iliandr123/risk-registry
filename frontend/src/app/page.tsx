import { headers } from "next/headers";
import { ApiError, createApi, errorMessage } from "./api";
import { Home, type InitialPage } from "./home";
import { readCard } from "./read-card";
import { registerUrl, sections, type Query } from "./navigation";
import { upstream } from "./upstream";

export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const view = sections.find((section) => section.id === query.view)?.id ?? "active";
  const requestHeaders = await headers();
  const api = createApi(() => {}, (path, init) => upstream(path, init, requestHeaders));

  let initial: InitialPage = { session: null, view };
  try {
    const account = await api.profile();
    initial = { session: account, view };
    if ((view === "review" && !account.isReviewer) || (view === "accounts" && !account.isAdmin)) {
      initial = { ...initial, error: "Раздел недоступен для вашей роли." };
    } else if (view === "accounts") {
      initial.accounts = await api.accounts();
    } else if (view === "groups") {
      initial.groups = await api.groups();
    } else if (view !== "password") {
      const listQuery = registerUrl(view, query);
      const [list, participants, groups] = await Promise.all([
        api.risks(listQuery), api.participants(), api.groups(),
      ]);
      initial.register = { list, participants, groups, filters: Object.fromEntries(listQuery) };
      if (typeof query.risk === "string") {
        const proposal = (list.view === "mine" || list.view === "review")
          ? list.items.find((item) => item.riskId === query.risk && item.versionId === query.version)
          : undefined;
        if (list.view === "active" || list.view === "archive" || proposal || query.version === undefined) {
          const selection = { riskId: query.risk, proposal };
          const card = await readCard(api, selection, account.id);
          if (list.view === "active" || list.view === "archive" || proposal || card.published) {
            initial.register.card = card;
            initial.register.selection = selection;
          } else {
            initial.error = "Опубликованная карточка недоступна.";
          }
        } else {
          initial.error = "Предложение больше недоступно в этом разделе.";
        }
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) initial = { session: "guest", view };
    else if (error instanceof ApiError && error.code === "PASSWORD_CHANGE_REQUIRED") initial = { session: "password", view };
    else initial = { ...initial, error: errorMessage(error), retry: true };
  }
  return <Home initial={initial} />;
}
