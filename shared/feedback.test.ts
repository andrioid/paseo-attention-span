import { describe, expect, it } from "vitest";
import { type FeedbackContext, feedbackPrompt, themeName } from "./feedback";

const input: FeedbackContext = {
  message: "Waiting shows a PR\nthat I merged",
  dir: "/home/me/plugins/attention-span",
  version: "1.4.0",
  device: "phone",
  platform: "ios",
  theme: "dark",
  tab: "waiting",
  refreshError: null,
};

describe("feedbackPrompt", () => {
  it("FB-01: starts from the user's own words, quoted", () => {
    expect(feedbackPrompt("problem", input)).toContain("> Waiting shows a PR\n> that I merged");
  });

  it("FB-01: carries the versions, device, theme and tab, and a failed refresh", () => {
    const prompt = feedbackPrompt("problem", { ...input, refreshError: "gh: not logged in" });
    expect(prompt).toContain("Attention Span 1.4.0, phone (ios), dark theme, opened from the waiting tab, the last refresh failed: gh: not logged in.");
  });

  it("FB-01: posts only after approval, and keeps private details out", () => {
    const prompt = feedbackPrompt("idea", input);
    expect(prompt).toContain("Post it / Change something / Cancel");
    expect(prompt).toContain('post only after they reply "post"');
    expect(prompt).toContain("Nothing from them goes in the post");
  });

  it("FB-01: asks each kind for its own checklist", () => {
    expect(feedbackPrompt("problem", input)).toContain("Wrong list");
    expect(feedbackPrompt("problem", input)).not.toContain("Proposed requirement");
    expect(feedbackPrompt("idea", input)).toContain("Proposed requirement");
  });

  it("FB-01: reads the source by its path, and closes by archiving its own workspace", () => {
    const prompt = feedbackPrompt("idea", input);
    expect(prompt).toContain("The plugin's installed source is at /home/me/plugins/attention-span");
    expect(prompt).toContain("archive its workspace with Paseo's archive_workspace tool");
  });

  it("FB-01: reads the source from GitHub when it isn't on the host", () => {
    expect(feedbackPrompt("idea", { ...input, dir: null })).toContain("gh api repos/andrioid/paseo-attention-span/contents/<path>");
  });
});

describe("themeName", () => {
  it("FB-01: tells dark from light by the background", () => {
    expect(themeName("#101014")).toBe("dark");
    expect(themeName("#fafafa")).toBe("light");
  });
});
