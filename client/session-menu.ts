import type { AgentSummary } from "../shared/attention";
import { ago } from "../shared/format";
import { sessionBadge } from "../shared/item-view";
import type { SheetEntry } from "./sheet";

// A session as a sheet line, under the name of what started it: it opens the session, its state at the end [SES-03, ATT-07].
export function sessionEntry(agent: AgentSummary, label: string, onOpen: (agentId: string) => void): SheetEntry {
  // Non-breaking, so "2h ago" doesn't split across lines beside a badge on phones.
  const when = agent.lastActivityAt ? `${ago(agent.lastActivityAt)} ago`.replace(/ /g, "\u00a0") : null;
  return {
    key: agent.id,
    icon: "agent",
    label,
    detail: [agent.title, when].filter(Boolean).join(" · ") || undefined,
    badge: sessionBadge(agent),
    onPress: () => onOpen(agent.id),
  };
}

// A session no action covers, or another one, only on purpose: quiet, near the end [SES-02, SES-03].
export function startAnotherEntry(any: boolean, onPress: () => void): SheetEntry {
  return {
    key: "start-another",
    icon: "plus",
    label: any ? "Start another session…" : "Start a session…",
    detail: "Pick the workspace, agent profile and prompt",
    quiet: true,
    onPress,
  };
}
