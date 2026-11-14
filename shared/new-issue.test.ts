import { describe, expect, it } from "vitest";
import { AttentionConfig } from "./config";
import { lastMessages, newIssuePrompt, newIssueRepos, prefillRepo } from "./new-issue";

const config = (input: Partial<{ orgs: string[]; repos: string[]; nextUp: Partial<AttentionConfig["nextUp"]> }> = {}) => AttentionConfig.parse(input);

describe("newIssueRepos", () => {
  it("ISS-01: offers the chosen repositories, my projects and shown items under a chosen org, once each, sorted", () => {
    const repos = newIssueRepos(config({ orgs: ["acme"], repos: ["solo/tool"], nextUp: { repos: ["Acme/Web"] } }), ["acme/api", "other/thing"], ["acme/web", "acme/shop"], "me");
    expect(repos).toEqual(["acme/api", "acme/shop", "Acme/Web", "solo/tool"]);
  });

  it("ISS-01: always offers the repositories of items it shows, which it covers by definition", () => {
    expect(newIssueRepos(config({ repos: ["solo/tool"] }), ["other/thing"], ["elsewhere/lib"], "me")).toEqual(["elsewhere/lib", "solo/tool"]);
  });

  it("ISS-01: covers all my projects when nothing is chosen, as Attention Span covers everything involving me", () => {
    expect(newIssueRepos(config(), ["b/two", "a/one"], [], null)).toEqual(["a/one", "b/two"]);
  });

  it("ISS-01: counts my own account's projects when Next up looks in my repos", () => {
    expect(newIssueRepos(config({ nextUp: { mine: true } }), ["me/dots", "acme/api"], [], "me")).toEqual(["me/dots"]);
  });
});

describe("prefillRepo", () => {
  const repos = ["acme/api", "acme/web", "solo/tool"];

  it("ISS-01: starts on the workspace's repository, then Next up's, then the last one used", () => {
    expect(prefillRepo(repos, { workspace: "ACME/web", nextUp: "acme/api", last: "solo/tool" })).toBe("acme/web");
    expect(prefillRepo(repos, { nextUp: "acme/api", last: "solo/tool" })).toBe("acme/api");
    expect(prefillRepo(repos, { last: "solo/tool" })).toBe("solo/tool");
  });

  it("ISS-01: skips a repository it doesn't cover, and picks nothing when it can't tell", () => {
    expect(prefillRepo(repos, { workspace: "stranger/repo", last: "gone/repo" })).toBeNull();
    expect(prefillRepo(["only/one"], {})).toBe("only/one");
  });
});

describe("lastMessages", () => {
  it("ISS-01: keeps the last few things said, mine and the agent's, and cuts long ones short", () => {
    const entries = [
      { item: { type: "user_message", text: "first" } },
      { item: { type: "tool_call" } },
      { item: { type: "assistant_message", text: "x".repeat(900) } },
      { item: { type: "reasoning", text: "hidden" } },
      { item: { type: "user_message", text: "  " } },
      { item: { type: "user_message", text: "last" } },
    ];
    const messages = lastMessages(entries, 2);
    expect(messages.map((message) => message.from)).toEqual(["agent", "me"]);
    expect(messages[0].text).toHaveLength(801);
    expect(messages[1].text).toBe("last");
  });
});

describe("newIssuePrompt", () => {
  const input = { message: "Export fails\non empty months", repo: "acme/web", codeRepo: "acme/web", dir: "/src/web", source: null };

  it("ISS-01: starts from my words, quoted, in my checkout, changing nothing there", () => {
    const prompt = newIssuePrompt(input);
    expect(prompt).toContain("> Export fails\n> on empty months");
    expect(prompt).toContain("You are in my checkout of acme/web at /src/web.");
    expect(prompt).toContain("change nothing");
    expect(prompt).not.toContain("{{");
  });

  it("ISS-01: follows the repository's templates, labels and types, and posts only once I approve the draft", () => {
    const prompt = newIssuePrompt(input);
    expect(prompt).toContain(".github/ISSUE_TEMPLATE");
    expect(prompt).toContain("gh label list --repo acme/web");
    expect(prompt).toContain("issueTypes");
    expect(prompt).toContain("Post it / Change something / Cancel");
  });

  it("ISS-02: offers File anyway, Comment there or Cancel on a likely duplicate", () => {
    expect(newIssuePrompt(input)).toContain("File anyway / Comment there instead / Cancel");
  });

  it("ISS-01: archives only its own agent, never my checkout's workspace", () => {
    const prompt = newIssuePrompt(input);
    expect(prompt).toContain('archive_agent tool (find its ID with list_agents, titled "New issue: acme/web")');
    expect(prompt).toContain("never the workspace");
  });

  it("ISS-01: says where the code lives when it's kept apart from the issues", () => {
    expect(newIssuePrompt({ ...input, repo: "acme/issues" })).toContain("checkout of acme/web at /src/web, where acme/issues's code lives");
  });

  it("ISS-01: brings what the session I came from was doing, when I let it", () => {
    const source = { title: "Fix login", workspace: "web", branch: "fix-login", messages: [{ from: "me" as const, text: "why\ntwice?" }, { from: "agent" as const, text: "a race" }] };
    const prompt = newIssuePrompt({ ...input, source });
    expect(prompt).toContain('I started this from the Paseo session "Fix login" in web on branch fix-login.');
    expect(prompt).toContain("> **Me:** why\n> twice?\n>\n> **Agent:** a race");
    expect(prompt).toContain("nothing private");
    expect(newIssuePrompt(input)).not.toContain("I started this from");
  });
});
