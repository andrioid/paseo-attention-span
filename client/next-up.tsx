import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ago, repoLabel, shortValue } from "../shared/format";
import { type AgentSummary, type Chip, type IssueCloseReason, matchSessions, type NextUpIssue, type UnclaimedSource } from "../shared/attention";
import type { NextUpSource } from "../shared/config";
import type { IconName } from "./icons";
import type { FetchDetails } from "./attention-screen";
import { CardList, CardRow, type Tone } from "./card";
import { openSessionEntry, sessionsGroup } from "./session-menu";
import { ActionSheet, DetailLines, type MenuGroup, MenuSheet, type SheetEntry } from "./sheet";
import { Modal } from "@getpaseo/plugin/client/ui";
import { type Anchor, Button, KeepStyles, Meta, SectionHeader, TablerIcon, useHover, useStyles } from "./ui";

const TYPE_ICONS: Record<string, IconName> = { bug: "bug", feature: "feature", debt: "debt", task: "task", epic: "epic" };

interface Props {
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  unclaimedFrom: UnclaimedSource;
  // Scopes I ticked in the filter; none means all [NXT-03].
  selected: string[];
  onSelect: (scopes: string[]) => void;
  // Where Next up looks, and the sources I ticked; none means all [NXT-09].
  sources: NextUpSource[];
  selectedSources: string[];
  onSelectSources: (sources: string[]) => void;
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

type RowProps = Omit<Props, "assigned" | "unclaimed" | "unclaimedFrom" | "selected" | "onSelect" | "sources" | "selectedSources" | "onSelectSources">;

// Assigned issues first [NXT-06], then unclaimed ones [NXT-01]; both already ranked by the server [NXT-02].
export function NextUpList({ assigned, unclaimed, unclaimedFrom, selected, onSelect, sources, selectedSources, onSelectSources, ...rowProps }: Props) {
  const styles = useStyles();
  const scopes = useMemo(() => [...new Set(unclaimed.map((issue) => issue.scope).filter((scope): scope is string => !!scope))].sort(), [unclaimed]);
  // Filter by the scopes I picked last time [NXT-03]; a picked scope with no issues left is ignored.
  const active = selected.filter((scope) => scopes.includes(scope));
  // And by source, when there's more than one [NXT-09]; a picked source no longer in settings is ignored.
  const activeSources = sources.length > 1 ? selectedSources.filter((id) => sources.some((source) => source.id === id)) : [];
  const shown = unclaimed.filter(
    (issue) => (active.length === 0 || (issue.scope && active.includes(issue.scope))) && (activeSources.length === 0 || issue.sources.some((id) => activeSources.includes(id))),
  );
  const toggle = (scope: string) => onSelect(active.includes(scope) ? active.filter((s) => s !== scope) : [...active, scope]);
  const toggleSource = (id: string) => onSelectSources(activeSources.includes(id) ? activeSources.filter((s) => s !== id) : [...activeSources, id]);
  const narrowedBy = [activeSources.length ? "sources" : null, active.length ? "scopes" : null].filter(Boolean).join(" and ");
  const [filtering, setFiltering] = useState(false);
  const picked = active.length + activeSources.length;
  const groups: FilterGroup[] = [
    ...(sources.length > 1 ? [{ title: "Source", options: sources, active: activeSources, onToggle: toggleSource }] : []),
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
            onClear={() => {
              onSelect([]);
              onSelectSources([]);
            }}
            onClose={() => setFiltering(false)}
          />
        ) : null}
        {unclaimedFrom === "none" ? (
          <Text style={styles.text}>No repos to look in. Register a project in Paseo, or choose where Next up looks in Settings.</Text>
        ) : shown.length === 0 ? (
          <Text style={styles.text}>No unclaimed issues{narrowedBy ? ` in these ${narrowedBy}` : ""}.</Text>
        ) : (
          <IssueList issues={shown} claim {...rowProps} />
        )}
      </View>
    </View>
  );
}

// Source and scope filters behind one button, so they take no room above the list [NXT-03, NXT-09].
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
                  <FilterOption key={option.id} label={option.label} checked={group.active.includes(option.id)} first={index === 0} onPress={() => group.onToggle(option.id)} />
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
  options: { id: string; label: string }[];
  active: string[];
  onToggle: (id: string) => void;
}

function FilterOption({ label, checked, first, onPress }: { label: string; checked: boolean; first: boolean; onPress: () => void }) {
  const styles = useStyles();
  const { hovered, hover } = useHover();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onPress}
      {...hover}
      style={({ pressed }) => [
        styles.row,
        { paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed || hovered ? styles.c.border : "transparent" },
        first ? null : { borderTopWidth: 1, borderTopColor: styles.c.surface1 },
      ]}
    >
      <TablerIcon name={checked ? "squareCheck" : "square"} size={18} color={checked ? styles.action : styles.c.foregroundMuted} />
      <Text style={styles.text}>{label}</Text>
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

// What tells me whether to pick it up: where it lives and how old it is, then priority, effort and scope as tags [NXT-10].
// The type is the mark. The sheet has the full values.
const fullFacts = (issue: NextUpIssue) => [
  `${issue.repo}#${issue.number}`,
  `${ago(issue.createdAt)} old`,
  ...[issue.type, issue.priority, issue.effort, issue.scope].filter((v): v is string => !!v),
];

// An open PR that closes it means someone may already be on it [NXT-10].
function prSignal(issue: NextUpIssue): Chip[] {
  const [first, ...more] = issue.openPrs;
  if (!first) return [];
  return [{ text: `PR by ${first.author ?? "someone"}${more.length ? ` +${more.length}` : ""}`, tone: "warn" }];
}

// The top priority is warm, the next accent, the rest quiet; unknown order stays quiet.
function Tags({ issue }: { issue: NextUpIssue }) {
  const styles = useStyles();
  const priorityColor = issue.priorityRank === 0 ? styles.c.statusWarning : issue.priorityRank === 1 ? styles.action : undefined;
  const tags = [
    issue.priority ? { key: "priority", text: shortValue(issue.priority), color: priorityColor } : null,
    issue.effort ? { key: "effort", text: shortValue(issue.effort) } : null,
    issue.scope ? { key: "scope", text: shortValue(issue.scope) } : null,
  ].filter((tag): tag is { key: string; text: string; color?: string } => !!tag);
  if (tags.length === 0) return null;
  return (
    <View style={[styles.wrap, { gap: 4, marginTop: 2 }]}>
      {tags.map((tag) => (
        <Text
          key={tag.key}
          style={{
            fontSize: 11,
            color: tag.color ?? styles.c.foregroundMuted,
            borderWidth: 1,
            borderColor: tag.color ?? styles.c.border,
            borderRadius: 4,
            paddingHorizontal: 5,
            paddingVertical: 1,
          }}
        >
          {tag.text}
        </Text>
      ))}
    </View>
  );
}

// The type as the card's mark: red bugs, green features and epics, amber debt, the rest quiet.
const TYPE_TONES: Record<string, Tone> = { bug: "bad", feature: "good", epic: "good", debt: "warn" };

// Its main action and ⋯; tapping it opens the sheet with the description, Claim or Unclaim [ATT-06, NXT-07].
function IssueRow({ issue, claim, first, agents, login, busy, fetchDetails, onStart, onOptions, onClaim, onCloseIssue, onOpenAgent }: RowProps & { issue: NextUpIssue; claim: boolean; first: boolean }) {
  // The sheet, or the split button's menu.
  const [sheet, setSheet] = useState<"item" | { anchor?: Anchor } | null>(null);
  // Closing asks first, with the reason and an optional comment [NXT-11, SAFE-01].
  const [closing, setClosing] = useState(false);
  // An open session leads; without one, Start does [SES-03].
  const sessions = matchSessions(agents, [issue.key]);
  const startLabel = claim ? "Claim & start" : "Start";
  const type = issue.type?.toLowerCase() ?? "";
  const close = (reason: IssueCloseReason) => (comment: string) => (setClosing(false), onCloseIssue(issue, reason, comment));
  const onMenu = (anchor: Anchor | undefined) => setSheet({ anchor });
  const done = (then: () => void) => () => (setSheet(null), then());
  const withOptions: SheetEntry = {
    key: "start-options",
    icon: "agent",
    label: `${startLabel} with options…`,
    detail: "Choose the workspace, agent profile and prompt first",
    onPress: done(() => onOptions(issue, claim, startLabel)),
  };
  const groups: MenuGroup[] = sessions.length
    ? [
        sessionsGroup(sessions, (agentId) => done(() => onOpenAgent(agentId))()),
        { title: "Start a new one", entries: [{ ...startEntry(claim), onPress: done(() => onStart(issue, claim)) }, withOptions] },
      ]
    : [{ entries: [withOptions] }];
  return (
    <CardRow
      first={first}
      mark={{ icon: TYPE_ICONS[type] ?? "issue", tone: TYPE_TONES[type] ?? "neutral" }}
      title={issue.title}
      accessibilityLabel={`${issue.type ? `${issue.type}: ` : ""}${issue.title}, more`}
      meta={{ place: `${repoLabel(issue.repo, login)} #${issue.number}`, when: `${ago(issue.createdAt)} old`, signals: prSignal(issue) }}
      extra={<Tags issue={issue} />}
      onOpen={() => setSheet("item")}
      busy={busy.has(issue.key)}
      primary={
        sessions[0]
          ? { label: "Open session", icon: "agent", onPress: () => onOpenAgent(sessions[0].id), menu: { label: "Session choices", onPress: onMenu } }
          : // Claim first so teammates see it's taken [NXT-05].
            { label: startLabel, accessibilityLabel: `${startLabel} ${issue.title}`, icon: "agent", onPress: () => onStart(issue, claim), menu: { label: `${startLabel} choices`, onPress: onMenu } }
      }
      secondary={[{ label: "More actions", icon: "dots", onPress: () => setSheet("item") }]}
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
        sheet === "item" ? (
          <IssueSheet
            issue={issue}
            claim={claim}
            sessions={sessions}
            fetchDetails={fetchDetails}
            onStart={onStart}
            onClaim={onClaim}
            onOpenAgent={onOpenAgent}
            onMenu={onMenu}
            onCloseIssue={() => setClosing(true)}
            onClose={() => setSheet(null)}
          />
        ) : sheet ? (
          <MenuSheet title={issue.title} anchor={sheet.anchor} groups={groups} onClose={() => setSheet(null)} />
        ) : null
      }
    />
  );
}

const startEntry = (claim: boolean): Omit<SheetEntry, "onPress"> => ({
  key: "start",
  icon: "agent",
  label: claim ? "Claim & start" : "Start",
  detail: `${claim ? "Assigns you, then an agent" : "An agent"} reads the issue and proposes a plan`,
});

function IssueSheet({
  issue,
  claim,
  sessions,
  fetchDetails,
  onStart,
  onClaim,
  onOpenAgent,
  onMenu,
  onCloseIssue,
  onClose,
}: Pick<Props, "fetchDetails" | "onStart" | "onClaim" | "onOpenAgent"> & {
  issue: NextUpIssue;
  claim: boolean;
  sessions: AgentSummary[];
  onMenu: (anchor: Anchor | undefined) => void;
  onCloseIssue: () => void;
  onClose: () => void;
}) {
  const details = useQuery({
    queryKey: ["attention-span", "details", issue.key, false],
    queryFn: () => fetchDetails({ subject: { kind: "issue", repo: issue.repo, number: issue.number }, checks: false }),
    staleTime: 60_000,
  });
  const close = (then: () => void) => () => (onClose(), then());
  const entries: SheetEntry[] = [
    sessions.length
      ? openSessionEntry(sessions, (agentId) => close(() => onOpenAgent(agentId))(), { label: "Session choices", onPress: onMenu })
      : { ...startEntry(claim), onPress: close(() => onStart(issue, claim)), menu: { label: `${claim ? "Claim & start" : "Start"} choices`, onPress: onMenu } },
    claim
      ? { key: "claim", icon: "claim", label: "Claim", detail: "Assigns you, without starting a session", onPress: close(() => onClaim(issue, true)) }
      : { key: "unclaim", icon: "unclaim", label: "Unclaim", detail: "Removes you as assignee, so it goes back to Unclaimed", onPress: close(() => onClaim(issue, false)) },
    { key: "github", icon: "github", label: "Open issue on GitHub", detail: `${issue.repo}#${issue.number}`, onPress: close(() => void openExternalUrl(issue.url)) },
    { key: "close", icon: "issueClosed", label: "Close issue", detail: "Asks first: as completed or not planned, with an optional comment", onPress: close(onCloseIssue) },
  ];
  return (
    <ActionSheet
      title={issue.title}
      onClose={onClose}
      top={
        <>
          <Meta facts={fullFacts(issue)} chips={prSignal(issue)} />
        </>
      }
      entries={entries}
      bottom={<DetailLines details={details.data} loading={details.isLoading} error={details.error} linkedLabel="PR" />}
    />
  );
}
