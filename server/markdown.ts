// GitHub Markdown for the screen: whole comments to render in the 👍 picker, and plain text for quotes cut anywhere.

const FENCE = /^\s*(```|~~~)/;

// Markdown cut after whole blocks only, so a cut never breaks a link or code block [MEN-07].
// HTML comments (PR templates) and images go; other HTML tags, like <details>, keep only their text.
export function excerpt(body: string | undefined, max = 600): string | null {
  const blocks = markdownBlocks(
    (body ?? "")
      .replace(/\r/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ""),
  );
  if (blocks.length === 0) return null;
  const kept: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (length + block.length > max) return kept.length ? `${kept.join("\n\n")}\n\n…` : cutBlock(block, max);
    kept.push(block);
    length += block.length;
  }
  return kept.join("\n\n");
}

// Paragraphs, lists and code blocks, split at blank lines outside code; HTML tags stripped outside code.
function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let inCode = false;
  const end = () => {
    const block = lines.join("\n").trim();
    if (block) blocks.push(block);
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inCode = !inCode;
    else if (!inCode && !line.trim()) {
      end();
      continue;
    }
    lines.push(inCode || FENCE.test(line) ? line : line.replace(/<\/?[a-zA-Z][^>]*>/g, ""));
  }
  end();
  return blocks;
}

// A first block too long on its own: cut at a line, else a word, and close an open code block.
function cutBlock(block: string, max: number): string {
  const cut = block.slice(0, max);
  const at = cut.lastIndexOf("\n") > max / 2 ? cut.lastIndexOf("\n") : Math.max(cut.lastIndexOf(" "), max - 40);
  const kept = cut.slice(0, at).trimEnd();
  return FENCE.test(kept) ? `${kept}\n\`\`\`\n\n…` : `${kept}…`;
}

// Markdown as plain text, for quotes cut mid-sentence where rendering would break [ATT-05].
// Links keep their text, emphasis and code lose their marks, quoted replies and HTML go.
export function plainText(markdown: string): string {
  return markdown
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[ \t]*>.*$/gm, "")
    .replace(/^[ \t]*(```|~~~).*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "");
}

// People and teams tagged in a comment, from GitHub's rendering of it: GitHub links a tag only to an account that exists and
// a team I can see, and never in code. Tags in quoted replies are someone else's words, so they don't count [WAI-02].
// Whether a comment asks something: a question mark in its own words, not in quotes, code or links [WAI-01].
export function asksQuestion(markdown: string | undefined): boolean {
  const withoutCode = (markdown ?? "").replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
  return /[?？]/.test(plainText(withoutCode).replace(/https?:\/\/\S+/g, ""));
}

export function taggedIn(html: string | undefined): { login: string; team: boolean }[] {
  let text = html ?? "";
  // Innermost quotes first, so nested ones go whole.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/g, "");
  } while (text !== previous);
  const tags: { login: string; team: boolean }[] = [];
  for (const [, attributes] of text.matchAll(/<a\b([^>]*)>/g)) {
    const kind = /\bclass="[^"]*\b(user|team)-mention\b/.exec(attributes)?.[1];
    const path = /\bhref="(?:https?:\/\/[^/"]+)?([^"?#]*)/.exec(attributes)?.[1] ?? "";
    const team = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/?$/.exec(path);
    const user = /^\/([^/]+)\/?$/.exec(path);
    const login = kind === "team" && team ? `${team[1]}/${team[2]}` : kind === "user" && user ? user[1] : undefined;
    if (login && !tags.some((tag) => tag.login.toLowerCase() === login.toLowerCase())) tags.push({ login, team: kind === "team" });
  }
  return tags;
}
