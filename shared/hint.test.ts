import { describe, expect, it } from "vitest";
import { HINT_GAP, hintPlacement } from "./hint";

describe("hint placement", () => {
  it("ATT-19: beside the content where there's room, up to the area's right edge", () => {
    expect(hintPlacement(100, 80, 0, 600)).toEqual({ side: "beside", width: 600 - 180 - HINT_GAP });
  });

  it("ATT-19: above where there's too little room beside, from the content's left edge", () => {
    expect(hintPlacement(100, 300, 0, 500)).toEqual({ side: "above", width: 400, offset: 0 });
  });

  it("ATT-19: near the right edge it shifts left to fit, never past either edge of the area", () => {
    // Content ends 60px before the right edge: 160 wide, 100 to the left of the content.
    const near = hintPlacement(440, 20, 0, 500);
    expect(near).toEqual({ side: "above", width: 160, offset: -100 });
    // An area narrower than a hint: as wide as the area, starting at its left edge.
    expect(hintPlacement(50, 20, 40, 140)).toEqual({ side: "above", width: 100, offset: -10 });
  });
});
