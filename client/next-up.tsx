import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ago } from "../shared/format";
import {
  type AgentSummary,
  type Chip,
  type GithubColor,
  type IssueCloseReason,
  matchSessions,
  type NextUpIssue,
  type ProjectInfo,
  projectFilterId,
  projectFilterIds,
  type UnclaimedSource,
} from "../shared/attention";
import type { NextUpSource } from "../shared/config";
import type { IconName } from "./icons";
import type { FetchDetails } from "./attention-screen";
import { CardList, CardRow, type Tone } from "./card";
import { sessionEntry, startAnotherEntry } from "./session-menu";
import { ActionSheet, DETAILS_STALE_MS, DetailLines, type DetailsQuery, detailsKey, type SheetEntry, useSheetOpener } from "./sheet";
import { Modal } from "@getpaseo/plugin/client/ui";
import { githubColor, IssuePills, PlaceText } from "./entity";
import { Button, KeepStyles, Meta, SectionHeader, TablerIcon, useHover, useStyles } from "./ui";

const TYPE_ICONS: Record<string, IconName> = { bug: "bug", feature: "feature", debt: "debt", task: "task", epic: "epic" };

interface Props {
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  unclaimedFrom: UnclaimedSource;
  // Scopes I ticked in the filter; none means all [NXT-03].
  selected: string[];
  // Where Next up looks, and the sources I ticked; none means all [NXT-09].
  sources: NextUpSource[];
  selectedSources: string[];
  // The projects Next up's issues are on, and the statuses I ticked; none means all [NXT-03, NXT-12].
  projects: ProjectInfo[];
  selectedProjects: string[];
  // Change any filter or all at once, so Clear empties them in one go.
  onFilter: (change: FilterChange) => void;
  agents: AgentSummary[];
  // Mine, so my repos show without the owner.
  login: string | null;
  busy: ReadonlySet<string>;
  fetchDetails: FetchDetails;
  onStart: (issue: NextUpIssue, claim: boolean) => void;
  // The same, choosing the workspace, profile and prompt first [SES-02]; `label` names it.
  onOptions: (issue: NextUpIssue, claim: boolean, label: string) => void;
  // Claim without starting, or give an assigned issue back [NXT-07].
  onClaim: (issue: NextUpIssue, on: boolean) => void;
  // Close it, once I've confirmed the reason [NXT-11].
  onCloseIssue: (issue: NextUpIssue, reason: IssueCloseReason, comment: string) => void;
  onOpenAgent: (agentId: string) => void;
}

type FilterChange = { scopes?: string[]; sources?: string[]; projectFilter?: string[] };

type RowProps = Omit<Props, "assigned" | "unclaimed" | "unclaimedFrom" | "selected" | "sources" | "selectedSources" | "projects" | "selectedProjects" | "onFilter">;

// Assigned issues first [NXT-06], then unclaimed ones [NXT-01]; both already ranked by the server [NXT-02].
export function NextUpList({ assigned, unclaimed, unclaimedFrom, selected, sources, selectedSources, projects, selectedProjects, onFilter, ...rowProps }: Props) {
  const styles = useStyles();
  const scopes = useMemo(() => [...new Set(unclaimed.map((issue) => issue.scope).filter((scope): scope is string => !!scope))].sort(), [unclaimed]);
  // Filter by the scopes I picked last time [NXT-03]; a picked scope with no issues left is ignored.
  const active = selected.filter((scope) => scopes.includes(scope));
  // And by source, when there's more than one [NXT-09]; a picked source no longer in settings is ignored.
  const activeSources = sources.length > 1 ? selectedSources.filter((id) => sources.some((source) => source.id === id)) : [];
  // And by project and status [NXT-03, NXT-12]; a picked status no longer offered is ignored.
  const tree = useMemo(() => projectTree(unclaimed, projects), [unclaimed, projects]);
  const leaves = tree.flatMap((node) => node.children.map((child) => child.id));
  const activeProjects = selectedProjects.filter((id) => leaves.includes(id));
  const shown = unclaimed.filter(
    (issue) =>
      (active.length === 0 || (issue.scope && active.includes(issue.scope))) &&
      (activeSources.length === 0 || issue.sources.some((id) => activeSources.includes(id))) &&
      (activeProjects.length === 0 || projectFilterIds(issue).some((id) => activeProjects.includes(id))),
  );
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((other) => other !== id) : [...list, id]);
  const toggle = (scope: string) => onFilter({ scopes: flip(active, scope) });
  const toggleSource = (id: string) => onFilter({ sources: flip(activeSources, id) });
  // A project ticks or clears all its statuses at once; partly ticked, it clears them.
  const toggleProject = (id: string) => {
    const children = tree.find((node) => node.id === id)?.children.map((child) => child.id);
    if (!children) return onFilter({ projectFilter: flip(activeProjects, id) });
    const any = children.some((child) => activeProjects.includes(child));
    onFilter({ projectFilter: any ? activeProjects.filter((other) => !children.includes(other)) : [...activeProjects, ...children] });
  };
  const narrowedBy = [activeSources.length ? "sources" : null, activeProjects.length ? "projects" : null, active.length ? "scopes" : null].filter(Boolean);
  const [filtering, setFiltering] = useState(false);
  // A project ticked whole counts once.
  const projectsPicked = tree.reduce((sum, node) => {
    const on = node.children.filter((child) => activeProjects.includes(child.id)).length;
    return sum + (on === node.children.length ? 1 : on);
  }, 0);
  const picked = active.length + activeSources.length + projectsPicked;
  const projectOptions: FilterOption[] = tree.flatMap((node) => {
    if (node.children.length === 1 && node.children[0].id === node.id) return [{ id: node.id, label: node.title }];
    const on = node.children.filter((child) => activeProjects.includes(child.id)).length;
    return [
      { id: node.id, label: node.title, strong: true, state: on === 0 ? "off" : on === node.children.length ? "on" : "partial" },
      ...node.children.map((child) => ({ ...child, indent: true })),
    ];
  });
  const groups: FilterGroup[] = [
    ...(sources.length > 1 ? [{ title: "Source", options: sources, active: activeSources, onToggle: toggleSource }] : []),
    ...(projectOptions.length > 0 ? [{ title: "Project", options: projectOptions, active: activeProjects, onToggle: toggleProject }] : []),
    ...(scopes.length > 0 ? [{ title: "Scope", options: scopes.map((scope) => ({ id: scope, label: scope })), active, onToggle: toggle }] : []),
  ];

  return (
    <View style={{ gap: 24 }}>
      {assigned.length > 0 ? (
        <View>
          <SectionHeader icon="claim" title="Assigned to you" count={assigned.length} />
          <IssueList issues={assigned} claim={false} {...rowProps} />
        </View>
      ) : null}
      <View>
        <SectionHeader
          icon="nextUp"
          title="Unclaimed"
          count={shown.length}
          action={
            groups.length > 0 ? (
              <Button
                label={picked ? `Filter · ${picked}` : "Filter"}
                accessibilityLabel={picked ? `Filter, ${picked} on` : "Filter"}
                icon="filter"
                variant={picked ? "calm" : "ghost"}
                onPress={() => setFiltering(true)}
              />
            ) : null
          }
        />
        {filtering ? (
          <FilterSheet
            groups={groups}
            onClear={() => onFilter({ scopes: [], sources: [], projectFilter: [] })}
            onClose={() => setFiltering(false)}
          />
        ) : null}
        {unclaimedFrom === "none" ? (
          <Text style={styles.text}>No repos to look in. Register a project in Paseo, or choose where Next up looks in Settings.</Text>
        ) : shown.length === 0 ? (
          <Text style={styles.text}>No unclaimed issues{narrowedBy.length ? ` in these ${narrowedBy.join(" and ")}` : ""}.</Text>
        ) : (
          <IssueList issues={shown} claim {...rowProps} />
        )}
      </View>
    </View>
  );
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

// Source, project and scope filters behind one button, so they take no room above the list [NXT-03, NXT-09].
// Ticks apply right away; a bottom sheet on phones, a dialog on desktop.
function FilterSheet({ groups, onClear, onClose }: { groups: FilterGroup[]; onClear: () => void; onClose: () => void }) {
  const styles = useStyles();
  const any = groups.some((group) => group.active.length > 0);
  return (
    <Modal title="Filter" open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          {groups.map((group) => (
            <View key={group.title} style={{ gap: 6 }}>
              <Text style={styles.muted}>{group.title}</Text>
              <View style={[styles.card, { backgroundColor: styles.c.surface2 }]}>
                {group.options.map((option, index) => (
                  <FilterRow
                    key={`${option.id}:${option.strong ? "project" : "leaf"}`}
                    option={option}
                    state={option.state ?? (group.active.includes(option.id) ? "on" : "off")}
                    first={index === 0}
                    onPress={() => group.onToggle(option.id)}
                  />
                ))}
              </View>
            </View>
          ))}
          <View style={[styles.row, { justifyContent: "flex-end" }]}>
            <Button label="Clear" variant="ghost" disabled={!any} onPress={onClear} />
            <Button label="Done" variant="solid" onPress={onClose} />
          </View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

interface FilterGroup {
  title: string;
  options: FilterOption[];
  active: string[];
  onToggle: (id: string) => void;
}

interface FilterOption {
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
}

function FilterRow({ option, state, first, onPress }: { option: FilterOption; state: "on" | "partial" | "off"; first: boolean; onPress: () => void }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  const checked = state === "on";
  const color = githubColor(styles, option.color);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: state === "partial" ? "mixed" : checked }}
      aria-checked={state === "partial" ? "mixed" : checked}
      accessibilityLabel={option.label}
      onPress={onPress}
      {...hover}
      style={({ pressed }) => [
        styles.row,
        { paddingVertical: 10, paddingRight: 12, paddingLeft: option.indent ? 40 : 12, backgroundColor: pressed || hovered ? styles.c.border : "transparent" },
        first ? null : { borderTopWidth: 1, borderTopColor: styles.c.surface1 },
      ]}
    >
      <TablerIcon name={state === "on" ? "squareCheck" : state === "partial" ? "squareMinus" : "square"} size={18} color={state === "off" ? styles.c.foregroundMuted : styles.action} />
      {option.indent ? (
        <View
          style={{ width: 8, height: 8, borderRadius: 4, ...(option.color ? { backgroundColor: color ?? styles.c.foregroundMuted } : { borderWidth: 1.5, borderColor: styles.c.foregroundMuted }) }}
        />
      ) : null}
      <Text style={[styles.text, option.strong ? { fontWeight: "600" } : null, option.dim ? { opacity: 0.45 } : null]}>{option.label}</Text>
    </Pressable>
  );
}

function IssueList({ issues, claim, ...rowProps }: RowProps & { issues: NextUpIssue[]; claim: boolean }) {
  return (
    <CardList>
      {issues.map((issue, index) => (
        <IssueRow key={issue.key} issue={issue} claim={claim} first={index === 0} {...rowProps} />
      ))}
    </CardList>
  );
}

// An open PR that closes it means someone may already be on it [NXT-10].
function prSignal(issue: NextUpIssue): Chip[] {
  const [first, ...more] = issue.openPrs;
  if (!first) return [];
  return [{ text: `PR by ${first.author ?? "someone"}${more.length ? ` +${more.length}` : ""}`, tone: "warn" }];
}

// What an issue's sheet fetches when it opens; its card fetches the same ahead, so the sheet opens complete [ATT-06].
function issueDetailsQuery(issue: NextUpIssue, fetchDetails: FetchDetails): DetailsQuery {
  const subject = { kind: "issue" as const, repo: issue.repo, number: issue.number };
  return { queryKey: detailsKey(subject, undefined, false), queryFn: () => fetchDetails({ subject, checks: false }) };
}

// The type as the card's mark: red bugs, green features and epics, amber debt, the rest quiet.
const TYPE_TONES: Record<string, Tone> = { bug: "bad", feature: "good", epic: "good", debt: "warn" };

// Its main action and ›; tapping it opens the sheet with the description, Claim or Unclaim [ATT-06, NXT-07].
function IssueRow({ issue, claim, first, agents, login, busy, fetchDetails, onStart, onOptions, onClaim, onCloseIssue, onOpenAgent }: RowProps & { issue: NextUpIssue; claim: boolean; first: boolean }) {
  const [sheet, setSheet] = useState(false);
  // The sheet opens once its details are in; meanwhile › spins [ATT-06].
  const opener = useSheetOpener(issueDetailsQuery(issue, fetchDetails), () => setSheet(true));
  // Closing asks first, with the reason and an optional comment [NXT-11, SAFE-01].
  const [closing, setClosing] = useState(false);
  // An open session leads; without one, Start does [SES-03].
  const sessions = matchSessions(agents, [issue.key]);
  const startLabel = claim ? "Claim & start" : "Start";
  const type = issue.type?.toLowerCase() ?? "";
  const close = (reason: IssueCloseReason) => (comment: string) => (setClosing(false), onCloseIssue(issue, reason, comment));
  return (
    <CardRow
      first={first}
      mark={{ icon: TYPE_ICONS[type] ?? "issue", tone: TYPE_TONES[type] ?? "neutral" }}
      title={issue.title}
      accessibilityLabel={`${issue.type ? `${issue.type}: ` : ""}${issue.title}, more`}
      meta={{ place: { repo: issue.repo, number: issue.number, login }, when: `${ago(issue.createdAt)} old`, signals: prSignal(issue) }}
      extra={<IssuePills issue={issue} />}
      onOpen={opener.open}
      opening={opener.opening}
      hover={opener.hover}
      busy={busy.has(issue.key)}
      primary={
        sessions[0]
          ? { label: "Open session", icon: "agent", onPress: () => onOpenAgent(sessions[0].id) }
          : // Claim first so teammates see it's taken [NXT-05].
            { label: startLabel, accessibilityLabel: `${startLabel} ${issue.title}`, icon: "agent", onPress: () => onStart(issue, claim) }
      }
      secondary={[{ label: `Details for #${issue.number}`, icon: "chevronRight", onPress: opener.open }]}
      confirm={
        closing
          ? {
              text: `Close #${issue.number}? A comment is only posted if you write one.`,
              comment: true,
              choices: [
                { label: "Completed", icon: "issueClosed", solid: true, onConfirm: close("completed") },
                { label: "Not planned", icon: "close", onConfirm: close("not_planned") },
              ],
              onCancel: () => setClosing(false),
            }
          : null
      }
      overlay={
        sheet ? (
          <IssueSheet
            issue={issue}
            claim={claim}
            sessions={sessions}
            fetchDetails={fetchDetails}
            onOptions={onOptions}
            onClaim={onClaim}
            onOpenAgent={onOpenAgent}
            onCloseIssue={() => setClosing(true)}
            onClose={() => setSheet(false)}
          />
        ) : null
      }
    />
  );
}

function IssueSheet({
  issue,
  claim,
  sessions,
  fetchDetails,
  onOptions,
  onClaim,
  onOpenAgent,
  onCloseIssue,
  onClose,
}: Pick<Props, "fetchDetails" | "onOptions" | "onClaim" | "onOpenAgent"> & {
  issue: NextUpIssue;
  claim: boolean;
  sessions: AgentSummary[];
  onCloseIssue: () => void;
  onClose: () => void;
}) {
  const details = useQuery({ ...issueDetailsQuery(issue, fetchDetails), staleTime: DETAILS_STALE_MS });
  const close = (then: () => void) => () => (onClose(), then());
  const startLabel = claim ? "Claim & start" : "Start";
  const withOptions = close(() => onOptions(issue, claim, startLabel));
  // Its sessions in Start's place; until there's one, Start asks first, since the card's button is the one-tap start [SES-01, SES-02, SES-03].
  const entries: SheetEntry[] = [
    ...(sessions.length
      ? sessions.map((agent) => sessionEntry(agent, "Continue session", (agentId) => close(() => onOpenAgent(agentId))()))
      : [
          {
            key: "start",
            icon: "agent" as const,
            label: `${startLabel}…`,
            detail: `${claim ? "Assigns you, then an agent" : "An agent"} reads the issue and proposes a plan`,
            onPress: withOptions,
          },
        ]),
    claim
      ? { key: "claim", icon: "claim", label: "Claim", detail: "Assigns you, without starting a session", onPress: close(() => onClaim(issue, true)) }
      : { key: "unclaim", icon: "unclaim", label: "Unclaim", detail: "Removes you as assignee, so it goes back to Unclaimed", onPress: close(() => onClaim(issue, false)) },
    { key: "github", icon: "github", label: "Open issue on GitHub", detail: `${issue.repo}#${issue.number}`, onPress: close(() => void openExternalUrl(issue.url)) },
    ...(sessions.length ? [startAnotherEntry(true, withOptions)] : []),
    { key: "close", icon: "issueClosed", label: "Close issue", detail: "Asks first: as completed or not planned, with an optional comment", onPress: close(onCloseIssue) },
  ];
  return (
    <ActionSheet
      title={issue.title}
      onClose={onClose}
      top={
        <>
          {/* The sheet always names the owner, even of my own repos. */}
          <Meta lead={<PlaceText place={{ repo: issue.repo, number: issue.number, login: null }} />} facts={[`${ago(issue.createdAt)} old`, ...(issue.type ? [issue.type] : [])]} chips={prSignal(issue)} />
          <IssuePills issue={issue} full />
        </>
      }
      entries={entries}
      // One line per open PR the card already knows closes it [ATT-06].
      bottom={<DetailLines details={details.data} loading={details.isLoading} error={details.error} linkedLabel="PR" expected={issue.openPrs.length} />}
    />
  );
}
