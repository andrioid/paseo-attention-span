import { useState } from "react";
import { Text, View } from "react-native";
import type { AgentSummary, WrapItem } from "../shared/attention";
import type { ArchiveOutcome, UnsavedSession } from "../shared/archive";
import { allWrapBusy, wrapBusy } from "../shared/got-it";
import { cleanSingle, sessionCleanliness, unsavedText } from "../shared/wrap-up";
import { CardList, CardRow } from "./card";
import { stateMark } from "./mark";
import { Modal } from "./sheet";
import { Button, KeepStyles, SectionHeader, TablerIcon, useStyles } from "./ui";

// Doing's Wrap up: finished or out-of-my-hands work whose sessions are still open, and archiving them [ATT-22]. The screen
// assembles the rows and runs the archive; these draw them and ask before archiving anything unsaved.

interface RowProps {
  busy: ReadonlySet<string>;
  login: string | null;
  // Previews have made-up sessions: their snapshot is the answer, as there's no daemon to ask.
  fixture: boolean;
  openAgent: (agentId: string) => void;
  onArchive: (item: WrapItem, confirm: boolean) => Promise<ArchiveOutcome | null>;
}

// Finished or out-of-my-hands work whose Paseo sessions are all idle: the cleanup Doing owns [ATT-22].
export function WrapUp({ items, onArchiveAll, ...row }: { items: WrapItem[]; onArchiveAll: () => Promise<void> } & RowProps) {
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
  const dirty = sessions.some((session) => sessionCleanliness(session) === "dirty");
  const press = async () => {
    if (sessions.length > 1) return setSheet("multi");
    // A preview has no daemon to ask; its made-up snapshot is the answer. Elsewhere the server checks git too, so the sheet
    // can name the files and commits it found.
    if (sessionCleanliness(sessions[0]) !== "clean" && fixture) {
      setUnsaved([dirtyFallback(sessions[0])]);
      return setSheet("dirty");
    }
    const outcome = await onArchive(item, false);
    if (outcome && !outcome.ok && outcome.reason === "unsaved") {
      setUnsaved(outcome.sessions);
      setSheet("dirty");
    }
  };
  // The multi sheet asks the server first, like a single row; unsaved work it finds gets the confirm that names it [ATT-22].
  const confirm = async (confirm: boolean) => {
    const outcome = await onArchive(item, confirm);
    if (outcome?.ok) return setSheet(null);
    if (outcome && outcome.reason === "unsaved") {
      setUnsaved(outcome.sessions);
      setSheet("dirty");
    }
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
          <Modal title={`Sessions on #${item.number}`} open onOpenChange={(open) => (open ? null : setSheet(null))}>
            <Modal.Content>
              <KeepStyles styles={styles}>
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
                      </View>
                      <Button label="Open" variant="ghost" onPress={() => openSession(session.id)} />
                    </View>
                  ))}
                </View>
                <Text style={styles.muted}>
                  Archives {sessions.length} sessions. Their worktrees go too when nothing else lives in them
                  {sessions.some((session) => sessionCleanliness(session) === "unknown") ? "; the one that couldn't be checked may hold unsaved work" : ""}.
                </Text>
                <View style={[styles.row, { justifyContent: "flex-end" }]}>
                  <Button label="Cancel" onPress={() => setSheet(null)} />
                  <Button label={sessions.length === 2 ? "Archive both" : `Archive ${sessions.length}`} variant="danger" onPress={() => void confirm(false)} />
                </View>
              </KeepStyles>
            </Modal.Content>
          </Modal>
        ) : sheet === "dirty" ? (
          <Modal title={sessions.length > 1 ? `Archive the sessions on #${item.number}?` : `Archive the session on #${item.number}?`} open onOpenChange={(open) => (open ? null : setSheet(null))}>
            <Modal.Content>
              <KeepStyles styles={styles}>
                {(unsaved.length ? unsaved : [dirtyFallback(sessions[0])]).map((info) => (
                  <View key={info.agentId} style={{ gap: 2 }}>
                    <Text style={styles.text}>{info.title ?? "Session"}</Text>
                    <Text style={{ color: styles.c.statusWarning, fontSize: 13 }}>
                      {info.unknown ? "Couldn't check for unsaved changes. Archiving may remove the worktree." : `Its worktree has ${unsavedTextFrom(info)}. Archiving may remove them.`}
                    </Text>
                  </View>
                ))}
                <View style={[styles.row, { justifyContent: "flex-end" }]}>
                  <Button label="Open session" icon="agent" variant="calm" onPress={() => openSession(unsaved[0]?.agentId ?? sessions[0].id)} />
                  <Button label="Archive anyway" variant="danger" onPress={() => void confirm(true)} />
                </View>
              </KeepStyles>
            </Modal.Content>
          </Modal>
        ) : null
      }
    />
  );
}

// What a session in Wrap up's multi sheet says about its worktree [ATT-22].
function sessionStateText(session: AgentSummary): string {
  const state = sessionCleanliness(session);
  if (state === "clean") return "idle · nothing unsaved";
  if (state === "dirty") return `idle · ${unsavedText(session)}`;
  return "idle · couldn't check for unsaved changes";
}

function dirtyFallback(session: AgentSummary | undefined): UnsavedSession {
  const workspace = session?.workspace;
  return session
    ? {
        agentId: session.id,
        title: session.title,
        ...(workspace?.branch ? { branch: workspace.branch } : {}),
        ...(workspace?.dirtyFiles ? { files: workspace.dirtyFiles } : {}),
        ...(workspace?.ahead ? { commits: workspace.ahead } : {}),
        ...(sessionCleanliness(session) === "unknown" ? { unknown: true as const } : {}),
      }
    : { agentId: "", title: null, unknown: true };
}

// "2 uncommitted files and 1 unpushed commit on branch", from the archive check's git counts [ATT-22].
function unsavedTextFrom(info: UnsavedSession): string {
  if (info.unknown) return "changes Paseo couldn't check";
  const parts: string[] = [];
  if (info.files) parts.push(`${info.files} uncommitted file${info.files === 1 ? "" : "s"}`);
  if (info.commits) parts.push(`${info.commits} unpushed commit${info.commits === 1 ? "" : "s"}`);
  const what = parts.join(" and ") || "unsaved changes";
  return info.branch ? `${what} on ${info.branch}` : what;
}
