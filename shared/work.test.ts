import { describe, expect, it } from "vitest";
import { workEmoji, workOf } from "./work";

const kind = (from: Parameters<typeof workOf>[0]) => workOf(from)?.kind;

describe("workOf", () => {
  it("HIS-04: reads the issue type first, then labels, then a Conventional Commit title", () => {
    expect(workOf({ type: "Bug", labels: ["enhancement"], title: "feat: x" })).toEqual({ name: "bug", kind: "bug" });
    expect(workOf({ type: null, labels: ["enhancement"], title: "fix: x" })).toEqual({ name: "feature", kind: "feature" });
    expect(kind({ labels: ["help wanted"], title: "fix(api)!: drop v1" })).toBe("bug");
    expect(kind({ title: "chore: bump deps" })).toBe("task");
  });

  it("HIS-04, NXT-15: an issue type it doesn't know decides by its own name, over labels and title", () => {
    expect(workOf({ type: "Spike", labels: ["bug"], title: "fix: x" })).toEqual({ name: "spike" });
    expect(workOf({ type: " Research / Spike ", title: "x" })).toEqual({ name: "research / spike" });
    expect(workOf({ type: "constructor", title: "x" })).toEqual({ name: "constructor" });
    expect(workOf({ type: "  ", labels: ["bug"], title: "x" })).toEqual({ name: "bug", kind: "bug" });
  });

  it("HIS-04: tells epics and debt by type, label and title", () => {
    expect(kind({ type: "Epic", title: "x" })).toBe("epic");
    expect(kind({ type: "Debt", title: "x" })).toBe("debt");
    expect(kind({ type: "Refactor", title: "x" })).toBe("debt");
    for (const label of ["epic", "debt", "tech debt", "Technical Debt", "refactor", "kind/tech-debt"]) expect(kind({ labels: [label], title: "x" })).toBe(label.includes("epic") ? "epic" : "debt");
    expect(kind({ title: "refactor(pdf)!: one pipeline" })).toBe("debt");
  });

  it("HIS-04: bug beats epic beats feature beats debt beats task among labels", () => {
    expect(kind({ labels: ["chore", "enhancement", "bug", "epic"], title: "x" })).toBe("bug");
    expect(kind({ labels: ["enhancement", "epic"], title: "x" })).toBe("epic");
    expect(kind({ labels: ["tech debt", "enhancement"], title: "x" })).toBe("feature");
    expect(kind({ labels: ["chore", "refactor"], title: "x" })).toBe("debt");
  });

  it("HIS-04: matches whole names under common wrappers and emoji, in any case", () => {
    for (const label of ["Bug", "type: bug", "kind/bug", "Type: Bug 🐞", "🐛 bug", "bug report", "T-Bug"]) expect(kind({ labels: [label], title: "x" })).toBe("bug");
    for (const label of ["feature request", "Enhancement", "kind/feature"]) expect(kind({ labels: [label], title: "x" })).toBe("feature");
  });

  it("HIS-04: doesn't guess from names that only mention a kind", () => {
    for (const label of ["not a bug", "bug bash", "debug", "needs regression test", "feature-flag", "docs", "ci", "area/test", "good first issue", "debt collection", "constructor"]) {
      expect(workOf({ labels: [label], title: "x" })).toBeUndefined();
    }
  });

  it("HIS-04: only a prefix at the start of the title counts", () => {
    expect(workOf({ title: "Fix VAT on credit notes" })).toBeUndefined();
    expect(workOf({ title: "Make the fix: part two" })).toBeUndefined();
    expect(workOf({ title: "wip: try things" })).toBeUndefined();
    expect(workOf({ title: "constructor: x" })).toBeUndefined();
    expect(kind({ title: "docs: explain the config" })).toBe("task");
  });
});

describe("workEmoji", () => {
  it("HIS-04: leads with the kind, a PR's own mark without a kind it knows, and nothing for an issue without one", () => {
    expect(workEmoji({ kind: "issue", work: { name: "bug", kind: "bug" } })).toBe("🐞");
    expect(workEmoji({ kind: "pr", work: { name: "feature", kind: "feature" } })).toBe("🚀");
    expect(workEmoji({ kind: "issue", work: { name: "epic", kind: "epic" } })).toBe("🏔️");
    expect(workEmoji({ kind: "issue", work: { name: "debt", kind: "debt" } })).toBe("🧾");
    expect(workEmoji({ kind: "pr" })).toBe("🔀");
    expect(workEmoji({ kind: "pr", work: { name: "spike" } })).toBe("🔀");
    expect(workEmoji({ kind: "issue", work: { name: "spike" } })).toBeUndefined();
    expect(workEmoji({ kind: "issue" })).toBeUndefined();
  });
});
