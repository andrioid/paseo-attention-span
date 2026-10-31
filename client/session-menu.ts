import type { AgentSummary, Chip } from "../shared/attention";
import { ago } from "../shared/format";
import type { MenuGroup, SheetEntry } from "./sheet";

// A session started from the item, as a signal [ATT-07].
export function agentSignal(agent: AgentSummary): Chip {
  if (agent.requiresAttention) return { text: "agent needs you", tone: "warn" };
  if (agent.status === "running" || agent.status === "initializing") return { text: "agent working", tone: "good" };
  if (agent.status === "error") return { text: "agent failed", tone: "bad" };
  return { text: "agent idle", tone: "neutral" };
}

// "needs you · 2h ago"
export function sessionStatus(agent: AgentSummary): string {
  const status = agentSignal(agent).text.replace(/^agent /, "");
  return agent.lastActivityAt ? `${status} · ${ago(agent.lastActivityAt)} ago` : status;
}

// With a session open, the item's main action opens it; ▾ picks another or starts a new one [SES-03].
export function openSessionEntry(sessions: AgentSummary[], onOpen: (agentId: string) => void, onMenu: SheetEntry["menu"]): SheetEntry {
  const first = sessions[0];
  return {
    key: "session",
    icon: "agent",
    label: "Open session",
    detail: `${first.title ?? "Session"} · ${sessionStatus(first)}`,
    onPress: () => onOpen(first.id),
    menu: onMenu,
  };
}

// Every open session; the first is the one Open session opens.
export function sessionsGroup(sessions: AgentSummary[], onOpen: (agentId: string) => void): MenuGroup {
  return {
    title: "Sessions",
    entries: sessions.map((agent, index) => ({
      key: agent.id,
      icon: "agent",
      label: agent.title ?? "Session",
      detail: sessionStatus(agent),
      checked: index === 0,
      onPress: () => onOpen(agent.id),
    })),
  };
}
