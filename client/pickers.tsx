import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Markdown, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { checkoutPr, type Item, type Reviewer } from "../shared/attention";
import type { AttentionConfig } from "../shared/config";
import { ago } from "../shared/format";
import { renderPrompt } from "../shared/prompts";
import * as rpc from "../shared/rpc";
import type { OptionsChoice, OptionsSpec } from "./item-actions";
import { branchWorkspaces, findCheckout, githubProjects, listProfiles, noProjectMessage, resolveAgentConfig, useStartRpcs } from "./sessions";
import { useAttention } from "./data";
import { useSessionSource } from "./session-source";
import { Dialog } from "./sheet";
import { Avatar, Button, CheckRow, Loading, TablerIcon, Toggle, useStyles } from "./ui";

// The dialogs a card or the screen opens before acting: which comments to 👍, who should review, a session's options, and
// where an issue's code lives.

// Pick which waiting comments get a 👍, after reading them in full; all are picked to start [MEN-07].
export function AcknowledgeSheet({ item, onReact, onClose }: { item: Item; onReact: (ids: string[]) => void; onClose: () => void }) {
  const styles = useStyles();
  const comments = item.person?.comments ?? [];
  const [picked, setPicked] = useState(() => new Set(comments.map((c) => c.id)));
  const toggle = (id: string) => setPicked((now) => (now.has(id) ? new Set([...now].filter((other) => other !== id)) : new Set([...now, id])));
  return (
    <Dialog title={`Acknowledge: ${item.title}`} onClose={onClose}>
      <View style={styles.row}>
        <TablerIcon name="thumbUp" size={14} />
        <Text style={[styles.muted, { flexShrink: 1 }]}>Tells them you've seen it, and clears it from your list.</Text>
      </View>
      {comments.map((c) => (
        <CheckRow key={c.id} checked={picked.has(c.id)} label={`Comment from ${c.author}`} onPress={() => toggle(c.id)} style={[styles.quote, styles.row, { alignItems: "flex-start", gap: 10 }]}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ color: styles.c.foreground, fontSize: 12, fontWeight: "600" }}>
              {c.author} <Text style={[styles.muted, { fontWeight: "400" }]}>· {ago(c.createdAt)}</Text>
            </Text>
            <Markdown>{c.body}</Markdown>
          </View>
        </CheckRow>
      ))}
      <View style={styles.wrap}>
        <Button
          label={`${picked.size} comment${picked.size === 1 ? "" : "s"}`}
          icon="thumbUp"
          accessibilityLabel={`Acknowledge ${picked.size} comment${picked.size === 1 ? "" : "s"}`}
          variant="solid"
          disabled={picked.size === 0}
          onPress={() => onReact(comments.filter((c) => picked.has(c.id)).map((c) => c.id))}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </Dialog>
  );
}

// Who should review a PR: GitHub's suggestions, who reviewed my other PRs in the repo, its teams, or anyone typed in.
// All start unticked; requesting keeps whoever is already asked [PRS-12].
export function ReviewerSheet({
  item,
  afterReady,
  onRequest,
  onClose,
}: {
  item: Item;
  afterReady: boolean;
  onRequest: (reviewers: string[]) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const fetchReviewers = useRpc(rpc.reviewerChoices);
  const choices = useQuery({ queryKey: ["attention-span", "reviewers", item.target.repo, item.target.number], queryFn: () => fetchReviewers({ target: item.target }), staleTime: 60_000 });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState<Reviewer[]>([]);
  const [text, setText] = useState("");
  const toggle = (login: string) => setPicked((now) => (now.has(login) ? new Set([...now].filter((other) => other !== login)) : new Set([...now, login])));
  // Each person or team once, in the first group that has them.
  const seen = new Set<string>();
  const once = (list: Reviewer[]) => list.filter((reviewer) => !seen.has(reviewer.login.toLowerCase()) && seen.add(reviewer.login.toLowerCase()));
  const groups = [
    { title: "Added", list: once(typed) },
    { title: "Suggested by GitHub", list: once(choices.data?.suggested ?? []) },
    { title: "Recent on your PRs here", list: once(choices.data?.recent ?? []) },
    { title: "Teams", list: once(choices.data?.teams ?? []) },
  ];
  const add = () => {
    const login = text.trim().replace(/^@/, "");
    if (!login) return;
    setTyped((now) => [...now, { login, team: login.includes("/") }]);
    setPicked((now) => new Set([...now, login]));
    setText("");
  };
  const count = `${picked.size} reviewer${picked.size === 1 ? "" : "s"}`;
  return (
    <Dialog title={`${afterReady ? "Ready for review" : "Request review"}: ${item.title}`} onClose={onClose}>
      <Text style={styles.muted}>{afterReady ? `PR ${item.target.number} is out of draft. Who should review it?` : `Who should review PR ${item.target.number}?`}</Text>
      {choices.isLoading ? <Loading text="Loading suggestions…" /> : null}
      {choices.error ? <Text style={styles.danger}>Couldn't load suggestions: {(choices.error as Error).message}</Text> : null}
      {groups.map(({ title, list }) =>
        list.length > 0 ? (
          <View key={title} style={{ gap: 4 }}>
            <Text style={[styles.muted, { fontSize: 12 }]}>{title}</Text>
            {list.map((reviewer) => (
              <CheckRow key={reviewer.login} checked={picked.has(reviewer.login)} label={reviewer.login} onPress={() => toggle(reviewer.login)} style={[styles.row, { paddingVertical: 4 }]}>
                {reviewer.team ? <TablerIcon name="claim" size={18} color={styles.c.foregroundMuted} /> : <Avatar url={reviewer.avatarUrl} />}
                <Text style={{ color: styles.c.foreground, fontSize: 13 }}>{reviewer.login}</Text>
              </CheckRow>
            ))}
          </View>
        ) : null,
      )}
      {choices.data?.teamsNote ? <Text style={styles.muted}>{choices.data.teamsNote}</Text> : null}
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="Login, or org/team"
          placeholderTextColor={styles.c.foregroundMuted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={add}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button label="Add" variant="calm" disabled={!text.trim()} onPress={add} />
      </View>
      <View style={styles.wrap}>
        <Button
          label={`Request ${count}`}
          icon="claim"
          variant="solid"
          disabled={picked.size === 0}
          onPress={() => onRequest([...picked])}
        />
        <Button label={afterReady ? "Skip" : "Cancel"} onPress={onClose} />
      </View>
    </Dialog>
  );
}

// Session options in a modal: a bottom sheet on phones [SES-02].
// Start keeps the sheet open, saying so, until the session is written or the start failed [FRESH-04].
export function SessionOptions({
  spec,
  config,
  onStart,
  onClose,
}: {
  spec: OptionsSpec;
  config: AttentionConfig;
  onStart: (spec: OptionsSpec, choice: OptionsChoice) => Promise<boolean>;
  onClose: () => void;
}) {
  const styles = useStyles();
  const paseo = usePaseo();
  const sessionSource = useSessionSource(useAttention().data);
  const { fetchContext, defaultBranch, fetchProviders } = useStartRpcs();
  const { itemKey, kind, target } = spec;
  const options = useQuery({
    queryKey: ["attention-span", "options", itemKey, kind],
    queryFn: async () => {
      const [{ context }, profiles, checkout, defaults] = await Promise.all([
        fetchContext({ kind, target }),
        listProfiles(paseo),
        findCheckout(paseo, config, target, defaultBranch),
        // Without a ready provider, still show the options; starting reports the error.
        resolveAgentConfig(paseo, sessionSource!, fetchProviders, kind, config).catch(() => ({ label: "No agent provider is ready" })),
      ]);
      const workspaces = checkout.project ? await branchWorkspaces(paseo, checkout.project.projectId, checkoutPr(kind, target).head) : [];
      return { prompt: renderPrompt(kind, target, context, config), profiles, checkout, workspaces, defaultLabel: defaults.label };
    },
    staleTime: 60_000,
    enabled: !!sessionSource,
  });
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [profileId, setProfileId] = useState<string>();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const data = options.data;

  async function start() {
    if (!data) return;
    setStarting(true);
    const started = await onStart(spec, { prompt: prompt ?? data.prompt, checkout: data.checkout, profileId, workspaceId });
    setStarting(false);
    if (started) onClose();
  }

  return (
    <Dialog title={spec.title} onClose={onClose}>
      {options.isLoading ? <Loading text="Loading context…" /> : null}
      {!options.isLoading && !data ? <Text style={styles.danger}>{(options.error as Error)?.message ?? "No options"}</Text> : null}
      {data && !data.checkout.project ? <Text style={styles.danger}>{noProjectMessage(data.checkout, target)}</Text> : null}
      {data?.checkout.project ? (
        <View style={{ gap: 10 }}>
          <Text style={styles.muted}>Workspace</Text>
          <View style={styles.wrap}>
            <Toggle label="New worktree" active={!workspaceId} onPress={() => setWorkspaceId(undefined)} />
            {data.workspaces.map((w) => (
              <Toggle key={w.id} label={w.name} active={workspaceId === w.id} onPress={() => setWorkspaceId(w.id)} />
            ))}
          </View>
          <Text style={styles.muted}>Agent profile</Text>
          <View style={styles.wrap}>
            <Toggle label={data.defaultLabel} active={!profileId} onPress={() => setProfileId(undefined)} />
            {data.profiles.map((p) => (
              <Toggle key={p.id} label={p.name} active={profileId === p.id} onPress={() => setProfileId(p.id)} />
            ))}
          </View>
          <Text style={styles.muted}>Prompt</Text>
          <TextInput style={[styles.input, { minHeight: 180 }]} value={prompt ?? data.prompt} onChangeText={setPrompt} multiline textAlignVertical="top" />
          <View style={styles.wrap}>
            <Button label={starting ? "Starting…" : "Start session"} icon="agent" variant="solid" disabled={starting} onPress={() => void start()} />
            <Button label="Cancel" onPress={onClose} />
          </View>
        </View>
      ) : null}
    </Dialog>
  );
}

// Where an issue repo's code lives, picked from my Paseo projects and saved to config.json [SES-07].
export function CodeRepoPicker({ issueRepo, missing, onPick, onClose }: { issueRepo: string; missing: string; onPick: (repo: string) => void; onClose: () => void }) {
  const styles = useStyles();
  const paseo = usePaseo();
  const projects = useQuery({ queryKey: ["attention-span", "github-projects"], queryFn: () => githubProjects(paseo) });
  return (
    <Dialog title={`Where does the code for ${issueRepo} live?`} onClose={onClose}>
      <View style={{ gap: 10 }}>
        <Text style={styles.text}>No Paseo project has {missing} as its GitHub remote. Pick the project that holds the code for issues in {issueRepo}.</Text>
        {projects.isLoading ? <Loading text="Loading projects…" /> : null}
        {projects.data?.length === 0 ? <Text style={styles.danger}>No Paseo project has a GitHub remote. Add the code repository as a project first.</Text> : null}
        <View style={styles.wrap}>
          {projects.data?.map((project) => (
            <Button key={project.projectId} label={project.repo} icon="play" variant="calm" onPress={() => onPick(project.repo)} />
          ))}
        </View>
        <Text style={styles.muted}>Saved to codeRepos in config.json, so the next start goes straight there.</Text>
        <View style={styles.wrap}>
          <Button label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Dialog>
  );
}
