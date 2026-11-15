import { useState } from "react";
import { Text, View } from "react-native";
import type { AgentSummary, WrapItem } from "../shared/attention";
import { type ArchiveOutcome, type KeptRow, keptText, sheetLines, type UnsavedSession, unsavedWords } from "../shared/archive";
import { allWrapBusy, wrapBusy } from "../shared/got-it";
import { cleanSingle, sessionCleanliness, sessionUnsaved } from "../shared/wrap-up";
import { CardList, CardRow } from "./card";
import { stateMark } from "./mark";
import { Dialog } from "./sheet";
import { Button, SectionHeader, TablerIcon, useStyles } from "./ui";

// Doing's Wrap up: finished or out-of-my-hands work whose sessions are still open, and archiving them [ATT-22]. The screen
// assembles the rows and runs the archive; these draw them and ask before archiving anything unsaved or closing a terminal,
// in a sheet shaped like Paseo's own. A worktree that stayed lingers as a row saying why.

interface RowProps {
  busy: ReadonlySet<string>;
  login: string | null;
  // Previews have made-up sessions: their snapshot is the answer, as there's no daemon to ask.
  fixture: boolean;
  openAgent: (agentId: string) => void;
  onArchive: (item: WrapItem, confirm: boolean, terminals?: string[]) => Promise<ArchiveOutcome | null>;
}

interface KeptProps {
  kept: KeptRow[];
  onArchiveWorktree: (row: KeptRow, confirm: boolean, terminals?: string[]) => Promise<ArchiveOutcome | null>;
  onDismissKept: (row: KeptRow) => void;
}

// Finished or out-of-my-hands work whose Paseo sessions are all idle: the cleanup Doing owns [ATT-22].
export function WrapUp({ items, onArchiveAll, kept, onArchiveWorktree, onDismissKept, ...row }: { items: WrapItem[]; onArchiveAll: () => Promise<void> } & RowProps & KeptProps) {
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
        {items.map((item, index) => (
          <WrapRow key={item.key} item={item} first={index === 0} {...row} />
        ))}
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

// "merged by dave 2h ago · your session's still open": what finishing looked like, then the session it left behind [ATT-22].
function wrapMeta({ wrap }: WrapItem): string {
  const still = wrap.review ? "your review session's still open" : wrap.sessions.length > 1 ? `${wrap.sessions.length} sessions still open` : "your session's still open";
  return `${wrap.finish} · ${still}`;
}

function WrapRow({ item, first, busy, login, fixture, openAgent: openSession, onArchive }: { item: WrapItem; first: boolean } & RowProps) {
  const styles = useStyles();
  const { sessions } = item.wrap;
  const [sheet, setSheet] = useState<"multi" | "dirty" | null>(null);
  const [unsaved, setUnsaved] = useState<UnsavedSession[]>([]);
  // The terminals the confirm sheet names, sent back with it: a terminal opened since brings the sheet back [ATT-22].
  const [terminals, setTerminals] = useState<string[]>([]);
  // The worktrees the sheet's archive removes, by name, for its title.
  const [leaving, setLeaving] = useState<string[]>([]);
  const dirty = sessions.some((session) => sessionCleanliness(session) === "dirty");
  const press = async () => {
    if (sessions.length > 1) return setSheet("multi");
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
  // The multi sheet asks the server first, like a single row; unsaved work or open terminals it finds get the confirm that
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
      onOpen={() => (sessions.length > 1 ? setSheet("multi") : sessions[0] ? openSession(sessions[0].id) : undefined)}
      busy={wrapBusy(busy, item.key)}
      primary={{
        label: sessions.length > 1 ? "Archive sessions" : "Archive session",
        accessibilityLabel: `Archive the ${sessions.length > 1 ? "sessions" : "session"} on #${item.number}`,
        icon: "archive",
        onPress: () => void press(),
      }}
      secondary={[{ label: `Details for #${item.number}`, icon: "chevronRight", onPress: () => (sessions.length > 1 ? setSheet("multi") : sessions[0] ? openSession(sessions[0].id) : undefined) }]}
      overlay={
        sheet === "multi" ? (
          <Dialog title={`Sessions on #${item.number}`} onClose={() => setSheet(null)}>
            <Text style={styles.muted}>
              {item.title} · {item.wrap.finish}
            </Text>
            <View style={[styles.card, { backgroundColor: styles.c.surface2 }]}>
              {sessions.map((session, index) => (
                <View key={session.id} style={[styles.row, { paddingVertical: 10, paddingHorizontal: 12 }, index > 0 ? styles.divider : null]}>
                  <TablerIcon name="agent" size={16} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.text}>{session.title ?? "Session"}</Text>
                    <Text style={styles.muted}>{sessionStateText(session)}</Text>
                    {session.subAgents?.count ? (
                      <Text style={styles.muted}>
                        +{session.subAgents.count} sub-agent{session.subAgents.count === 1 ? "" : "s"}
                      </Text>
                    ) : null}
                  </View>
                  <Button label="Open" variant="ghost" onPress={() => openSession(session.id)} />
                </View>
              ))}
            </View>
            <Text style={styles.muted}>
              Archives {sessions.length} sessions. Their worktrees go too when no other session lives in them, closing their terminals
              {sessions.some((session) => sessionCleanliness(session) === "unknown") ? "; the one that couldn't be checked may hold unsaved work" : ""}.
            </Text>
            <View style={[styles.row, { justifyContent: "flex-end" }]}>
              <Button label="Cancel" onPress={() => setSheet(null)} />
              <Button label={sessions.length === 2 ? "Archive both" : `Archive ${sessions.length}`} variant="danger" onPress={() => void confirm(false)} />
            </View>
          </Dialog>
        ) : sheet === "dirty" ? (
          <ArchiveSheet
            title={leaving.length === 1 ? `Archive "${leaving[0]}"?` : sessions.length > 1 ? `Archive the sessions on #${item.number}?` : `Archive the session on #${item.number}?`}
            unsaved={unsaved.length ? unsaved : [readingOf(sessions[0])]}
            onOpen={() => openSession(unsaved[0]?.agentId ?? sessions[0].id)}
            onArchive={() => void confirm(true)}
            onClose={() => setSheet(null)}
          />
        ) : null
      }
    />
  );
}

// What a session in Wrap up's multi sheet says about its worktree [ATT-22].
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
      onOpen={primary.onPress}
      busy={busy}
      primary={{ ...primary, accessibilityLabel: `${primary.label}: ${row.name}` }}
      secondary={[{ label: "Dismiss", icon: "close", accessibilityLabel: `Dismiss: keep ${row.name}`, onPress: () => onDismiss(row) }]}
      overlay={
        sheet ? <ArchiveSheet title={`Archive "${row.name}"?`} unsaved={sheet.unsaved} onArchive={() => void archive(true)} onClose={() => setSheet(null)} /> : null
      }
    />
  );
}
