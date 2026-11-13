import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  claimIssue,
  closeIssue,
  closePullRequest,
  mergePullRequest,
  react,
  reopenIssue,
  requestReviewers,
  rerunFailed,
  reviewerChoices,
  setAutoMerge,
  setReady,
  unclaimIssue,
  updateBranch,
} from "./server/actions";
import { defaultBranch, sessionContext } from "./server/context";
import { itemDetails } from "./server/details";
import { feedbackInfo } from "./server/feedback";
import { FIXTURE_CONTEXT, fixtureDetails, fixtureReviewerChoices } from "./server/fixture";
import { FIXTURE } from "./server/gh";
import { checkCoverage, configStatus, myOrgs, setupStatus } from "./server/setup";
import { AttentionService, type Change } from "./server/service";
import { UpdateCheck } from "./server/update";
import type { Chip } from "./shared/attention";
import { readyProviders } from "./shared/providers";
import * as rpc from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const attention = new AttentionService();
  const updates = new UpdateCheck();
  const started = attention.start().catch((error) => console.error("Attention Span failed to start:", error));
  const ready = <T>(work: () => Promise<T>) => started.then(work);

  // A change on GitHub, answered with the list after it; what it does to the card shows right away [FRESH-02].
  const act = (key: string, work: () => Promise<void>, change: Change) => ready(() => attention.act(key, work, change));
  const chip = (text: string, tone: Chip["tone"] = "neutral", icon?: Chip["icon"]): Change => ({ kind: "chip", chip: { text, tone, ...(icon ? { icon } : {}) } });

  // The app asks for the list on load and every few minutes; its Paseo connection lets refreshes see my projects [NXT-08].
  server.handle(rpc.getAttention, ({ refresh }, { paseo }) => ready(() => (attention.connect(paseo), attention.get(refresh))));
  server.handle(rpc.dismissItem, ({ key }) => ready(() => attention.dismiss(key)));
  server.handle(rpc.undismissItem, ({ key }) => ready(() => attention.undismiss(key)));
  server.handle(rpc.gotIt, ({ id, on }) => ready(() => attention.gotIt(id, on)));
  server.handle(rpc.restoreDismissed, () => ready(() => attention.restoreDismissed()));
  server.handle(rpc.setCodeRepo, ({ issueRepo, codeRepo }) => ready(() => attention.setCodeRepo(issueRepo, codeRepo)));
  server.handle(rpc.setupStatus, () => setupStatus());
  server.handle(rpc.getCoverage, () => configStatus());
  server.handle(rpc.checkCoverage, ({ kind, name }) => checkCoverage(kind, name));
  server.handle(rpc.setCoverage, ({ orgs, repos }) => ready(() => attention.setCoverage(orgs, repos)).then(() => ({ ok: true as const })));
  server.handle(rpc.setNextUpSources, (sources) => ready(() => attention.setNextUpSources(sources)).then(() => ({ ok: true as const })));
  server.handle(rpc.issueFields, () => ready(async () => ({ fields: await attention.issueFields() })));
  server.handle(rpc.setNextUpFields, (fields) => ready(() => attention.setNextUpFields(fields)).then(() => ({ ok: true as const })));
  server.handle(rpc.setFollowThreads, ({ on }) => ready(() => attention.setFollowThreads(on)).then(() => ({ ok: true as const })));
  server.handle(rpc.myOrgs, async () => ({ orgs: await myOrgs() }));
  server.handle(rpc.setScopes, ({ scopes }) => ready(() => attention.setScopes(scopes)).then(() => ({ ok: true as const })));
  server.handle(rpc.setSources, ({ sources }) => ready(() => attention.setSources(sources)).then(() => ({ ok: true as const })));
  server.handle(rpc.setProjectFilter, ({ projects }) => ready(() => attention.setProjectFilter(projects)).then(() => ({ ok: true as const })));
  server.handle(rpc.projectsAccess, () => ready(() => attention.projectsAccess(true)));
  server.handle(rpc.updateBranch, ({ key, target }) => act(key, () => updateBranch(target), chip("updating")));
  server.handle(rpc.mergePullRequest, ({ key, target }) => act(key, () => mergePullRequest(target), { kind: "finished" }));
  server.handle(rpc.closePullRequest, ({ key, target, comment }) => act(key, () => closePullRequest(target, comment), { kind: "gone" }));
  server.handle(rpc.claimIssue, ({ key, target }) => act(key, () => claimIssue(target), { kind: "claimed" }));
  server.handle(rpc.unclaimIssue, ({ key, target }) => act(key, () => unclaimIssue(target), { kind: "unclaimed" }));
  server.handle(rpc.closeIssue, ({ key, target, reason, comment }) => act(key, () => closeIssue(target, reason, comment), { kind: "finished", notPlanned: reason === "not_planned" }));
  server.handle(rpc.reopenIssue, ({ key, target }) => act(key, () => reopenIssue(target), null));
  server.handle(rpc.setReady, ({ key, target, ready }) => act(key, () => setReady(target, ready), ready ? chip("ready for review", "good") : null));
  server.handle(rpc.setAutoMerge, ({ key, target, on }) => act(key, () => setAutoMerge(target, on), on ? chip("auto-merge on", "good") : null));
  server.handle(rpc.requestReviewers, ({ key, target, reviewers, on }) =>
    act(key, () => requestReviewers(target, reviewers, on), on ? chip("review requested", "good") : null),
  );
  server.handle(rpc.reviewerChoices, ({ target }) =>
    ready(() => {
      const { recent, login } = attention.reviewers(target.repo);
      return FIXTURE ? Promise.resolve(fixtureReviewerChoices(recent)) : reviewerChoices(target, recent, login);
    }),
  );
  server.handle(rpc.react, ({ key, subjectIds, on }) => act(key, () => react(subjectIds, on), on ? chip("acknowledged", "neutral", "thumbUp") : null));
  server.handle(rpc.rerunFailed, ({ key, repo, runIds }) => act(key, () => rerunFailed(repo, runIds), chip("rerunning")));
  server.handle(rpc.itemDetails, ({ subject, target, checks }) => (FIXTURE ? Promise.resolve(fixtureDetails(subject, target, checks)) : itemDetails(subject, target, checks)));
  server.handle(rpc.defaultBranch, async ({ repo }) => ({ name: FIXTURE ? "main" : await defaultBranch(repo) }));
  server.handle(rpc.feedbackInfo, () => feedbackInfo());
  // [UPD-01]
  server.handle(rpc.checkUpdate, () => ready(async () => {
    const notice = await updates.get();
    return notice && notice.latest !== attention.skippedUpdate ? notice : null;
  }));
  server.handle(rpc.applyUpdate, ({ latest }) => updates.apply(latest).then(() => ({ ok: true as const })));
  server.handle(rpc.skipUpdate, ({ latest }) => ready(() => attention.skipUpdate(latest)).then(() => ({ ok: true as const })));
  // The server's Paseo connection expands the snapshot; the app's may not (getpaseo compact snapshots) [SES-06].
  server.handle(rpc.readyProviders, async (_input, { paseo }) => ({ providers: readyProviders((await paseo.providers.snapshot()).entries) }));
  server.handle(rpc.sessionContext, async ({ kind, target }) => ({ context: FIXTURE ? FIXTURE_CONTEXT : await sessionContext(kind, target) }));

  return () => attention.stop();
}
