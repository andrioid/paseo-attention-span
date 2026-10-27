import type { Target } from "../shared/inbox";
import { graphql } from "./gh";

// Each action runs only from an explicit tap in the inbox [SAFE-01].

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

// The expected head guards against merging commits the inbox hasn't seen [PRS-04].
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
