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
const configPath = `${process.env.HOME}/.config/paseo-github-attention/config.json`;
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
    try {
      await writeFile(configPath, originalConfig);
      // The container's daemon serves the web app and is the only host it knows.
      await page.goto("http://127.0.0.1:6767/", { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      // On phones the sidebar sits behind a menu button.
      const entry = page.getByText("GitHub attention").first();
      if (!(await entry.isVisible())) await page.getByRole("button", { name: /menu|sidebar/i }).first().click().catch(() => {});
      await entry.click();
      await page.getByText("Doing").first().waitFor({ timeout: 15000 });
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
      await doing();
      await page.getByText("Retry webhook deliveries with backoff").click();
      await page.waitForTimeout(500);
      await shot("doing-expanded");
      await page.getByText("Retry webhook deliveries with backoff").first().click(); // collapse
      await page.getByRole("button", { name: "Address comments options" }).first().click();
      await page.getByText("Agent profile").waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `/out/${prefix}-doing-options.png` }); // the modal sits over the whole page
      await page.getByRole("button", { name: "Cancel" }).last().click();
      await page.getByRole("button", { name: "Merge", exact: true }).click();
      await page.waitForTimeout(400);
      await shot("doing-merge-confirm");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("tab", { name: /History/ }).first().click();
      await page.getByText(/Reviewed \(\d+\)/).first().click();
      await page.waitForTimeout(800);
      await shot("history-reviewed");
      await page.getByRole("tab", { name: /Next up/ }).first().click();
      await page.getByText("🔙 Backend", { exact: true }).click();
      await page.waitForTimeout(400);
      await shot("next-up-filtered");
      await page.getByText("All", { exact: true }).click(); // the pick is saved, so clear it for the next layout
      // Last, because it changes the daemon's state: dismiss one item.
      await doing();
      await page.getByRole("button", { name: "Dismiss" }).first().click();
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
      await page.screenshot({ path: `/out/${prefix}-next-up-code-repo.png` }); // the modal sits over the whole page
      await page.getByRole("button", { name: "acme/shop" }).click();
      await page.waitForTimeout(3000);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      if (saved.codeRepos?.["acme/issues"] !== "acme/shop" || saved.orgs?.[0] !== "acme") throw new Error(`config.json after picking: ${JSON.stringify(saved)}`);
      await page.screenshot({ path: `/out/${prefix}-next-up-code-repo-after.png` });
      // Still on the inbox means the start stopped later (no agent provider in here); press it again.
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
