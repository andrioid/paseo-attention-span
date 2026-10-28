import type { FailingChecks, ItemDetails, Target } from "../shared/attention";
import { graphql, runGh } from "./gh";

// What an item's sheet shows beyond the card, fetched when it opens [ATT-06, GH-01].

export interface Subject {
  kind: "pr" | "issue";
  repo: string;
  number: number;
}

type Linked = { nodes: { number: number; title: string; url: string; state: string }[] };
type Context = { __typename: string; name?: string; conclusion?: string | null; checkSuite?: { workflowRun: { databaseId: number } | null } | null; context?: string; state?: string };
type PullRequest = {
  number: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: Context[] } } | null } }[] };
};
type Result = {
  s: { issueOrPullRequest: { closedByPullRequestsReferences?: Linked; closingIssuesReferences?: Linked } | null } | null;
} & Record<string, { pullRequest: PullRequest | null } | null>;

const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);

const repository = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)})`;
};

// One GraphQL request, plus one REST call per failing workflow run for its attempt number.
export async function itemDetails(subject: Subject, target: Target | undefined, checks: boolean): Promise<ItemDetails> {
  const pr = target?.kind === "pr" ? target : undefined;
  const numbers = pr ? (checks ? (pr.stack ?? [{ number: pr.number }]).map((p) => p.number) : [pr.number]) : [];
  const contexts = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion checkSuite { workflowRun { databaseId } } }
    ... on StatusContext { context state }
  } } } } } }`;
  const linked = "nodes { number title url state }";
  const query = `query {
  s: ${repository(subject.repo)} { issueOrPullRequest(number: ${subject.number}) {
    ... on Issue { closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { ${linked} } }
    ... on PullRequest { closingIssuesReferences(first: 5) { ${linked} } }
  } }
${numbers.map((number, index) => `  p${index}: ${repository(pr!.repo)} { pullRequest(number: ${number}) { number additions deletions changedFiles ${checks ? contexts : ""} } }`).join("\n")}
}`;
  const result = await graphql<Result>(query);
  const node = result.s?.issueOrPullRequest;
  const prs = numbers.map((_, index) => result[`p${index}`]?.pullRequest).filter((p): p is PullRequest => !!p);
  const own = prs.find((p) => p.number === pr?.number);

  const failing: FailingChecks[] = [];
  for (const p of checks ? prs : []) {
    const failed = (p.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c) => FAILED.has(c.conclusion ?? c.state ?? ""));
    if (failed.length === 0) continue;
    const runIds = [...new Set(failed.map((c) => c.checkSuite?.workflowRun?.databaseId).filter((id): id is number => !!id))];
    failing.push({
      pr: p.number,
      checks: failed.map((c) => ({ name: c.name ?? c.context ?? "check", rerunnable: !!c.checkSuite?.workflowRun })),
      runs: await Promise.all(runIds.map(async (id) => ({ id, attempt: await runAttempt(pr!.repo, id) }))),
    });
  }

  return {
    size: own ? { additions: own.additions, deletions: own.deletions, files: own.changedFiles } : undefined,
    linked: (node?.closingIssuesReferences ?? node?.closedByPullRequestsReferences)?.nodes ?? [],
    failing,
  };
}

async function runAttempt(repo: string, id: number): Promise<number> {
  const { code, stdout } = await runGh(["api", `repos/${repo}/actions/runs/${id}`, "--jq", ".run_attempt"]);
  return code === 0 ? Number(stdout.trim()) || 1 : 1;
}
