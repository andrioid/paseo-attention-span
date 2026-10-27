import type { PluginServerContext } from "@getpaseo/plugin/server";
import { claimIssue, closePullRequest, mergePullRequest, updateBranch } from "./server/actions";
import { sessionContext } from "./server/context";
import { FIXTURE_CONTEXT } from "./server/fixture";
import { FIXTURE } from "./server/gh";
import { InboxService } from "./server/service";
import * as rpc from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const inbox = new InboxService();
  const started = inbox.start().catch((error) => console.error("Inbox failed to start:", error));
  const ready = <T>(work: () => Promise<T>) => started.then(work);

  // After a change on GitHub, refresh in the background so the list catches up.
  const thenRefresh = async (work: Promise<void>) => {
    await work;
    void inbox.refresh().catch(() => {});
    return { ok: true as const };
  };

  server.handle(rpc.getInbox, ({ maxAgeSeconds }) => ready(() => inbox.get(maxAgeSeconds)));
  server.handle(rpc.dismissItem, ({ key }) => ready(() => inbox.dismiss(key)));
  server.handle(rpc.restoreDismissed, () => ready(() => inbox.restoreDismissed()));
  server.handle(rpc.updateBranch, ({ target }) => thenRefresh(updateBranch(target)));
  server.handle(rpc.mergePullRequest, ({ target }) => thenRefresh(mergePullRequest(target)));
  server.handle(rpc.closePullRequest, ({ target, comment }) => thenRefresh(closePullRequest(target, comment)));
  server.handle(rpc.claimIssue, ({ target }) => thenRefresh(claimIssue(target)));
  server.handle(rpc.sessionContext, async ({ kind, target }) => ({ context: FIXTURE ? FIXTURE_CONTEXT : await sessionContext(kind, target) }));

  return () => inbox.stop();
}
