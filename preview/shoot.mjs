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
    const page = await browser.newPage({ viewport: layout.viewport, isMobile: layout.isMobile, hasTouch: layout.isMobile, colorScheme });
    // Clip to where the plugin's scrolled content ends, so tall viewports don't leave empty space.
    const shot = async (name) => {
      const bottom = await page.evaluate(() => {
        let node = document.querySelector('[role="tab"]');
        while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
        return node?.firstElementChild?.getBoundingClientRect().bottom ?? 0;
      });
      const { width, height } = page.viewportSize();
      const clip = bottom > 0 ? { x: 0, y: 0, width, height: Math.min(height, Math.ceil(bottom) + 16) } : undefined;
      await page.screenshot({ path: `/out/${prefix}-${name}.png`, clip });
    };
    // A sheet or modal sits over the whole page: clip to a band around it, so the thumbnail stays readable.
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
        : await page.getByRole("dialog").last().boundingBox().catch(() => null);
      const { width, height } = page.viewportSize();
      const y = box ? Math.max(0, Math.floor(box.y) - 80) : 0;
      const clip = box ? { x: 0, y, width, height: Math.min(height - y, Math.ceil(box.height) + 160) } : undefined;
      await page.screenshot({ path: `/out/${prefix}-${name}.png`, clip });
    };
    try {
      await writeFile(configPath, originalConfig);
      // The container's daemon serves the web app and is the only host it knows.
      await page.goto("http://127.0.0.1:6767/", { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      // Screens without tabs: the top of the page is enough.
      const top = (name) => page.screenshot({ path: `/out/${prefix}-${name}.png`, clip: { x: 0, y: 0, width: layout.viewport.width, height: layout.isMobile ? 1100 : 900 } });
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
      // Interactions that don't reach GitHub.
      const doing = () => page.getByRole("tab", { name: /Doing/ }).first().click();
      const openSheet = async (title) => {
        await page.getByRole("button", { name: `${title}, more` }).first().click();
        await page.getByText(/^Open (issue|PR) on GitHub$/).last().waitFor({ timeout: 10000 });
        await page.waitForTimeout(800); // details load
      };
      const closeSheet = async () => {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        if (await page.getByText(/^Open (issue|PR) on GitHub$/).last().isVisible()) await page.getByRole("button", { name: /^(?!Close issue).*close/i }).last().click(); // the sheet's ×, not its Close issue entry
        await page.waitForTimeout(300);
      };
      await doing();
      await openSheet("Show delivery dates on the order page");
      await modalShot("doing-sheet");
      await closeSheet();
      // An issue led card: its stack of PRs, each opening on GitHub [ATT-03, ATT-12].
      await openSheet("Supplier prices are a week out of date");
      await modalShot("doing-issue-sheet");
      await closeSheet();
      await openSheet("Publish security.txt");
      await page.getByRole("button", { name: "Acknowledge" }).last().click();
      await page.getByText(/👍 2 comments/).waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await modalShot("doing-acknowledge");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await page.waitForTimeout(300);
      await openSheet("Harden the upload endpoint");
      await page.getByRole("button", { name: "Address comments with options…" }).last().click();
      await page.getByText("Agent profile").waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await modalShot("doing-options");
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await page.getByRole("button", { name: "Merge", exact: true }).click();
      await page.waitForTimeout(400);
      await shot("doing-merge-confirm");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("tab", { name: /History/ }).first().click();
      await page.getByText(/Reviewed \(\d+\)/).first().click();
      await page.waitForTimeout(800);
      await shot("history-reviewed");
      // Copy a week, then one card's link, and keep what landed on the clipboard [HIS-03, ATT-15].
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:6767" });
      const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
      await page.getByRole("button", { name: "Copy links from This week" }).click();
      await page.getByText(/^Copied \d+ links? from This week$/).waitFor({ timeout: 5000 });
      await shot("history-copied");
      const week = await clipboard();
      await page.getByRole("button", { name: /^Copy link to #\d+$/ }).first().click();
      await page.waitForTimeout(400);
      await writeFile(`/out/${prefix}-history-clipboard.txt`, `${week}\n---\n${await clipboard()}\n`);
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
      // Picks are saved, so clear them for the next layout.
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
      await page.screenshot({ path: `/out/${prefix}-settings-next-up.png` });
      // Only orgs I belong to, minus those already added [NXT-04].
      await page.getByText("Choose…", { exact: true }).click();
      await page.getByText("globex", { exact: true }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `/out/${prefix}-settings-org-picker.png` });
      await page.keyboard.press("Escape");
      const withSource = JSON.parse(await readFile(configPath, "utf8"));
      if (withSource.nextUp?.repos?.[0] !== "me/tool" || !withSource.nextUp.mine || !withSource.nextUp.priority) throw new Error(`config.json after adding to Next up: ${JSON.stringify(withSource)}`);
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
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("button", { name: "Dismiss" }).last().click();
      await page.getByText("Undo", { exact: true }).waitFor({ timeout: 10000 });
      await shot("doing-dismissed");
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
      await page.screenshot({ path: `/out/${prefix}-next-up-code-repo-after.png` });
      // Still on the list means the start stopped later (no agent provider in here); press it again.
      if (await page.getByRole("tab", { name: /Next up/ }).first().isVisible()) {
        await nextUp();
        await startIssue();
        await page.waitForTimeout(3000);
        if (await picker.isVisible()) throw new Error("asked where the code lives a second time");
        await page.screenshot({ path: `/out/${prefix}-next-up-code-repo-again.png` });
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
