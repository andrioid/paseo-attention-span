import { describe, expect, it } from "vitest";
import { sheetWords, unsavedOf, unsavedWords } from "./archive";

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

  it("ATT-22: the confirm sheet names unsaved work, then the terminals archiving closes", () => {
    expect(sheetWords({ ...session, files: 2, branch: "split-pdf" })).toBe("Its worktree has 2 uncommitted files on split-pdf. Archiving may remove them.");
    expect(sheetWords({ ...session, files: 2, terminals: ["dev", "shell"] })).toBe("Its worktree has 2 uncommitted files. Archiving may remove them. Archiving closes its terminals: dev, shell.");
    expect(sheetWords({ ...session, terminals: ["dev"] })).toBe("Archiving closes its terminal: dev.");
    expect(sheetWords({ ...session, unknown: true })).toBe("Couldn't check for unsaved changes. Archiving may remove the worktree.");
  });
});
