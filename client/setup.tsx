import { openExternalUrl, usePaseo } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { AttentionConfig } from "../shared/config";
import type { SetupStatus } from "../shared/setup";
import { githubProjects, listProfiles } from "./sessions";
import { Button, useStyles } from "./ui";

type State = "done" | "missing" | "optional";

interface Line {
  key: string;
  state: State;
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
}

// What's needed and how to fix it, in place of the tabs while nothing can load [SET-01].
// The last three lines don't block; they say what Attention Span will use.
export function SetupChecklist({
  status,
  config: loaded,
  onCheck,
  checking,
  openSettings,
}: {
  status: SetupStatus;
  // The last config that loaded, for the profile names; the defaults otherwise.
  config?: AttentionConfig;
  onCheck: () => void;
  checking: boolean;
  openSettings?: () => void;
}) {
  const styles = useStyles();
  const paseo = usePaseo();
  const toast = useToast();
  const projects = useQuery({ queryKey: ["attention-span", "github-projects"], queryFn: () => githubProjects(paseo) });
  const profiles = useQuery({ queryKey: ["attention-span", "profiles"], queryFn: () => listProfiles(paseo) });
  const { gh, config } = status;

  const copy = (command: string) =>
    void copyText(command).then(
      () => toast.show(`Copied ${command}`, { variant: "success" }),
      () => toast.error("Couldn't copy"),
    );

  const lines: Line[] = [];
  lines.push(
    gh.found
      ? { key: "gh", state: "done", title: "GitHub CLI installed" }
      : {
          key: "gh",
          state: "missing",
          title: "Install the GitHub CLI",
          detail: "On the machine that runs Paseo. Attention Span reads GitHub through it.",
          action: { label: "cli.github.com ↗", onPress: () => void openExternalUrl("https://cli.github.com") },
        },
  );
  if (gh.found)
    lines.push(
      gh.login
        ? { key: "login", state: "done", title: `Signed in to GitHub as ${gh.login}` }
        : {
            key: "login",
            state: "missing",
            title: "Sign in to GitHub",
            detail: `Run gh auth login on the machine that runs Paseo. gh says: ${gh.error}`,
            action: { label: "Copy command", onPress: () => copy("gh auth login") },
          },
    );
  lines.push(
    config.error
      ? { key: "config", state: "missing", title: "Fix config.json", detail: config.error }
      : {
          key: "coverage",
          state: config.orgs.length || config.repos.length ? "done" : "optional",
          title: config.orgs.length || config.repos.length ? `Covering ${[...config.orgs, ...config.repos].join(", ")}` : "Covering everything on GitHub that involves you",
          action: openSettings ? { label: "Choose orgs and repos", onPress: openSettings } : undefined,
        },
  );
  if (projects.data)
    lines.push(
      projects.data.length
        ? { key: "projects", state: "done", title: `${projects.data.length} Paseo ${projects.data.length === 1 ? "project" : "projects"} with a GitHub remote` }
        : { key: "projects", state: "optional", title: "No Paseo projects with a GitHub remote yet", detail: "Add the repos you work in as projects, so items can start sessions and Next up has issues to suggest." },
    );
  if (profiles.data) lines.push(agentLine(profiles.data.map((profile) => profile.name), (loaded ?? AttentionConfig.parse({})).profiles));

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>Set up Attention Span</Text>
        <Text style={styles.muted}>A few things are needed before it can show what's waiting on you.</Text>
      </View>
      <View style={styles.card}>
        {lines.map((line, index) => (
          <View key={line.key} style={[styles.item, index > 0 && styles.divider]}>
            <Mark state={line.state} />
            <View style={styles.body}>
              <Text style={styles.text}>{line.title}</Text>
              {line.detail ? <Text style={styles.muted}>{line.detail}</Text> : null}
            </View>
            {line.action ? <Button label={line.action.label} variant="calm" onPress={line.action.onPress} /> : null}
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Button label={checking ? "Checking…" : "Check again"} icon="reload" variant="solid" disabled={checking} onPress={onCheck} />
      </View>
    </View>
  );
}

function Mark({ state }: { state: State }) {
  const styles = useStyles();
  const { glyph, color } = {
    done: { glyph: "✓", color: styles.c.statusSuccess },
    missing: { glyph: "✗", color: styles.c.statusDanger },
    optional: { glyph: "○", color: styles.c.foregroundMuted },
  }[state];
  return <Text style={{ color, fontSize: 15, fontWeight: "700", width: 16, textAlign: "center" }}>{glyph}</Text>;
}

// Which agent sessions will use: the profile named for the session type, then "default", then Paseo's defaults [SES-06].
function agentLine(names: string[], profiles: AttentionConfig["profiles"]): Line {
  const has = (name: string) => names.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const fallback = has(profiles.default) ? `the ${profiles.default} profile` : "Paseo's default agent";
  const review = has(profiles.review ?? "") ? `the ${profiles.review} profile` : fallback;
  if (!has(profiles.default) && !has(profiles.review ?? ""))
    return { key: "agent", state: "optional", title: "Sessions use Paseo's default agent", detail: `Add an agent profile named ${profiles.review} for reviews, or ${profiles.default} for every session.` };
  return { key: "agent", state: "done", title: `Reviews use ${review}; other sessions use ${fallback}` };
}
