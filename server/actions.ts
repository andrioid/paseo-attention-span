import type { IssueCloseReason, Reviewer, ReviewerChoices, Target } from "../shared/attention";
import { graphql, runGh } from "./gh";

// Each action runs only from an explicit tap in Attention Span [SAFE-01].

function pullRequestId(target: Target): string {
  if (target.kind !== "pr" || !target.id) throw new Error(`${target.repo}#${target.number} is not a pull request.`);
  return target.id;
}

// GitHub's "Update branch", rebasing onto the base [UPS-03].
export async function updateBranch(target: Target): Promise<void> {
  await graphql(
    `mutation($id: ID!, $oid: GitObjectID) {
      updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $oid, updateMethod: REBASE }) { clientMutationId }
    }`,
    { id: pullRequestId(target), oid: target.headRefOid ?? null },
  );
}

// The expected head guards against merging commits Attention Span hasn't seen [PRS-04].
export async function mergePullRequest(target: Target): Promise<void> {
  await graphql(
    `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID) {
      mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { clientMutationId }
    }`,
    { id: pullRequestId(target), method: (target.mergeMethod ?? "squash").toUpperCase(), oid: target.headRefOid ?? null },
  );
}

// Close a stale draft; comment only when I wrote one [PRS-07].
export async function closePullRequest(target: Target, comment?: string): Promise<void> {
  const id = pullRequestId(target);
  if (comment?.trim()) {
    await graphql(`mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }`, {
      id,
      body: comment.trim(),
    });
  }
  await graphql(`mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
}

// Assign me, so teammates see the issue is taken [NXT-05].
export async function claimIssue(target: Target): Promise<void> {
  const { code, stderr } = await runGh(["issue", "edit", String(target.number), "--repo", target.repo, "--add-assignee", "@me"]);
  if (code !== 0) throw new Error(stderr.trim() || "Claiming the issue failed");
}

// Close an issue I won't pick up, as completed or not planned; comment only when I wrote one [NXT-11].
export async function closeIssue(target: Target, reason: IssueCloseReason, comment?: string): Promise<void> {
  const args = ["issue", "close", String(target.number), "--repo", target.repo, "--reason", reason === "not_planned" ? "not planned" : "completed"];
  if (comment?.trim()) args.push("--comment", comment.trim());
  const { code, stderr } = await runGh(args);
  if (code !== 0) throw new Error(stderr.trim() || "Closing the issue failed");
}

// Undo of Close [NXT-11]. A comment already posted stays.
export async function reopenIssue(target: Target): Promise<void> {
  const { code, stderr } = await runGh(["issue", "reopen", String(target.number), "--repo", target.repo]);
  if (code !== 0) throw new Error(stderr.trim() || "Reopening the issue failed");
}

// Hand an assigned issue back; also undoes a claim [NXT-07].
export async function unclaimIssue(target: Target): Promise<void> {
  const { code, stderr } = await runGh(["issue", "edit", String(target.number), "--repo", target.repo, "--remove-assignee", "@me"]);
  if (code !== 0) throw new Error(stderr.trim() || "Unclaiming the issue failed");
}

// Ready for review, or back to draft for Undo [PRS-11].
export async function setReady(target: Target, ready: boolean): Promise<void> {
  const mutation = ready ? "markPullRequestReadyForReview" : "convertPullRequestToDraft";
  await graphql(`mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, { id: pullRequestId(target) });
}

// GitHub merges once checks pass; the expected head guards like Merge does [PRS-10].
export async function setAutoMerge(target: Target, on: boolean): Promise<void> {
  if (!on) {
    await graphql(`mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`, { id: pullRequestId(target) });
    return;
  }
  await graphql(
    `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { clientMutationId }
    }`,
    { id: pullRequestId(target), method: (target.mergeMethod ?? "squash").toUpperCase(), oid: target.headRefOid ?? null },
  );
}

// 👍 the comments I picked, which clears them as mentions; or take it back for Undo [MEN-07].
export async function react(subjectIds: string[], on: boolean): Promise<void> {
  if (subjectIds.length === 0) return;
  const mutation = on ? "addReaction" : "removeReaction";
  const fields = subjectIds.map((_, index) => `r${index}: ${mutation}(input: { subjectId: $s${index}, content: THUMBS_UP }) { clientMutationId }`);
  const variables = subjectIds.map((_, index) => `$s${index}: ID!`).join(", ");
  await graphql(`mutation(${variables}) {\n${fields.join("\n")}\n}`, Object.fromEntries(subjectIds.map((id, index) => [`s${index}`, id])));
}

// Rerun only the failed jobs of each run [PRS-09].
export async function rerunFailed(repo: string, runIds: number[]): Promise<void> {
  for (const id of runIds) {
    const { code, stderr } = await runGh(["run", "rerun", String(id), "--failed", "--repo", repo]);
    if (code !== 0) throw new Error(stderr.trim() || `Rerunning run ${id} failed`);
  }
}

// Who the reviewer picker suggests: GitHub's picks for the PR and the repo's teams; recent reviewers come from the last fetch [PRS-12].
// Fetched when the picker opens, not in every refresh [GH-01]. My own repos have no teams, so they aren't asked for.
export async function reviewerChoices(target: Target, recent: Reviewer[], login: string | null): Promise<ReviewerChoices> {
  const isMe = (name: string) => !!login && name.toLowerCase() === login.toLowerCase();
  const [owner] = target.repo.split("/");
  const [suggested, teams] = await Promise.all([
    graphql<{ node: { suggestedReviewers: { reviewer: { login: string; avatarUrl?: string } }[] } | null }>(
      `query($id: ID!) { node(id: $id) { ... on PullRequest { suggestedReviewers { reviewer { login avatarUrl(size: 64) } } } } }`,
      { id: pullRequestId(target) },
    ),
    isMe(owner) ? Promise.resolve({ code: 0, stdout: "[]", stderr: "" }) : runGh(["api", `repos/${target.repo}/teams?per_page=100`]),
  ]);
  const people = (suggested.node?.suggestedReviewers ?? []).map(({ reviewer }) => ({ login: reviewer.login, avatarUrl: reviewer.avatarUrl, team: false })).filter((r) => !isMe(r.login));
  if (teams.code !== 0) return { suggested: people, recent, teams: [], teamsNote: "Teams need the read:org scope (gh auth refresh -s read:org)" };
  const list = JSON.parse(teams.stdout) as { slug: string }[];
  return { suggested: people, recent, teams: list.map((team) => ({ login: `${owner}/${team.slug}`, team: true })) };
}

// Ask people and teams ("org/slug") to review, keeping who's already asked; or withdraw them for Undo [PRS-12, ATT-14].
export async function requestReviewers(target: Target, reviewers: string[], on: boolean): Promise<void> {
  if (reviewers.length === 0) return;
  const body = {
    reviewers: reviewers.filter((name) => !name.includes("/")),
    team_reviewers: reviewers.filter((name) => name.includes("/")).map((name) => name.split("/")[1]),
  };
  const path = `repos/${target.repo}/pulls/${target.number}/requested_reviewers`;
  const { code, stderr } = await runGh(["api", "--method", on ? "POST" : "DELETE", path, "--input", "-"], JSON.stringify(body));
  if (code !== 0) throw new Error(stderr.trim() || (on ? "Requesting reviewers failed" : "Withdrawing the request failed"));
}
