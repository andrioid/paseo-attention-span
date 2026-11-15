import { describe, expect, it } from "vitest";
import { keptText, sheetLines, unsavedOf, unsavedWords } from "./archive";

const session = { agentId: "a", title: "Fix CI" };

describe("unsaved work", () => {
  it("ATT-22: clean needs both answers; either one missing is unknown, whatever the other says", () => {
    expect(unsavedOf(session, { dirty: false, ahead: 0 })).toBeNull();
    expect(unsavedOf(session, { dirty: true, ahead: 2 })).toMatchObject({ uncommitted: true, commits: 2 });
    expect(unsavedOf(session, { dirty: false, ahead: null })).toMatchObject({ unknown: true });
    expect(unsavedOf(session, { dirty: true })).toMatchObject({ uncommitted: true, unknown: true });
    expect(unsavedOf(session, undefined)).toMatchObject({ unknown: true });
  });

  it("ATT-22: names what's unsaved, counting files where they were counted", () => {
    const words = (reading: Parameters<typeof unsavedOf>[1]) => unsavedWords(unsavedOf(session, reading)!);
    expect(words({ dirty: true, ahead: 1, branch: "split-invoice-pdf" })).toBe("uncommitted changes and 1 unpushed commit on split-invoice-pdf");
    expect(words({ dirty: true, ahead: 0, files: 2 })).toBe("2 uncommitted files");
    expect(words({ dirty: false, ahead: 3 })).toBe("3 unpushed commits");
    expect(unsavedWords({ ...session, files: 1, commits: 1, branch: "b" })).toBe("1 uncommitted file and 1 unpushed commit on b");
  });

  it("ATT-22: the confirm sheet says it in Paseo's words, then the terminals archiving closes", () => {
    expect(sheetLines({ ...session, files: 2, added: 12, deleted: 3, commits: 1 })).toEqual(["Uncommitted changes: 2 files (+12 −3)", "1 unpushed commit"]);
    expect(sheetLines({ ...session, uncommitted: true, terminals: ["dev", "shell"] })).toEqual(["Uncommitted changes", "Closes terminals: dev, shell"]);
    expect(sheetLines({ ...session, terminals: ["dev"] })).toEqual(["Closes terminal: dev"]);
    expect(sheetLines({ ...session, unknown: true, commits: 2 })).toEqual(["Couldn't check for unsaved changes", "2 unpushed commits"]);
  });

  it("ATT-22: a kept worktree's row says why it stayed", () => {
    expect(keptText({ reason: "session", detail: "Fix flaky test" })).toBe("Sessions archived · worktree kept: Fix flaky test is still in it");
    expect(keptText({ reason: "terminal", detail: "dev" })).toBe("Sessions archived · worktree kept: dev opened while archiving");
    expect(keptText({ reason: "refused", detail: "busy" })).toBe("Sessions archived · Paseo couldn't remove the worktree: busy");
  });
});
