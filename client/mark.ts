import type { Item, PrState, SubRow } from "../shared/attention";
import type { CardProps } from "./card";

// A PR's own state, shared by card marks and linked stack rows [ATT-05, ATT-06].
const PR_MARKS: Record<PrState, CardProps["mark"]> = {
  OPEN: { icon: "pr", tone: "good" },
  DRAFT: { icon: "draft", tone: "neutral" },
  CLOSED: { icon: "prClosed", tone: "bad" },
  MERGED: { icon: "merge", tone: "good", color: "PURPLE" },
};

export const prStateMark = (state: PrState) => PR_MARKS[state];

// A parent issue's closure says nothing about the state of its individual PRs.
export function stackMark(row: Pick<SubRow, "state" | "draft" | "mergedAt">): CardProps["mark"] {
  return prStateMark(row.state ?? (row.mergedAt ? "MERGED" : row.draft ? "DRAFT" : "OPEN"));
}

// An issue closed as completed is done like a merged PR, in GitHub's purple; one closed as not planned was set aside.
const issueClosedMark = (notPlanned: boolean): CardProps["mark"] =>
  notPlanned ? { icon: "notPlanned", tone: "neutral" } : { icon: "issueClosed", tone: "good", color: "PURPLE" };

// What the card is: open, draft, merged or closed. Urgency stays in the chips and section headers.
// A note on what someone else did shows what happened instead; its words say it too, so color isn't the only sign [HIS-07].
export function stateMark(item: Item): CardProps["mark"] {
  if (item.section === "reviewed" || item.wrap?.review) return { icon: "review", tone: "neutral" };
  if (item.change) {
    const kind = item.change.kind;
    if (kind === "merged") return prStateMark("MERGED");
    if (kind === "closed") return prStateMark("CLOSED");
    if (kind === "issue_closed") return issueClosedMark(item.change.reason === "not_planned");
    if (kind === "reopened") return { icon: "pr", tone: "warn" };
    return { icon: kind === "unassigned" ? "userMinus" : "userShare", tone: "warn" };
  }
  if (item.kind === "pr" && item.closedUnmerged) return prStateMark("CLOSED");
  if (item.closedAt) return item.kind === "pr" ? prStateMark("MERGED") : issueClosedMark(!!item.notPlanned);
  if (item.kind === "issue") return { icon: "issue", tone: "good" };
  return prStateMark(item.draft ? "DRAFT" : "OPEN");
}
