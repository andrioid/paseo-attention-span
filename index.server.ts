import type { PluginServerContext } from "@getpaseo/plugin/server";
import { claimIssue, closePullRequest, mergePullRequest, react, rerunFailed, setAutoMerge, setReady, unclaimIssue, updateBranch } from "./server/actions";
import { defaultBranch, sessionContext } from "./server/context";
import { itemDetails } from "./server/details";
import { FIXTURE_CONTEXT, fixtureDetails } from "./server/fixture";
import { FIXTURE } from "./server/gh";
import { AttentionService } from "./server/service";
import type { FeedId } from "./shared/attention";
import * as rpc from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const attention = new AttentionService();
  const started = attention.start().catch((error) => console.error("Attention Span failed to start:", error));
  const ready = <T>(work: () => Promise<T>) => started.then(work);

  // After a change on GitHub, refresh in the background so the list catches up. Only a merge changes History.
  const thenRefresh = async (work: Promise<void>, feeds: FeedId[] = ["live"]) => {
    await work;
    for (const feed of feeds) void attention.refresh(feed).catch(() => {});
    return { ok: true as const };
  };

  server.handle(rpc.getAttention, ({ refresh }) => ready(() => attention.get(refresh)));
  server.handle(rpc.dismissItem, ({ key }) => ready(() => attention.dismiss(key)));
  server.handle(rpc.undismissItem, ({ key }) => ready(() => attention.undismiss(key)));
  server.handle(rpc.restoreDismissed, () => ready(() => attention.restoreDismissed()));
  server.handle(rpc.setCodeRepo, ({ issueRepo, codeRepo }) => ready(() => attention.setCodeRepo(issueRepo, codeRepo)));
  server.handle(rpc.setScopes, ({ scopes }) => ready(() => attention.setScopes(scopes)).then(() => ({ ok: true as const })));
  server.handle(rpc.updateBranch, ({ target }) => thenRefresh(updateBranch(target)));
  server.handle(rpc.mergePullRequest, ({ target }) => thenRefresh(mergePullRequest(target), ["live", "history"]));
  server.handle(rpc.closePullRequest, ({ target, comment }) => thenRefresh(closePullRequest(target, comment)));
  server.handle(rpc.claimIssue, ({ target }) => thenRefresh(claimIssue(target)));
  server.handle(rpc.unclaimIssue, ({ target }) => thenRefresh(unclaimIssue(target)));
  server.handle(rpc.setReady, ({ target, ready }) => thenRefresh(setReady(target, ready)));
  server.handle(rpc.setAutoMerge, ({ target, on }) => thenRefresh(setAutoMerge(target, on)));
  server.handle(rpc.react, ({ subjectIds, on }) => thenRefresh(react(subjectIds, on)));
  server.handle(rpc.rerunFailed, ({ repo, runIds }) => thenRefresh(rerunFailed(repo, runIds)));
  server.handle(rpc.itemDetails, ({ subject, target, checks }) => (FIXTURE ? Promise.resolve(fixtureDetails(subject, target, checks)) : itemDetails(subject, target, checks)));
  server.handle(rpc.defaultBranch, async ({ repo }) => ({ name: FIXTURE ? "main" : await defaultBranch(repo) }));
  server.handle(rpc.sessionContext, async ({ kind, target }) => ({ context: FIXTURE ? FIXTURE_CONTEXT : await sessionContext(kind, target) }));

  return () => attention.stop();
}
