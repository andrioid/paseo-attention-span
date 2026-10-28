import { openExternalUrl } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { ago } from "../shared/format";
import type { AgentSummary, NextUpIssue } from "../shared/inbox";
import type { IconName } from "./icons";
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
  onStart: (issue: NextUpIssue, claim: boolean) => void;
  onOpenAgent: (agentId: string) => void;
}

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

function IssueList({ issues, claim, agents, busy, onStart, onOpenAgent }: Omit<Props, "assigned" | "unclaimed" | "selected" | "onSelect"> & { issues: NextUpIssue[]; claim: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.card}>
      {issues.map((issue, index) => {
        const agent = agents[issue.key];
        return (
          <View key={issue.key} style={[styles.item, index === 0 ? null : styles.divider]}>
            <View style={{ paddingTop: 2 }}>
              <TablerIcon name={TYPE_ICONS[issue.type?.toLowerCase() ?? ""] ?? "issue"} size={18} color={issue.type === "Bug" ? styles.c.statusDanger : styles.c.foregroundMuted} />
            </View>
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={2}>
                {issue.title}
              </Text>
              <Meta facts={[`#${issue.number}`, `${ago(issue.createdAt)} old`, ...[issue.type, issue.priority, issue.effort, issue.scope].filter((v): v is string => !!v)]} chips={[]} />
            </View>
            <View style={styles.wrap}>
              {busy === issue.key ? (
                <Text style={styles.muted}>working…</Text>
              ) : agent ? (
                <Button label={styles.compact ? undefined : "Continue"} icon="play" variant="calm" onPress={() => onOpenAgent(agent.id)} />
              ) : (
                // Claim first so teammates see it's taken [NXT-05].
                <Button
                  label={styles.compact ? undefined : claim ? "Claim & start" : "Start"}
                  accessibilityLabel={`${claim ? "Claim & start" : "Start"} ${issue.title}`}
                  icon={claim ? "claim" : "play"}
                  variant="calm"
                  onPress={() => onStart(issue, claim)}
                />
              )}
              <Button icon="github" variant="ghost" accessibilityLabel="Open on GitHub" onPress={() => void openExternalUrl(issue.url)} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
