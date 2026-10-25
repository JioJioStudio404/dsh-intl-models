#!/usr/bin/env node
/**
 * Import API keys into the dsh-intl-models key store from a terminal (the same
 * store the app uses; a running app picks them up on its next read).
 *
 *   node bin/import-keys.mjs --file keys.txt [--endpoint <id>] [--label <name>]
 *   node bin/import-keys.mjs --stdin < keys.txt
 *   node bin/import-keys.mjs --list
 *   node bin/import-keys.mjs --endpoints
 *
 * A key file holds one key per line; `vendor: key` lines (openai, claude /
 * anthropic, xai / grok, openrouter, opencode, gemini / google) and env-style
 * `ANTHROPIC_API_KEY=…` lines work too. Each key's endpoint is detected unless
 * `--endpoint` names one, and every key is checked before it is kept. Keys are
 * never printed: only masked forms.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { IntlAdapter } from "../lib/adapter.js";
import { CatalogStore } from "../lib/catalog.js";
import { createChecker } from "../lib/checker.js";
import { ENDPOINTS, displayNameOf } from "../lib/endpoints.js";
import { redact } from "../lib/errors.js";
import { KeyStore } from "../lib/keys.js";
import { createIntlModelsService } from "../lib/service.js";

function parseArgs(argv) {
  const out = { files: [], stdin: false, list: false, endpoints: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" || arg === "--path") out.files.push(argv[++index]);
    else if (arg === "--stdin") out.stdin = true;
    else if (arg === "--list") out.list = true;
    else if (arg === "--endpoints") out.endpoints = true;
    else if (arg === "--endpoint") out.endpoint = argv[++index];
    else if (arg === "--label") out.label = argv[++index];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const describe = (key) => {
  const facts = [key.status];
  if (typeof key.balance?.amount === "number") facts.push(`$${key.balance.amount.toFixed(2)}`);
  if (key.balance?.freeRequests) facts.push(`free ${key.balance.freeRequests.remaining}/${key.balance.freeRequests.limit} today`);
  if (key.usage?.month?.cost > 0) facts.push(`≈$${key.usage.month.cost.toFixed(2)} this month`);
  if (key.limitedUntil) facts.push(`held until ${key.limitedUntil}`);
  return facts.join(" · ");
};

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: node bin/import-keys.mjs --file <keys.txt> [--endpoint <id>] [--label <name>] | --stdin | --list | --endpoints");
    return 0;
  }
  if (args.endpoints) {
    for (const endpoint of ENDPOINTS) console.log(`${endpoint.id.padEnd(18)} ${displayNameOf(endpoint).padEnd(28)} ${endpoint.baseUrl}`);
    return 0;
  }
  const keys = new KeyStore();
  const catalog = new CatalogStore();
  const adapter = new IntlAdapter({ keys, catalog });
  const checker = createChecker({ keys });
  const service = createIntlModelsService({ keys, catalog, adapter, checker });
  if (args.list) {
    const status = await service.status({});
    if (status.keys.length === 0) console.log(`(no key) store: ${keys.path()}`);
    for (const key of status.keys) console.log(`${key.active ? "*" : " "} ${key.endpoint.padEnd(18)} ${key.masked.padEnd(18)} ${(key.label ?? "").padEnd(16)} ${describe(key)}`);
    return 0;
  }
  const texts = args.files.map((path) => readFileSync(path, "utf8"));
  if (args.stdin) texts.push(readFileSync(0, "utf8"));
  if (texts.length === 0) {
    console.error("nothing to import: pass --file <keys.txt> or --stdin");
    return 2;
  }
  let added = 0;
  for (const text of texts) {
    try {
      const out = await service.addKeys({ text, source: "cli", ...(args.endpoint ? { endpoint: args.endpoint } : {}), ...(args.label ? { label: args.label } : {}) });
      for (const result of out.added) {
        if (result.ok) {
          added += 1;
          const key = out.keys.find((item) => item.id === result.id);
          console.log(`ok   ${result.masked.padEnd(18)} → ${result.endpointName}${result.created ? "" : " (updated)"}: ${key ? describe(key) : result.status}`);
        } else {
          console.log(`skip ${result.masked.padEnd(18)} ${result.endpointName ? `→ ${result.endpointName}: ` : ""}${redact(result.error ?? result.kind)}`);
        }
      }
    } catch (error) {
      console.error(`import failed: ${redact(error?.message ?? error)}`);
    }
  }
  console.log(`\n${added} key(s) kept in ${keys.path()}`);
  return added > 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(redact(error?.message ?? error));
    process.exitCode = 1;
  });
}
