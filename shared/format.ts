// "5m", "3h", "4d", "2 months": how long ago an ISO timestamp was.
export function ago(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months`;
  return `${Math.floor(days / 365)} years`;
}

export function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000;
}

// A Markdown bullet list of links, for pasting a week's work into a report [HIS-03].
export function linkList(items: { title: string; url: string }[]): string {
  return items.map(({ title, url }) => `- [${title.replace(/[[\]\\]/g, "\\$&")}](${url})`).join("\n");
}

// Where a card's item lives: "app" for my own repos, "acme/app" for anyone else's, so same-named repos don't blur [ATT-05, NXT-10].
export function repoLabel(repo: string, login: string | null): string {
  const [owner, name] = repo.split("/");
  return name && login && owner.toLowerCase() === login.toLowerCase() ? name : repo;
}

// An issue field value for a card: "🐟 Tiny (< 4h)" -> "Tiny", "🏕P2 Medium" -> "P2 Medium" [NXT-10]. The sheet keeps the full value.
export function shortValue(value: string): string {
  return (
    value
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim() || value
  );
}
