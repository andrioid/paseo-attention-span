import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import * as rpc from "../shared/rpc";
import { DEFAULT_FIELD, FIELD_ROLES, type FieldRole, sameField } from "../shared/config";
import type { ConfigStatus, CoverageKind, IssueField } from "../shared/setup";
import { VIEW_QUERY_KEY } from "./data";
import { Button, StylesProvider, useStyles } from "./ui";

const COVERAGE_QUERY_KEY = ["attention-span", "coverage"] as const;
const MY_ORGS_QUERY_KEY = ["attention-span", "my-orgs"] as const;
const FIELDS_QUERY_KEY = ["attention-span", "issue-fields"] as const;
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
  const saveFollow = useRpc(rpc.setFollowThreads);
  const saveFields = useRpc(rpc.setNextUpFields);
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
  const { orgs, repos, nextUp, fields, followThreads } = coverage.data;
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
      // Other orgs may have other fields.
      if (next.orgs || next.repos || next.nextUp) void queryClient.invalidateQueries({ queryKey: FIELDS_QUERY_KEY });
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
      <NextUpFields value={fields} disabled={saving} onChange={(role, field) => write({ fields: { ...fields, [role]: field } }, () => saveFields({ [role]: field }))} />
      <View style={{ gap: 8 }}>
        <SettingsSection title="Replies">
          <SettingsCard>
            <SettingsSwitch
              label="Follow threads I've commented on"
              value={followThreads}
              disabled={saving}
              onValueChange={(on) => void write({ followThreads: on }, () => saveFollow({ on }))}
            />
          </SettingsCard>
        </SettingsSection>
        <Text style={[styles.muted, CAPTION]}>
          {followThreads
            ? "Recent replies after your comment on other people's threads show under Answered."
            : "Only tags bring other people's threads back. Your own issues and PRs show any recent reply."}
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

const ROLE_LABEL: Record<FieldRole, string> = { priority: "Priority", effort: "Effort", scope: "Scope" };
const ROLE_HINT: Record<FieldRole, string> = {
  priority: "Ranks the list, in the field's order",
  effort: "Breaks ties, in the field's order",
  scope: "Adds a filter to Next up",
};

// Which org issue fields rank and filter Next up [NXT-04], picked from the fields its orgs have. Until I pick, a field
// named after the role is used, so an org with Priority and Effort needs no setup.
function NextUpFields({ value, disabled, onChange }: { value: ConfigStatus["fields"]; disabled: boolean; onChange: (role: FieldRole, field: string | null) => Promise<void> }) {
  const styles = useStyles();
  const fetchFields = useRpc(rpc.issueFields);
  const available = useQuery({ queryKey: FIELDS_QUERY_KEY, queryFn: () => fetchFields({}) });
  const fields: IssueField[] = available.data?.fields ?? [];
  const find = (name: string | null | undefined) => fields.find((field) => sameField(field.name, name ?? undefined));
  // What each role uses now: the chosen field, or the one named after it if an org has it. Names match without case,
  // so a field typed "priority" shows as GitHub's "Priority".
  const current = (role: FieldRole): string | null => {
    const chosen = role in value ? (value[role] ?? null) : DEFAULT_FIELD[role];
    return find(chosen)?.name ?? (role in value ? chosen : null);
  };
  const none = available.isLoading ? "Loading…" : "None";

  return (
    <View style={{ gap: 8 }}>
      <SettingsSection title="Next up fields">
        <SettingsCard>
          {FIELD_ROLES.map((role) => {
            const chosen = current(role);
            // A field no org has any more still shows, so it can be seen and changed.
            const missing = chosen && available.data && !find(chosen) ? [{ label: `${chosen} (not found)`, value: chosen }] : [];
            const hint = !(role in value) && chosen ? `${ROLE_HINT[role]}. Picked by its name` : ROLE_HINT[role];
            return (
              <SettingsSelect
                key={role}
                label={ROLE_LABEL[role]}
                hint={hint}
                error={role === "priority" && available.error ? (available.error as Error).message : null}
                value={chosen ?? ""}
                options={[{ label: none, value: "" }, ...missing, ...fields.map((field) => ({ label: field.name, value: field.name }))]}
                disabled={disabled || !available.data}
                onValueChange={(field) => void onChange(role, field || null)}
              />
            );
          })}
        </SettingsCard>
      </SettingsSection>
      <Text style={[styles.muted, CAPTION]}>
        {available.data && fields.length === 0
          ? "None of the organizations Next up looks in have issue fields, so it lists issues oldest first."
          : "Org issue fields from the organizations Next up looks in. Values rank in the order the organization lists them."}
      </Text>
    </View>
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
