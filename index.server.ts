import type { PluginServerContext } from "@getpaseo/plugin/server";
import { claimIssue, closePullRequest, mergePullRequest, updateBranch } from "./server/actions";
import { defaultBranch, sessionContext } from "./server/context";
import { FIXTURE_CONTEXT } from "./server/fixture";
import { FIXTURE } from "./server/gh";
import { InboxService } from "./server/service";
import type { FeedId } from "./shared/inbox";
import * as rpc from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const inbox = new InboxService();
  const started = inbox.start().catch((error) => console.error("Inbox failed to start:", error));
  const ready = <T>(work: () => Promise<T>) => started.then(work);

  // After a change on GitHub, refresh in the background so the list catches up. Only a merge changes History.
  const thenRefresh = async (work: Promise<void>, feeds: FeedId[] = ["live"]) => {
    await work;
    for (const feed of feeds) void inbox.refresh(feed).catch(() => {});
    return { ok: true as const };
  };

  server.handle(rpc.getInbox, ({ refresh }) => ready(() => inbox.get(refresh)));
  server.handle(rpc.dismissItem, ({ key }) => ready(() => inbox.dismiss(key)));
  server.handle(rpc.undismissItem, ({ key }) => ready(() => inbox.undismiss(key)));
  server.handle(rpc.restoreDismissed, () => ready(() => inbox.restoreDismissed()));
  server.handle(rpc.setCodeRepo, ({ issueRepo, codeRepo }) => ready(() => inbox.setCodeRepo(issueRepo, codeRepo)));
  server.handle(rpc.setScopes, ({ scopes }) => ready(() => inbox.setScopes(scopes)).then(() => ({ ok: true as const })));
  server.handle(rpc.updateBranch, ({ target }) => thenRefresh(updateBranch(target)));
  server.handle(rpc.mergePullRequest, ({ target }) => thenRefresh(mergePullRequest(target), ["live", "history"]));
  server.handle(rpc.closePullRequest, ({ target, comment }) => thenRefresh(closePullRequest(target, comment)));
  server.handle(rpc.claimIssue, ({ target }) => thenRefresh(claimIssue(target)));
  server.handle(rpc.defaultBranch, async ({ repo }) => ({ name: FIXTURE ? "main" : await defaultBranch(repo) }));
  server.handle(rpc.sessionContext, async ({ kind, target }) => ({ context: FIXTURE ? FIXTURE_CONTEXT : await sessionContext(kind, target) }));

  return () => inbox.stop();
}
