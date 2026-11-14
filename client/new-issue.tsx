import { type PluginScreenParams, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AttentionView } from "../shared/attention";
import { codeRepoFor } from "../shared/config";
import { lastMessages, newIssueItemKey, newIssuePrompt, newIssueTag, newIssueTitle, prefillRepo, type SourceSession } from "../shared/new-issue";
import * as rpc from "../shared/rpc";
import { Dialog } from "./sheet";
import { githubProjects, ITEM_LABEL, LABEL, listProfiles, resolveAgentConfig } from "./sessions";
import { Button, Loading, TablerIcon, Toggle, useStyles } from "./ui";

// A new issue in a repository I cover, from ⌘K anywhere in Paseo or from Next up [ISS-01]. A line or two here, then an agent in
// my checkout asks until it's clear, checks for duplicates [ISS-02] and posts only once I approve the draft [SAFE-01].

// Where the sheet was opened from. ⌘K can't show a sheet of its own, so it opens the screen with these as its params.
export interface NewIssueRequest {
  // A fresh one per pick, so a screen opened again with the same params doesn't show the sheet twice.
  at: string;
  workspaceId?: string;
  agentId?: string;
  // The repository Next up is narrowed to.
  nextUp?: string;
}

export function newIssueParams(request: Pick<NewIssueRequest, "workspaceId" | "agentId">): PluginScreenParams {
  return { newIssue: String(Date.now()), ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}), ...(request.agentId ? { agentId: request.agentId } : {}) };
}

const seen = new Set<string>();

// The request in the screen's params, once per pick.
export function takeNewIssueRequest(params: PluginScreenParams | undefined): NewIssueRequest | null {
  const at = params?.newIssue;
  if (!at || seen.has(at)) return null;
  seen.add(at);
  return { at, workspaceId: params.workspaceId, agentId: params.agentId };
}

type Paseo = ReturnType<typeof usePaseo>;

interface SourceWorkspace {
  projectId: string;
  name: string;
  directory: string;
  branch: string | null;
}

async function sourceWorkspace(paseo: Paseo, workspaceId: string): Promise<SourceWorkspace | null> {
  const { entries } = await paseo.workspaces.list();
  const workspace = entries.find((entry) => entry.id === workspaceId);
  if (!workspace) return null;
  return {
    projectId: workspace.projectId,
    name: workspace.title ?? workspace.name,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
    branch: workspace.gitRuntime?.currentBranch ?? null,
  };
}

// The session I came from: its title and last few messages. Reading them may fail; the rest still helps.
async function sourceSession(paseo: Paseo, agentId: string, workspace: SourceWorkspace | null): Promise<SourceSession> {
  const agent = paseo.agents.ref(agentId);
  const base = { workspace: workspace?.name ?? null, branch: workspace?.branch ?? null };
  const page = await agent.timeline.refetch({ direction: "tail", limit: 40, projection: "projected" }).catch(() => null);
  if (!agent.current()) await agent.refresh().catch(() => null);
  return { ...base, title: agent.current()?.title ?? null, messages: page ? lastMessages(page.entries) : [] };
}

export function NewIssueSheet({
  request,
  view,
  onView,
  onStarted,
  onClose,
}: {
  request: Omit<NewIssueRequest, "at">;
  view: AttentionView;
  onView: (view: AttentionView) => void;
  onStarted: (agentId: string) => Promise<void>;
  onClose: () => void;
}) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const fetchProviders = useRpc(rpc.readyProviders);
  const remember = useRpc(rpc.setNewIssueChoice);
  const setCodeRepo = useRpc(rpc.setCodeRepo);
  const projects = useQuery({ queryKey: ["attention-span", "github-projects"], queryFn: () => githubProjects(paseo) });
  const profiles = useQuery({ queryKey: ["attention-span", "profiles"], queryFn: () => listProfiles(paseo) });
  const from = useQuery({
    queryKey: ["attention-span", "new-issue-source", request.workspaceId ?? null],
    queryFn: () => (request.workspaceId ? sourceWorkspace(paseo, request.workspaceId) : null),
  });
  const { repos } = view.newIssue;
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [withContext, setWithContext] = useState(true);
  const [profileId, setProfileId] = useState<string | null | undefined>(undefined);
  const [options, setOptions] = useState(false);
  const [starting, setStarting] = useState(false);
  const [placing, setPlacing] = useState(false);

  const workspaceRepo = from.data ? projects.data?.find((project) => project.projectId === from.data?.projectId)?.repo : null;
  const repo = picked ?? prefillRepo(repos, { workspace: workspaceRepo, nextUp: request.nextUp, last: view.newIssue.repo });
  // A remembered profile that's gone falls back to the default.
  const knownProfile = view.newIssue.profileId && profiles.data?.some((profile) => profile.id === view.newIssue.profileId) ? view.newIssue.profileId : null;
  const profile = profileId === undefined ? knownProfile : profileId;
  // Where its code lives, if it's kept apart, and my checkout of that [SES-05, SES-07].
  const codeRepo = repo ? codeRepoFor(view.config, repo) : null;
  const checkout = codeRepo ? (projects.data?.find((project) => project.repo.toLowerCase() === codeRepo.toLowerCase()) ?? null) : null;
  const loading = projects.isLoading || from.isLoading;
  // Start waits for where I came from and my profiles, so a quick tap doesn't fall back to the project's checkout or the
  // default profile.
  const ready = !loading && !profiles.isLoading;
  const noCheckout = !!repo && !loading && !checkout;
  const fromSession = !!request.agentId;

  async function place(code: string) {
    if (!repo) return;
    setPlacing(true);
    try {
      onView(await setCodeRepo({ issueRepo: repo, codeRepo: code }));
    } catch (error) {
      toast.error(`Saving where the code lives failed: ${(error as Error).message}`);
    } finally {
      setPlacing(false);
    }
  }

  async function start() {
    if (!repo || !codeRepo || !checkout) return;
    setStarting(true);
    try {
      // In the workspace I came from when it's a checkout of the code, else in the project's own checkout.
      const here = request.workspaceId && from.data?.projectId === checkout.projectId ? from.data : null;
      const dir = here?.directory ?? checkout.rootPath;
      const source = fromSession && withContext && request.agentId ? await sourceSession(paseo, request.agentId, from.data ?? null) : null;
      const title = newIssueTitle(repo, newIssueTag());
      const prompt = newIssuePrompt({ message, repo, codeRepo, dir, source, title });
      const { agent } = await resolveAgentConfig(paseo, () => fetchProviders({}).then((result) => result.providers), "start", view.config, profile ?? undefined);
      const workspace = here && request.workspaceId ? paseo.workspaces.ref(request.workspaceId) : await paseo.workspaces.open({ cwd: checkout.rootPath });
      const created = await workspace.agents.create({
        config: agent,
        title,
        prompt,
        labels: { [LABEL]: "1", [ITEM_LABEL]: newIssueItemKey(repo) },
      });
      onView({ ...view, newIssue: { ...view.newIssue, repo, profileId: profile } });
      remember({ repo, profileId: profile }).catch(() => {}); // only next time's starting point
      onClose();
      await onStarted(created.id);
    } catch (error) {
      toast.error(`Starting the session failed: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  const profileName = profile ? (profiles.data?.find((choice) => choice.id === profile)?.name ?? profile) : "Default";
  const summary = [repo ?? "Pick a repository", fromSession ? (withContext ? "with this session's context" : "without this session's context") : null, `${profileName} profile`]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog title="New issue" onClose={onClose}>
      <View style={{ gap: 10 }}>
        <Text style={styles.muted}>What should the issue be about?</Text>
        <TextInput
          style={[styles.input, { minHeight: 110 }]}
          value={message}
          onChangeText={setMessage}
          placeholder={fromSession ? "File what we just found: …" : "Export fails when a month has no entries…"}
          multiline
          textAlignVertical="top"
          autoFocus
        />
        {repos.length === 0 ? (
          <Text style={styles.danger}>No repositories to file in yet. Choose what Attention Span covers in Settings.</Text>
        ) : (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: options }} onPress={() => setOptions(!options)} style={styles.row} hitSlop={6}>
            <TablerIcon name={options ? "chevronDown" : "chevronRight"} size={14} color={styles.c.foregroundMuted} />
            <Text style={[styles.muted, { flexShrink: 1 }]}>{summary}</Text>
          </Pressable>
        )}
        {options || (!repo && repos.length > 0) ? (
          <View style={{ gap: 10 }}>
            <Text style={styles.muted}>Repository</Text>
            <View style={styles.wrap}>
              {repos.map((choice) => (
                <Toggle key={choice} label={choice} active={choice === repo} onPress={() => setPicked(choice)} />
              ))}
            </View>
            {options && fromSession ? (
              <>
                <Text style={styles.muted}>Context</Text>
                <View style={styles.wrap}>
                  <Toggle label="Include this session's last messages" active={withContext} onPress={() => setWithContext(!withContext)} />
                </View>
              </>
            ) : null}
            {options ? (
              <>
                <Text style={styles.muted}>Agent profile</Text>
                <View style={styles.wrap}>
                  <Toggle label="Default" active={!profile} onPress={() => setProfileId(null)} />
                  {profiles.data?.map((choice) => (
                    <Toggle key={choice.id} label={choice.name} active={profile === choice.id} onPress={() => setProfileId(choice.id)} />
                  ))}
                </View>
              </>
            ) : null}
          </View>
        ) : null}
        {loading && repo ? <Loading text="Finding your checkout…" /> : null}
        {noCheckout ? (
          // Like SES-07: picked once, saved to codeRepos, so the next one goes straight there.
          <View style={{ gap: 8 }}>
            <Text style={styles.text}>
              No Paseo project has {codeRepo} as its GitHub remote. Pick the project that holds the code for {repo}, or add it as a project in Paseo.
            </Text>
            <View style={styles.wrap}>
              {projects.data?.map((project) => (
                <Button key={project.projectId} label={project.repo} icon="play" variant="calm" disabled={placing} onPress={() => void place(project.repo)} />
              ))}
            </View>
          </View>
        ) : null}
        <Text style={styles.muted}>An agent in your checkout asks what else it needs and shows you the issue before anything goes to GitHub.</Text>
        <View style={styles.wrap}>
          <Button
            label={starting ? "Starting…" : "Start"}
            icon="agent"
            variant="solid"
            disabled={starting || !ready || !message.trim() || !checkout}
            onPress={() => void start()}
          />
          <Button label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Dialog>
  );
}
