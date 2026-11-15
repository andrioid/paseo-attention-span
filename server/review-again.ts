import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { reviewAgain, type Target } from "../shared/attention";

type Paseo = PluginHandlerContext["paseo"];

// What pressing Review again on an open Review session did: sent it the follow-up, found it busy, had sent this one
// already, or found nothing asked again [REV-02].
export type FollowUpOutcome = "sent" | "busy" | "already" | "none";

// Which re-request a target stands for: each PR asked again, with its head and my last review. A new push or a new review
// of mine makes it another one; null when nothing is asked again [REV-02].
export function followUpMark(target: Pick<Target, "stack">): string | null {
  const prs = reviewAgain(target);
  return prs.length ? prs.map((pr) => `${pr.number}@${pr.reviewed!.head}:${pr.reviewed!.at}`).join(",") : null;
}

// A session mid-turn, starting up, or waiting on a permission isn't sent anything; its own snapshot says, fresh from Paseo.
export async function sendFollowUp(paseo: Paseo, agentId: string, prompt: () => Promise<string>): Promise<"sent" | "busy"> {
  const agent = paseo.agents.ref(agentId);
  const snapshot = (await agent.refresh())?.agent;
  if (!snapshot) throw new Error("The review session wasn't found");
  if (snapshot.status === "running" || snapshot.status === "initializing" || (snapshot.pendingPermissions?.length ?? 0) > 0) return "busy";
  await agent.send(await prompt());
  return "sent";
}
