// What the preview can shoot: layouts, and scenarios in the order they run, each with the shots it takes.
// Read on the host (run.sh: which layouts to start, whether a name exists) and in the container (shoot.mjs: what to run).
// Usage on the host: node shots.mjs layouts [selection]   prints the layouts to run, or why the selection is unknown
//                    node shots.mjs list                  prints every shot name

export const LAYOUTS = ["phone-dark", "desktop-dark", "phone-light", "desktop-light"];

// `desktop`: the scenario needs a pointer to hover with. Scenarios marked `last` change the daemon's state for good.
export const SCENARIOS = [
  { name: "tabs", shots: ["doing", "history", "waiting", "next-up"] },
  { name: "doing-bands", shots: ["doing-needs-reviewer", "doing-ready", "doing-wrap", "doing-review", "doing-in-progress"] },
  { name: "wrap-details", shots: ["doing-wrap-sheet", "doing-wrap-ask-sheet", "doing-wrap-worktree-sheet"] },
  { name: "wrap-confirm", shots: ["doing-wrap-dirty", "doing-wrap-multi"] },
  { name: "wrap-ask", shots: ["doing-wrap-kept-open"] },
  { name: "hints", shots: ["doing-hint", "doing-details-hint", "settings-hint", "waiting-too-long", "waiting-copy-hint"], desktop: true },
  { name: "waiting-copy", shots: ["waiting-copied"] },
  { name: "waiting-sheet", shots: ["waiting-sheet"] },
  { name: "doing-sheet", shots: ["doing-sheet"] },
  { name: "doing-issue-sheet", shots: ["doing-issue-sheet"] },
  { name: "doing-in-progress-sheet", shots: ["doing-in-progress-sheet"] },
  { name: "doing-stack-issue-sheet", shots: ["doing-stack-issue-sheet"] },
  { name: "doing-review-sheet", shots: ["doing-review-sheet"] },
  { name: "doing-review-stack-sheet", shots: ["doing-review-stack-sheet"] },
  { name: "acknowledge", shots: ["doing-acknowledge"] },
  { name: "reviewers", shots: ["doing-reviewers"] },
  { name: "options", shots: ["doing-options"] },
  { name: "merge-confirm", shots: ["doing-merge-confirm"] },
  { name: "feedback", shots: ["doing-feedback", "doing-feedback-ask"] },
  { name: "history-filter", shots: ["history-filter", "history-filtered", "history-groups", "history-copied"] },
  { name: "next-up-sheet", shots: ["next-up-sheet"] },
  { name: "next-up-close", shots: ["next-up-close"] },
  { name: "next-up-new-issue", shots: ["next-up-new-issue"] },
  { name: "next-up-by-repo", shots: ["next-up-by-repo"] },
  { name: "next-up-filters", shots: ["next-up-filter", "next-up-filtered", "next-up-source", "next-up-cleared", "next-up-filter-projects", "next-up-projects"] },
  { name: "settings", shots: ["settings-typo", "settings", "settings-next-up", "settings-org-picker", "settings-fields", "settings-fields-picked", "settings-waiting"] },
  { name: "setup", shots: ["setup"] },
  { name: "clear", shots: ["doing-dismissed", "doing-clear", "waiting-clear", "history-clear", "next-up-clear", "next-up-setup"], last: true },
  { name: "code-repo", shots: ["next-up-code-repo", "next-up-code-repo-after", "next-up-code-repo-again"], last: true },
];

const SHOTS = SCENARIOS.flatMap((scenario) => scenario.shots);

// Edits from one name to another, for suggesting the name meant by a typo.
const distance = (a, b) => {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

/**
 * What a selection asks for, as `{ layouts, shots }`: `shots` maps each layout to the shots it takes, or null for all of
 * them. Throws, saying why, for a name that
 * matches nothing. A selection is comma-separated parts, each one of:
 * - nothing: everything
 * - part of a layout name (`desktop`, `phone-dark`, `light`): every shot in those layouts
 * - a shot (`doing-sheet`): that shot in every layout that has it
 * - a layout and a shot (`desktop-dark-doing-sheet`): that shot in that layout
 */
export const select = (selection = "") => {
  const parts = selection.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { layouts: LAYOUTS, shots: Object.fromEntries(LAYOUTS.map((name) => [name, null])) };
  const wanted = new Map(); // layout → Set of shots, or null for all
  const add = (layout, shot) => {
    if (shot === null) return wanted.set(layout, null);
    if (wanted.get(layout) === null) return;
    wanted.set(layout, (wanted.get(layout) ?? new Set()).add(shot));
  };
  for (const part of parts) {
    const layout = LAYOUTS.find((name) => part.startsWith(`${name}-`));
    const shot = layout ? part.slice(layout.length + 1) : part;
    if (!layout && LAYOUTS.some((name) => name.includes(part))) {
      for (const name of LAYOUTS.filter((name) => name.includes(part))) add(name, null);
      continue;
    }
    if (!SHOTS.includes(shot)) {
      const near = SHOTS.filter((name) => name.includes(shot) || distance(name, shot) <= 2).slice(0, 6);
      throw new Error(`No shot or layout called "${part}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} List them with: node preview/shots.mjs list`);
    }
    const desktopOnly = SCENARIOS.find((scenario) => scenario.shots.includes(shot)).desktop;
    const layouts = (layout ? [layout] : LAYOUTS).filter((name) => !desktopOnly || name.startsWith("desktop"));
    if (!layouts.length) throw new Error(`"${shot}" is desktop only: it needs a pointer to hover with`);
    for (const name of layouts) add(name, shot);
  }
  const layouts = LAYOUTS.filter((name) => wanted.has(name));
  // One layout's shots, or null for all of them.
  const shots = Object.fromEntries(layouts.map((name) => [name, wanted.get(name) && [...wanted.get(name)]]));
  return { layouts, shots };
};

if (process.argv[1]?.endsWith("shots.mjs")) {
  const [command, selection] = process.argv.slice(2);
  try {
    if (command === "layouts") {
      console.log(select(selection).layouts.join(" "));
    } else if (command === "list") {
      const shots = (layout) => SCENARIOS.filter((scenario) => !scenario.desktop || layout.startsWith("desktop")).flatMap((scenario) => scenario.shots);
      for (const layout of LAYOUTS) for (const shot of shots(layout)) console.log(`${layout}-${shot}`);
    } else {
      throw new Error("Usage: node shots.mjs layouts [selection] | list");
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
