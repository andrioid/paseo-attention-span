import { openExternalUrl, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgentSummary } from "../shared/attention";
import type { AttentionConfig } from "../shared/config";
import { FEEDBACK_REPO, type FeedbackContext, type FeedbackKind, feedbackItemKey, feedbackPrompt } from "../shared/feedback";
import * as rpc from "../shared/rpc";
import { ActionSheet, type SheetEntry } from "./sheet";
import { sessionEntry } from "./session-menu";
import { ITEM_LABEL, KIND_LABEL, LABEL, resolveAgentConfig } from "./sessions";
import { Button, KeepStyles, TablerIcon, useStyles } from "./ui";

// Feedback to the Attention Span project from the bottom of every tab [FB-01].
// Problem and Idea start an agent that asks until it's clear and posts only once I approve; Like opens the repo to star it.

const KINDS: Record<FeedbackKind, { label: string; detail: string; ask: string; placeholder: string; cont: string }> = {
  problem: {
    label: "Something's wrong",
    detail: "A bug, something in the wrong list, or something confusing. An agent asks until it's clear, then drafts an issue or discussion for you to approve",
    ask: "What happened?",
    placeholder: "Waiting still shows a PR I merged yesterday…",
    cont: "Continue problem report",
  },
  idea: {
    label: "I have an idea",
    detail: "An agent checks it against what's planned, asks until it's clear, then drafts an issue or discussion for you to approve",
    ask: "What's your idea?",
    placeholder: "I'd like to see…",
    cont: "Continue idea",
  },
};

const REPO_URL = `https://github.com/${FEEDBACK_REPO}`;

export type FeedbackScreen = Omit<FeedbackContext, "message" | "dir" | "version">;

export function FeedbackLine({ onPress }: { onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.row, { justifyContent: "center", paddingVertical: 12 }]} hitSlop={8}>
      <Text style={styles.muted}>Enjoying Attention Span?</Text>
      <TablerIcon name="chevronRight" size={14} color={styles.c.foregroundMuted} />
    </Pressable>
  );
}

// Picking a line closes the sheet before the next one opens, as an item's sheet does for Options:
// swapping the sheet for the next one inside it showed the wrong dialog on phones.
export function FeedbackSheet({
  agents,
  onOpenAgent,
  onAsk,
  onClose,
}: {
  agents: AgentSummary[];
  onOpenAgent: (agentId: string) => void;
  onAsk: (kind: FeedbackKind) => void;
  onClose: () => void;
}) {
  const close = (then: () => void) => () => (onClose(), then());
  // Built with map, not a for loop: a closure must get its own kind on every JS engine the app runs on.
  const entries: SheetEntry[] = (["problem", "idea"] as const).flatMap((kind): SheetEntry[] => {
    // An open one takes the line, so a report stays in one session [SES-03].
    const open = agents.filter((agent) => agent.itemKey === feedbackItemKey(kind));
    if (open.length) return open.map((agent) => sessionEntry(agent, KINDS[kind].cont, (id) => close(() => onOpenAgent(id))()));
    return [{ key: kind, icon: "agent", label: `${KINDS[kind].label}…`, detail: KINDS[kind].detail, onPress: close(() => onAsk(kind)) }];
  });
  entries.push({ key: "like", icon: "star", label: "I'll star it on GitHub", detail: "Opens the repo, so others find it too", onPress: close(() => void openExternalUrl(REPO_URL)) });
  return <ActionSheet title="Enjoying Attention Span?" top={null} entries={entries} bottom={null} onClose={onClose} />;
}

// The first words go in the prompt, so the agent's first message is already a follow-up [FB-01].
export function FeedbackAsk({
  kind,
  config,
  screen,
  onStarted,
  onBack,
  onClose,
}: {
  kind: FeedbackKind;
  config: AttentionConfig;
  screen: FeedbackScreen;
  onStarted: (agentId: string) => Promise<void>;
  onBack: () => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const fetchInfo = useRpc(rpc.feedbackInfo);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);

  async function start() {
    setStarting(true);
    try {
      const info = await fetchInfo({});
      const prompt = feedbackPrompt(kind, { ...screen, message, dir: info.hasSource ? info.cwd : null, version: info.version });
      const { agent } = await resolveAgentConfig(paseo, "start", config);
      const workspace = await paseo.workspaces.open({ cwd: info.cwd });
      const created = await workspace.agents.create({
        config: { ...agent, modeId: (await readOnlyMode(paseo, agent.provider)) ?? agent.modeId },
        title: `Feedback: ${KINDS[kind].label}`,
        prompt,
        labels: { [LABEL]: "1", [ITEM_LABEL]: feedbackItemKey(kind), [KIND_LABEL]: `feedback-${kind}` },
      });
      onClose();
      await onStarted(created.id);
    } catch (error) {
      toast.error(`Starting the session failed: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Modal title={KINDS[kind].label} open onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Content>
        <KeepStyles styles={styles}>
          <View style={{ gap: 10 }}>
            <Text style={styles.muted}>{KINDS[kind].ask}</Text>
            <TextInput
              style={[styles.input, { minHeight: 110 }]}
              value={message}
              onChangeText={setMessage}
              placeholder={KINDS[kind].placeholder}
              multiline
              textAlignVertical="top"
              autoFocus
            />
            <Text style={styles.muted}>An agent asks what else it needs and shows you the post before anything goes to GitHub.</Text>
            <View style={styles.wrap}>
              <Button label={starting ? "Starting…" : "Start"} icon="agent" variant="solid" disabled={starting || !message.trim()} onPress={() => void start()} />
              <Button label="Back" onPress={onBack} />
            </View>
          </View>
        </KeepStyles>
      </Modal.Content>
    </Modal>
  );
}

// The provider's plan or read-only mode, where it has one, so the session reads but doesn't change files.
async function readOnlyMode(paseo: ReturnType<typeof usePaseo>, provider: string): Promise<string | undefined> {
  const name = provider.split("/")[0];
  const snapshot = await paseo.providers.snapshot();
  const modes = snapshot.entries.find((entry) => entry.provider === name)?.modes ?? [];
  return modes.find((mode) => /plan|read.?only/i.test(`${mode.id} ${mode.label}`))?.id;
}
