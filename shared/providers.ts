// The agent providers a session can start with, and the agent config chosen from them [SES-01, SES-06].

// A provider that is ready and enabled on the host, with the model a session gets when nothing names one.
export interface ReadyProvider {
  provider: string;
  label: string;
  defaultModel?: string;
  defaultModeId?: string;
}

// The parts of Paseo's provider snapshot entry this needs.
interface SnapshotEntry {
  provider: string;
  status: string;
  enabled: boolean;
  label?: string;
  models?: { id: string; isDefault?: boolean }[];
  defaultModeId?: string | null;
}

export function readyProviders(entries: SnapshotEntry[]): ReadyProvider[] {
  return entries
    .filter((entry) => entry.status === "ready" && entry.enabled)
    .map((entry) => ({
      provider: entry.provider,
      label: entry.label ?? entry.provider,
      defaultModel: (entry.models ?? []).find((model) => model.isDefault)?.id ?? entry.models?.[0]?.id,
      defaultModeId: entry.defaultModeId ?? undefined,
    }));
}

// The parts of a Paseo agent profile this needs.
interface Profile {
  name: string;
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown> | null;
}

export interface ChosenAgent<P extends Profile> {
  label: string;
  agent: { provider: string; modeId?: P["modeId"]; thinkingOptionId?: P["thinkingOptionId"]; featureValues?: P["featureValues"] };
}

export const NO_PROVIDER = "No agent provider is ready on this host.";

// The profile with its provider's default model when it names none; without a profile, the first ready provider that has a model.
export function chooseAgent<P extends Profile>(profile: P | undefined, providers: ReadyProvider[]): ChosenAgent<P> {
  if (profile) {
    const model = profile.model ?? providers.find((entry) => entry.provider === profile.provider)?.defaultModel;
    return {
      label: profile.name,
      agent: {
        provider: model ? `${profile.provider}/${model}` : profile.provider,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues,
      },
    };
  }
  const fallback = providers.find((entry) => entry.defaultModel);
  if (!fallback) throw new Error(NO_PROVIDER);
  return {
    label: `Paseo default (${fallback.label})`,
    agent: { provider: `${fallback.provider}/${fallback.defaultModel}`, modeId: fallback.defaultModeId },
  };
}
