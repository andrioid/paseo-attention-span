import { describe, expect, it } from "vitest";
import { workEmoji, workKind } from "./work";

describe("workKind", () => {
  it("HIS-04: reads the issue type first, then labels, then a Conventional Commit title", () => {
    expect(workKind({ type: "Bug", labels: ["enhancement"], title: "feat: x" })).toBe("bug");
    expect(workKind({ type: null, labels: ["enhancement"], title: "fix: x" })).toBe("feature");
    expect(workKind({ labels: ["help wanted"], title: "fix(api)!: drop v1" })).toBe("bug");
    expect(workKind({ title: "chore: bump deps" })).toBe("task");
  });

  it("HIS-04: an issue type it doesn't know falls through to labels", () => {
    expect(workKind({ type: "Spike", labels: ["chore"], title: "x" })).toBe("task");
  });

  it("HIS-04: bug beats feature beats task among labels", () => {
    expect(workKind({ labels: ["chore", "enhancement", "bug"], title: "x" })).toBe("bug");
    expect(workKind({ labels: ["chore", "epic"], title: "x" })).toBe("feature");
  });

  it("HIS-04: matches whole names under common wrappers and emoji, in any case", () => {
    for (const label of ["Bug", "type: bug", "kind/bug", "Type: Bug 🐞", "🐛 bug", "bug report", "T-Bug"]) expect(workKind({ labels: [label], title: "x" })).toBe("bug");
    for (const label of ["feature request", "Enhancement", "kind/feature", "Epic"]) expect(workKind({ labels: [label], title: "x" })).toBe("feature");
  });

  it("HIS-04: doesn't guess from names that only mention a kind", () => {
    for (const label of ["not a bug", "bug bash", "debug", "needs regression test", "feature-flag", "docs", "ci", "area/test", "good first issue"]) {
      expect(workKind({ labels: [label], title: "x" })).toBeUndefined();
    }
  });

  it("HIS-04: only a prefix at the start of the title counts", () => {
    expect(workKind({ title: "Fix VAT on credit notes" })).toBeUndefined();
    expect(workKind({ title: "Make the fix: part two" })).toBeUndefined();
    expect(workKind({ title: "wip: try things" })).toBeUndefined();
    expect(workKind({ title: "docs: explain the config" })).toBe("task");
  });
});

describe("workEmoji", () => {
  it("HIS-04: leads with the kind, a PR's own mark without one, and nothing for an issue without one", () => {
    expect(workEmoji({ kind: "issue", work: "bug" })).toBe("🐞");
    expect(workEmoji({ kind: "pr", work: "feature" })).toBe("🚀");
    expect(workEmoji({ kind: "pr" })).toBe("🔀");
    expect(workEmoji({ kind: "issue" })).toBeUndefined();
  });
});
