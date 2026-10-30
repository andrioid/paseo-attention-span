import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import * as rpc from "../shared/rpc";
import type { ConfigStatus, CoverageKind } from "../shared/setup";
import { VIEW_QUERY_KEY } from "./data";
import { Button, StylesProvider, useStyles } from "./ui";

const COVERAGE_QUERY_KEY = ["attention-span", "coverage"] as const;
const MY_ORGS_QUERY_KEY = ["attention-span", "my-orgs"] as const;
// A caption belongs to the card above it, so it sits closer to that card than to the next heading.
const CAPTION = { marginTop: -24, marginBottom: 16 };

// Settings → Plugins → Attention Span: which orgs and repos the lists cover, and where Next up looks,
// saved to config.json [SRC-02, NXT-04].
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
  const saveNextUp = useRpc(rpc.setNextUpSources);
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
  const { orgs, repos, nextUp } = coverage.data;
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
  async function write(next: Partial<ConfigStatus>, send: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await send();
      queryClient.setQueryData(COVERAGE_QUERY_KEY, { ...coverage.data!, ...next });
      await queryClient.invalidateQueries({ queryKey: VIEW_QUERY_KEY });
    } catch (failure) {
      setError(`Saving failed: ${(failure as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  const persist = (next: Pick<ConfigStatus, "orgs" | "repos">) => write(next, () => save(next));
  const persistNextUp = (next: ConfigStatus["nextUp"]) => write({ nextUp: next }, () => saveNextUp(next));
  const chosen = nextUp.mine || nextUp.orgs.length > 0 || nextUp.repos.length > 0;

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
      <View style={{ gap: 8 }}>
        <SettingsSection title="Repositories">
          <SettingsCard>
            {repos.map((repo) => (
              <SettingsAction key={repo} label={repo} actionLabel="Remove" disabled={saving} onPress={() => void persist({ orgs, repos: repos.filter((other) => other !== repo) })} />
            ))}
            <AddRow kind="repo" existing={repos} disabled={saving} onAdd={(name) => persist({ orgs, repos: [...repos, name] })} />
          </SettingsCard>
        </SettingsSection>
        <Text style={[styles.muted, CAPTION]}>
          {orgs.length || repos.length
            ? "Attention Span only shows pull requests and issues from the organizations and repositories above."
            : "With none chosen, Attention Span shows everything on GitHub that involves you."}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <NextUpSources value={nextUp} disabled={saving} onChange={persistNextUp} />
        <Text style={[styles.muted, CAPTION]}>
          {chosen
            ? "Next up suggests unclaimed issues from these."
            : orgs.length || repos.length
              ? "None chosen: using the orgs and repos above."
              : "None chosen: using your Paseo projects."}
        </Text>
      </View>
      <View style={{ gap: 4 }}>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        {/* Until more moves here, point to the file for the rest. */}
        <Text style={styles.muted}>Settings are not complete yet. Until then, check out your ~/.config/paseo-attention-span/config.json for more options.</Text>
      </View>
    </View>
  );
}

// Where Next up looks [NXT-04]: my own repos, orgs I belong to, and single repos. Each is its own chip on Next up [NXT-09].
function NextUpSources({ value, disabled, onChange }: { value: ConfigStatus["nextUp"]; disabled: boolean; onChange: (next: ConfigStatus["nextUp"]) => Promise<void> }) {
  const fetchOrgs = useRpc(rpc.myOrgs);
  const myOrgs = useQuery({ queryKey: MY_ORGS_QUERY_KEY, queryFn: () => fetchOrgs({}) });
  const choosable = (myOrgs.data?.orgs ?? []).filter((org) => !value.orgs.some((added) => added.toLowerCase() === org.toLowerCase()));
  return (
    <SettingsSection title="Next up">
      <SettingsCard>
        <SettingsSwitch label="My repos" value={value.mine} disabled={disabled} onValueChange={(mine) => void onChange({ ...value, mine })} />
        {value.orgs.map((org) => (
          <SettingsAction key={`org:${org}`} label={org} actionLabel="Remove" disabled={disabled} onPress={() => void onChange({ ...value, orgs: value.orgs.filter((other) => other !== org) })} />
        ))}
        {value.repos.map((repo) => (
          <SettingsAction key={`repo:${repo}`} label={repo} actionLabel="Remove" disabled={disabled} onPress={() => void onChange({ ...value, repos: value.repos.filter((other) => other !== repo) })} />
        ))}
        {myOrgs.data && myOrgs.data.orgs.length === 0 ? (
          <SettingsRow label="Add an organization" hint="You're not a member of any organizations" />
        ) : (
          <SettingsSelect
            label="Add an organization"
            error={myOrgs.error ? (myOrgs.error as Error).message : null}
            value=""
            options={[{ label: myOrgs.isLoading ? "Loading…" : "Choose…", value: "" }, ...choosable.map((org) => ({ label: org, value: org }))]}
            disabled={disabled || choosable.length === 0}
            onValueChange={(org) => void (org && onChange({ ...value, orgs: [...value.orgs, org] }))}
          />
        )}
        <AddRow kind="repo" placeholder="owner/name" existing={value.repos} disabled={disabled} onAdd={(name) => onChange({ ...value, repos: [...value.repos, name] })} />
      </SettingsCard>
    </SettingsSection>
  );
}

// Each name is checked on GitHub before it's saved; GitHub's exact name is what's kept.
function AddRow({ kind, placeholder, existing, disabled, onAdd }: { kind: CoverageKind; placeholder?: string; existing: string[]; disabled: boolean; onAdd: (name: string) => Promise<void> }) {
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
          placeholder={placeholder ?? (kind === "org" ? "acme" : "acme/shop")}
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
