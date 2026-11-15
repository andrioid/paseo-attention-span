// A hash of everything the preview's screenshots are made from, so a copy can tell whether preview/out/ is still current.
// Usage: fingerprint.mjs            prints the hash
//        fingerprint.mjs check      exits 1, saying why, unless preview/out/ holds a finished full run of the current source
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "preview/out/manifest.json");
// What the plugin loads, what the preview runs, and the fixture they show. Docs, requirements and agent notes aren't inputs.
const inputs = ["client/", "server/", "shared/", "assets/", "preview/", "index.client.tsx", "index.server.ts", "paseo-plugin.json", "package.json"];

export const fingerprint = () => {
  // Tracked and untracked files alike; a deleted tracked file still counts, as gone.
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--deduplicate", "--", ...inputs], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !file.startsWith("preview/out/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    hash.update(`${file}\0`);
    hash.update(existsSync(path) ? readFileSync(path) : "(deleted)");
    hash.update("\0");
  }
  return hash.digest("hex");
};

if (process.argv[2] === "check") {
  const fail = (why) => {
    console.error(`preview/out/ can't be copied: ${why}. Run the full preview first: npm run preview`);
    process.exit(1);
  };
  if (!existsSync(manifestPath)) fail("no finished full run there");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.fingerprint !== fingerprint()) fail("the source changed since it was taken");
  const missing = process.argv.slice(3).filter((name) => !existsSync(join(root, "preview/out", `${name}.png`)));
  if (missing.length) fail(`missing ${missing.join(", ")}`);
} else {
  console.log(fingerprint());
}
