import { describe, expect, it } from "vitest";
import { failure } from "./update";

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
