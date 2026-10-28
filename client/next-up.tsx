import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ago } from "../shared/format";
import type { AgentSummary, NextUpIssue } from "../shared/attention";
import type { IconName } from "./icons";
import type { FetchDetails } from "./attention-screen";
import { ActionSheet, DetailLines, type SheetEntry } from "./sheet";
import { Button, Meta, SectionHeader, TablerIcon, Toggle, useStyles } from "./ui";

const TYPE_ICONS: Record<string, IconName> = { bug: "bug", feature: "feature", debt: "debt", task: "task", epic: "epic" };

interface Props {
  assigned: NextUpIssue[];
  unclaimed: NextUpIssue[];
  // Scope chips I picked; none means all [NXT-03].
  selected: string[];
  onSelect: (scopes: string[]) => void;
  agents: Record<string, AgentSummary>;
  busy: string | null;
  fetchDetails: FetchDetails;
  onStart: (issue: NextUpIssue, claim: boolean) => void;
  // Claim without starting, or give an assigned issue back [NXT-07].
  onClaim: (issue: NextUpIssue, on: boolean) => void;
  onOpenAgent: (agentId: string) => void;
}

type RowProps = Omit<Props, "assigned" | "unclaimed" | "selected" | "onSelect">;

// Assigned issues first [NXT-06], then unclaimed ones [NXT-01]; both already ranked by the server [NXT-02].
export function NextUpList({ assigned, unclaimed, selected, onSelect, ...rowProps }: Props) {
  const styles = useStyles();
  const scopes = useMemo(() => [...new Set(unclaimed.map((issue) => issue.scope).filter((scope): scope is string => !!scope))].sort(), [unclaimed]);
  // Filter by the scopes I picked last time [NXT-03]; a picked scope with no issues left is ignored.
  const active = selected.filter((scope) => scopes.includes(scope));
  const shown = active.length === 0 ? unclaimed : unclaimed.filter((issue) => issue.scope && active.includes(issue.scope));
  const toggle = (scope: string) => onSelect(active.includes(scope) ? active.filter((s) => s !== scope) : [...active, scope]);

  return (
    <View style={{ gap: 24 }}>
      {assigned.length > 0 ? (
        <View>
          <SectionHeader icon="claim" title="Assigned to you" count={assigned.length} />
          <IssueList issues={assigned} claim={false} {...rowProps} />
        </View>
      ) : null}
      <View>
        <SectionHeader icon="nextUp" title="Unclaimed" count={shown.length} />
        {scopes.length > 0 ? (
          <View style={[styles.wrap, { marginBottom: 10 }]}>
            <Toggle label="All" active={active.length === 0} onPress={() => onSelect([])} />
            {scopes.map((scope) => (
              <Toggle key={scope} label={scope} active={active.includes(scope)} onPress={() => toggle(scope)} />
            ))}
          </View>
        ) : null}
        {shown.length === 0 ? <Text style={styles.text}>No unclaimed issues{active.length ? " in these scopes" : ""}.</Text> : <IssueList issues={shown} claim {...rowProps} />}
      </View>
    </View>
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

const facts = (issue: NextUpIssue) => [`#${issue.number}`, `${ago(issue.createdAt)} old`, ...[issue.type, issue.priority, issue.effort, issue.scope].filter((v): v is string => !!v)];

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
    { key: "github", icon: "github", label: "Open on GitHub", detail: `${issue.repo}#${issue.number}`, onPress: close(() => void openExternalUrl(issue.url)) },
  ];
  return (
    <ActionSheet
      title={issue.title}
      onClose={onClose}
      top={
        <>
          <Meta facts={[`${issue.repo}#${issue.number}`, ...facts(issue).slice(1)]} chips={[]} />
        </>
      }
      entries={entries}
      bottom={<DetailLines details={details.data} loading={details.isLoading} error={details.error} linkedLabel="PR" />}
    />
  );
}
