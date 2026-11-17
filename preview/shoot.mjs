// Screenshots of the plugin in the real Paseo web app, connected to the container's own daemon.
// Usage: shoot.mjs [selection] [layout]; writes PNGs to /out. The selection is described in shots.mjs: nothing for every
// shot, a layout part (`phone`), a shot (`doing-sheet`), or a layout's shot (`desktop-dark-doing-sheet`), comma-separated.
// Only the scenarios that take a selected shot run, and only selected shots are written.
import { readFile, rm, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { SCENARIOS, select } from "./shots.mjs";

const [selection = "", only] = process.argv.slice(2);
let wanted;
try {
  wanted = select(selection);
} catch (error) {
  console.log(`failed: ${error.message}`);
  process.exit(1);
}
const devices = {
  // Tall, because the plugin screen scrolls inside its own view, so the page itself never grows.
  desktop: { viewport: { width: 1280, height: 3000 }, isMobile: false },
  phone: { viewport: { width: 390, height: 4200 }, isMobile: true },
};
// No screenshot is taller than a desktop monitor; what's below the fold isn't worth reading.
const MAX_HEIGHT = 1080;
const tabs = ["Doing", "History", "Waiting", "Next up"];
// Each layout starts without the code-repo mapping that an earlier layout saved.
const configPath = `${process.env.HOME}/.config/paseo-attention-span/config.json`;
const originalConfig = await readFile(configPath, "utf8");
// While this exists, the fixture has nothing in it: a quiet day, for the empty tabs' scenes.
const quietPath = `${process.env.HOME}/.config/paseo-attention-span/fixture-quiet`;
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
let failed = false;
// Instead of fixed sleeps: wait until the page stops changing (no DOM mutations, which JS-driven animations make, for a
// moment, and no CSS transition running) and every image has loaded. Gives up after a few seconds, so a page that never settles is slow, not stuck.
const QUIET_MS = 150;
const SETTLE_LIMIT_MS = 5000;
const settledIn = (page) =>
  page.evaluate(
    ({ quiet, limit }) =>
      new Promise((resolve) => {
        const start = performance.now();
        let last = start;
        const observer = new MutationObserver(() => (last = performance.now()));
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        const check = () => {
          const now = performance.now();
          const images = [...document.images].every((image) => image.complete);
          // CSS transitions (a sheet sliding up) move things without touching the DOM. Endless ones (spinners) don't count.
          const moving = document.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
          if ((now - last >= quiet && images && !moving) || now - start >= limit) {
            observer.disconnect();
            resolve(now - start >= limit);
          } else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
    { quiet: QUIET_MS, limit: SETTLE_LIMIT_MS },
  );

for (const prefix of wanted.layouts.filter((name) => !only || name === only)) {
  const [device, colorScheme] = prefix.split("-");
  const layout = { name: device, ...devices[device] };
  const shots = wanted.shots[prefix];
  const want = (name) => !shots || shots.includes(name);
  const scenarios = SCENARIOS.filter((scenario) => (!scenario.desktop || !layout.isMobile) && scenario.shots.some(want));
  const started = Date.now();
  // The top of the page, at most a desktop monitor tall.
  const fold = () => ({ x: 0, y: 0, width: layout.viewport.width, height: Math.min(layout.viewport.height, MAX_HEIGHT) });
  const page = await browser.newPage({ viewport: layout.viewport, isMobile: layout.isMobile, hasTouch: layout.isMobile, colorScheme });
  // The fixture answers at once, so what isn't there within 10 seconds won't come: fail then, not after Playwright's 30.
  page.setDefaultTimeout(10000);
  let unsettled = 0;
  const settled = async () => {
    if (await settledIn(page)) unsettled++;
  };
  // Poll a condition on this side (config.json, a count), failing with what was awaited.
  const until = async (condition, what, timeout = 10000) => {
    for (const end = Date.now() + timeout; !(await condition()); ) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  // Every screenshot goes through here, so a selection writes only what it asked for. `clip` is computed only then.
  const capture = async (name, clip) => {
    if (want(name)) await page.screenshot({ path: `/out/${prefix}-${name}.png`, clip: typeof clip === "function" ? await clip() : clip });
  };
  // The plugin's own scrolling view: the nearest scrolling ancestor of its tabs.
  const scroller = () => {
    let node = document.querySelector('[role="tab"]');
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    return node;
  };
  // Clip to where the plugin's scrolled content ends, so tall viewports don't leave empty space.
  const shot = (name) =>
    capture(name, async () => {
      const bottom = await page.evaluate(`(${scroller})()?.firstElementChild?.getBoundingClientRect().bottom ?? 0`);
      const { width, height } = page.viewportSize();
      return { x: 0, y: 0, width, height: Math.min(height, MAX_HEIGHT, bottom > 0 ? Math.ceil(bottom) + 16 : MAX_HEIGHT) };
    });
  // A sheet, modal or menu sits over the whole page: clip to a band around it, so the thumbnail stays readable.
  // On phones it's a bottom sheet: a draggable container, taller than what it shows, so end at its last text.
  const modalShot = (name) =>
    capture(name, async () => {
      const box = layout.isMobile
        ? await page.evaluate(() => {
            const texts = (node) => [...node.querySelectorAll("*")].filter((n) => !n.children.length && n.textContent.trim());
            const sheet = [...document.querySelectorAll('[role="slider"]')].filter((n) => texts(n).length).pop();
            if (!sheet) return null;
            const y = sheet.getBoundingClientRect().y;
            return { y, height: Math.max(...texts(sheet).map((n) => n.getBoundingClientRect().bottom)) - y };
          })
        : await page.getByRole("dialog").or(page.getByRole("menu")).last().boundingBox().catch(() => null);
      const { width, height } = page.viewportSize();
      const y = box ? Math.max(0, Math.floor(box.y) - 80) : 0;
      return { x: 0, y, width, height: Math.min(height - y, MAX_HEIGHT, box ? Math.ceil(box.height) + 160 : MAX_HEIGHT) };
    });
  // Screens without tabs: the top of the page is enough.
  const top = (name) => capture(name, { ...fold(), height: layout.isMobile ? 1080 : 900 });
  // On phones the sidebar sits behind a menu button. Wait for the entry first, so a slow load doesn't look like a phone.
  const openAttention = async () => {
    const entry = page.getByText("Attention", { exact: true }).first();
    await entry.waitFor({ state: "attached", timeout: 15000 });
    if (!(await entry.isVisible())) await page.getByRole("button", { name: /menu|sidebar/i }).first().click().catch(() => {});
    await entry.click();
    await page.getByRole("button", { name: "Refresh now" }).waitFor({ timeout: 15000 });
  };
  // The app from the start, with the full fixture and config: before the first scenario, after one that leaves the
  // plugin's screen, and after a failure.
  const start = async () => {
    await writeFile(configPath, originalConfig);
    await rm(quietPath, { force: true });
    // The container's daemon serves the web app and is the only host it knows.
    await page.goto("http://127.0.0.1:6767/", { waitUntil: "domcontentloaded" });
    await openAttention();
    await page.getByRole("button", { name: "Refresh now" }).click(); // reloads config.json
    await settled();
    // An earlier layout's dismissal lives on in the daemon; bring it back.
    const restore = page.getByText(/dismissed · show them again/);
    if (await restore.isVisible()) {
      await restore.click();
      await settled();
    }
  };
  // A tab, scrolled to its top, so a scenario looks the same whether or not others ran before it.
  const tab = async (name) => {
    await page.getByRole("tab", { name: new RegExp(name) }).first().click();
    await page.evaluate(`(${scroller})()?.scrollTo(0, 0)`);
    await settled();
  };
  const band = async (from, to) => {
    const header = (title) => page.locator(`text=/^${title}/ >> visible=true`).first();
    await header(from).scrollIntoViewIfNeeded();
    await settled();
    const y = Math.max(0, Math.floor((await header(from).boundingBox()).y) - 24);
    const end = Math.ceil((await header(to).boundingBox()).y) - 16;
    // Just the list's column, with even margins: the sidebar on desktops is 320 px wide.
    const sidebar = layout.isMobile ? 0 : 320;
    const x = Math.max(sidebar, Math.floor((await header(from).boundingBox()).x) - 48);
    return { x, y, width: layout.viewport.width - x - (x - sidebar), height: Math.min(end - y, MAX_HEIGHT) };
  };
  const bandShot = (name, from, to) => capture(name, () => band(from, to));
  // A phone's bottom sheet has no Escape; its × closes it.
  const closeModal = async () => {
    const close = page.getByRole("button", { name: /^close/i }).last();
    if (await close.isVisible().catch(() => false)) await close.click();
    else await page.keyboard.press("Escape");
    await settled();
  };
  const keepIssueOpen = async (number) => {
    await page.getByRole("button", { name: `Details for #${number}`, exact: true }).click();
    await page.getByRole("button", { name: "Keep open", exact: true }).last().click();
    await settled();
  };
  const sheetOpen = () => page.getByText(/^Open (issue|PR)( on GitHub)?$/).last();
  const openSheet = async (title) => {
    await page.getByRole("button", { name: `${title}, more` }).first().click();
    await sheetOpen().waitFor({ timeout: 10000 });
    await settled();
  };
  const closeSheet = async () => {
    await page.keyboard.press("Escape");
    await settled();
    if (await sheetOpen().isVisible()) await page.getByRole("button", { name: /^(?!Close issue).*close/i }).last().click(); // the sheet's ×, not its Close issue entry
    await settled();
  };
  const sheet = (tabName, title, name) => async () => {
    await tab(tabName);
    await openSheet(title);
    await modalShot(name);
    await closeSheet();
  };
  // A toast covers what's under it: wait it out, so the next scenario's shots don't depend on this one.
  const toastGone = (text) => page.getByText(text).waitFor({ state: "hidden", timeout: 15000 });
  // What a face and an amber age mean, in words on hover, floating over the card so nothing moves [ATT-19, ATT-11].
  // A band around what's pointed at; touch has no hover.
  const around = async (target) => {
    const box = await target.boundingBox();
    const sidebar = layout.isMobile ? 0 : 320;
    return { x: sidebar, y: Math.max(0, Math.floor(box.y) - 90), width: layout.viewport.width - sidebar, height: 150 };
  };
  const clipboard = async () => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:6767" });
    return () => page.evaluate(() => navigator.clipboard.readText());
  };
  // Source and scope filters sit behind one button [NXT-03, NXT-09]. Ticks apply right away.
  const filter = async (ticks) => {
    await page.getByRole("button", { name: /^Filter/ }).click();
    await page.getByText("Source", { exact: true }).waitFor({ timeout: 10000 });
    for (const name of ticks) await page.getByRole("checkbox", { name }).click();
    await settled();
  };
  const done = async () => {
    await page.getByRole("button", { name: "Done" }).click();
    await settled();
  };
  const config = async () => JSON.parse(await readFile(configPath, "utf8"));

  // Each scenario starts on the plugin's screen with nothing open, and leaves it so.
  const run = {
    tabs: async () => {
      for (const name of tabs) {
        await tab(name);
        await shot(name.toLowerCase().replace(" ", "-"));
      }
    },
    // Doing's sections, one band each. Optional checks failing or still running leave a PR ready [PRS-14]. Wrap up:
    // finished work whose sessions are still open, first in Doing [ATT-22]. A session started outside Attention Span,
    // on the PR its workspace is linked to [SES-08].
    "doing-bands": async () => {
      await tab("Doing");
      await bandShot("doing-needs-reviewer", "Needs a reviewer", "My drafts");
      await bandShot("doing-ready", "Ready to merge", "Needs upstream");
      await bandShot("doing-wrap", "Wrap up", "Waiting for your reply");
      await bandShot("doing-review", "Review requested", "CI failing");
    },
    // Card bodies and chevrons open details without navigating or starting cleanup [ATT-06, ATT-22, ATT-24].
    "wrap-details": async () => {
      await tab("Doing");
      for (const [number, title] of [
        [186, "Split the invoice PDF job"], [172, "Fix VAT on credit notes"], [152, "Customer statements as PDF"],
        [176, "Round prices per currency"], [178, "Cache the tax tables"], [179, "Drop the legacy exporter"],
      ]) {
        const details = page.getByRole("button", { name: `Details for #${number}`, exact: true });
        // Start with the body; then check the chevron opens the same sheet.
        await page.getByRole("button", { name: `${title}, more`, exact: true }).first().click();
        const dialog = layout.isMobile ? page.getByRole("slider").filter({ hasText: title }).last() : page.getByRole("dialog");
        await dialog.waitFor({ timeout: 10000 });
        await closeModal();
        await details.click();
        await dialog.waitFor({ timeout: 10000 });
        if (number === 186 || number === 172) {
          await dialog.getByRole("button", { name: "Continue session", exact: true }).first().waitFor();
          await dialog.getByRole("button", { name: "Open PR on GitHub", exact: true }).waitFor();
        }
        await settled();
        if (number === 186) {
          await modalShot("doing-wrap-sheet");
          await dialog.getByRole("button", { name: "Archive session", exact: true }).click();
          await page.getByText("Closes terminals: dev, shell").waitFor({ timeout: 10000 });
          await settled();
        }
        if (number === 152) {
          await dialog.getByRole("button", { name: "Close #152", exact: true }).waitFor();
          // The fixture models an already-started session: it remains reachable while working [SES-03, SES-10].
          await dialog.getByRole("button", { name: "Continue session", exact: true }).waitFor();
          await dialog.getByText("working", { exact: true }).waitFor();
          for (const pr of [194, 195]) await dialog.getByRole("link", { name: `Open PR #${pr} on GitHub`, exact: true }).waitFor();
          await modalShot("doing-wrap-ask-sheet");
          await dialog.getByRole("button", { name: "Start another session…", exact: true }).click();
          await page.getByText("Start session: Customer statements as PDF", { exact: true }).waitFor({ timeout: 10000 });
          await page.getByRole("button", { name: "Start session", exact: true }).last().waitFor({ timeout: 10000 });
          await settled();
        }
        if (number === 178) {
          await dialog.getByRole("button", { name: "Archive worktree", exact: true }).waitFor();
          await modalShot("doing-wrap-worktree-sheet");
        }
        await closeModal();
      }
    },
    // A dirty session asks first; several sessions list themselves. Neither archives until confirmed.
    "wrap-confirm": async () => {
      await tab("Doing");
      await page.getByRole("button", { name: "Archive the session on #186" }).click();
      await page.getByText("Closes terminals: dev, shell").waitFor({ timeout: 10000 });
      await settled();
      await modalShot("doing-wrap-dirty");
      await closeModal();
      await page.getByRole("button", { name: "Archive the sessions on #172" }).click();
      await page.getByText("Archive both").waitFor({ timeout: 10000 });
      await settled();
      await modalShot("doing-wrap-multi");
      await closeModal();
    },
    // "Close #152?": Keep open in its sheet has Undo, which brings the question back [ATT-24]. Close isn't pressed, since it
    // would call GitHub.
    "wrap-ask": async () => {
      await tab("Doing");
      await keepIssueOpen(152);
      await page.getByText("Kept #152 open").waitFor({ timeout: 10000 });
      await bandShot("doing-wrap-kept-open", "Kept #152 open", "Waiting for your reply");
      await page.getByRole("button", { name: "Undo" }).first().click();
      await page.getByRole("button", { name: "Close #152 as completed", exact: true }).waitFor({ timeout: 10000 });
      await settled();
    },
    hints: async () => {
      await tab("Doing");
      const face = page.getByLabel(/^Waiting on bob since/).first();
      await face.scrollIntoViewIfNeeded();
      await face.hover();
      await settled();
      await capture("doing-hint", () => around(face));
      await page.mouse.move(0, 0);
      await tab("Waiting");
      const age = page.getByLabel(/^Waited too long:/).first();
      await age.scrollIntoViewIfNeeded();
      await age.hover();
      await settled();
      await capture("waiting-too-long", () => around(age));
      await page.mouse.move(0, 0);
      await settled();
    },
    // Copy what waits on alice for a nudge, and keep what landed on the clipboard [WAI-03].
    "waiting-copy": async () => {
      await tab("Waiting");
      const read = await clipboard();
      await page.getByRole("button", { name: "Copy what waits on alice" }).click();
      const toast = page.getByText(/^Copied \d+ links? for alice$/);
      await toast.waitFor({ timeout: 5000 });
      await shot("waiting-copied");
      await writeFile(`/out/${prefix}-waiting-clipboard.txt`, `${await read()}\n`);
      await toastGone(/^Copied \d+ links? for alice$/);
    },
    // Who a question waits on, each by name in its sheet [WAI-02].
    "waiting-sheet": sheet("Waiting", "Invoice totals round wrong", "waiting-sheet"),
    "doing-sheet": sheet("Doing", "Show delivery dates on the order page", "doing-sheet"),
    // An issue led card: its stack of PRs, each opening on GitHub [ATT-03, ATT-12].
    "doing-issue-sheet": sheet("Doing", "Supplier prices are a week out of date", "doing-issue-sheet"),
    // A stack GitHub links to no issue, under the issue its descriptions name [ATT-03, ATT-04].
    "doing-stack-issue-sheet": sheet("Doing", "The calendar can't be used with a keyboard", "doing-stack-issue-sheet"),
    "doing-review-sheet": sheet("Doing", "Add a status page", "doing-review-sheet"),
    // Someone else's stack asking for my review: one Review stack, and the session started on its upper PR [ATT-04].
    "doing-review-stack-sheet": sheet("Doing", "Price rules: data model", "doing-review-stack-sheet"),
    acknowledge: async () => {
      await tab("Doing");
      await openSheet("Publish security.txt");
      await page.getByRole("button", { name: "Acknowledge" }).last().click();
      await page.getByRole("button", { name: "Acknowledge 2 comments" }).waitFor({ timeout: 10000 });
      await settled();
      await modalShot("doing-acknowledge");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await settled();
    },
    // Who should review a PR nobody was asked on: suggestions, recent reviewers, teams, a typed name [PRS-12].
    reviewers: async () => {
      await tab("Doing");
      await page.getByRole("button", { name: "Request review", exact: true }).first().click();
      await page.getByText("Suggested by GitHub").waitFor({ timeout: 10000 });
      await page.getByRole("checkbox", { name: "carol" }).click();
      await settled();
      await modalShot("doing-reviewers");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await settled();
    },
    // Without a session, a session action's line in the sheet asks first [SES-02].
    options: async () => {
      await tab("Doing");
      await openSheet("Harden the upload endpoint");
      await page.getByRole("button", { name: "Address comments…" }).last().click();
      await page.getByText("Agent profile").last().waitFor({ timeout: 15000 });
      await settled();
      await modalShot("doing-options");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await settled();
    },
    // The first Ready card's: the a11y stack's.
    "merge-confirm": async () => {
      await tab("Doing");
      await page.getByRole("button", { name: "Merge", exact: true }).first().click();
      await settled();
      await shot("doing-merge-confirm");
      await page.getByRole("button", { name: "Cancel" }).click();
      await settled();
    },
    // Feedback from the bottom of the tab: the three lines, then the first words for a problem [FB-01].
    feedback: async () => {
      await tab("Doing");
      await page.getByRole("button", { name: "Enjoying Attention Span?" }).click();
      await page.getByText("I'll star it on GitHub").waitFor({ timeout: 10000 });
      await settled();
      await modalShot("doing-feedback");
      await page.getByRole("button", { name: "Something's wrong…" }).click();
      await page.getByText("What happened?").waitFor({ timeout: 10000 });
      await page.getByPlaceholder(/Waiting still shows/).fill("Waiting still shows a PR I merged yesterday.");
      await settled();
      await modalShot("doing-feedback-ask");
      await page.getByRole("button", { name: /close/i }).last().click();
      await settled();
    },
    // History's filter: Finished always, Reviewed and cleared Changed by others when asked [HIS-07]. Then both of the
    // week's other lists under Finished [HIS-02, HIS-07], and copies of a week and of one card's link [HIS-03, ATT-15].
    "history-filter": async () => {
      await tab("History");
      await page.getByRole("button", { name: /^Filter/ }).first().click();
      await page.getByText("Show in each week").waitFor({ timeout: 10000 });
      await settled();
      await modalShot("history-filter");
      await page.getByRole("checkbox", { name: "Reviewed", exact: true }).click();
      await page.getByRole("checkbox", { name: "Changed by others", exact: true }).click();
      await done();
      await shot("history-filtered");
      await bandShot("history-groups", "Reviewed", "Last week");
      const read = await clipboard();
      // The newest week with work in it: on a Monday, "This week" has none yet.
      await page.getByRole("button", { name: /^Copy links from / }).first().click();
      await page.getByText(/^Copied \d+ links? from /).waitFor({ timeout: 5000 });
      await shot("history-copied");
      const week = await read();
      await page.getByRole("button", { name: /^Copy link to #\d+$/ }).first().click();
      await settled();
      await writeFile(`/out/${prefix}-history-clipboard.txt`, `${week}\n---\n${await read()}\n`);
      // Clear the filter: the choice is saved, and every scenario starts from Finished only.
      await page.getByRole("button", { name: /^Filter/ }).first().click();
      await page.getByRole("button", { name: "Clear" }).click();
      await done();
      await toastGone(/^Copied \d+ links? /);
    },
    "next-up-sheet": sheet("Next up", "Orders export times out for big shops", "next-up-sheet"),
    // Close asks first, on the card: reason and an optional comment [NXT-11]. Cancelled, since it would call GitHub.
    "next-up-close": async () => {
      await tab("Next up");
      await openSheet("Merge the two import commands");
      await page.getByRole("button", { name: "Close issue" }).click();
      await page.locator('[role="button"][aria-label="Not planned"] >> visible=true').first().waitFor({ timeout: 10000 });
      await settled();
      await shot("next-up-close");
      await page.locator('[role="button"][aria-label="Cancel"] >> visible=true').first().click();
      await settled();
    },
    // New issue: a line or two, then where it goes, opened [ISS-01]. Never started, since that would open a session.
    "next-up-new-issue": async () => {
      await tab("Next up");
      await page.getByRole("button", { name: "New issue" }).click();
      await page.getByText("What should the issue be about?").waitFor({ timeout: 10000 });
      await page.getByPlaceholder(/Export fails/).fill("Export fails when a month has no entries");
      await page.getByRole("button", { name: "acme/shop", exact: true }).click();
      await page.getByRole("button", { name: /^acme\/shop · Default profile$/ }).click();
      await page.getByText("Agent profile").waitFor({ timeout: 10000 });
      await settled();
      await modalShot("next-up-new-issue");
      await closeModal();
    },
    // Unclaimed grouped by repository, the one with the P0 first, then back to one list [NXT-14]. Saved, so it's turned off
    // again for the scenarios after.
    "next-up-by-repo": async () => {
      await tab("Next up");
      const toggle = page.getByRole("button", { name: "Group by repo" });
      await toggle.click();
      const headings = page.getByRole("heading", { name: /^(acme\/|tool)/ });
      await headings.first().waitFor({ timeout: 10000 });
      await settled();
      const names = await headings.allTextContents();
      if (names.join(" | ") !== "acme/shop · 4 | acme/web · 2 | tool · 1") throw new Error(`Repo headings: ${names.join(" | ")}`);
      if ((await toggle.getAttribute("aria-pressed")) !== "true") throw new Error("Group by repo isn't marked as on");
      const unclaimed = page.locator("text=/^Unclaimed/ >> visible=true").first();
      await unclaimed.evaluate((node) => node.scrollIntoView({ block: "start" }));
      await settled();
      await capture("next-up-by-repo", async () => {
        const y = Math.max(0, Math.floor((await unclaimed.boundingBox()).y) - 16);
        const { width, height } = page.viewportSize();
        return { x: 0, y, width, height: Math.min(height - y, MAX_HEIGHT) };
      });
      await toggle.click();
      await headings.first().waitFor({ state: "hidden", timeout: 10000 });
      await settled();
    },
    "next-up-filters": async () => {
      await tab("Next up");
      await filter(["🔙 Backend"]);
      await modalShot("next-up-filter");
      await done();
      await shot("next-up-filtered");
      await filter(["🔙 Backend", "My repos"]);
      await done();
      await shot("next-up-source");
      // Clear empties a source and a scope together. Picks are saved, so this also resets the next scenario.
      // My repos is still ticked from above; tick a scope beside it.
      await filter(["🔙 Backend"]);
      const ticked = await page.getByRole("checkbox", { checked: true }).count();
      if (ticked !== 2) throw new Error(`Expected a source and a scope ticked before Clear, got ${ticked}`);
      await page.getByRole("button", { name: "Clear" }).click();
      await settled();
      const stillTicked = await page.getByRole("checkbox", { checked: true }).count();
      if (stillTicked) throw new Error(`Clear left ${stillTicked} filter(s) ticked`);
      await done();
      const label = await page.getByRole("button", { name: /^Filter/ }).first().getAttribute("aria-label");
      if (label !== "Filter") throw new Error(`Filter button after Clear: ${label}`);
      await shot("next-up-cleared");
      // Projects with their statuses nested under them [NXT-03, NXT-12]: all of Ideas, and TODO's Todo only, so TODO shows
      // partly ticked. Names are exact, as "TODO" and "Todo" differ only in case.
      await page.getByRole("button", { name: /^Filter/ }).click();
      await page.getByText("Project", { exact: true }).waitFor({ timeout: 10000 });
      await page.getByRole("checkbox", { name: "Ideas", exact: true }).click();
      await page.getByRole("checkbox", { name: "Todo", exact: true }).click();
      await settled();
      const projectTicks = await page.getByRole("checkbox", { checked: true }).count();
      // Ideas itself, its three statuses and No status, and Todo; TODO is only partly ticked, which doesn't count.
      if (projectTicks !== 6) throw new Error(`Expected 6 ticked for all of Ideas and TODO's Todo, got ${projectTicks}`);
      await modalShot("next-up-filter-projects");
      await done();
      await shot("next-up-projects");
      await page.getByRole("button", { name: /^Filter/ }).click();
      await page.getByRole("button", { name: "Clear" }).click();
      await done();
    },
    // Settings from the gear: a typo is caught, then a repo is added and saved to config.json [SRC-02].
    settings: async () => {
      try {
        await tab("Doing");
        await page.getByRole("button", { name: "Attention Span settings" }).click();
        const addRepo = page.getByLabel("Add a repository").first();
        await addRepo.waitFor({ timeout: 15000 });
        await addRepo.fill("acme/shpo");
        await addRepo.press("Enter");
        await page.getByText(/acme\/shpo wasn't found/).waitFor({ timeout: 10000 });
        await settled();
        await top("settings-typo");
        await addRepo.fill("acme/web");
        await addRepo.press("Enter");
        await page.getByText("acme/web", { exact: true }).waitFor({ timeout: 10000 });
        await settled();
        await top("settings");
        const withRepo = await config();
        if (withRepo.repos?.[0] !== "acme/web" || withRepo.orgs?.[0] !== "acme" || !withRepo.nextUp) throw new Error(`config.json after adding: ${JSON.stringify(withRepo)}`);
        // Next up's own sources, below: a repo added there lands in nextUp, beside its fields [NXT-04].
        const addNextUpRepo = page.getByLabel("Add a repository").last();
        await addNextUpRepo.fill("me/tool");
        await addNextUpRepo.press("Enter");
        await page.getByText("me/tool", { exact: true }).waitFor({ timeout: 10000 });
        await page.getByText("My repos", { exact: true }).scrollIntoViewIfNeeded();
        await settled();
        await capture("settings-next-up", fold());
        // Only orgs I belong to, minus those already added [NXT-04].
        await page.getByText("Choose…", { exact: true }).click();
        await page.getByText("globex", { exact: true }).waitFor({ timeout: 10000 });
        await settled();
        await capture("settings-org-picker", fold());
        await page.keyboard.press("Escape");
        const withSource = await config();
        if (withSource.nextUp?.repos?.[0] !== "me/tool" || !withSource.nextUp.mine || !withSource.nextUp.effort) throw new Error(`config.json after adding to Next up: ${JSON.stringify(withSource)}`);
        // Next up's fields: Priority and Scope found by their names, Effort as config.json has it [NXT-04].
        const fieldsHeading = page.getByText("Next up fields", { exact: true });
        await page.getByText(/Picked by its name/).first().waitFor({ timeout: 10000 });
        await settled();
        // The viewport is tall, so clip a band from the section down rather than scroll to it.
        const fieldsBand = async () => {
          const box = await fieldsHeading.boundingBox();
          return { ...fold(), y: Math.max(0, box.y - 24), height: 500 };
        };
        await capture("settings-fields", fieldsBand);
        // Scope set to another field is saved; Priority, never picked, is left to its name, and Effort keeps its order.
        await page.getByText("Scope", { exact: true }).last().click();
        await page.getByText("Team", { exact: true }).last().click();
        await page.getByText("Team", { exact: true }).first().waitFor({ timeout: 10000 });
        await until(async () => (await config()).nextUp?.scope?.field === "Team", "config.json to save Scope as Team").catch(() => {});
        await settled();
        const withFields = await config();
        if (withFields.nextUp?.scope?.field !== "Team" || "priority" in withFields.nextUp || withFields.nextUp.effort?.order?.length !== 4)
          throw new Error(`config.json after picking a field: ${JSON.stringify(withFields)}`);
        await capture("settings-fields-picked", fieldsBand);
      } finally {
        // Out of Paseo's settings: phones have only a back arrow, so start over from the app.
        await start();
      }
    },
    // The setup checklist, from a config.json that doesn't parse; fixed, Check again brings the tabs back [SET-01].
    setup: async () => {
      try {
        await writeFile(configPath, "{ broken");
        await page.getByRole("button", { name: "Refresh now" }).click();
        await page.locator(`text="Set up Attention Span" >> visible=true`).waitFor({ timeout: 15000 });
        await settled();
        await top("setup");
      } finally {
        await writeFile(configPath, originalConfig);
      }
      await page.getByRole("button", { name: "Check again" }).click();
      await page.getByRole("tab", { name: /Doing/ }).first().waitFor({ timeout: 15000 });
      await settled();
    },
    // Archive every Wrap up row, then dismiss everything: a clear Doing tab shows its horizon, as on a real screen's
    // height [ATT-18]. Then a quiet day: every other tab empty shows its own scene [HIS-08, WAI-04, NXT-13].
    clear: async () => {
      await tab("Doing");
      // Keep open answers "Close #152?", leaving its PR's clean session to Archive all clean [ATT-24].
      await keepIssueOpen(152);
      await page.getByText("Kept #152 open").waitFor({ timeout: 10000 });
      await settled();
      // Archive all clean takes the clean ones, then the dirty and multi rows ask first [ATT-22].
      const archiveAll = page.getByRole("button", { name: /^Archive all clean/ });
      if (await archiveAll.isVisible().catch(() => false)) {
        await archiveAll.click();
        await settled();
      }
      await page.getByRole("button", { name: "Archive the session on #186" }).click();
      // The sheet's Archive is the last: Paseo's own UI has hidden ones of the same name.
      const archive = page.getByRole("button", { name: "Archive", exact: true }).last();
      await archive.waitFor({ timeout: 10000 });
      await archive.click();
      await settled();
      await page.getByRole("button", { name: "Archive the sessions on #172" }).click();
      await page.getByRole("button", { name: "Archive both" }).waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Archive both" }).click();
      await settled();
      await tab("Doing");
      // Kept worktrees keep the horizon away too: dismiss them first [ATT-22].
      for (const number of [176, 178, 179]) {
        const details = page.getByRole("button", { name: `Details for #${number}`, exact: true });
        await details.click();
        await page.getByRole("button", { name: "Dismiss", exact: true }).last().click();
        await details.waitFor({ state: "detached" });
        await settled();
      }
      await page.getByRole("button", { name: /^Details for #/ }).first().click();
      await page.getByRole("button", { name: "Dismiss", exact: true }).last().click();
      await page.getByText("Undo", { exact: true }).waitFor({ timeout: 10000 });
      await settled();
      await shot("doing-dismissed");
      const details = page.getByRole("button", { name: /^Details for #/ });
      for (let left = await details.count(); left > 0; left = await details.count()) {
        const title = await details.first().getAttribute("aria-label");
        await details.first().click();
        await page.getByRole("button", { name: "Dismiss", exact: true }).last().click();
        await until(async () => (await details.count()) < left, `"${title}" to leave Doing after Dismiss`);
      }
      const tall = page.viewportSize();
      await page.setViewportSize({ width: tall.width, height: layout.isMobile ? 844 : 900 });
      try {
        await tab("Waiting"); // clears the Undo rows
        await tab("Doing");
        await page.getByText("Nothing's on you.").waitFor({ timeout: 10000 });
        await settled();
        await capture("doing-clear", { x: 0, y: 0, ...page.viewportSize() });
        const calm = async (tabName, text, name) => {
          await tab(tabName);
          await page.getByRole("button", { name: "Refresh now" }).click();
          await page.getByText(text).waitFor({ timeout: 15000 });
          await settled();
          await capture(name, { x: 0, y: 0, ...page.viewportSize() });
        };
        // Always back to the full fixture and config, so later scenarios see them even if a shot fails.
        try {
          await writeFile(quietPath, "");
          // Waiting first: its refresh is the live feed's, which also brings History's notes.
          await calm("Waiting", "Nobody's holding you up.", "waiting-clear");
          await calm("History", "Nothing finished yet.", "history-clear");
          await calm("Next up", "Nothing ready for work.", "next-up-clear");
          // Nowhere to look: no sources in config.json at all.
          await writeFile(configPath, "{}");
          await calm("Next up", "Nowhere to look yet.", "next-up-setup");
        } finally {
          await writeFile(configPath, originalConfig);
          await rm(quietPath, { force: true });
        }
        // Both feeds back to the full fixture: History's too, as Wrap up in later layouts is made from its finished work.
        await tab("History");
        await page.getByRole("button", { name: "Refresh now" }).click();
        await page.getByText("Order list takes 8 seconds").first().waitFor({ timeout: 15000 });
        await tab("Next up");
        await page.getByRole("button", { name: "Refresh now" }).click();
        await page.getByRole("button", { name: /^Start / }).first().waitFor({ timeout: 15000 });
      } finally {
        await page.setViewportSize(tall);
      }
    },
    // Last, because it may open a session: an issue kept apart from its code [SES-07].
    // Start asks where the code lives, saves it to config.json, and the next start goes straight on.
    "code-repo": async () => {
      const startIssue = () => page.getByRole("button", { name: "Start Price list import skips quoted rows" }).click();
      const picker = page.getByText("Where does the code for acme/issues live?");
      await tab("Next up");
      await startIssue();
      await picker.waitFor({ timeout: 15000 });
      await settled();
      await modalShot("next-up-code-repo");
      await page.getByRole("button", { name: "acme/shop" }).click();
      await until(async () => (await config()).codeRepos?.["acme/issues"], "config.json to map acme/issues").catch(() => {});
      await settled();
      const saved = await config();
      if (saved.codeRepos?.["acme/issues"] !== "acme/shop" || saved.orgs?.[0] !== "acme") throw new Error(`config.json after picking: ${JSON.stringify(saved)}`);
      await capture("next-up-code-repo-after", fold());
      // Still on the list means the start stopped later (no agent provider in here); press it again.
      if (await page.getByRole("tab", { name: /Next up/ }).first().isVisible()) {
        await tab("Next up");
        await startIssue();
        await settled();
        if (await picker.isVisible()) throw new Error("asked where the code lives a second time");
        await capture("next-up-code-repo-again", fold());
      }
    },
  };

  let ok = true;
  try {
    const since = Date.now();
    await start();
    console.log(`  ${prefix} start ${seconds(since)}`);
  } catch (error) {
    ok = false;
    console.log(`failed ${prefix} start: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: `/out/${prefix}-start-failure.png` }).catch(() => {});
  }
  for (const scenario of ok ? scenarios : []) {
    const since = Date.now();
    try {
      await run[scenario.name]();
      console.log(`  ${prefix} ${scenario.name} ${seconds(since)}`);
    } catch (error) {
      ok = false;
      console.log(`failed ${prefix} ${scenario.name}: ${error.message.split("\n")[0]}`);
      await page.screenshot({ path: `/out/${prefix}-${scenario.name}-failure.png`, clip: fold() }).catch(() => {});
      // The rest still run, from the start, so one failure doesn't hide another.
      try {
        await start();
      } catch {
        console.log(`failed ${prefix}: couldn't start over after ${scenario.name}`);
        break;
      }
    }
  }
  if (ok) console.log(`ok ${prefix} in ${seconds(started)}${unsettled ? `, ${unsettled} waits gave up settling` : ""}`);
  else failed = true;
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
