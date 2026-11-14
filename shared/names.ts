// GitHub's logins, owner and repo names, and so item keys ("owner/name#number"), ignore case; so do org issue field
// names, as people type them in config.json. Compare them only through these.

// The same name, whatever its case; nothing matches a missing one.
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// Each name once, ignoring case, in the first spelling seen.
export function uniqueKeys(keys: string[]): string[] {
  const unique = new Map<string, string>();
  for (const key of keys) if (!unique.has(key.toLowerCase())) unique.set(key.toLowerCase(), key);
  return [...unique.values()];
}

// Names for looking up, ignoring case: `keySet(keys).has(key.toLowerCase())`.
export const keySet = (keys: Iterable<string>): Set<string> => new Set([...keys].map((key) => key.toLowerCase()));
