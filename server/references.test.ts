import { describe, expect, it } from "vitest";
import { closingRefs, issueFor, mergedToLookUp, toLookUp } from "./references";

const REPO = "acme/shop";
const keys = (refs: { repo: string; number: number }[]) => refs.map((ref) => `${ref.repo}#${ref.number}`);

describe("references", () => {
  it("ATT-03: finds closing keywords, in this repo or another, and links to issues", () => {
    expect(keys(closingRefs("Closes #12. fixes: acme/web#3\nResolved https://github.com/acme/api/issues/7", REPO))).toEqual(["acme/shop#12", "acme/web#3", "acme/api#7"]);
    expect(keys(closingRefs("For #12, see #13", REPO))).toEqual([]);
    // As GitHub reads them: a negation doesn't stop the keyword.
    expect(keys(closingRefs("This doesn't fix #12", REPO))).toEqual(["acme/shop#12"]);
  });

  it("ATT-03: finds closing keywords, but not in code, quotes, template comments, links to PRs or anchors", () => {
    const body = "Closes #12.\n\n> Fixes #1\n\n<!-- Closes #2 -->\n`Fixes #3`\n```\nFixes #4\n```\nFixes https://github.com/acme/shop/pull/5, fixes x.html#6, fixes a&#7;";
    expect(keys(closingRefs(body, REPO))).toEqual(["acme/shop#12"]);
  });

  it("ATT-03: prefers what GitHub links, then a closing keyword anywhere in the stack", () => {
    const open = (key: string) => ["acme/shop#1", "acme/shop#2", "acme/shop#3", "acme/shop#4"].includes(key);
    const pr = (body: string, linked: string[] = []) => ({ repo: REPO, body, linked });
    expect(issueFor([pr("for #1"), pr("Closes #2", ["acme/shop#3"])], open)).toBe("acme/shop#3");
    expect(issueFor([pr("for #1"), pr("Closes #2")], open)).toBe("acme/shop#2");
    // A PR or closed issue doesn't count, so the open issue it closes does.
    expect(issueFor([pr("Closes #9, fixes #1")], open)).toBe("acme/shop#1");
  });

  it("ATT-03: a plain mention isn't the issue a PR works on", () => {
    const open = (key: string) => key === "acme/shop#1";
    const pr = (body: string) => ({ repo: REPO, body, linked: [] });
    for (const body of ["Part 1 of #1", "Follow-up to #1", "See #1 for context", "Unrelated to #1"]) expect(issueFor([pr(body), pr("")], open)).toBeUndefined();
  });

  it("ATT-03: looks up only issues a description closes that aren't my PRs or linked already", () => {
    const node = (number: number, body?: string, linked: number[] = []) => ({
      number,
      body,
      repository: { nameWithOwner: REPO },
      closingIssuesReferences: { nodes: linked.map((n) => ({ number: n, repository: { nameWithOwner: REPO } })) },
    });
    expect(keys(toLookUp([node(10, "for #5, closes #11"), node(11, "Closes #2, fixes #1", [2]), node(12)]))).toEqual(["acme/shop#1"]);
    expect(toLookUp([node(10, "Fixes #1, fixes #2, fixes #3")], 2)).toHaveLength(2);
  });

  it("ATT-24: looks up the issues my merged PRs close or GitHub links, not ones they only mention, my PRs or closed issues History knows", () => {
    const merged = (number: number, body: string, linked: number[] = []) => ({
      number,
      body,
      repository: { nameWithOwner: REPO },
      closingIssuesReferences: { nodes: linked.map((n) => ({ number: n, repository: { nameWithOwner: REPO } })) },
    });
    const closed = [{ number: 4, repository: { nameWithOwner: REPO } }];
    expect(keys(mergedToLookUp([merged(10, "Closes #1, see #2", [3]), merged(11, "Fixes #4, fixes #10, follow-up to #5")], closed))).toEqual(["acme/shop#3", "acme/shop#1"]);
  });
});
