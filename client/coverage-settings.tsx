import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import * as rpc from "../shared/rpc";
import type { ConfigStatus, CoverageKind } from "../shared/setup";
import { VIEW_QUERY_KEY } from "./data";
import { Button, StylesProvider, useStyles } from "./ui";

const COVERAGE_QUERY_KEY = ["attention-span", "coverage"] as const;

// Settings → Plugins → Attention Span: which orgs and repos the lists cover, saved to config.json [SRC-02].
export function CoverageSettings({ theme, layout }: PluginSurfaceProps) {
  return (
    <StylesProvider theme={theme} compact={layout.compact}>
      <Coverage />
    </StylesProvider>
  );
}

function Coverage() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const fetchCoverage = useRpc(rpc.getCoverage);
  const save = useRpc(rpc.setCoverage);
  const coverage = useQuery({ queryKey: COVERAGE_QUERY_KEY, queryFn: () => fetchCoverage({}) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!coverage.data)
    return (
      <SettingsSection title="Orgs and repos">
        <SettingsCard>
          <SettingsRow label={coverage.error ? "Couldn't read the settings" : "Loading…"} error={coverage.error ? (coverage.error as Error).message : null} />
        </SettingsCard>
      </SettingsSection>
    );
  const { orgs, repos, path } = coverage.data;
  // A file that doesn't parse is left for the person who edited it.
  if (coverage.data.error)
    return (
      <SettingsSection title="Orgs and repos">
        <SettingsCard>
          <SettingsRow label="config.json can't be read" hint="Fix the file by hand. Nothing here overwrites it." error={coverage.data.error} />
        </SettingsCard>
      </SettingsSection>
    );

  // Saving refreshes the lists on the daemon; the screen picks them up on its next read.
  async function persist(next: Pick<ConfigStatus, "orgs" | "repos">) {
    setSaving(true);
    setError(null);
    try {
      await save(next);
      queryClient.setQueryData(COVERAGE_QUERY_KEY, { ...coverage.data!, ...next });
      await queryClient.invalidateQueries({ queryKey: VIEW_QUERY_KEY });
    } catch (failure) {
      setError(`Saving failed: ${(failure as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Organizations">
        <SettingsCard>
          {orgs.map((org) => (
            <SettingsAction key={org} label={org} actionLabel="Remove" disabled={saving} onPress={() => void persist({ orgs: orgs.filter((other) => other !== org), repos })} />
          ))}
          <AddRow kind="org" existing={orgs} disabled={saving} onAdd={(name) => persist({ orgs: [...orgs, name], repos })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Repositories">
        <SettingsCard>
          {repos.map((repo) => (
            <SettingsAction key={repo} label={repo} actionLabel="Remove" disabled={saving} onPress={() => void persist({ orgs, repos: repos.filter((other) => other !== repo) })} />
          ))}
          <AddRow kind="repo" existing={repos} disabled={saving} onAdd={(name) => persist({ orgs, repos: [...repos, name] })} />
        </SettingsCard>
      </SettingsSection>
      <View style={{ gap: 4 }}>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        <Text style={styles.muted}>
          {orgs.length || repos.length
            ? "Every list covers only these. Next up looks for unclaimed issues in them too, unless nextUp.repos is set."
            : "Covering everything on GitHub that involves you. Next up looks for unclaimed issues in your Paseo projects' repos."}
        </Text>
        <Text style={styles.muted}>Saved in {path}, where everything else is set.</Text>
      </View>
    </View>
  );
}

// Each name is checked on GitHub before it's saved; GitHub's exact name is what's kept.
function AddRow({ kind, existing, disabled, onAdd }: { kind: CoverageKind; existing: string[]; disabled: boolean; onAdd: (name: string) => Promise<void> }) {
  const styles = useStyles();
  const check = useRpc(rpc.checkCoverage);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const label = kind === "org" ? "Add an organization" : "Add a repository";

  async function add() {
    if (!text.trim()) return;
    setChecking(true);
    setError(null);
    try {
      const result = await check({ kind, name: text });
      if (result.error !== null) return setError(result.error);
      if (existing.some((name) => name.toLowerCase() === result.name.toLowerCase())) return setError(`${result.name} is already in the list`);
      await onAdd(result.name);
      setText("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <SettingsRow label={label} error={error}>
      <View style={[styles.row, { flexShrink: 1 }]}>
        <TextInput
          accessibilityLabel={label}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setError(null);
          }}
          placeholder={kind === "org" ? "acme" : "acme/shop"}
          placeholderTextColor={styles.c.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled && !checking}
          onSubmitEditing={() => void add()}
          style={[styles.input, { minWidth: 160, flexShrink: 1 }]}
        />
        <Button label={checking ? "Checking…" : "Add"} variant="calm" disabled={disabled || checking || !text.trim()} onPress={() => void add()} />
      </View>
    </SettingsRow>
  );
}
