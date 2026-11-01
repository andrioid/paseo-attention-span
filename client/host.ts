import { type PluginHostProps, useHosts } from "@getpaseo/plugin/client";

// This host's name, once the app knows more than one host, so two copies of Attention Span can be told apart [REACH-02].
// Hosts without the plugin count too: the app can't say which hosts have it.
export function useHostLabel(host: PluginHostProps["host"]): string | null {
  const hosts = useHosts();
  return hosts.length > 1 ? host.label : null;
}
