// A card on Doing, Waiting and History, and its sheet, with the people and stack lines both show [ATT-05, ATT-06].

import { openExternalUrl } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { type ActionId, type AgentSummary, type Chip, type FailingChecks, type Item, itemSessions, type PersonRole, type WaitingGroup, type WaitingOn } from "../shared/attention";
import type { SessionKind } from "../shared/config";
import { failingList, groupLabel, rerunHistory, summarizeRerun } from "../shared/checks";
import { ago } from "../shared/format";
import { noteBusy } from "../shared/got-it";
import { actionLabel, alsoWaitingOn, cardStack, cardWhen, copiesLink, rerunState, sessionSignal, type SheetStep, sheetPlan, soleStep, stackMetaChips, targetUrl, waitChips, waitedSince } from "../shared/item-view";
import { CardList, CardRow } from "./card";
import { PlaceText } from "./entity";
import type { IconName } from "./icons";
import { type Actions, itemDetailsQuery } from "./item-actions";
import { stateMark } from "./mark";
import { StackLine } from "./stack";
import { AcknowledgeSheet, ReviewerSheet } from "./pickers";
import { sessionEntry, startAnotherEntry } from "./session-menu";
import { ActionSheet, DETAILS_STALE_MS, DetailLines, FadeIn, githubEntry, type SheetEntry, useArrived, usePrefetchOnRest } from "./sheet";
import { Avatar, Hint, LINE_HEIGHT, Meta, mix, TablerIcon, useCopy, useStrongText, useStyles } from "./ui";

// The agent icon marks every action that starts an agent session; the rest act on GitHub right away [ATT-13].
const ACTION_ICONS: Record<ActionId, IconName> = {
  reply: "replyArrow",
  acknowledge: "thumbUp",
  review: "agent",
  fix: "agent",
  rerun: "reload",
  address: "agent",
  update: "update",
  rebase: "agent",
  refresh: "agent",
  ready: "pr",
  request_review: "claim",
  automerge: "clock",
  merge: "merge",
  close: "close",
  start: "agent",
  got_it: "check",
};

// Rerun failed jobs as a sheet line: which checks failed and whether they were rerun before, flaky or real? [PRS-09]
// It can be pressed before the checks are in: the sheet closes, and the rerun goes ahead once they are.
function rerunEntry(label: string, details: SheetDetails | undefined, rerun: (runIds?: number[]) => void): SheetEntry {
  const base = { key: "rerun", icon: ACTION_ICONS.rerun, label, live: true };
  const line = rerunState(details);
  if (line.state === "ready") return { ...base, detailNode: <RerunDetail failing={line.failing} arrived={!!details?.arrived} />, hint: failingList(line.failing), onPress: () => rerun(line.runIds) };
  if (line.state === "checking") return { ...base, detail: line.detail, onPress: () => rerun() };
  return { ...base, detail: line.detail, ...(line.state === "elsewhere" ? { hint: failingList(line.failing) } : {}), disabled: true, onPress: () => {} };
}

// What an item's sheet has fetched, as its lines need it; `arrived` once it came in while the sheet was open.
interface SheetDetails {
  data?: { failing: FailingChecks[] };
  isLoading: boolean;
  arrived?: boolean;
}

// "7 failed · lint, e2e ×3, unit ×2 · ↻ rerun once": the count and names quiet, as the card's red already says CI failed; checks
// that can't rerun dimmer; the history amber once rerun, a hint it may not be flaky. One line on desktop, where the names give way
// and the hint has them all; two on phones, which can't point at a hint [PRS-09].
function RerunDetail({ failing, arrived }: { failing: FailingChecks[]; arrived: boolean }) {
  const styles = useStyles();
  const summary = summarizeRerun(failing);
  const strong = useStrongText();
  // Dimmer than the quiet text, on the line's own background, so it reads in any theme.
  const dimmer = { color: mix(styles.c.foregroundMuted, styles.c.surface2, 0.55) };
  const stack = summary.prs.length > 1;
  const names = summary.prs.map(({ pr, groups }, index) => (
    <Text key={pr}>
      {index > 0 ? " · " : null}
      {stack ? <Text style={strong}>#{pr} </Text> : null}
      {groups.map((group, at) => (
        <Text key={`${group.name}-${group.rerunnable}`} style={group.rerunnable ? null : dimmer}>
          {at > 0 ? ", " : null}
          {groupLabel(group)}
        </Text>
      ))}
    </Text>
  ));
  const history = (
    <Text style={summary.reruns ? { color: styles.c.statusWarning, fontWeight: "500" } : null}>{summary.reruns ? `↻ ${rerunHistory(summary.reruns)}` : rerunHistory(0)}</Text>
  );
  const line = [styles.muted, { lineHeight: LINE_HEIGHT }];
  return (
    <FadeIn active={arrived}>
      {styles.compact ? (
        <Text style={line} numberOfLines={2}>
          {summary.failed} failed · {names} · {history}
        </Text>
      ) : (
        <View style={{ flexDirection: "row", minWidth: 0 }}>
          <Text style={line}>{summary.failed} failed · </Text>
          <Text style={[line, { flexShrink: 1 }]} numberOfLines={1}>
            {names}
          </Text>
          <Text style={line}> · {history}</Text>
        </View>
      )}
    </FadeIn>
  );
}

export function Card({ items, actions, group }: { items: Item[]; actions: Actions; group?: WaitingGroup }) {
  return (
    <CardList>
      {items.map((item, index) => (
        <ItemRow key={item.key} item={item} first={index === 0} actions={actions} group={group} />
      ))}
    </CardList>
  );
}

// The sheet, Acknowledge, or the reviewer picker (after Ready for review, or on its own).
type Sheet = "item" | "acknowledge" | "reviewers" | "reviewers-after-ready" | null;

// A card that works collapsed: its main action and ›. Tapping it opens the sheet with everything else [ATT-05, ATT-06].
// In Waiting, a card sits under one of whom it waits on: its group.
export function ItemRow({ item, first, actions, group }: { item: Item; first: boolean; actions: Actions; group?: WaitingGroup }) {
  const styles = useStyles();
  // An open session leads; without one, the item's own action does [SES-03].
  const sessions = itemSessions(actions.agents, item);
  const waits = waitChips(item, !!group, actions.config.waitingTooLongDays);
  // The group names one; the card names the rest [WAI-01].
  const others = alsoWaitingOn(item, group?.who);
  const waitingOn = group ? null : item.waitingOn ? <WaitingOnLine people={item.waitingOn} reason={item.wait?.reason} expanded={false} /> : null;
  const alsoOn = others.length ? <Text style={styles.muted}>also waiting on {others.join(", ")}</Text> : null;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const main = item.actions[0];
  const { rows: children, target: targetRow } = cardStack(item);
  const shown = [...waits, ...stackMetaChips(item, targetRow)];
  const chips = sessions[0] ? [...shown, sessionSignal(sessions[0])] : shown;
  // The sheet opens at once; what it fetches fills in [ATT-06].
  const open = () => setSheet("item");
  const prefetch = usePrefetchOnRest(itemDetailsQuery(item, actions.fetchDetails));
  const copy = useCopy();

  function perform(action: ActionId) {
    setSheet(null);
    if (action === "merge" || action === "close") setConfirm(action);
    else if (action === "acknowledge") setSheet("acknowledge");
    else if (action === "request_review") setSheet("reviewers");
    // A draft made ready goes straight on to who should review it [PRS-11].
    else if (action === "ready") (actions.act(item, action), setSheet("reviewers-after-ready"));
    else actions.act(item, action);
  }
  const handlers: SheetHandlers = { onPerform: perform, onClose: () => setSheet(null) };
  // One action shows instead of ›; the card still opens the sheet, quiet lines and all [ATT-06].
  const sole = soleStep(sheetPlan(item, sessions));
  const only = sole && sheetEntry(sole, item, actions, handlers);
  const confirmed = (action: "merge" | "close") => (comment: string) => (setConfirm(null), actions.confirm(item, action, comment));

  return (
    <CardRow
      first={first}
      mark={stateMark(item)}
      title={item.title}
      meta={{
        place: { repo: item.repo, number: item.number, login: actions.login },
        when: cardWhen(item),
        signals: chips,
      }}
      extra={
        item.person || waitingOn || alsoOn || children.length > 0 ? (
          <>
            {item.person ? <PersonQuote person={item.person} expanded={false} /> : null}
            {waitingOn}
            {alsoOn}
            {children.length > 0 ? <StackLine rows={children} target={targetRow?.key} /> : null}
          </>
        ) : null
      }
      onOpen={open}
      hover={prefetch}
      busy={item.change ? noteBusy(actions.busy, item.key) : actions.busy.has(item.key)}
      primary={
        sessions[0]
          ? { label: "Open session", icon: "agent", onPress: () => actions.openAgent(sessions[0].id) }
          : main
            ? { label: actionLabel(main, item), icon: ACTION_ICONS[main], iconOnly: main === "got_it", onPress: () => perform(main) }
            : undefined
      }
      secondary={[
        only ? { label: only.label, accessibilityLabel: only.accessibilityLabel, icon: only.icon, onPress: only.onPress } : { label: `Details for #${item.number}`, icon: "chevronRight", onPress: open },
        ...(copiesLink(item) ? [{ label: `Copy link to #${item.number}`, icon: "copy" as const, onPress: () => copy(item.url, `Copied link to #${item.number}`) }] : []),
      ]}
      confirm={
        confirm === "merge"
          ? {
              text: `Merge PR ${item.target.number} into ${item.target.baseRefName} (${item.target.mergeMethod})?`,
              choices: [{ label: "Merge", icon: "merge", solid: true, onConfirm: confirmed("merge") }],
              onCancel: () => setConfirm(null),
            }
          : confirm === "close"
            ? {
                text: `Close PR ${item.target.number}? A comment is only posted if you write one.`,
                comment: true,
                choices: [{ label: "Close PR", icon: "close", solid: true, onConfirm: confirmed("close") }],
                onCancel: () => setConfirm(null),
              }
            : null
      }
      overlay={
        <>
          {sheet === "item" ? <ItemSheet item={item} waitChips={waits} sessions={sessions} actions={actions} {...handlers} /> : null}
          {sheet === "acknowledge" ? <AcknowledgeSheet item={item} onReact={(ids) => (setSheet(null), actions.acknowledge(item, ids))} onClose={() => setSheet(null)} /> : null}
          {sheet === "reviewers" || sheet === "reviewers-after-ready" ? (
            <ReviewerSheet
              item={item}
              afterReady={sheet === "reviewers-after-ready"}
              onRequest={(reviewers) => (setSheet(null), actions.requestReviewers(item, reviewers))}
              onClose={() => setSheet(null)}
            />
          ) : null}
        </>
      }
    />
  );
}

interface SheetHandlers {
  onPerform: (action: ActionId) => void;
  onClose: () => void;
}

// What the card already knows on top, then every action, then what's fetched when it opens, so nothing jumps as it loads [ATT-06, GH-01].
function ItemSheet({ item, waitChips, sessions, actions, ...handlers }: { item: Item; waitChips: Chip[]; sessions: AgentSummary[]; actions: Actions } & SheetHandlers) {
  const details = useQuery({ ...itemDetailsQuery(item, actions.fetchDetails), staleTime: DETAILS_STALE_MS });
  const arrived = useArrived(details.isLoading);
  const elsewhere = !!targetUrl(item);
  // The row of the PR its actions apply to, where it's in the stack line: marked there instead of named on top.
  const targetRow = elsewhere ? item.children.find((child) => child.url === item.target.url) : undefined;
  // How it finished, as its card says it ("closed 1d ago by bob as not planned"), so the sheet keeps the close reason [HIS-07].
  const when = cardWhen(item);
  const meta = [...(when ? [when] : []), ...(elsewhere && !targetRow ? [`actions apply to PR #${item.target.number}`] : [])];
  // PRs already in the stack line link from there; list only the rest, like someone else's PR closing the same issue.
  const shown = new Set(item.children.map((child) => child.url));
  const extra = details.data && { ...details.data, linked: details.data.linked.filter((link) => !shown.has(link.url)) };
  return (
    <ActionSheet
      title={item.title}
      onClose={handlers.onClose}
      top={
        <>
          {/* Number first, as on the card; the sheet always names the owner, even of my own repos [ATT-20]. */}
          <Meta lead={<PlaceText place={{ repo: item.repo, number: item.number, login: null }} />} facts={meta} chips={[...waitChips, ...stackMetaChips(item, targetRow)]} />
          {item.person ? <PersonQuote person={item.person} expanded /> : null}
          {item.waitingOn ? <WaitingOnLine people={item.waitingOn} reason={item.wait?.reason} expanded /> : null}
          {item.children.length > 0 ? <StackLine rows={item.children} links target={targetRow?.key} /> : null}
        </>
      }
      entries={sheetEntries(item, sessions, actions, handlers, { data: details.data, isLoading: details.isLoading, arrived })}
      // The PR its actions apply to has a size line, named where it isn't the item; an issue's PRs are in its stack line
      // already, so few more come [ATT-06].
      bottom={
        <DetailLines
          details={extra}
          loading={details.isLoading}
          error={details.error}
          linkedLabel={item.kind === "issue" ? "PR" : "Closes"}
          expected={item.target.kind === "pr" ? 1 : 0}
          sizeOf={elsewhere ? item.target.number : undefined}
        />
      }
    />
  );
}

// Everything an item's sheet offers, each saying what it will do [ATT-06]. Rerun's line says more once the checks are in.
function sheetEntries(item: Item, sessions: AgentSummary[], actions: Actions, handlers: SheetHandlers, details?: SheetDetails): SheetEntry[] {
  return sheetPlan(item, sessions).map((step) => sheetEntry(step, item, actions, handlers, details));
}

function sheetEntry(step: SheetStep, item: Item, actions: Actions, { onPerform, onClose }: SheetHandlers, details?: SheetDetails): SheetEntry {
  const close = (then: () => void) => () => (onClose(), then());
  const open = (agentId: string) => close(() => actions.openAgent(agentId))();
  const withOptions = (label: string, kind: SessionKind) => close(() => actions.startWithOptions({ itemKey: item.key, title: `${label}: ${item.title}`, kind, target: item.target }));
  switch (step.kind) {
    case "session":
      return sessionEntry(step.agent, step.label, open);
    case "ask":
      return { key: step.action, icon: "agent", label: `${step.label}…`, detail: step.detail, onPress: withOptions(step.label, step.session) };
    case "rerun":
      return rerunEntry(step.label, details, (runIds) => close(() => actions.rerun(item, runIds))());
    case "action":
      return { key: step.action, icon: ACTION_ICONS[step.action], label: step.label, detail: step.detail, housekeeping: step.housekeeping, onPress: () => onPerform(step.action) };
    case "github":
      return githubEntry(item, (url) => close(() => void openExternalUrl(url))(), step.pr);
    case "start":
      return startAnotherEntry(step.any, withOptions("Start session", step.session));
    case "dismiss":
      return { key: "dismiss", icon: "dismiss", label: "Dismiss", detail: "Hides it until something new happens on it", housekeeping: true, onPress: close(() => actions.dismiss(item)) };
  }
}

// What a face on a card is to it, where no quote says it: the icon of the tab or section that means the same, so whom I wait on
// reads like Waiting, and whose comments are left like Changes requested [ATT-19].
const ROLE_ICON: Record<PersonRole | "waiting", IconName> = { waiting: "hourglass", author: "pencil", changes: "changes" };

// The icon sits tight against the faces it explains, apart from the name and time, so they read as one.
function Badged({ role, children }: { role: keyof typeof ROLE_ICON; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <TablerIcon name={ROLE_ICON[role]} size={16} color={styles.c.foregroundMuted} />
      {children}
    </View>
  );
}

// Who is waiting on me, or who I'm waiting on.
function PersonQuote({ person, expanded }: { person: NonNullable<Item["person"]>; expanded: boolean }) {
  const styles = useStyles();
  const name = <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600" }}>{person.login}</Text>;
  // An author line says who, not when: its time meant something different on each tab [ATT-19].
  if (!person.snippet && person.role) {
    const text = person.role === "author" ? `Opened by ${person.login}` : `${person.login}'s comments are left to address, since your last push ${ago(person.since)} ago`;
    return (
      <Hint text={text}>
        <View style={styles.row}>
          <Badged role={person.role}>
            <Avatar url={person.avatarUrl} bot={person.bot} />
          </Badged>
          {name}
          {person.role === "author" ? null : <Text style={styles.muted}>· {ago(person.since)}</Text>}
        </View>
      </Hint>
    );
  }
  const line = (
    <View style={styles.row}>
      <Avatar url={person.avatarUrl} bot={person.bot} />
      {name}
      <Text style={styles.muted}>· {ago(person.since)}</Text>
    </View>
  );
  if (!person.snippet) return line;
  return (
    <View style={styles.quote}>
      {line}
      <Text style={{ color: styles.c.foreground, fontSize: 13, lineHeight: 18 }} numberOfLines={expanded ? undefined : 2}>
        {person.snippet}
      </Text>
    </View>
  );
}

// Pictures on a card before the rest are counted, so a crowd fits a phone; the sheet names everyone.
const MAX_FACES = 5;

// Who my work waits on: one by name, several by picture, named on hover, and each by name in the sheet [WAI-02].
// On an issue they're who my question tagged; on a PR, reviewers since my last push or reply [WAI-02, ATT-19].
function WaitingOnLine({ people, reason, expanded }: { people: WaitingOn[]; reason: string | undefined; expanded: boolean }) {
  const styles = useStyles();
  const [hovered, setHovered] = useState<string | null>(null);
  const name = (login: string) => (
    <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
      {login}
    </Text>
  );
  const since = (at: string) => <Text style={styles.muted}>· {ago(at)}</Text>;
  const explain = (logins: string[], at: string) => `Waiting on ${logins.join(", ")} since ${waitedSince(reason)}, ${ago(at)} ago`;
  if (expanded || people.length === 1) {
    return (
      <View style={{ gap: 6 }}>
        {people.map((who) => (
          <Hint key={who.login} text={explain([who.login], who.since)}>
            <View style={styles.row}>
              <Badged role="waiting">
                <Avatar url={who.avatarUrl} team={who.team} />
              </Badged>
              {name(who.login)}
              {since(who.since)}
            </View>
          </Hint>
        ))}
      </View>
    );
  }
  const earliest = people.map((who) => who.since).sort()[0];
  return (
    <Hint text={explain(people.map((who) => who.login), earliest)}>
      <View style={styles.row}>
        <Badged role="waiting">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {people.slice(0, MAX_FACES).map((who) => (
              <View key={who.login} onPointerEnter={() => setHovered(who.login)} onPointerLeave={() => setHovered((current) => (current === who.login ? null : current))}>
                <Avatar url={who.avatarUrl} team={who.team} />
              </View>
            ))}
            {people.length > MAX_FACES ? <Text style={styles.muted}>+{people.length - MAX_FACES}</Text> : null}
          </View>
        </Badged>
        {hovered ? name(hovered) : null}
        {since(earliest)}
      </View>
    </Hint>
  );
}
