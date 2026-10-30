import type { PluginServerContext } from "@getpaseo/plugin/server";
import { claimIssue, closeIssue, closePullRequest, mergePullRequest, react, reopenIssue, rerunFailed, setAutoMerge, setReady, unclaimIssue, updateBranch } from "./server/actions";
import { defaultBranch, sessionContext } from "./server/context";
import { itemDetails } from "./server/details";
import { FIXTURE_CONTEXT, fixtureDetails } from "./server/fixture";
import { FIXTURE } from "./server/gh";
import { checkCoverage, configStatus, myOrgs, setupStatus } from "./server/setup";
import { AttentionService } from "./server/service";
import type { FeedId } from "./shared/attention";
import * as rpc from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const attention = new AttentionService();
  const started = attention.start().catch((error) => console.error("Attention Span failed to start:", error));
  const ready = <T>(work: () => Promise<T>) => started.then(work);

  // A change on GitHub, answered with the list after it. Only a merge changes History.
  const act = (work: () => Promise<void>, feeds?: FeedId[]) => ready(() => attention.act(work, feeds));

  // The app asks for the list on load and every few minutes; its Paseo connection lets refreshes see my projects [NXT-08].
  server.handle(rpc.getAttention, ({ refresh }, { paseo }) => ready(() => (attention.connect(paseo), attention.get(refresh))));
  server.handle(rpc.dismissItem, ({ key }) => ready(() => attention.dismiss(key)));
  server.handle(rpc.undismissItem, ({ key }) => ready(() => attention.undismiss(key)));
  server.handle(rpc.restoreDismissed, () => ready(() => attention.restoreDismissed()));
  server.handle(rpc.setCodeRepo, ({ issueRepo, codeRepo }) => ready(() => attention.setCodeRepo(issueRepo, codeRepo)));
  server.handle(rpc.setupStatus, () => setupStatus());
  server.handle(rpc.getCoverage, () => configStatus());
  server.handle(rpc.checkCoverage, ({ kind, name }) => checkCoverage(kind, name));
  server.handle(rpc.setCoverage, ({ orgs, repos }) => ready(() => attention.setCoverage(orgs, repos)).then(() => ({ ok: true as const })));
  server.handle(rpc.setNextUpSources, (sources) => ready(() => attention.setNextUpSources(sources)).then(() => ({ ok: true as const })));
  server.handle(rpc.myOrgs, async () => ({ orgs: await myOrgs() }));
  server.handle(rpc.setScopes, ({ scopes }) => ready(() => attention.setScopes(scopes)).then(() => ({ ok: true as const })));
  server.handle(rpc.setSources, ({ sources }) => ready(() => attention.setSources(sources)).then(() => ({ ok: true as const })));
  server.handle(rpc.updateBranch, ({ target }) => act(() => updateBranch(target)));
  server.handle(rpc.mergePullRequest, ({ target }) => act(() => mergePullRequest(target), ["live", "history"]));
  server.handle(rpc.closePullRequest, ({ target, comment }) => act(() => closePullRequest(target, comment)));
  server.handle(rpc.claimIssue, ({ target }) => act(() => claimIssue(target)));
  server.handle(rpc.unclaimIssue, ({ target }) => act(() => unclaimIssue(target)));
  server.handle(rpc.closeIssue, ({ target, reason, comment }) => act(() => closeIssue(target, reason, comment)));
  server.handle(rpc.reopenIssue, ({ target }) => act(() => reopenIssue(target)));
  server.handle(rpc.setReady, ({ target, ready }) => act(() => setReady(target, ready)));
  server.handle(rpc.setAutoMerge, ({ target, on }) => act(() => setAutoMerge(target, on)));
  server.handle(rpc.react, ({ subjectIds, on }) => act(() => react(subjectIds, on)));
  server.handle(rpc.rerunFailed, ({ repo, runIds }) => act(() => rerunFailed(repo, runIds)));
  server.handle(rpc.itemDetails, ({ subject, target, checks }) => (FIXTURE ? Promise.resolve(fixtureDetails(subject, target, checks)) : itemDetails(subject, target, checks)));
  server.handle(rpc.defaultBranch, async ({ repo }) => ({ name: FIXTURE ? "main" : await defaultBranch(repo) }));
  server.handle(rpc.sessionContext, async ({ kind, target }) => ({ context: FIXTURE ? FIXTURE_CONTEXT : await sessionContext(kind, target) }));

  return () => attention.stop();
}
