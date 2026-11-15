// Next up's Filter: which ticks still count, which unclaimed issues they leave, and what the sheet offers [NXT-03, NXT-09, NXT-12].
// Drawn by client/sheet.tsx's FilterSheet.
import { type GithubColor, type NextUpIssue, type ProjectInfo, projectFilterId, projectFilterIds } from "./attention";
import type { NextUpSource } from "./config";

export type FilterKind = "sources" | "projects" | "scopes";
export type FilterChange = { scopes?: string[]; sources?: string[]; projectFilter?: string[] };

export interface FilterOption {
  id: string;
  label: string;
  // A project's statuses sit under it, each with its board color.
  indent?: boolean;
  color?: GithubColor;
  // A status no unclaimed issue has right now.
  dim?: boolean;
  // A project, ticked as a whole, partly, or not, by its statuses.
  strong?: boolean;
  state?: "on" | "partial" | "off";
  // Always ticked, with a note why, like History's Finished [HIS-07].
  disabled?: boolean;
  note?: string;
}

export interface FilterGroup {
  kind: FilterKind;
  title: string;
  options: FilterOption[];
  active: string[];
}

export interface NextUpFilterInput {
  unclaimed: NextUpIssue[];
  // What I ticked, as saved; none means all.
  selected: string[];
  sources: NextUpSource[];
  selectedSources: string[];
  projects: ProjectInfo[];
  selectedProjects: string[];
}

export interface NextUpFilter {
  shown: NextUpIssue[];
  // How many ticks the Filter button counts; a project ticked whole counts once.
  picked: number;
  groups: FilterGroup[];
  // Unclaimed's line when nothing's left.
  empty: string;
  // What a tick changes, to save.
  toggle: (kind: FilterKind, id: string) => FilterChange;
}

export const CLEAR_FILTER: FilterChange = { scopes: [], sources: [], projectFilter: [] };

export function nextUpFilter({ unclaimed, selected, sources, selectedSources, projects, selectedProjects }: NextUpFilterInput): NextUpFilter {
  const scopes = [...new Set(unclaimed.map((issue) => issue.scope).filter((scope): scope is string => !!scope))].sort();
  // A picked scope with no issues left is ignored [NXT-03].
  const active = selected.filter((scope) => scopes.includes(scope));
  // Sources filter only when there's more than one; a picked source no longer in settings is ignored [NXT-09].
  const activeSources = sources.length > 1 ? selectedSources.filter((id) => sources.some((source) => source.id === id)) : [];
  // A picked status no longer offered is ignored [NXT-03, NXT-12].
  const tree = projectTree(unclaimed, projects);
  const leaves = tree.flatMap((node) => node.children.map((child) => child.id));
  const activeProjects = selectedProjects.filter((id) => leaves.includes(id));
  const shown = unclaimed.filter(
    (issue) =>
      (active.length === 0 || (issue.scope && active.includes(issue.scope))) &&
      (activeSources.length === 0 || issue.sources.some((id) => activeSources.includes(id))) &&
      (activeProjects.length === 0 || projectFilterIds(issue).some((id) => activeProjects.includes(id))),
  );
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((other) => other !== id) : [...list, id]);
  // A project ticks or clears all its statuses at once; partly ticked, it clears them.
  const toggleProject = (id: string): FilterChange => {
    const children = tree.find((node) => node.id === id)?.children.map((child) => child.id);
    if (!children) return { projectFilter: flip(activeProjects, id) };
    const any = children.some((child) => activeProjects.includes(child));
    return { projectFilter: any ? activeProjects.filter((other) => !children.includes(other)) : [...activeProjects, ...children] };
  };
  const toggle = (kind: FilterKind, id: string): FilterChange =>
    kind === "scopes" ? { scopes: flip(active, id) } : kind === "sources" ? { sources: flip(activeSources, id) } : toggleProject(id);
  const projectsPicked = tree.reduce((sum, node) => {
    const on = node.children.filter((child) => activeProjects.includes(child.id)).length;
    return sum + (on === node.children.length ? 1 : on);
  }, 0);
  const projectOptions: FilterOption[] = tree.flatMap((node) => {
    if (node.children.length === 1 && node.children[0].id === node.id) return [{ id: node.id, label: node.title }];
    const on = node.children.filter((child) => activeProjects.includes(child.id)).length;
    return [
      { id: node.id, label: node.title, strong: true, state: on === 0 ? "off" : on === node.children.length ? "on" : "partial" },
      ...node.children.map((child) => ({ ...child, indent: true })),
    ];
  });
  const groups: FilterGroup[] = [
    ...(sources.length > 1 ? [{ kind: "sources" as const, title: "Source", options: sources, active: activeSources }] : []),
    ...(projectOptions.length > 0 ? [{ kind: "projects" as const, title: "Project", options: projectOptions, active: activeProjects }] : []),
    ...(scopes.length > 0 ? [{ kind: "scopes" as const, title: "Scope", options: scopes.map((scope) => ({ id: scope, label: scope })), active }] : []),
  ];
  const narrowedBy = [activeSources.length ? "sources" : null, activeProjects.length ? "projects" : null, active.length ? "scopes" : null].filter(Boolean);
  return {
    shown,
    picked: active.length + activeSources.length + projectsPicked,
    groups,
    empty: `No unclaimed issues${narrowedBy.length ? ` in these ${narrowedBy.join(" and ")}` : ""}.`,
    toggle,
  };
}

// A project in the filter with its statuses under it, all of them in the board's order, dimmed where no unclaimed issue has
// one; "No status" where some issue on it has none, and "No project" last, where some issue is on none [NXT-03, NXT-12].
// Only projects the unclaimed issues are on; none at all when projects can't be read.
interface ProjectNode {
  id: string;
  title: string;
  children: FilterOption[];
}

function projectTree(unclaimed: NextUpIssue[], projects: ProjectInfo[]): ProjectNode[] {
  if (!unclaimed.some((issue) => issue.projects)) return [];
  const on = (project: ProjectInfo) => unclaimed.flatMap((issue) => (issue.projects ?? []).filter((p) => p.id === project.id));
  const nodes: ProjectNode[] = projects.flatMap((project) => {
    const items = on(project);
    if (items.length === 0) return [];
    const statuses = project.statuses.map((status) => ({
      id: projectFilterId(project, status.name),
      label: status.name,
      color: status.color,
      dim: !items.some((item) => item.status === status.name),
    }));
    // A status the board no longer offers still filters, after the board's own.
    const gone = [...new Set(items.map((item) => item.status).filter((name): name is string => !!name && !project.statuses.some((s) => s.name === name)))];
    const none = items.some((item) => !item.status) ? [{ id: projectFilterId(project, null), label: "No status" }] : [];
    return [{ id: project.id, title: project.title, children: [...statuses, ...gone.map((name) => ({ id: projectFilterId(project, name), label: name })), ...none] }];
  });
  const loose = unclaimed.some((issue) => issue.projects && issue.projects.length === 0);
  const noProject = projectFilterId(null);
  return loose ? [...nodes, { id: noProject, title: "No project", children: [{ id: noProject, label: "No project" }] }] : nodes;
}
