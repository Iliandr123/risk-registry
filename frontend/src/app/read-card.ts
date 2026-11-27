import { ifVisible, type Api, type Proposal, type PublishedRisk, type RiskHistory, type RiskOccurrencePage } from "./api";

export type Selection = { riskId: string; proposal?: Proposal };
export type Card =
  { draft: Proposal | null; history: RiskHistory | null }
  & ({ published: PublishedRisk; occurrences: RiskOccurrencePage } | { published: null; occurrences: null });

export async function readCard(api: Api, { riskId, proposal }: Selection, accountId: string): Promise<Card> {
  const [published, current, history] = await Promise.all([
    ifVisible(api.risk(riskId)), ifVisible(api.draft(riskId)), ifVisible(api.history(riskId)),
  ]);
  let draft = !proposal || current?.versionId === proposal.versionId ? current : null;
  if (!draft && proposal?.author.id === accountId && history) {
    const mine = await api.risks(new URLSearchParams({ view: "mine" }));
    if (mine.view === "mine") draft = mine.items.find((item) => item.versionId === proposal.versionId) ?? null;
  }
  if (!published) return { published, draft, history, occurrences: null };
  return { published, draft, history, occurrences: await api.occurrences(riskId) };
}
