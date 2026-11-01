import { describe, expect, it } from "vitest";
import { closingRefs, issueFor, mentionedRefs, toLookUp } from "./references";

const REPO = "acme/shop";
const keys = (refs: { repo: string; number: number }[]) => refs.map((ref) => `${ref.repo}#${ref.number}`);

describe("references", () => {
  it("ATT-03: finds closing keywords, in this repo or another, and links to issues", () => {
    expect(keys(closingRefs("Closes #12. fixes: acme/web#3\nResolved https://github.com/acme/api/issues/7", REPO))).toEqual(["acme/shop#12", "acme/web#3", "acme/api#7"]);
    expect(keys(closingRefs("For #12, see #13", REPO))).toEqual([]);
  });

  it("ATT-03: finds plain references, but not in code, quotes, template comments, links to PRs or anchors", () => {
    const body = "First of three stacked PRs for #12.\n\n> Fixes #1\n\n<!-- Closes #2 -->\n`#3`\n```\n#4\n```\nhttps://github.com/acme/shop/pull/5 and x.html#6 and a&#7;";
    expect(keys(mentionedRefs(body, REPO))).toEqual(["acme/shop#12"]);
  });

  it("ATT-03: prefers what GitHub links, then a closing keyword anywhere in the stack, then the bottom's one mention", () => {
    const open = (key: string) => ["acme/shop#1", "acme/shop#2", "acme/shop#3", "acme/shop#4"].includes(key);
    const pr = (body: string, linked: string[] = []) => ({ repo: REPO, body, linked });
    expect(issueFor([pr("for #1"), pr("Closes #2", ["acme/shop#3"])], open)).toBe("acme/shop#3");
    expect(issueFor([pr("for #1"), pr("Closes #2")], open)).toBe("acme/shop#2");
    expect(issueFor([pr("Part 1 of #1"), pr("")], open)).toBe("acme/shop#1");
    // Mentions count on the bottom PR only, and only when there's one.
    expect(issueFor([pr(""), pr("for #1")], open)).toBeUndefined();
    expect(issueFor([pr("for #1, after #4")], open)).toBeUndefined();
    // A PR or closed issue doesn't count, so the one open issue does.
    expect(issueFor([pr("Closes #9, for #1 after #8")], open)).toBe("acme/shop#1");
  });

  it("ATT-03: looks up only references that aren't my PRs or linked already", () => {
    const node = (number: number, body?: string, linked: number[] = []) => ({
      number,
      body,
      repository: { nameWithOwner: REPO },
      closingIssuesReferences: { nodes: linked.map((n) => ({ number: n, repository: { nameWithOwner: REPO } })) },
    });
    expect(keys(toLookUp([node(10, "for #1, after #11"), node(11, "Closes #2 and #1", [2]), node(12)]))).toEqual(["acme/shop#1"]);
    expect(toLookUp([node(10, "#1 #2 #3")], 2)).toHaveLength(2);
  });
});
