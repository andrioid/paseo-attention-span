import { Text, View } from "react-native";
import type { GithubColor, IssueProject, NextUpIssue } from "../shared/attention";
import type { FieldRole } from "../shared/config";
import { repoLabel, shortValue } from "../shared/format";
import type { IconName } from "./icons";
import { Pill, type Styles, useStrongText, useStyles } from "./ui";

// How an issue or PR is presented wherever it shows, on a card or in its sheet: which one it is, and the facts that help
// pick it up. Tabs and sheets compose these rather than format their own.

// ---- Which item [ATT-20] ----

// An item's number and repo. My own repos go without their owner where `login` is given; a sheet passes none, so it always
// names the owner.
export interface Place {
  repo: string;
  number: number;
  login: string | null;
}

// "#160", standing out a little from the quiet text it leads, like a stack's rows in a sheet.
export function NumberText({ number }: { number: number }) {
  return <Text style={useStrongText()}>#{number}</Text>;
}

// "#160 · acme/shop", to lead a Meta line: the number on its own first, then the repo with its name standing out from its
// owner, so cards from several repos scan.
export function PlaceText({ place }: { place: Place }) {
  const strong = useStrongText();
  const label = repoLabel(place.repo, place.login);
  const cut = label.lastIndexOf("/") + 1;
  return (
    <>
      <NumberText number={place.number} />
      {" · "}
      {label.slice(0, cut)}
      <Text style={strong}>{label.slice(cut)}</Text>
    </>
  );
}

// ---- GitHub's option colors [NXT-10] ----

// The colors GitHub offers for issue field and project options, as GitHub draws them on dark and on light.
const GITHUB_COLORS: Record<GithubColor, { dark: string; light: string }> = {
  GRAY: { dark: "#8b949e", light: "#6e7781" },
  BLUE: { dark: "#4493f8", light: "#0969da" },
  GREEN: { dark: "#3fb950", light: "#1a7f37" },
  YELLOW: { dark: "#d29922", light: "#9a6700" },
  ORANGE: { dark: "#db6d28", light: "#bc4c00" },
  RED: { dark: "#f85149", light: "#cf222e" },
  PINK: { dark: "#db61a2", light: "#bf3989" },
  PURPLE: { dark: "#ab7df8", light: "#8250df" },
};

// An option's color for this theme. GRAY is what an option looks like when nobody chose a color, so it tints nothing.
export function githubColor(styles: Styles, color: GithubColor | undefined): string | undefined {
  return color && color !== "GRAY" ? GITHUB_COLORS[color]?.[styles.dark ? "dark" : "light"] : undefined;
}

// ---- An issue to pick up [NXT-10, NXT-12] ----

// Each field's pill: its icon says which field the value is.
const FIELDS = [
  { role: "priority", label: "Priority", icon: "flag" },
  { role: "effort", label: "Effort", icon: "weight" },
  { role: "scope", label: "Scope", icon: "layers" },
] as const satisfies { role: FieldRole; label: string; icon: IconName }[];

// Priority in the color the org gave it; where it colored none, the top priority is warm, the next accent, the rest quiet.
function priorityColor(styles: Styles, issue: NextUpIssue): string | undefined {
  if (issue.priorityColor) return githubColor(styles, issue.priorityColor);
  return issue.priorityRank === 0 ? styles.c.statusWarning : issue.priorityRank === 1 ? styles.action : undefined;
}

// A board it's on, and its column there in the board's color.
export function ProjectPill({ project }: { project: IssueProject }) {
  const styles = useStyles();
  return (
    <Pill
      icon="kanban"
      label={project.title}
      value={project.status}
      color={githubColor(styles, project.color)}
      hint={`Project ${project.title}: ${project.status ?? "no status"}`}
    />
  );
}

// One of its fields. `full` (the sheet) names the field and keeps the value whole, as phones can't show a pill's hint;
// the card trims the value's emoji and notes in brackets.
export function FieldPill({ issue, role, full = false }: { issue: NextUpIssue; role: FieldRole; full?: boolean }) {
  const styles = useStyles();
  const field = FIELDS.find((f) => f.role === role)!;
  const raw = issue[role];
  if (!raw) return null;
  const value = full ? raw : shortValue(raw);
  const color = role === "priority" ? priorityColor(styles, issue) : undefined;
  return <Pill icon={field.icon} label={full ? field.label : undefined} value={value} color={color} hint={`${field.label}: ${value}`} />;
}

// What helps decide whether to pick it up: the boards it's on, then priority, effort and scope. Nothing when it has none.
export function IssuePills({ issue, full = false }: { issue: NextUpIssue; full?: boolean }) {
  const styles = useStyles();
  const projects = issue.projects ?? [];
  const fields = FIELDS.filter(({ role }) => issue[role]);
  if (projects.length === 0 && fields.length === 0) return null;
  return (
    <View style={[styles.wrap, { gap: 4, marginTop: 2 }]}>
      {projects.map((project) => (
        <ProjectPill key={project.id} project={project} />
      ))}
      {fields.map(({ role }) => (
        <FieldPill key={role} issue={issue} role={role} full={full} />
      ))}
    </View>
  );
}
