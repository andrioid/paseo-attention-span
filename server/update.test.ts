import { describe, expect, it } from "vitest";
import type { UpdateNotice } from "../shared/update";
import { failure, UpdateCheck, type UpdatePaseo } from "./update";

describe("failure", () => {
  it("UPD-01: an update that worked is no failure", () => {
    expect(failure("attention-span", JSON.stringify([{ id: "attention-span", outcome: "updated" }]), 0)).toBeNull();
  });

  it("UPD-01: gives Paseo's reason for this plugin", () => {
    const output = JSON.stringify([{ id: "attention-span", outcome: "error", links: [], error: "Registry updates use only the reviewed registry pin" }]);
    expect(failure("attention-span", output, 1)).toBe("Registry updates use only the reviewed registry pin");
  });

  it("UPD-01: falls back to the last line of output, or the exit code", () => {
    expect(failure("attention-span", "npm ERR! network\nnpm ERR! request to registry.npmjs.org failed\n", 1)).toBe("npm ERR! request to registry.npmjs.org failed");
    expect(failure("attention-span", "", 2)).toBe("paseo plugin update exited with 2");
  });
});

describe("UpdateCheck", () => {
  const HOUR = 3_600_000;
  const notice = (latest: string): UpdateNotice => ({ id: "attention-span", current: "0.4.3", latest, source: "npm", args: ["--version", latest], command: "paseo plugin update attention-span", notes: "" });

  // A Paseo that answers from `answers` in turn and records what it was asked to install.
  function setup(answers: (UpdateNotice | null | Error)[]) {
    let clock = 0;
    const asked = { checks: 0, installs: [] as string[] };
    let fail: ((error: string) => void) | null = null;
    const paseo: UpdatePaseo = {
      check: async () => {
        const answer = answers[Math.min(asked.checks++, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer;
      },
      install: (target, failed) => {
        asked.installs.push(target.latest);
        fail = failed;
      },
    };
    const updates = new UpdateCheck(paseo, () => clock);
    return { updates, asked, later: (ms: number) => (clock += ms), fail: (error: string) => fail?.(error) };
  }

  it("UPD-01: asks Paseo at most every 12 hours, and once for callers at the same time", async () => {
    const { updates, asked, later } = setup([notice("0.5.0"), notice("0.6.0")]);
    const [a, b] = await Promise.all([updates.get(), updates.get()]);
    expect([a?.latest, b?.latest, asked.checks]).toEqual(["0.5.0", "0.5.0", 1]);
    later(11 * HOUR);
    expect((await updates.get())?.latest).toBe("0.5.0");
    later(HOUR);
    expect((await updates.get())?.latest).toBe("0.6.0");
  });

  it("UPD-01: a failed check shows no notice and is tried again after an hour", async () => {
    const { updates, asked, later } = setup([new Error("offline"), notice("0.5.0")]);
    expect(await updates.get()).toBeNull();
    later(HOUR - 1);
    expect(await updates.get()).toBeNull();
    later(1);
    expect((await updates.get())?.latest).toBe("0.5.0");
    expect(asked.checks).toBe(2);
  });

  it("SAFE-01, UPD-01: installs only the version on offer, and keeps why it failed for the notice until tried again", async () => {
    const { updates, asked, fail } = setup([notice("0.5.0")]);
    await expect(updates.apply("0.4.9")).rejects.toThrow("isn't the update on offer");
    await updates.apply("0.5.0");
    expect(asked.installs).toEqual(["0.5.0"]);
    fail("network down");
    expect(await updates.get()).toMatchObject({ latest: "0.5.0", error: "network down" });
    await updates.apply("0.5.0");
    expect((await updates.get())?.error).toBeUndefined();
  });
});
