import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ago } from "../shared/format";
import type { AgentSummary, NextUpIssue, UnclaimedSource } from "../shared/attention";
import type { NextUpSource } from "../shared/config";
import type { IconName } from "./icons";
import type { FetchDetails } from "./attention-screen";
import { ActionSheet, DetailLines, type SheetEntry } from "./sheet";
import { Modal } from "@getpaseo/plugin/client/ui";
import { Button, KeepStyles, Meta, SectionHeader, TablerIcon, useHover, useStyles } from "./ui";

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
  agents: Record<string, AgentSummary>;
  busy: string | null;
  fetchDetails: FetchDetails;
  onStart: (issue: NextUpIssue, claim: boolean) => void;
  // Claim without starting, or give an assigned issue back [NXT-07].
  onClaim: (issue: NextUpIssue, on: boolean) => void;
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
  const styles = useStyles();
  return (
    <View style={styles.card}>
      {issues.map((issue, index) => (
        <IssueRow key={issue.key} issue={issue} claim={claim} first={index === 0} {...rowProps} />
      ))}
    </View>
  );
}

// The repo's name always shows, since where an issue lives is part of deciding to pick it up; the sheet has the owner too.
const facts = (issue: NextUpIssue) => [
  `#${issue.number}`,
  issue.repo.split("/")[1],
  `${ago(issue.createdAt)} old`,
  ...[issue.type, issue.priority, issue.effort, issue.scope].filter((v): v is string => !!v),
];

// Its main action and ⋯; tapping it opens the sheet with the description, Claim or Unclaim [ATT-06, NXT-07].
function IssueRow({ issue, claim, first, agents, busy, fetchDetails, onStart, onClaim, onOpenAgent }: RowProps & { issue: NextUpIssue; claim: boolean; first: boolean }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const agent = agents[issue.key];
  const startLabel = claim ? "Claim & start" : "Start";
  return (
    <View style={[styles.item, first ? null : styles.divider]}>
      <View style={{ paddingTop: 2 }}>
        <TablerIcon name={TYPE_ICONS[issue.type?.toLowerCase() ?? ""] ?? "issue"} size={18} color={issue.type === "Bug" ? styles.c.statusDanger : styles.c.foregroundMuted} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`${issue.title}, more`} onPress={() => setOpen(true)} style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {issue.title}
        </Text>
        <Meta facts={facts(issue)} chips={[]} />
      </Pressable>
      <View style={styles.wrap}>
        {busy === issue.key ? (
          <Text style={styles.muted}>working…</Text>
        ) : agent ? (
          <Button label={styles.compact ? undefined : "Continue"} icon="agent" variant="calm" onPress={() => onOpenAgent(agent.id)} />
        ) : (
          // Claim first so teammates see it's taken [NXT-05].
          <Button label={styles.compact ? undefined : startLabel} accessibilityLabel={`${startLabel} ${issue.title}`} icon="agent" variant="calm" onPress={() => onStart(issue, claim)} />
        )}
        <Button icon="dots" variant="ghost" accessibilityLabel="More actions" onPress={() => setOpen(true)} />
      </View>
      {open ? <IssueSheet issue={issue} claim={claim} agent={agent} fetchDetails={fetchDetails} onStart={onStart} onClaim={onClaim} onOpenAgent={onOpenAgent} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

function IssueSheet({
  issue,
  claim,
  agent,
  fetchDetails,
  onStart,
  onClaim,
  onOpenAgent,
  onClose,
}: Pick<Props, "fetchDetails" | "onStart" | "onClaim" | "onOpenAgent"> & { issue: NextUpIssue; claim: boolean; agent?: AgentSummary; onClose: () => void }) {
  const details = useQuery({
    queryKey: ["attention-span", "details", issue.key, false],
    queryFn: () => fetchDetails({ subject: { kind: "issue", repo: issue.repo, number: issue.number }, checks: false }),
    staleTime: 60_000,
  });
  const close = (then: () => void) => () => (onClose(), then());
  const entries: SheetEntry[] = [
    agent
      ? { key: "start", icon: "agent", label: "Continue", detail: "Opens the session started on this issue", onPress: close(() => onOpenAgent(agent.id)) }
      : {
          key: "start",
          icon: "agent",
          label: claim ? "Claim & start" : "Start",
          detail: `${claim ? "Assigns you, then an agent" : "An agent"} reads the issue and proposes a plan`,
          onPress: close(() => onStart(issue, claim)),
        },
    claim
      ? { key: "claim", icon: "claim", label: "Claim", detail: "Assigns you, without starting a session", onPress: close(() => onClaim(issue, true)) }
      : { key: "unclaim", icon: "unclaim", label: "Unclaim", detail: "Removes you as assignee, so it goes back to Unclaimed", onPress: close(() => onClaim(issue, false)) },
    { key: "github", icon: "github", label: "Open issue on GitHub", detail: `${issue.repo}#${issue.number}`, onPress: close(() => void openExternalUrl(issue.url)) },
  ];
  return (
    <ActionSheet
      title={issue.title}
      onClose={onClose}
      top={
        <>
          <Meta facts={[`${issue.repo}#${issue.number}`, ...facts(issue).slice(2)]} chips={[]} />
        </>
      }
      entries={entries}
      bottom={<DetailLines details={details.data} loading={details.isLoading} error={details.error} linkedLabel="PR" />}
    />
  );
}
