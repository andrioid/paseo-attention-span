import type { Item } from "../shared/attention";
import type { CardProps } from "./card";

// What the card is: open, draft, merged or closed. Urgency stays in the chips and section headers.
// A note on what someone else did shows what happened instead; its words say it too, so color isn't the only sign [HIS-07].
export function stateMark(item: Item): CardProps["mark"] {
  if (item.section === "reviewed" || item.wrap?.review) return { icon: "review", tone: "neutral" };
  if (item.change) {
    const kind = item.change.kind;
    if (kind === "merged") return { icon: "merge", tone: "good" };
    if (kind === "closed") return { icon: "prClosed", tone: "bad" };
    if (kind === "issue_closed") return item.change.reason === "not_planned" ? { icon: "close", tone: "bad" } : { icon: "issueClosed", tone: "good" };
    if (kind === "reopened") return { icon: "pr", tone: "warn" };
    return { icon: kind === "unassigned" ? "userMinus" : "userShare", tone: "warn" };
  }
  if (item.closedAt) return item.kind === "pr" ? { icon: "merge", tone: "good" } : { icon: "issueClosed", tone: item.chips.length ? "neutral" : "good" };
  if (item.kind === "issue") return { icon: "issue", tone: "good" };
  return item.draft ? { icon: "draft", tone: "neutral" } : { icon: "pr", tone: "good" };
}
