// Which issue a PR or stack works on, from what GitHub links and what its descriptions say [ATT-03, HIS-01].

export interface IssueRef {
  repo: string;
  number: number;
}

// "#12", "acme/shop#12" or a link to an issue; links to PRs are left out.
const REF = String.raw`(?:https://github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)|(?<![\w/#&])(?:([\w.-]+/[\w.-]+))?#(\d+))(?![\w-])`;
// GitHub's closing keywords [docs: linking a pull request to an issue].
const CLOSING = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${REF}`, "gi");
const ANY = new RegExp(REF, "gi");

// What counts as said: not code, quoted replies or template comments.
function prose(body: string): string {
  return body
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/^\s*>.*$/gm, "");
}

function refs(body: string | undefined, repo: string, pattern: RegExp): IssueRef[] {
  const found = new Map<string, IssueRef>();
  for (const match of prose(body ?? "").matchAll(pattern)) {
    const ref = { repo: match[1] ?? match[3] ?? repo, number: Number(match[2] ?? match[4]) };
    found.set(refKey(ref), ref);
  }
  return [...found.values()];
}

export const refKey = (ref: IssueRef) => `${ref.repo}#${ref.number}`;
export const closingRefs = (body: string | undefined, repo: string) => refs(body, repo, CLOSING);
export const mentionedRefs = (body: string | undefined, repo: string) => refs(body, repo, ANY);

export interface LinkedPr {
  repo: string;
  body?: string;
  // Issues GitHub links it to with a closing keyword, as "owner/name#number".
  linked: string[];
}

// The issue for PRs listed bottom first, strongest evidence first: what GitHub links, then a closing keyword in a
// description, then the one issue the bottom PR's description mentions. GitHub links only PRs into the default branch,
// so a stack's upper PRs need their descriptions read. `isIssue` says whether a reference is an issue that counts, which
// rules out PRs and closed issues; several mentioned issues are too ambiguous to pick from.
export function issueFor(prs: LinkedPr[], isIssue: (key: string) => boolean): string | undefined {
  for (const pr of prs) {
    const linked = pr.linked.find(isIssue);
    if (linked) return linked;
  }
  for (const pr of prs) {
    const closing = closingRefs(pr.body, pr.repo).map(refKey).find(isIssue);
    if (closing) return closing;
  }
  const mentioned = prs[0] ? mentionedRefs(prs[0].body, prs[0].repo).map(refKey).filter(isIssue) : [];
  return mentioned.length === 1 ? mentioned[0] : undefined;
}

// The references in my PRs' descriptions to look up, at most `max`: my PRs themselves and what GitHub links are known.
type Node = { number: number; repository: { nameWithOwner: string } };
const nodeKey = (node: Node) => `${node.repository.nameWithOwner}#${node.number}`;

export function toLookUp(prs: (Node & { body?: string; closingIssuesReferences: { nodes: Node[] } })[], max = 100): IssueRef[] {
  const known = new Set(prs.flatMap((pr) => [pr, ...pr.closingIssuesReferences.nodes].map(nodeKey)));
  const wanted = new Map<string, IssueRef>();
  for (const pr of prs) for (const ref of mentionedRefs(pr.body, pr.repository.nameWithOwner)) if (!known.has(refKey(ref))) wanted.set(refKey(ref), ref);
  return [...wanted.values()].slice(0, max);
}
