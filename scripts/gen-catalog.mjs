#!/usr/bin/env node
/**
 * Regenerate `lib/catalog-data.js` from pi-ai's provider catalog (MIT, the
 * library DSH's own multi-provider adapter uses): each model's wire protocol,
 * reasoning levels (and the vendor's own names for them), sampling and
 * thinking quirks, limits and prices.
 *
 *   npm pack @earendil-works/pi-ai && tar -xzf earendil-works-pi-ai-*.tgz
 *   node scripts/gen-catalog.mjs --pi package/dist/providers/data
 *
 * The data is read as JSON; no code of the package runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args[args.indexOf("--pi") + 1];
if (!args.includes("--pi") || !dir) {
  console.error("usage: node scripts/gen-catalog.mjs --pi <pi-ai package/dist/providers/data>");
  process.exit(2);
}
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(dir, "..", "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

/** Catalog name → pi-ai data file. */
const SOURCES = { openai: "openai", anthropic: "anthropic", xai: "xai", openrouter: "openrouter", opencode: "opencode", "opencode-go": "opencode-go", google: "google" };
const PROTOCOLS = { "openai-responses": "responses", "anthropic-messages": "messages", "openai-completions": "chat", "google-generative-ai": "gemini" };
/** Ticked by default (the rest are offered unticked). */
const RECOMMENDED = {
  openai: ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini"],
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  xai: ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"],
  // Gemini 2.5 Pro is no longer offered to new users (404 "no longer available"): offered, not ticked.
  google: ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"],
  openrouter: ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-sol", "google/gemini-3.8-flash", "x-ai/grok-4.7", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-max-0902", "moonshotai/kimi-k3", "z-ai/glm-5.3", "minimax/minimax-m3", "openrouter/free"],
  opencode: ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-sol", "gpt-5.6-sol", "gemini-3.8-flash", "grok-4.7", "kimi-k3", "glm-5.3", "deepseek-v4-pro", "qwen3.8-max", "minimax-m3"],
  "opencode-go": ["deepseek-v4-pro", "kimi-k3", "glm-5.3", "qwen3.8-max", "minimax-m3", "mimo-v2.6-pro", "grok-4.7", "gpt-5.6-luna"],
};
/** Known corrections to the data (Gemini 2.5 Pro cannot switch thinking off: its minimum budget is 128). */
const OVERRIDES = [
  [/^(google\/)?gemini-2\.5-pro/, (entry) => { if (entry.reasoning) entry.reasoning.off = false; }],
];
/** Not chat models, or not for streaming chat. */
const SKIP = /:batch$|realtime|audio|-image|image-|deep-research|computer-use|-live|lyria|tts|embedding|moderation|safeguard/i;

/** The reasoning levels a model offers (pi-ai's rule: null = unsupported; xhigh / max only when named). */
function reasoningOf(model) {
  if (!model.reasoning) return null;
  const map = model.thinkingLevelMap ?? {};
  const levels = ["minimal", "low", "medium", "high"].filter((level) => map[level] !== null);
  for (const level of ["xhigh", "max"]) if (typeof map[level] === "string") levels.push(level);
  const names = Object.fromEntries(Object.entries(map).filter(([, value]) => typeof value === "string"));
  return { levels, off: map.off !== null, ...(Object.keys(names).length ? { map: names } : {}) };
}

function flagsOf(model, catalog) {
  const compat = model.compat ?? {};
  const flags = {};
  if (compat.forceAdaptiveThinking || compat.supportsMidConvoEffort) flags.adaptive = true;
  if (compat.supportsTemperature === false) flags.noTemperature = true;
  if (compat.maxTokensField && compat.maxTokensField !== "max_tokens") flags.maxTokensField = compat.maxTokensField;
  if (compat.requiresReasoningContentOnAssistantMessages) flags.reasoningOnAssistant = true;
  if (compat.thinkingFormat && !(catalog === "openrouter" && compat.thinkingFormat === "openrouter")) flags.thinkingFormat = compat.thinkingFormat;
  if (compat.supportsReasoningEffort === false) flags.reasoningEffort = false;
  return flags;
}

const round = (value) => (typeof value === "number" ? Math.round(value * 1e6) / 1e6 : 0);
const costOf = (cost) => cost ? {
  input: round(cost.input), output: round(cost.output), cacheRead: round(cost.cacheRead), cacheWrite: round(cost.cacheWrite),
  ...(Array.isArray(cost.tiers) && cost.tiers.length ? { tiers: cost.tiers.map((tier) => ({ above: tier.inputTokensAbove, input: round(tier.input), output: round(tier.output), cacheRead: round(tier.cacheRead), cacheWrite: round(tier.cacheWrite) })) } : {}),
} : null;

const CATALOGS = {};
for (const [catalog, file] of Object.entries(SOURCES)) {
  const data = JSON.parse(readFileSync(join(dir, `${file}.json`), "utf8"));
  const entries = [];
  for (const [api, group] of Object.entries(data)) {
    const protocol = PROTOCOLS[api];
    if (!protocol) continue;
    for (const model of Object.values(group)) {
      if (model.type && model.type !== "chat") continue;
      if (SKIP.test(model.id)) continue;
      const cost = costOf(model.cost);
      const free = Boolean(cost && cost.input === 0 && cost.output === 0 && !/^openrouter\//.test(model.id));
      const flags = flagsOf(model, catalog);
      entries.push({
        id: model.id,
        name: model.name ?? model.id,
        protocol,
        image: Array.isArray(model.input) && model.input.includes("image"),
        context: model.contextWindow ?? null,
        output: model.maxTokens ?? null,
        reasoning: reasoningOf(model),
        cost,
        ...(Object.keys(flags).length ? { flags } : {}),
        ...(free ? { free: true } : {}),
        recommended: (RECOMMENDED[catalog] ?? []).includes(model.id),
      });
      for (const [pattern, fix] of OVERRIDES) if (pattern.test(model.id)) fix(entries.at(-1));
    }
  }
  entries.sort((a, b) => Number(b.recommended) - Number(a.recommended) || (RECOMMENDED[catalog] ?? []).indexOf(a.id) - (RECOMMENDED[catalog] ?? []).indexOf(b.id) || a.id.localeCompare(b.id));
  const missing = (RECOMMENDED[catalog] ?? []).filter((id) => !entries.some((entry) => entry.id === id));
  if (missing.length) console.warn(`${catalog}: recommended but not in the data: ${missing.join(", ")}`);
  CATALOGS[catalog] = entries;
  console.log(`${catalog}: ${entries.length} models, ${entries.filter((entry) => entry.recommended).length} ticked`);
}

// Cloudflare (one REST API per account): Workers AI's chat models, plus the third-party models its
// AI Gateway credits pay for, renamed to that API's `author/model` (claude-haiku-5-5 → anthropic/claude-haiku-5.5,
// checked live 2026-10-16). The third-party ones are not in Workers AI's model search: `offList` keeps them.
{
  const RECOMMENDED_CF = ["@cf/zai-org/glm-5.3", "@cf/moonshotai/kimi-k2.7-code", "@cf/deepseek-ai/deepseek-v4-pro-0813", "@cf/qwen/qwen3.8-27b", "@cf/openai/gpt-oss-120b", "@cf/google/gemma-4-26b-a4b-it", "@cf/zai-org/glm-5.3-flash"];
  const workers = JSON.parse(readFileSync(join(dir, "cloudflare-workers-ai.json"), "utf8"));
  const gateway = JSON.parse(readFileSync(join(dir, "cloudflare-ai-gateway.json"), "utf8"));
  const entryOf = (model, id, protocol, extra = {}) => {
    const flags = { ...flagsOf(model, "cloudflare"), ...extra.flags };
    return {
      id,
      name: model.name ?? model.id,
      protocol,
      image: Array.isArray(model.input) && model.input.includes("image"),
      context: model.contextWindow ?? null,
      output: model.maxTokens ?? null,
      reasoning: reasoningOf(model),
      cost: costOf(model.cost),
      ...(Object.keys(flags).length ? { flags } : {}),
      ...(extra.offList ? { offList: true, credits: true } : {}),
      recommended: RECOMMENDED_CF.includes(id),
    };
  };
  const entries = [];
  for (const model of Object.values(workers["openai-completions"] ?? {})) if (!model.type || model.type === "chat") entries.push(entryOf(model, model.id, "chat"));
  for (const model of Object.values(gateway["anthropic-messages"] ?? {})) {
    entries.push(entryOf(model, `anthropic/${model.id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`, "messages", { offList: true }));
  }
  // OpenAI's current models (not the gpt-4 / o-series ones); its newer models refuse `max_tokens` there.
  for (const model of Object.values(gateway["openai-responses"] ?? {})) {
    if (!/^gpt-(5\.[4-9]|6)/.test(model.id)) continue;
    entries.push(entryOf(model, `openai/${model.id}`, "chat", { offList: true, flags: { maxTokensField: "max_completion_tokens" } }));
  }
  entries.sort((a, b) => Number(b.recommended) - Number(a.recommended) || RECOMMENDED_CF.indexOf(a.id) - RECOMMENDED_CF.indexOf(b.id) || Number(a.offList ?? false) - Number(b.offList ?? false) || a.id.localeCompare(b.id));
  CATALOGS.cloudflare = entries;
  console.log(`cloudflare: ${entries.length} models (${entries.filter((entry) => entry.offList).length} third-party), ${entries.filter((entry) => entry.recommended).length} ticked`);
}

// Vercel AI Gateway: pi-ai lists its models over the Messages API (Vercel translates it for every
// vendor). Here Claude keeps it (thinking signatures, cache breakpoints); the others go over Chat
// Completions, which reports each request's cost (checked live 2026-10-17). `-batch` variants
// answer 404 in real time. Ticked: flagships, then models a free-tier team may use.
{
  const RECOMMENDED_VERCEL = [
    "anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-sol", "google/gemini-3.8-flash", "spacexai/grok-4.7",
    "deepseek/deepseek-v4-pro", "zai/glm-5.3", "moonshotai/kimi-k3", "minimax/minimax-m3",
    "moonshotai/kimi-k2.7-code", "minimax/minimax-m2.7", "zai/glm-4.7", "deepseek/deepseek-v3.1",
  ];
  const data = JSON.parse(readFileSync(join(dir, "vercel-ai-gateway.json"), "utf8"));
  const entries = [];
  for (const model of Object.values(data["anthropic-messages"] ?? {})) {
    if ((model.type && model.type !== "chat") || SKIP.test(model.id) || /-batch$/.test(model.id)) continue;
    const protocol = /^anthropic\//.test(model.id) ? "messages" : "chat";
    const flags = flagsOf(model, "vercel");
    // Adaptive thinking is a Messages API notion.
    if (protocol === "chat") delete flags.adaptive;
    const cost = costOf(model.cost);
    const free = Boolean(cost && cost.input === 0 && cost.output === 0);
    entries.push({
      id: model.id,
      name: model.name ?? model.id,
      protocol,
      image: Array.isArray(model.input) && model.input.includes("image"),
      context: model.contextWindow ?? null,
      output: model.maxTokens ?? null,
      reasoning: reasoningOf(model),
      cost,
      ...(Object.keys(flags).length ? { flags } : {}),
      ...(free ? { free: true } : {}),
      recommended: RECOMMENDED_VERCEL.includes(model.id),
    });
  }
  entries.sort((a, b) => Number(b.recommended) - Number(a.recommended) || RECOMMENDED_VERCEL.indexOf(a.id) - RECOMMENDED_VERCEL.indexOf(b.id) || a.id.localeCompare(b.id));
  const missing = RECOMMENDED_VERCEL.filter((id) => !entries.some((entry) => entry.id === id));
  if (missing.length) console.warn(`vercel: recommended but not in the data: ${missing.join(", ")}`);
  CATALOGS.vercel = entries;
  console.log(`vercel: ${entries.length} models (${entries.filter((entry) => entry.protocol === "messages").length} over Messages), ${entries.filter((entry) => entry.recommended).length} ticked`);
}

const header = `/**
 * Bundled model catalog: generated by scripts/gen-catalog.mjs from pi-ai ${version}'s
 * provider data (MIT, https://github.com/earendil-works/pi). Do not edit by hand.
 *
 * Per model: \`protocol\` (responses | messages | chat | gemini), \`image\`,
 * \`context\`, \`output\`, \`reasoning\` ({ levels, off, map }: map = the vendor's
 * own value for a level), \`cost\` (USD per million tokens, with \`tiers\` above
 * an input size), \`flags\` (adaptive thinking, no temperature, …), \`free\`,
 * \`recommended\` (ticked by default).
 *
 * @module dsh-intl-models/catalog-data
 */
`;
// One model per line: diffable, and smaller than indented JSON.
const body = Object.entries(CATALOGS).map(([catalog, entries]) => `  ${JSON.stringify(catalog)}: [\n${entries.map((entry) => `    ${JSON.stringify(entry)},`).join("\n")}\n  ],`).join("\n");
writeFileSync(new URL("../lib/catalog-data.js", import.meta.url), `${header}export const CATALOGS = {\n${body}\n};\n`);
console.log("wrote lib/catalog-data.js");
