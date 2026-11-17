import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { type AgentSummary, isIdle, matchSessions, type WrapItem } from "../shared/attention";
import { type ArchiveOutcome, type KeptRow, keptText, sheetLines, type UnsavedSession, unsavedWords } from "../shared/archive";
import { allWrapBusy, wrapBusy } from "../shared/got-it";
import { cleanSingle, sessionCleanliness, sessionUnsaved } from "../shared/wrap-up";
import { CardList, CardRow } from "./card";
import { stateMark } from "./mark";
import { type FetchDetails, itemDetailsQuery } from "./item-actions";
import { PlaceText } from "./entity";
import { StackLine } from "./stack";
import { sessionEntry, startAnotherEntry } from "./session-menu";
import { ActionSheet, DETAILS_STALE_MS, DetailLines, Dialog, githubEntry, type SheetEntry, usePrefetchOnRest } from "./sheet";
import { Button, Meta, SectionHeader, useStyles } from "./ui";

// Doing's Wrap up: finished or out-of-my-hands work whose sessions are still open, and archiving them [ATT-22]. The screen
// assembles the rows and runs the archive; these draw them and ask before archiving anything unsaved or closing a terminal,
// in a sheet shaped like Paseo's own. A worktree that stayed lingers as a row saying why.

interface RowProps {
  busy: ReadonlySet<string>;
  agents: AgentSummary[];
  login: string | null;
  // Previews have made-up sessions: their snapshot is the answer, as there's no daemon to ask.
  fixture: boolean;
  openAgent: (agentId: string) => void;
  fetchDetails: FetchDetails;
  onArchive: (item: WrapItem, confirm: boolean, terminals?: string[]) => Promise<ArchiveOutcome | null>;
}

interface KeptProps {
  kept: KeptRow[];
  onArchiveWorktree: (row: KeptRow, confirm: boolean, terminals?: string[]) => Promise<ArchiveOutcome | null>;
  onDismissKept: (row: KeptRow) => void;
}

// Finished or out-of-my-hands work whose Paseo sessions are all idle: the cleanup Doing owns [ATT-22].
interface AskProps {
  // Close as completed, with Undo, or Keep open until another PR merges under it [ATT-24].
  onCloseIssue: (item: WrapItem) => void;
  onKeepOpen: (item: WrapItem) => void;
  // The same session-options flow as the other item sheets [SES-02, SES-03].
  onStartSession: (item: WrapItem) => void;
}

export function WrapUp({
  items,
  onArchiveAll,
  kept,
  onArchiveWorktree,
  onDismissKept,
  onCloseIssue,
  onKeepOpen,
  onStartSession,
  ...row
}: { items: WrapItem[]; onArchiveAll: () => Promise<void> } & RowProps & KeptProps & AskProps) {
  const styles = useStyles();
  const clean = items.filter(cleanSingle);
  return (
    <View>
      <SectionHeader
        icon="archive"
        title="Wrap up"
        count={items.length}
        action={
          items.length > 1 && clean.length > 0 ? (
            <View style={styles.overCard}>
              <Button
                label={`Archive all clean · ${clean.length}`}
                icon="archive"
                variant="ghost"
                disabled={allWrapBusy(row.busy, items.map((item) => item.key))}
                onPress={() => void onArchiveAll()}
              />
            </View>
          ) : null
        }
      />
      <CardList>
        {items.map((item, index) =>
          item.wrap.ask ? (
            <AskRow key={item.key} item={item} sessions={matchSessions(row.agents, item.wrap.keys)} first={index === 0} busy={row.busy} login={row.login} openSession={row.openAgent} fetchDetails={row.fetchDetails} onCloseIssue={onCloseIssue} onKeepOpen={onKeepOpen} onStartSession={onStartSession} />
          ) : (
            <WrapRow key={item.key} item={item} first={index === 0} {...row} />
          ),
        )}
        {kept.map((keptRow, index) => (
          <KeptWorktreeRow
            key={keptRow.workspaceId}
            row={keptRow}
            first={items.length === 0 && index === 0}
            busy={row.busy.has(`kept:${keptRow.workspaceId}`)}
            login={row.login}
            openSession={row.openAgent}
            onArchive={onArchiveWorktree}
            onDismiss={onDismissKept}
          />
        ))}
      </CardList>
    </View>
  );
}

// An open issue whose PRs of mine all merged: Close #12, or Keep open in its sheet until another merges.
// A session open on the work waits for the usual row, which closing leaves behind [ATT-24].
function AskRow({
  item,
  sessions,
  first,
  busy,
  login,
  openSession,
  fetchDetails,
  onCloseIssue,
  onKeepOpen,
  onStartSession,
}: { item: WrapItem; sessions: AgentSummary[]; first: boolean; busy: ReadonlySet<string>; login: string | null; openSession: (agentId: string) => void; fetchDetails: FetchDetails } & AskProps) {
  const [sheet, setSheet] = useState(false);
  const open = () => setSheet(true);
  const prefetch = usePrefetchOnRest(itemDetailsQuery(item, fetchDetails));
  const close = () => setSheet(false);
  const blocked = wrapBusy(busy, item.key);
  const still = sessions.length > 1 ? ` · ${sessions.length} sessions still open` : sessions.length ? " · your session's still open" : "";
  return (
    <CardRow
      first={first}
      mark={stateMark(item)}
      title={item.title}
      meta={{ place: { repo: item.repo, number: item.number, login }, when: `Close #${item.number}? ${item.wrap.finish}${still}`, signals: [] }}
      onOpen={open}
      hover={prefetch}
      busy={blocked}
      primary={{ label: `Close #${item.number}`, accessibilityLabel: `Close #${item.number} as completed`, icon: "issueClosed", onPress: () => onCloseIssue(item) }}
      secondary={[{ label: `Details for #${item.number}`, icon: "chevronRight", onPress: open }]}
      overlay={
        sheet ? (
          <WrapItemSheet
            item={item}
            sessions={sessions}
            fetchDetails={fetchDetails}
            openSession={openSession}
            onClose={close}
            entries={[
              { ...startAnotherEntry(sessions.length > 0, () => { close(); onStartSession(item); }), disabled: blocked },
              {
                key: "close", label: `Close #${item.number}`, icon: "issueClosed",
                detail: "Closes as completed, with Undo", disabled: blocked,
                onPress: () => { close(); onCloseIssue(item); },
              },
              {
                key: "keep", label: "Keep open", icon: "close",
                detail: "Waits until another PR merges before asking again", housekeeping: true, disabled: blocked,
                onPress: () => { close(); onKeepOpen(item); },
              },
            ]}
          />
        ) : null
      }
    />
  );
}

// "merged by dave 2h ago · your session's still open": what finishing looked like, then the session it left behind [ATT-22].
function wrapMeta({ wrap }: WrapItem): string {
  const still = wrap.review ? "your review session's still open" : wrap.sessions.length > 1 ? `${wrap.sessions.length} sessions still open` : "your session's still open";
  return `${wrap.finish} · ${still}`;
}

function WrapRow({ item, first, busy, login, fixture, openAgent: openSession, fetchDetails, onArchive }: { item: WrapItem; first: boolean } & RowProps) {
  const { sessions } = item.wrap;
  const [sheet, setSheet] = useState<"item" | "dirty" | null>(null);
  const open = () => setSheet("item");
  const prefetch = usePrefetchOnRest(itemDetailsQuery(item, fetchDetails));
  const [unsaved, setUnsaved] = useState<UnsavedSession[]>([]);
  // The terminals the confirm sheet names, sent back with it: a terminal opened since brings the sheet back [ATT-22].
  const [terminals, setTerminals] = useState<string[]>([]);
  // The worktrees the sheet's archive removes, by name, for its title.
  const [leaving, setLeaving] = useState<string[]>([]);
  const dirty = sessions.some((session) => sessionCleanliness(session) === "dirty");
  const press = async () => {
    if (sessions.length > 1) return open();
    // A preview has no daemon to ask; its made-up snapshot is the answer. Elsewhere the server checks git too, so the sheet
    // can name the files and commits it found.
    if (sessionCleanliness(sessions[0]) !== "clean" && fixture) {
      const workspace = sessions[0].workspace;
      setUnsaved([readingOf(sessions[0])]);
      setLeaving(workspace?.kind === "worktree" ? [workspace.name] : []);
      return setSheet("dirty");
    }
    asked(await onArchive(item, false));
  };
  const asked = (outcome: ArchiveOutcome | null) => {
    if (outcome && !outcome.ok && outcome.reason === "unsaved") {
      setUnsaved(outcome.sessions);
      setTerminals(outcome.terminals);
      setLeaving(outcome.leaving);
      setSheet("dirty");
    }
  };
  // The item's archive entry asks the server first; unsaved work or open terminals it finds get the confirm that
  // names them [ATT-22].
  const confirm = async (confirm: boolean) => {
    const outcome = await onArchive(item, confirm, confirm ? terminals : []);
    if (outcome?.ok) return setSheet(null);
    asked(outcome);
  };
  return (
    <CardRow
      first={first}
      mark={stateMark(item)}
      title={item.title}
      meta={{
        place: { repo: item.repo, number: item.number, login },
        when: wrapMeta(item),
        signals: dirty ? [{ text: "unsaved changes", tone: "warn" }] : [],
      }}
      onOpen={open}
      hover={prefetch}
      busy={wrapBusy(busy, item.key)}
      primary={{
        label: sessions.length > 1 ? "Archive sessions" : "Archive session",
        accessibilityLabel: `Archive the ${sessions.length > 1 ? "sessions" : "session"} on #${item.number}`,
        icon: "archive",
        onPress: () => void press(),
      }}
      secondary={[{ label: `Details for #${item.number}`, icon: "chevronRight", onPress: open }]}
      overlay={
        sheet === "item" ? (
          <WrapItemSheet
            item={item}
            fetchDetails={fetchDetails}
            openSession={openSession}
            onClose={() => setSheet(null)}
            entries={[{
              key: "archive",
              label: sessions.length === 2 ? "Archive both" : sessions.length > 1 ? `Archive ${sessions.length} sessions` : "Archive session",
              icon: "archive",
              detail: "Archives the sessions and their worktrees when no other session lives in them. Asks before losing unsaved work or closing terminals.",
              housekeeping: true,
              disabled: wrapBusy(busy, item.key),
              onPress: () => { setSheet(null); void (sessions.length > 1 ? confirm(false) : press()); },
            }]}
          />
        ) : sheet === "dirty" ? (
          <ArchiveSheet
            title={leaving.length === 1 ? `Archive "${leaving[0]}"?` : sessions.length > 1 ? `Archive the sessions on #${item.number}?` : `Archive the session on #${item.number}?`}
            unsaved={unsaved.length ? unsaved : [readingOf(sessions[0])]}
            onOpen={() => { setSheet(null); openSession(unsaved[0]?.agentId ?? sessions[0].id); }}
            onArchive={() => void confirm(true)}
            onClose={() => setSheet(null)}
          />
        ) : null
      }
    />
  );
}

// Wrap up owns its cleanup actions; the sheet uses the same details and entries as the other tabs [ATT-06, SES-03].
function WrapItemSheet({ item, sessions = item.wrap.sessions, fetchDetails, openSession, entries, onClose }: {
  item: WrapItem;
  // Navigation includes working sessions on close prompts; archive eligibility stays in item.wrap.sessions.
  sessions?: AgentSummary[];
  fetchDetails: FetchDetails;
  openSession: (agentId: string) => void;
  entries: SheetEntry[];
  onClose: () => void;
}) {
  const details = useQuery({ ...itemDetailsQuery(item, fetchDetails), staleTime: DETAILS_STALE_MS });
  const pr = item.children.find((child) => child.url === item.target.url) ?? item.children[0];
  const shown = new Set(item.children.map((child) => child.url));
  const extra = details.data && { ...details.data, linked: details.data.linked.filter((link) => !shown.has(link.url)) };
  return (
    <ActionSheet
      title={item.title}
      onClose={onClose}
      top={
        <>
          <Meta lead={<PlaceText place={{ repo: item.repo, number: item.number, login: null }} />} facts={[item.wrap.finish]} chips={[]} />
          {item.children.length > 0 ? <StackLine rows={item.children} links /> : null}
        </>
      }
      entries={[
        ...sessions.map((session) => ({
          ...sessionEntry(session, "Continue session", (id) => { onClose(); openSession(id); }),
          ...(isIdle(session) ? {
            detail: [session.title, sessionStateText(session), session.subAgents?.count ? `+${session.subAgents.count} sub-agent${session.subAgents.count === 1 ? "" : "s"}` : null].filter(Boolean).join(" · "),
          } : {}),
        })),
        githubEntry(item, (url) => { onClose(); void openExternalUrl(url); }, pr),
        ...entries,
      ]}
      bottom={
        <DetailLines
          details={extra}
          loading={details.isLoading}
          error={details.error}
          linkedLabel={item.kind === "issue" ? "PR" : "Closes"}
          expected={item.target.kind === "pr" ? 1 : 0}
          sizeOf={item.kind === "issue" && item.target.kind === "pr" ? item.target.number : undefined}
        />
      }
    />
  );
}

// What a session in Wrap up's item sheet says about its worktree [ATT-22].
function sessionStateText(session: AgentSummary): string {
  const unsaved = sessionUnsaved(session);
  if (!unsaved) return "idle · nothing unsaved";
  return sessionCleanliness(session) === "unknown" ? "idle · couldn't check for unsaved changes" : `idle · ${unsavedWords(unsaved)}`;
}

// What the confirm sheet names for a session the server hasn't checked: Paseo's reading of it.
const readingOf = (session: AgentSummary | undefined): UnsavedSession =>
  session ? (sessionUnsaved(session) ?? { agentId: session.id, title: session.title }) : { agentId: "", title: null, unknown: true };

// The confirm sheet, shaped like Paseo's "Archive workspace" one: what each session's worktree would lose, in Paseo's
// words, then the terminals archiving closes; Open session to look first, or Archive [ATT-22].
function ArchiveSheet({ title, unsaved, onOpen, onArchive, onClose }: { title: string; unsaved: UnsavedSession[]; onOpen?: () => void; onArchive: () => void; onClose: () => void }) {
  const styles = useStyles();
  return (
    <Dialog title={title} onClose={onClose}>
      {unsaved.map((info) => (
        <View key={info.agentId} style={{ gap: 2 }}>
          {unsaved.length > 1 || info.title ? <Text style={styles.text}>{info.title ?? "Session"}</Text> : null}
          {sheetLines(info).map((line) => (
            <Text key={line} style={{ color: line.startsWith("Closes") ? styles.c.foregroundMuted : styles.c.statusWarning, fontSize: 13 }}>
              {line}
            </Text>
          ))}
        </View>
      ))}
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        {onOpen ? <Button label="Open session" icon="agent" variant="calm" onPress={onOpen} /> : <Button label="Cancel" onPress={onClose} />}
        <Button label="Archive" variant="danger" onPress={onArchive} />
      </View>
    </Dialog>
  );
}

// A row whose sessions are archived but whose worktree stayed, saying why, until the worktree goes or I dismiss it [ATT-22].
// Its button fits the reason: open the session that kept it, archive the worktree a terminal kept, or try Paseo again.
function KeptWorktreeRow({
  row,
  first,
  busy,
  login,
  openSession,
  onArchive,
  onDismiss,
}: {
  row: KeptRow;
  first: boolean;
  busy: boolean;
  login: string | null;
  openSession: (agentId: string) => void;
  onArchive: KeptProps["onArchiveWorktree"];
  onDismiss: (row: KeptRow) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const open = () => setDetailsOpen(true);
  const [sheet, setSheet] = useState<{ unsaved: UnsavedSession[]; terminals: string[] } | null>(null);
  const archive = async (confirm: boolean) => {
    const outcome = await onArchive(row, confirm, confirm ? (sheet?.terminals ?? []) : []);
    if (outcome && !outcome.ok && outcome.reason === "unsaved") return setSheet({ unsaved: outcome.sessions, terminals: outcome.terminals });
    setSheet(null);
  };
  const primary =
    row.reason === "session" && row.agentId
      ? { label: "Open session", icon: "agent" as const, onPress: () => openSession(row.agentId!) }
      : { label: row.reason === "refused" ? "Try again" : "Archive worktree", icon: "archive" as const, onPress: () => void archive(false) };
  return (
    <CardRow
      first={first}
      mark={{ icon: "archive", tone: "neutral" }}
      title={row.title}
      meta={{ place: { repo: row.repo, number: row.number, login }, when: keptText(row), signals: [] }}
      onOpen={open}
      busy={busy}
      primary={{ ...primary, accessibilityLabel: `${primary.label}: ${row.name}` }}
      secondary={[{ label: `Details for #${row.number}`, icon: "chevronRight", onPress: open }]}
      overlay={
        detailsOpen ? (
          <ActionSheet
            title={row.title}
            onClose={() => setDetailsOpen(false)}
            top={<Meta lead={<PlaceText place={{ repo: row.repo, number: row.number, login: null }} />} facts={[row.name, keptText(row)]} chips={[]} />}
            entries={[
              { key: "primary", ...primary, detail: row.reason === "session" ? "Opens the session keeping this worktree" : "Checks the worktree before archiving; asks before losing unsaved work or closing terminals", disabled: busy, onPress: () => { setDetailsOpen(false); primary.onPress(); } },
              { key: "dismiss", label: "Dismiss", icon: "close", detail: "Keeps the worktree and removes this reminder", housekeeping: true, disabled: busy, onPress: () => { setDetailsOpen(false); onDismiss(row); } },
            ]}
            bottom={null}
          />
        ) : sheet ? <ArchiveSheet title={`Archive "${row.name}"?`} unsaved={sheet.unsaved} onArchive={() => void archive(true)} onClose={() => setSheet(null)} /> : null
      }
    />
  );
}
