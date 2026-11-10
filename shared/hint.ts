// Where a hint goes, from window coordinates: its content spans [x, x + width], and the area it may spread in [left, right]
// (a card's text column, which clips what runs past). Beside the content where there's room, else above it, never past the
// area's edges [ATT-19].

export const HINT_GAP = 8;
// Less room than this beside the content, and the hint goes above it instead.
export const HINT_MIN_WIDTH = 160;

export type HintPlacement =
  | { side: "beside"; width: number }
  // offset: from the content's left edge; negative where it shifts left to make room.
  | { side: "above"; width: number; offset: number };

export function hintPlacement(x: number, width: number, left: number, right: number): HintPlacement {
  const beside = right - (x + width) - HINT_GAP;
  if (beside >= HINT_MIN_WIDTH) return { side: "beside", width: beside };
  // From the content's left edge to the area's right; where that's too narrow, as wide as needed by shifting left, but never
  // wider than the area.
  const span = Math.min(Math.max(HINT_MIN_WIDTH, right - x), right - left);
  return { side: "above", width: span, offset: Math.min(0, right - span - x) };
}
