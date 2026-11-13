// Screenshots of the plugin in the real Paseo web app, connected to the container's own daemon.
// Usage: shoot.mjs [only-matching-name-part]; writes PNGs to /out.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const filter = process.argv[2] ?? "";
const layouts = [
  // Tall, because the plugin screen scrolls inside its own view, so the page itself never grows.
  { name: "desktop", viewport: { width: 1280, height: 3000 }, isMobile: false },
  { name: "phone", viewport: { width: 390, height: 4200 }, isMobile: true },
];
// No screenshot is taller than a desktop monitor; what's below the fold isn't worth reading.
const MAX_HEIGHT = 1080;
const schemes = ["dark", "light"];
const tabs = ["Doing", "History", "Waiting", "Next up"];
// Each layout starts without the code-repo mapping that an earlier layout saved.
const configPath = `${process.env.HOME}/.config/paseo-attention-span/config.json`;
const originalConfig = await readFile(configPath, "utf8");

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
let failed = false;

for (const layout of layouts) {
  for (const colorScheme of schemes) {
    const prefix = `${layout.name}-${colorScheme}`;
    if (filter && !prefix.includes(filter)) continue;
    // The top of the page, at most a desktop monitor tall.
    const fold = () => ({ x: 0, y: 0, width: layout.viewport.width, height: Math.min(layout.viewport.height, MAX_HEIGHT) });
    const page = await browser.newPage({ viewport: layout.viewport, isMobile: layout.isMobile, hasTouch: layout.isMobile, colorScheme });
    // Clip to where the plugin's scrolled content ends, so tall viewports don't leave empty space.
    const shot = async (name) => {
      const bottom = await page.evaluate(() => {
        let node = document.querySelector('[role="tab"]');
        while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
        return node?.firstElementChild?.getBoundingClientRect().bottom ?? 0;
      });
      const { width, height } = page.viewportSize();
      const clip = { x: 0, y: 0, width, height: Math.min(height, MAX_HEIGHT, bottom > 0 ? Math.ceil(bottom) + 16 : MAX_HEIGHT) };
      await page.screenshot({ path: `/out/${prefix}-${name}.png`, clip });
    };
    // A sheet, modal or menu sits over the whole page: clip to a band around it, so the thumbnail stays readable.
    // On phones it's a bottom sheet: a draggable container, taller than what it shows, so end at its last text.
    const modalShot = async (name) => {
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
      const clip = { x: 0, y, width, height: Math.min(height - y, MAX_HEIGHT, box ? Math.ceil(box.height) + 160 : MAX_HEIGHT) };
      await page.screenshot({ path: `/out/${prefix}-${name}.png`, clip });
    };
    try {
      await writeFile(configPath, originalConfig);
      // The container's daemon serves the web app and is the only host it knows.
      await page.goto("http://127.0.0.1:6767/", { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      // Screens without tabs: the top of the page is enough.
      const top = (name) => page.screenshot({ path: `/out/${prefix}-${name}.png`, clip: { ...fold(), height: layout.isMobile ? 1080 : 900 } });
      // On phones the sidebar sits behind a menu button. Wait for the entry first, so a slow load doesn't look like a phone.
      const openAttention = async () => {
        const entry = page.getByText("Attention", { exact: true }).first();
        await entry.waitFor({ state: "attached", timeout: 15000 });
        if (!(await entry.isVisible())) await page.getByRole("button", { name: /menu|sidebar/i }).first().click().catch(() => {});
        await entry.click();
        await page.getByRole("button", { name: "Refresh now" }).waitFor({ timeout: 15000 });
      };
      await openAttention();
      await page.getByRole("button", { name: "Refresh now" }).click(); // reloads config.json
      await page.waitForTimeout(2000); // avatars and icons
      // An earlier layout's dismissal lives on in the daemon; bring it back.
      const restore = page.getByText(/dismissed · show them again/);
      if (await restore.isVisible()) {
        await restore.click();
        await page.waitForTimeout(500);
      }
      for (const tab of tabs) {
        await page.getByRole("tab", { name: new RegExp(tab) }).first().click();
        await page.waitForTimeout(800);
        await shot(tab.toLowerCase().replace(" ", "-"));
      }
      // Doing's sections, one band each.
      await page.getByRole("tab", { name: /Doing/ }).first().click();
      await page.waitForTimeout(800);
      const band = async (from, to) => {
        const header = (title) => page.locator(`text=/^${title}/ >> visible=true`).first();
        await header(from).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const y = Math.max(0, Math.floor((await header(from).boundingBox()).y) - 24);
        const end = Math.ceil((await header(to).boundingBox()).y) - 16;
        // Just the list's column, with even margins: the sidebar on desktops is 320 px wide.
        const sidebar = layout.isMobile ? 0 : 320;
        const x = Math.max(sidebar, Math.floor((await header(from).boundingBox()).x) - 48);
        return { x, y, width: layout.viewport.width - x - (x - sidebar), height: Math.min(end - y, MAX_HEIGHT) };
      };
      await page.screenshot({ path: `/out/${prefix}-doing-needs-reviewer.png`, clip: await band("Needs a reviewer", "My drafts") });
      // Optional checks failing or still running leave a PR ready [PRS-14].
      await page.screenshot({ path: `/out/${prefix}-doing-ready.png`, clip: await band("Ready to merge", "Needs upstream") });
      // Interactions that don't reach GitHub.
      const doing = () => page.getByRole("tab", { name: /Doing/ }).first().click();
      const openSheet = async (title) => {
        await page.getByRole("button", { name: `${title}, more` }).first().click();
        await page.getByText(/^Open (issue|PR)( on GitHub)?$/).last().waitFor({ timeout: 10000 });
        await page.waitForTimeout(800); // details load
      };
      const closeSheet = async () => {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        if (await page.getByText(/^Open (issue|PR)( on GitHub)?$/).last().isVisible()) await page.getByRole("button", { name: /^(?!Close issue).*close/i }).last().click(); // the sheet's ×, not its Close issue entry
        await page.waitForTimeout(300);
      };
      // What a face and an amber age mean, in words on hover, floating over the card so nothing moves [ATT-19, ATT-11].
      // A band around what's pointed at; touch has no hover.
      const around = async (target) => {
        const box = await target.boundingBox();
        const sidebar = layout.isMobile ? 0 : 320;
        return { x: sidebar, y: Math.max(0, Math.floor(box.y) - 90), width: layout.viewport.width - sidebar, height: 150 };
      };
      if (!layout.isMobile) {
        const face = page.getByLabel(/^Waiting on bob since/).first();
        await face.scrollIntoViewIfNeeded();
        await face.hover();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `/out/${prefix}-doing-hint.png`, clip: await around(face) });
        await page.mouse.move(0, 0);
        await page.getByRole("tab", { name: /Waiting/ }).first().click();
        await page.waitForTimeout(800);
        const age = page.getByLabel(/^Waited too long:/).first();
        await age.scrollIntoViewIfNeeded();
        await age.hover();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `/out/${prefix}-waiting-too-long.png`, clip: await around(age) });
        await page.mouse.move(0, 0);
      }
      // Copy what waits on alice for a nudge, and keep what landed on the clipboard [WAI-03].
      // Then who a question waits on, each by name in its sheet [WAI-02].
      await page.getByRole("tab", { name: /Waiting/ }).first().click();
      await page.waitForTimeout(800);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:6767" });
      await page.getByRole("button", { name: "Copy what waits on alice" }).click();
      await page.getByText(/^Copied \d+ links? for alice$/).waitFor({ timeout: 5000 });
      await shot("waiting-copied");
      await writeFile(`/out/${prefix}-waiting-clipboard.txt`, `${await page.evaluate(() => navigator.clipboard.readText())}\n`);
      await openSheet("Invoice totals round wrong");
      await modalShot("waiting-sheet");
      await closeSheet();
      await doing();
      await openSheet("Show delivery dates on the order page");
      await modalShot("doing-sheet");
      await closeSheet();
      // An issue led card: its stack of PRs, each opening on GitHub [ATT-03, ATT-12].
      await openSheet("Supplier prices are a week out of date");
      await modalShot("doing-issue-sheet");
      await closeSheet();
      // A stack GitHub links to no issue, under the issue its descriptions name [ATT-03, ATT-04].
      await openSheet("The calendar can't be used with a keyboard");
      await modalShot("doing-stack-issue-sheet");
      await closeSheet();
      // A session started outside Attention Span, on the PR its workspace is linked to [SES-08].
      await page.screenshot({ path: `/out/${prefix}-doing-review.png`, clip: await band("Review requested", "CI failing") });
      await openSheet("Add a status page");
      await modalShot("doing-review-sheet");
      await closeSheet();
      // Someone else's stack asking for my review: one Review stack, and the session started on its upper PR [ATT-04].
      await openSheet("Price rules: data model");
      await modalShot("doing-review-stack-sheet");
      await closeSheet();
      await openSheet("Publish security.txt");
      await page.getByRole("button", { name: "Acknowledge" }).last().click();
      await page.getByRole("button", { name: "Acknowledge 2 comments" }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await modalShot("doing-acknowledge");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await page.waitForTimeout(300);
      // Who should review a PR nobody was asked on: suggestions, recent reviewers, teams, a typed name [PRS-12].
      await page.getByRole("button", { name: "Request review", exact: true }).first().click();
      await page.getByText("Suggested by GitHub").waitFor({ timeout: 10000 });
      await page.getByRole("checkbox", { name: "carol" }).click();
      await page.waitForTimeout(400);
      await modalShot("doing-reviewers");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await page.waitForTimeout(300);
      // Without a session, a session action's line in the sheet asks first [SES-02].
      await openSheet("Harden the upload endpoint");
      await page.getByRole("button", { name: "Address comments…" }).last().click();
      await page.getByText("Agent profile").waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await modalShot("doing-options");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      // The first Ready card's: the a11y stack's.
      await page.getByRole("button", { name: "Merge", exact: true }).first().click();
      await page.waitForTimeout(400);
      await shot("doing-merge-confirm");
      await page.getByRole("button", { name: "Cancel" }).click();
      // Feedback from the bottom of the tab: the three lines, then the first words for a problem [FB-01].
      await page.getByRole("button", { name: "Enjoying Attention Span?" }).click();
      await page.getByText("I'll star it on GitHub").waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await modalShot("doing-feedback");
      await page.getByRole("button", { name: "Something's wrong…" }).click();
      await page.getByText("What happened?").waitFor({ timeout: 10000 });
      await page.getByPlaceholder(/Waiting still shows/).fill("Waiting still shows a PR I merged yesterday.");
      await page.waitForTimeout(400);
      await modalShot("doing-feedback-ask");
      await page.getByRole("button", { name: /close/i }).last().click();
      await page.waitForTimeout(400);
      await page.getByRole("tab", { name: /History/ }).first().click();
      await page.getByText(/Reviewed \(\d+\)/).first().click();
      await page.waitForTimeout(800);
      await shot("history-reviewed");
      // Copy a week, its reviews, then one card's link, and keep what landed on the clipboard [HIS-03, ATT-15].
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:6767" });
      const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
      // The newest week with work in it: on a Monday, "This week" has none yet.
      await page.getByRole("button", { name: /^Copy links from / }).first().click();
      await page.getByText(/^Copied \d+ links? from /).waitFor({ timeout: 5000 });
      await shot("history-copied");
      const week = await clipboard();
      await page.getByRole("button", { name: /^Copy reviewed links from / }).first().click();
      await page.getByText(/^Copied \d+ reviewed links? from /).waitFor({ timeout: 5000 });
      const reviewed = await clipboard();
      await page.getByRole("button", { name: /^Copy link to #\d+$/ }).first().click();
      await page.waitForTimeout(400);
      await writeFile(`/out/${prefix}-history-clipboard.txt`, `${week}\n---\n${reviewed}\n---\n${await clipboard()}\n`);
      await page.getByRole("tab", { name: /Next up/ }).first().click();
      await openSheet("Orders export times out for big shops");
      await modalShot("next-up-sheet");
      await closeSheet();
      // Close asks first, on the card: reason and an optional comment [NXT-11]. Cancelled, since it would call GitHub.
      await openSheet("Merge the two import commands");
      await page.getByRole("button", { name: "Close issue" }).click();
      await page.locator('[role="button"][aria-label="Not planned"] >> visible=true').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await shot("next-up-close");
      await page.locator('[role="button"][aria-label="Cancel"] >> visible=true').first().click();
      // Source and scope filters sit behind one button [NXT-03, NXT-09]. Ticks apply right away.
      const filter = async (ticks) => {
        await page.getByRole("button", { name: /^Filter/ }).click();
        await page.getByText("Source", { exact: true }).waitFor({ timeout: 10000 });
        for (const name of ticks) await page.getByRole("checkbox", { name }).click();
      };
      const done = async () => {
        await page.getByRole("button", { name: "Done" }).click();
        await page.waitForTimeout(400);
      };
      await filter(["🔙 Backend"]);
      await page.waitForTimeout(300);
      await modalShot("next-up-filter");
      await done();
      await shot("next-up-filtered");
      await filter(["🔙 Backend", "My repos"]);
      await done();
      await shot("next-up-source");
      // Clear empties a source and a scope together. Picks are saved, so this also resets the next layout.
      // My repos is still ticked from above; tick a scope beside it.
      await filter(["🔙 Backend"]);
      await page.waitForTimeout(300);
      const ticked = await page.getByRole("checkbox", { checked: true }).count();
      if (ticked !== 2) throw new Error(`Expected a source and a scope ticked before Clear, got ${ticked}`);
      await page.getByRole("button", { name: "Clear" }).click();
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(300);
      const projectTicks = await page.getByRole("checkbox", { checked: true }).count();
      // Ideas itself, its three statuses and No status, and Todo; TODO is only partly ticked, which doesn't count.
      if (projectTicks !== 6) throw new Error(`Expected 6 ticked for all of Ideas and TODO's Todo, got ${projectTicks}`);
      await modalShot("next-up-filter-projects");
      await done();
      await shot("next-up-projects");
      await page.getByRole("button", { name: /^Filter/ }).click();
      await page.getByRole("button", { name: "Clear" }).click();
      await done();
      // Settings from the gear: a typo is caught, then a repo is added and saved to config.json [SRC-02].
      await doing();
      await page.getByRole("button", { name: "Attention Span settings" }).click();
      const addRepo = page.getByLabel("Add a repository").first();
      await addRepo.waitFor({ timeout: 15000 });
      await addRepo.fill("acme/shpo");
      await addRepo.press("Enter");
      await page.getByText(/acme\/shpo wasn't found/).waitFor({ timeout: 10000 });
      await top("settings-typo");
      await addRepo.fill("acme/web");
      await addRepo.press("Enter");
      await page.getByText("acme/web", { exact: true }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
      await top("settings");
      const withRepo = JSON.parse(await readFile(configPath, "utf8"));
      if (withRepo.repos?.[0] !== "acme/web" || withRepo.orgs?.[0] !== "acme" || !withRepo.nextUp) throw new Error(`config.json after adding: ${JSON.stringify(withRepo)}`);
      // Next up's own sources, below: a repo added there lands in nextUp, beside its fields [NXT-04].
      const addNextUpRepo = page.getByLabel("Add a repository").last();
      await addNextUpRepo.fill("me/tool");
      await addNextUpRepo.press("Enter");
      await page.getByText("me/tool", { exact: true }).waitFor({ timeout: 10000 });
      await page.getByText("My repos", { exact: true }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `/out/${prefix}-settings-next-up.png`, clip: fold() });
      // Only orgs I belong to, minus those already added [NXT-04].
      await page.getByText("Choose…", { exact: true }).click();
      await page.getByText("globex", { exact: true }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `/out/${prefix}-settings-org-picker.png`, clip: fold() });
      await page.keyboard.press("Escape");
      const withSource = JSON.parse(await readFile(configPath, "utf8"));
      if (withSource.nextUp?.repos?.[0] !== "me/tool" || !withSource.nextUp.mine || !withSource.nextUp.effort) throw new Error(`config.json after adding to Next up: ${JSON.stringify(withSource)}`);
      // Next up's fields: Priority and Scope found by their names, Effort as config.json has it [NXT-04].
      const fieldsHeading = page.getByText("Next up fields", { exact: true });
      await page.getByText(/Picked by its name/).first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      // The viewport is tall, so clip a band from the section down rather than scroll to it.
      const fieldsBand = async () => {
        const box = await fieldsHeading.boundingBox();
        return { ...fold(), y: Math.max(0, box.y - 24), height: 500 };
      };
      await page.screenshot({ path: `/out/${prefix}-settings-fields.png`, clip: await fieldsBand() });
      // Scope set to another field is saved; Priority, never picked, is left to its name, and Effort keeps its order.
      await page.getByText("Scope", { exact: true }).last().click();
      await page.getByText("Team", { exact: true }).last().click();
      await page.getByText("Team", { exact: true }).first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
      const withFields = JSON.parse(await readFile(configPath, "utf8"));
      if (withFields.nextUp?.scope?.field !== "Team" || "priority" in withFields.nextUp || withFields.nextUp.effort?.order?.length !== 4)
        throw new Error(`config.json after picking a field: ${JSON.stringify(withFields)}`);
      await page.screenshot({ path: `/out/${prefix}-settings-fields-picked.png`, clip: await fieldsBand() });
      // The setup checklist, from a config.json that doesn't parse; fixed, Check again brings the tabs back [SET-01].
      await writeFile(configPath, "{ broken");
      // Out of Paseo's settings: phones have only a back arrow, so start over from the app.
      await page.goto("http://127.0.0.1:6767/", { waitUntil: "networkidle" });
      await openAttention();
      await page.getByRole("button", { name: "Refresh now" }).click();
      await page.locator(`text="Set up Attention Span" >> visible=true`).waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
      await top("setup");
      await writeFile(configPath, originalConfig);
      await page.getByRole("button", { name: "Check again" }).click();
      await page.getByRole("tab", { name: /Doing/ }).first().waitFor({ timeout: 15000 });
      // Last, because it changes the daemon's state: dismiss one item.
      await doing();
      await page.getByRole("button", { name: /^Details for #/ }).first().click();
      await page.getByRole("button", { name: "Dismiss" }).last().click();
      await page.getByText("Undo", { exact: true }).waitFor({ timeout: 10000 });
      await shot("doing-dismissed");
      // Dismiss the rest: a clear Doing tab shows its horizon, as on a real screen's height [ATT-18].
      const details = page.getByRole("button", { name: /^Details for #/ });
      for (let left = await details.count(); left > 0; left = await details.count()) {
        await details.first().click();
        await page.getByRole("button", { name: "Dismiss" }).last().click();
        for (let i = 0; i < 50 && (await details.count()) === left; i++) await page.waitForTimeout(100);
      }
      const tall = page.viewportSize();
      await page.setViewportSize({ width: tall.width, height: layout.isMobile ? 844 : 900 });
      await page.getByRole("tab", { name: /Waiting/ }).first().click(); // clears the Undo rows
      await doing();
      await page.getByText("Nothing's on you.").waitFor({ timeout: 10000 });
      await page.waitForTimeout(1200); // it settles in
      await page.screenshot({ path: `/out/${prefix}-doing-clear.png`, clip: { x: 0, y: 0, ...page.viewportSize() } });
      await page.setViewportSize(tall);
      // Last, because it may open a session: an issue kept apart from its code [SES-07].
      // Start asks where the code lives, saves it to config.json, and the next start goes straight on.
      const nextUp = () => page.getByRole("tab", { name: /Next up/ }).first().click();
      const startIssue = () => page.getByRole("button", { name: "Start Price list import skips quoted rows" }).click();
      const picker = page.getByText("Where does the code for acme/issues live?");
      await nextUp();
      await startIssue();
      await picker.waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await modalShot("next-up-code-repo");
      await page.getByRole("button", { name: "acme/shop" }).click();
      await page.waitForTimeout(3000);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      if (saved.codeRepos?.["acme/issues"] !== "acme/shop" || saved.orgs?.[0] !== "acme") throw new Error(`config.json after picking: ${JSON.stringify(saved)}`);
      await page.screenshot({ path: `/out/${prefix}-next-up-code-repo-after.png`, clip: fold() });
      // Still on the list means the start stopped later (no agent provider in here); press it again.
      if (await page.getByRole("tab", { name: /Next up/ }).first().isVisible()) {
        await nextUp();
        await startIssue();
        await page.waitForTimeout(3000);
        if (await picker.isVisible()) throw new Error("asked where the code lives a second time");
        await page.screenshot({ path: `/out/${prefix}-next-up-code-repo-again.png`, clip: fold() });
      }
      console.log(`ok ${prefix}`);
    } catch (error) {
      failed = true;
      console.log(`failed ${prefix}: ${error.message.split("\n")[0]}`);
      await shot("failure").catch(() => {});
    }
    await page.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
