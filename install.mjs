#!/usr/bin/env node
/**
 * dsh-intl-models installer helper.
 *
 *   node install.mjs [--profile desktop|web] [--import <keys.txt>]
 *
 * It changes nothing in the profile: it prints the bundle install command for
 * the detected profile (the supported route — the bundle patch inserts the
 * row, and `dsh.client` serves the browser half) and, when a key file is
 * given, imports its keys into the plugin's store.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dshHome } from "./lib/paths.js";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { profile: undefined, imports: [] };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") out.profile = argv[++index];
    else if (arg === "--import") out.imports.push(argv[++index]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** The profile directory: the named one, else desktop, else web. */
function profileDir(name) {
  const root = join(dshHome(), "profiles");
  for (const candidate of name ? [name] : ["desktop", "web"]) {
    const dir = join(root, candidate);
    if (existsSync(dir)) return { name: candidate, dir };
  }
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("usage: node install.mjs [--profile desktop|web] [--import <keys.txt>]");
    return;
  }
  const profile = profileDir(args.profile);
  if (!profile) {
    console.error(`No DSH profile found under ${join(dshHome(), "profiles")}. Start DSH once, or set DSH_HOME.`);
    process.exitCode = 2;
    return;
  }
  console.log(`[install] DSH home: ${dshHome()}`);
  console.log(`[install] profile:  ${profile.name} (${profile.dir})`);
  console.log("\nInstall the bundle, then restart the app once:");
  console.log(`  dsh plugin --profile ${profile.name} add "${resolve(here)}"`);
  console.log("or, from a DSH agent session:");
  console.log(`  plugin_manager install_bundle   target: ${resolve(here)}`);
  if (args.imports.length) {
    const { main: importMain } = await import("./bin/import-keys.mjs");
    console.log("\n[install] importing keys…");
    await importMain(["node", "import", ...args.imports.flatMap((path) => ["--file", path])]).catch((error) => console.warn(`[install] import failed: ${error?.message ?? error}`));
  }
  console.log("\n[install] done. After the restart: the conversation header has OpenAI / Claude / xAI / OpenRouter / OpenCode / Gemini tabs; Settings → Models lists one row per endpoint that has keys.");
}

main().catch((error) => {
  console.error(`[install] ${error?.message ?? error}`);
  process.exitCode = 1;
});
