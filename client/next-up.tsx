import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ago } from "../shared/format";
import {
  type AgentSummary,
  type Chip,
  type IssueCloseReason,
  matchSessions,
  type NextUpIssue,
  type ProjectInfo,
  type UnclaimedSource,
} from "../shared/attention";
import type { NextUpSource } from "../shared/config";
import { CLEAR_FILTER, type FilterChange, nextUpFilter } from "../shared/next-up-filter";
import type { IconName } from "./icons";
import type { FetchDetails } from "./item-actions";
import { CardList, CardRow, type Tone } from "./card";
import { sessionEntry, startAnotherEntry } from "./session-menu";
import { ActionSheet, DETAILS_STALE_MS, DetailLines, type DetailsQuery, detailsKey, FilterSheet, githubEntry, type SheetEntry, usePrefetchOnRest } from "./sheet";
import { IssuePills, PlaceText } from "./entity";
import { Still } from "./still";
import { Button, FilterButton, Meta, SectionHeader, useStyles } from "./ui";

const TYPE_ICONS: Record<string, IconName> = { bug: "bug", feature: "feature", debt: "debt", task: "task", epic: "epic" };

interface Props {
  // Nothing at all to show: nowhere to look yet, or nothing to pick up after a refresh that worked [NXT-13].
  calm: "setup" | "clear" | null;
  openSettings?: () => void;
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
  // The New issue sheet [ISS-01].
  onNewIssue: () => void;
}

type RowProps = Omit<Props, "calm" | "openSettings" | "assigned" | "unclaimed" | "unclaimedFrom" | "selected" | "sources" | "selectedSources" | "projects" | "selectedProjects" | "onFilter" | "onNewIssue">;

// Assigned issues first [NXT-06], then unclaimed ones [NXT-01]; both already ranked by the server [NXT-02].
export function NextUpList({ calm, openSettings, assigned, unclaimed, unclaimedFrom, selected, sources, selectedSources, projects, selectedProjects, onFilter, onNewIssue, ...rowProps }: Props) {
  const styles = useStyles();
  const filter = useMemo(
    () => nextUpFilter({ unclaimed, selected, sources, selectedSources, projects, selectedProjects }),
    [unclaimed, selected, sources, selectedSources, projects, selectedProjects],
  );
  const { shown, picked, groups } = filter;
  const [filtering, setFiltering] = useState(false);

  // Both point at where Next up looks: plainly when it has nowhere to look, quietly when it found nothing [NXT-13].
  if (calm === "setup") {
    const way = openSettings ? { label: "Open settings", onPress: openSettings } : undefined;
    return <Still shore="signpost" title="Nowhere to look yet." line="Choose where Next up finds issues." way={way} />;
  }
  if (calm === "clear") {
    const way = openSettings ? { label: "Look in more places", onPress: openSettings, link: true } : undefined;
    return <Still shore="signpost" title="Nothing ready for work." line="Want more to choose from?" way={way} />;
  }

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
            <View style={styles.wrap}>
              <Button label="New issue" icon="plus" variant="ghost" onPress={onNewIssue} />
              {groups.length > 0 ? <FilterButton count={picked} onPress={() => setFiltering(true)} /> : null}
            </View>
          }
        />
        {/* Source, project and scope filters behind one button, so they take no room above the list [NXT-03, NXT-09]. */}
        {filtering ? (
          <FilterSheet
            groups={groups}
            onToggle={(kind, id) => onFilter(filter.toggle(kind, id))}
            onClear={() => onFilter(CLEAR_FILTER)}
            onClose={() => setFiltering(false)}
          />
        ) : null}
        {unclaimedFrom === "none" ? (
          <Text style={styles.text}>No repos to look in. Register a project in Paseo, or choose where Next up looks in Settings.</Text>
        ) : shown.length === 0 ? (
          <Text style={styles.text}>{filter.empty}</Text>
        ) : (
          <IssueList issues={shown} claim {...rowProps} />
        )}
      </View>
    </View>
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

// What an issue's sheet fetches when it opens; resting the pointer on its card fetches the same ahead [ATT-06].
function issueDetailsQuery(issue: NextUpIssue, fetchDetails: FetchDetails): DetailsQuery {
  const subject = { kind: "issue" as const, repo: issue.repo, number: issue.number };
  return { queryKey: detailsKey(subject, undefined, false), queryFn: () => fetchDetails({ subject, checks: false }) };
}

// The type as the card's mark: red bugs, green features and epics, amber debt, the rest quiet.
const TYPE_TONES: Record<string, Tone> = { bug: "bad", feature: "good", epic: "good", debt: "warn" };

// Its main action and ›; tapping it opens the sheet with the description, Claim or Unclaim [ATT-06, NXT-07].
function IssueRow({ issue, claim, first, agents, login, busy, fetchDetails, onStart, onOptions, onClaim, onCloseIssue, onOpenAgent }: RowProps & { issue: NextUpIssue; claim: boolean; first: boolean }) {
  const [sheet, setSheet] = useState(false);
  // The sheet opens at once; what it fetches fills in [ATT-06].
  const open = () => setSheet(true);
  const prefetch = usePrefetchOnRest(issueDetailsQuery(issue, fetchDetails));
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
      onOpen={open}
      hover={prefetch}
      busy={busy.has(issue.key)}
      primary={
        sessions[0]
          ? { label: "Open session", icon: "agent", onPress: () => onOpenAgent(sessions[0].id) }
          : // Claim first so teammates see it's taken [NXT-05].
            { label: startLabel, accessibilityLabel: `${startLabel} ${issue.title}`, icon: "agent", onPress: () => onStart(issue, claim) }
      }
      secondary={[{ label: `Details for #${issue.number}`, icon: "chevronRight", onPress: open }]}
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
      : { key: "unclaim", icon: "unclaim", label: "Unclaim", detail: "Removes you as assignee, so it goes back to Unclaimed", housekeeping: true, onPress: close(() => onClaim(issue, false)) },
    // Someone's PR open against it sits beside the issue [ATT-12].
    githubEntry({ kind: "issue", ...issue }, (url) => close(() => void openExternalUrl(url))(), issue.openPrs[0]),
    ...(sessions.length ? [startAnotherEntry(true, withOptions)] : []),
    // Giving it up or closing it sits apart, below the work [ATT-06].
    { key: "close", icon: "issueClosed", label: "Close issue", detail: "Asks first: as completed or not planned, with an optional comment", housekeeping: true, onPress: close(onCloseIssue) },
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
