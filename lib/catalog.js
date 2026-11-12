/**
 * Model lists per endpoint, what the picker offers, and what a request cost.
 *
 * An endpoint's list is the bundled snapshot (protocol, reasoning levels,
 * limits, prices) narrowed by the vendor's live list when one was fetched:
 * a snapshot model the key cannot see is not offered, and a live model the
 * snapshot does not know yet is offered unticked, with what the live list
 * tells (OpenRouter and Vercel tell context, image input, reasoning and
 * prices — Vercel also which models the key's team may use; Gemini limits;
 * OpenCode its limits, media types, effort levels and prices; the others only
 * the id).
 *
 * The selection is per endpoint; by default the snapshot's recommended models.
 *
 * @module dsh-intl-models/catalog
 */
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { CATALOGS } from "./catalog-data.js";
import { defaultEffortOf, EFFORT_NAMES, effortsOf } from "./dialects.js";
import { endpointById } from "./endpoints.js";
import { asNumber, asString, isRecord } from "./errors.js";
import { replaceFile } from "./keys.js";
import { settingsPath } from "./paths.js";
import { readJsonFile, withFileLock } from "./safe.js";

const VERSION = 1;
/** A live list older than this is re-fetched in the background. */
export const CATALOG_TTL_MS = 24 * 60 * 60_000;
/** Ids in a `/models` answer that are not chat models. */
const NOT_CHAT = /embed|whisper|tts|dall-e|gpt-image|image|audio|realtime|transcribe|moderation|search-preview|sora|computer-use|davinci|babbage|deep-research|veo|imagen|lyria|aqa|:batch/i;

/** The bundled entries of an endpoint. */
const bundled = (endpoint) => CATALOGS[endpoint?.catalog] ?? [];

/** A model the snapshot does not describe, from what its live entry tells. */
export function unknownModel(id, live = {}, endpoint) {
  return {
    id,
    name: asString(live.name) ?? id,
    protocol: live.protocol ?? endpoint?.protocol ?? "chat",
    image: live.image === true,
    context: asNumber(live.context) ?? null,
    output: asNumber(live.output) ?? null,
    reasoning: isRecord(live.reasoning) ? live.reasoning : null,
    cost: isRecord(live.cost) ? live.cost : null,
    ...(isRecord(live.flags) ? { flags: live.flags } : {}),
    ...(live.restricted ? { restricted: live.restricted } : {}),
    ...(live.retiring ? { retiring: live.retiring } : {}),
    recommended: false,
    newer: true,
  };
}

/**
 * Whether a model costs nothing: priced at zero (OpenRouter's routers aside,
 * whose zero is "it depends"), or named so by the gateway — OpenRouter's
 * `…:free` and its `openrouter/free` router, OpenCode's `…-free` and Big Pickle
 * (a live model the snapshot does not know carries only its id).
 */
export function isFreeModel(entry, endpoint) {
  const id = String(entry?.id ?? "");
  if (entry?.free === true) return true;
  if (endpoint?.vendor === "openrouter" && (/:free$/.test(id) || id === "openrouter/free")) return true;
  if (endpoint?.vendor === "opencode" && /-free$|^big-pickle$/.test(id)) return true;
  const cost = entry?.cost;
  return Boolean(isRecord(cost) && cost.input === 0 && cost.output === 0 && !/^openrouter\//.test(id));
}

/** OpenCode answers its free models only inside the OpenCode app (403 `FreeTierError`, checked live 2026-10-15). */
export const OPENCODE_FREE_TIER = "OpenCode 的免费模型只能在 OpenCode 客户端里使用（平台限制）";

/** Why a model can never be used through this plugin, or null: OpenCode's free tier. */
export const blockedReason = (entry, endpoint) => (endpoint?.vendor === "opencode" && isFreeModel(entry, endpoint) ? OPENCODE_FREE_TIER : null);

/** Vercel's free tier serves a subset of models (403 `RestrictedModelsError` for the rest, checked live 2026-10-17). */
export const VERCEL_RESTRICTED = "Vercel 免费层不能用这个模型（需购买额度）";

/**
 * Why the key's team may not use a model now, or null: Vercel's model list
 * says so per model (`include_availability`). Unlike {@link blockedReason}
 * this can change (buy credits, then refresh the list), so the model is only
 * kept out of the picker; a request for it still goes, and Vercel answers.
 */
export function restrictedReason(entry, endpoint) {
  if (endpoint?.vendor !== "vercel" || !entry?.restricted) return null;
  return entry.restricted === "plan_restricted" ? VERCEL_RESTRICTED : "Vercel 团队设置不允许使用这个模型";
}

/**
 * One entry of Cloudflare's model search (`{ name: "@cf/…", properties: [{ property_id, value }] }`,
 * checked live 2026-10-16): context, price per million tokens, vision, function calling, the
 * reasoning efforts it takes, and whether it needs the Workers Paid plan. LoRA bases and
 * moderation models are no chat models.
 */
function cloudflareModel(item) {
  const id = asString(item?.name);
  if (!id || /-lora$|llama-guard|\/clef/.test(id) || (Array.isArray(item.tags) && item.tags.some((tag) => /moderation|safety|guardrail/.test(String(tag))))) return null;
  const prop = (name) => (Array.isArray(item.properties) ? item.properties.find((entry) => entry?.property_id === name)?.value : undefined);
  const price = Array.isArray(prop("price")) ? prop("price") : [];
  const per = (pattern) => asNumber(price.find((entry) => pattern.test(String(entry?.unit)))?.price);
  const effort = isRecord(prop("reasoning_effort")) ? prop("reasoning_effort") : null;
  const named = Array.isArray(effort?.supported_efforts) ? effort.supported_efforts : null;
  const reasoning = prop("reasoning") === "true"
    ? {
      levels: named ? named.filter((level) => ["minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) : effort ? [] : ["low", "medium", "high"],
      off: named ? named.includes("none") : effort?.mandatory !== true,
      ...(named?.includes("none") ? { map: { off: "none" } } : {}),
    }
    : null;
  const input = per(/input/i);
  const output = per(/output/i);
  return {
    id,
    name: id.split("/").at(-1),
    ...(asNumber(Number(prop("context_window"))) ? { context: Number(prop("context_window")) } : {}),
    image: prop("vision") === "true",
    ...(reasoning ? { reasoning } : {}),
    ...(input !== undefined || output !== undefined ? { cost: { input: input ?? 0, output: output ?? 0, cacheRead: per(/cached/i) ?? 0, cacheWrite: 0 } } : {}),
    ...(prop("require_workers_paid") === "true" ? { paidPlan: true } : {}),
    protocol: "chat",
  };
}

/** Per-token price strings (OpenRouter, Vercel) → USD per million tokens. */
const perMillion = (value) => {
  const number = asNumber(value);
  return number === undefined ? 0 : Math.round(number * 1e6 * 1e6) / 1e6;
};

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * One entry of Vercel's model list (`GET /v1/models?include_availability`,
 * checked live 2026-10-17): language models only; `-batch` variants answer 404
 * in real time, and a model past its `deprecated_at` is gone. Prices are per
 * token (strings), with `*_tiers` by input size; `reasoning_options` name the
 * efforts (`none` and a `toggle` mean thinking can be switched off);
 * `model_eligibility` says whether the key's team may use it (a free-tier team
 * may not use most paid models). Claude goes over the Messages API.
 */
function vercelModel(item, now) {
  const id = asString(item?.id);
  if (!id || item.type !== "language" || /-batch$/.test(id)) return null;
  const deprecated = asNumber(item.deprecated_at);
  if (deprecated !== undefined && deprecated <= now) return null;
  const options = Array.isArray(item.reasoning_options) ? item.reasoning_options.filter(isRecord) : [];
  const named = options.find((option) => option.type === "effort" && Array.isArray(option.values))?.values ?? null;
  const toggle = options.some((option) => option.type === "toggle");
  const thinks = options.length > 0 || (Array.isArray(item.tags) && item.tags.includes("reasoning"));
  const levels = named ? EFFORT_LEVELS.filter((level) => named.includes(level)) : [];
  const reasoning = thinks
    ? { levels: levels.length ? levels : ["low", "medium", "high"], off: toggle || Boolean(named?.includes("none")), ...(!toggle && named?.includes("none") ? { map: { off: "none" } } : {}) }
    : null;
  const pricing = isRecord(item.pricing) ? item.pricing : {};
  let cost = null;
  if (asNumber(pricing.input) !== undefined && asNumber(pricing.output) !== undefined) {
    cost = { input: perMillion(pricing.input), output: perMillion(pricing.output), cacheRead: perMillion(pricing.input_cache_read), cacheWrite: perMillion(pricing.input_cache_write) };
    // Tiers start at an input size (`min`, inclusive): the catalog's `above` is the size below it.
    const tiersOf = (name) => (Array.isArray(pricing[`${name}_tiers`]) ? pricing[`${name}_tiers`].filter(isRecord) : []);
    const fields = [["input", "input"], ["output", "output"], ["input_cache_read", "cacheRead"], ["input_cache_write", "cacheWrite"]];
    const starts = [...new Set(fields.flatMap(([name]) => tiersOf(name).map((tier) => asNumber(tier.min)).filter((min) => min > 0)))].sort((a, b) => a - b);
    if (starts.length) {
      cost.tiers = starts.map((min) => ({
        above: min - 1,
        ...Object.fromEntries(fields.map(([name, field]) => {
          const tier = tiersOf(name).filter((item) => (asNumber(item.min) ?? 0) <= min).at(-1);
          return [field, tier ? perMillion(tier.cost) : cost[field]];
        })),
      }));
    }
  }
  const eligibility = isRecord(item.model_eligibility) ? item.model_eligibility : null;
  // A transient verdict (a dependency Vercel could not resolve) is no restriction.
  const restricted = eligibility?.status === "ineligible" && eligibility.category !== "transient" ? asString(eligibility.reason) ?? "ineligible" : null;
  const input = Array.isArray(item.modalities?.input) ? item.modalities.input : [];
  return {
    id,
    ...(asString(item.name) ? { name: item.name } : {}),
    ...(asNumber(item.context_window) ? { context: asNumber(item.context_window) } : {}),
    ...(asNumber(item.max_tokens) ? { output: asNumber(item.max_tokens) } : {}),
    image: input.includes("image") || (Array.isArray(item.tags) && item.tags.includes("vision")),
    ...(reasoning ? { reasoning } : {}),
    ...(cost ? { cost } : {}),
    ...(item.temperature === false ? { flags: { noTemperature: true } } : {}),
    ...(restricted ? { restricted } : {}),
    ...(deprecated !== undefined ? { retiring: new Date(deprecated).toISOString().slice(0, 10) } : {}),
    protocol: /^anthropic\//.test(id) ? "messages" : "chat",
  };
}

/**
 * One model of OpenCode's own list (Zen, Go; 2026-10): `name`, `limit`, what it takes as media types
 * (`modalities.input`: "image/png", "video/mp4" — never the word "image"), `capabilities.reasoning.effort`,
 * `cost.text` per million.
 */
function openCodeModel(item) {
  const input = Array.isArray(item.modalities?.input) ? item.modalities.input.map(String) : null;
  const reasoning = isRecord(item.capabilities?.reasoning) ? item.capabilities.reasoning : null;
  const levels = Array.isArray(reasoning?.effort) ? reasoning.effort.filter((level) => level !== "off" && EFFORT_NAMES[level]) : [];
  const text = isRecord(item.cost?.text) ? item.cost.text : null;
  const input$ = asNumber(text?.input?.price);
  return {
    id: item.id,
    ...(asString(item.name) ? { name: item.name } : {}),
    ...(asNumber(item.limit?.context) ? { context: asNumber(item.limit.context) } : {}),
    ...(asNumber(item.limit?.output) ? { output: asNumber(item.limit.output) } : {}),
    ...(input ? { image: input.some((type) => /^image(\/|$)/i.test(type)) } : {}),
    ...(reasoning?.supported === true && levels.length ? { reasoning: { levels, off: false } } : {}),
    ...(input$ !== undefined ? { cost: { input: input$, output: asNumber(text.output?.price) ?? 0, cacheRead: asNumber(text.input.cache?.read) ?? input$, cacheWrite: asNumber(text.input.cache?.write) ?? 0 } } : {}),
  };
}

/** A price per million tokens from a number or a decimal string (Novita's `price_per_m_decimal`). */
const perMillionOf = (value) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
};

/**
 * The open-model hosts' own lists (2026-11-03): what each tells beyond the id. A row that is no chat model
 * with tools is left out (undefined). None says how a model's thinking is switched: no levels.
 */
const HOST_LISTS = Object.freeze({
  // Groq: `context_window`, `max_completion_tokens`, `active`. Its list also carries speech (Whisper, Orpheus), guard
  // models and a 4K ALLaM (2026-11-04): only chat models with room for an agent's prompt are kept.
  groq: (item) => (item.active === false || /guard|orpheus|whisper|playai|tts|allam/i.test(item.id) || (asNumber(item.context_window) ?? Infinity) < 16384 ? undefined : {
    id: item.id,
    ...(asNumber(item.context_window) ? { context: asNumber(item.context_window) } : {}),
    ...(asNumber(item.max_completion_tokens) ? { output: asNumber(item.max_completion_tokens) } : {}),
  }),
  // DeepInfra: `metadata` { context_length, max_tokens, pricing { input_tokens, output_tokens, cache_read_tokens }, tags }.
  deepinfra: (item) => {
    const meta = isRecord(item.metadata) ? item.metadata : {};
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    if (!tags.includes("chat")) return undefined;
    const pricing = isRecord(meta.pricing) ? meta.pricing : {};
    const input = perMillionOf(pricing.input_tokens);
    return {
      id: item.id,
      ...(asNumber(meta.context_length) ? { context: asNumber(meta.context_length) } : {}),
      ...(asNumber(meta.max_tokens) ? { output: asNumber(meta.max_tokens) } : {}),
      image: tags.includes("vision") || tags.includes("vlm"),
      ...(input !== undefined ? { cost: { input, output: perMillionOf(pricing.output_tokens) ?? 0, cacheRead: perMillionOf(pricing.cache_read_tokens) ?? input, cacheWrite: 0 } } : {}),
    };
  },
  // Novita: `model_type`, `status`, `features` (function-calling), `context_size`, `max_output_tokens`,
  // `input_modalities`, `pricing.{prompt,completion,input_cache_read}.price_per_m_decimal` (USD).
  novita: (item) => {
    if (item.model_type !== "chat" || item.status !== 1 || !(Array.isArray(item.features) && item.features.includes("function-calling"))) return undefined;
    const pricing = isRecord(item.pricing) ? item.pricing : {};
    const input = perMillionOf(pricing.prompt?.price_per_m_decimal);
    return {
      id: item.id,
      ...(asString(item.display_name) ? { name: item.display_name } : {}),
      ...(asNumber(item.context_size) ? { context: asNumber(item.context_size) } : {}),
      ...(asNumber(item.max_output_tokens) ? { output: asNumber(item.max_output_tokens) } : {}),
      image: Array.isArray(item.input_modalities) && item.input_modalities.includes("image"),
      ...(input !== undefined ? { cost: { input, output: perMillionOf(pricing.completion?.price_per_m_decimal) ?? 0, cacheRead: perMillionOf(pricing.input_cache_read?.price_per_m_decimal) ?? input, cacheWrite: 0 } } : {}),
    };
  },
  // Hugging Face's router: `architecture.input_modalities`, and per provider `status`, `context_length`,
  // `pricing`, `supports_tools`. The window is the smallest a live provider with tools gives (any may serve).
  huggingface: (item) => {
    const providers = (Array.isArray(item.providers) ? item.providers : []).filter((provider) => isRecord(provider) && provider.status === "live" && provider.supports_tools !== false);
    if (providers.length === 0) return undefined;
    const windows = providers.map((provider) => asNumber(provider.context_length)).filter(Boolean);
    const priced = providers.find((provider) => isRecord(provider.pricing) && asNumber(provider.pricing.input) !== undefined);
    return {
      id: item.id,
      ...(windows.length ? { context: Math.min(...windows) } : {}),
      ...(Array.isArray(item.architecture?.input_modalities) ? { image: item.architecture.input_modalities.includes("image") } : {}),
      ...(priced ? { cost: { input: asNumber(priced.pricing.input), output: asNumber(priced.pricing.output) ?? 0, cacheRead: asNumber(priced.pricing.input), cacheWrite: 0 } } : {}),
    };
  },
  // NVIDIA: the id only.
  nvidia: (item) => ({ id: item.id }),
});

/**
 * Live entries from a vendor's model list: OpenAI / xAI / OpenCode
 * `{ data: [{ id }] }`, Anthropic `{ data: [{ id, display_name }] }`,
 * OpenRouter `{ data: [{ id, name, context_length, architecture, supported_parameters, pricing }] }`,
 * Gemini `{ models: [{ name: "models/…", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods, thinking }] }`,
 * Cloudflare `{ result: [...] }`, Vercel `{ data: [{ id, type, pricing, reasoning_options, model_eligibility, … }] }`.
 */
export function parseModelList(body, endpoint, now = Date.now()) {
  if (Array.isArray(body?.result)) return body.result.map(cloudflareModel).filter(Boolean);
  if (endpoint?.vendor === "vercel") return (Array.isArray(body?.data) ? body.data : []).map((item) => vercelModel(item, now)).filter(Boolean);
  if (endpoint?.vendor === "opencode") return (Array.isArray(body?.data) ? body.data : []).filter((item) => isRecord(item) && asString(item.id) && !NOT_CHAT.test(item.id)).map(openCodeModel);
  if (HOST_LISTS[endpoint?.vendor]) return (Array.isArray(body?.data) ? body.data : []).filter((item) => isRecord(item) && asString(item.id) && !NOT_CHAT.test(item.id)).map(HOST_LISTS[endpoint.vendor]).filter(Boolean);
  if (Array.isArray(body?.models)) {
    return body.models
      .filter((item) => isRecord(item) && asString(item.name) && (!Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes("generateContent")))
      .map((item) => ({
        id: item.name.replace(/^models\//, ""),
        ...(asString(item.displayName) ? { name: item.displayName } : {}),
        ...(asNumber(item.inputTokenLimit) ? { context: asNumber(item.inputTokenLimit) } : {}),
        ...(asNumber(item.outputTokenLimit) ? { output: asNumber(item.outputTokenLimit) } : {}),
        ...(item.thinking === true ? { reasoning: { levels: ["low", "medium", "high"], off: false } } : {}),
        image: true,
        protocol: "gemini",
      }))
      .filter((entry) => !NOT_CHAT.test(entry.id));
  }
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.filter((item) => isRecord(item) && asString(item.id) && !NOT_CHAT.test(item.id)).map((item) => {
    const entry = { id: item.id };
    const name = asString(item.display_name) ?? (endpoint?.vendor === "openrouter" ? asString(item.name) : undefined);
    if (name) entry.name = name;
    if (asNumber(item.context_length)) entry.context = asNumber(item.context_length);
    if (asNumber(item.top_provider?.max_completion_tokens)) entry.output = asNumber(item.top_provider.max_completion_tokens);
    if (Array.isArray(item.architecture?.input_modalities)) entry.image = item.architecture.input_modalities.includes("image");
    if (Array.isArray(item.supported_parameters) && item.supported_parameters.includes("reasoning")) entry.reasoning = { levels: ["low", "medium", "high"], off: true };
    if (isRecord(item.pricing)) entry.cost = { input: perMillion(item.pricing.prompt), output: perMillion(item.pricing.completion), cacheRead: perMillion(item.pricing.input_cache_read), cacheWrite: perMillion(item.pricing.input_cache_write) };
    return entry;
  });
}

/**
 * The window assumed for a model nobody states one for (a live model newer
 * than the bundled catalog): DSH 0.2.1's own default. Without a window DSH
 * never compacts that model automatically (it warns once and skips), its
 * context meter shows nothing, and from 0.2.2 switching to it fails.
 */
export const DEFAULT_CONTEXT = 262_144;

/**
 * The output a request reserves by default: the model's own limit, at most
 * 128K and an eighth of the window. DSH compacts at
 * `min(80 %, window − output − 64K)`, which a full-size output on a small
 * window would bring down to almost nothing.
 */
export function defaultMaxTokensOf(entry) {
  const output = entry.output ?? 32_768;
  const context = entry.context || DEFAULT_CONTEXT;
  return Math.min(output, 131_072, Math.max(4_096, Math.floor(context / 8)));
}

/** DSH's default compaction headroom (`compaction-basic` `headroomTokens`). */
export const DSH_HEADROOM = 65_536;

/**
 * Whether a conversation may switch to this model midway. From DSH 0.2.2 a switch
 * first budgets compaction for the new model (`compaction-basic` resolveCompactSpec):
 * window − request output − headroom must leave a threshold above the retained tail
 * (16 % of window − output), else the switch fails (MODEL_SWITCH_COMPACTION_FAILED)
 * however short the history. Below about 88K the default headroom does not fit.
 * @returns null when the default fits; else `{ headroom }`, the `headroomTokens` a
 *   `modelPolicies` entry needs (a quarter of window − output), null when none fits.
 */
export function switchLimitOf(entry) {
  const context = entry.context || DEFAULT_CONTEXT;
  const budget = context - defaultMaxTokensOf(entry);
  const pressure = budget - DSH_HEADROOM;
  if (pressure > 0 && Math.floor(budget * 0.16) < Math.floor(Math.min(context * 0.8, pressure))) return null;
  const headroom = Math.floor(budget / 4 / 1024) * 1024;
  return { headroom: headroom >= 1024 ? headroom : null };
}

/** Harness model info for one entry (`listModels` / `resolveModel`). */
export function toModelInfo(route, entry) {
  const efforts = effortsOf(entry);
  const defaultEffort = defaultEffortOf(entry);
  return {
    provider: route,
    id: entry.id,
    name: entry.name ?? entry.id,
    inputModalities: entry.image ? ["text", "image"] : ["text"],
    context: { contextWindow: entry.context || DEFAULT_CONTEXT },
    defaultMaxTokens: defaultMaxTokensOf(entry),
    ...(efforts.length
      ? { reasoning: { efforts: efforts.map((id) => ({ id, name: EFFORT_NAMES[id] ?? id })), ...(defaultEffort ? { defaultEffort } : {}) } }
      : {}),
  };
}

/**
 * Hours a model's list price is the off-peak half of. OpenCode Go bills DeepSeek V4.1 Flash and V4 Pro
 * at twice it 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, holidays included (opencode.ai/docs/go;
 * the hours are DeepSeek's own, api-docs.deepseek.com/quick_start/pricing; magpie 643b5254). Its catalog
 * lists DeepSeek's off-peak rates.
 */
const PEAK_PRICED = Object.freeze({ "opencode-go": /^deepseek-v4(\.1-flash|-pro)$/ });

/** The factor a request's list price takes at `at`: 2 in a catalog's peak hours for its model, else 1. */
export function peakFactor(catalog, modelId, at = Date.now()) {
  const pattern = PEAK_PRICED[catalog];
  if (!pattern || !pattern.test(String(modelId ?? ""))) return 1;
  const time = new Date(at);
  const day = time.getUTCDay();
  const hour = time.getUTCHours();
  if (day === 0 || day === 6) return 1;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? 2 : 1;
}

/**
 * What one request cost in USD, from the model's prices (the tier its input
 * size reaches) and the harness usage, times the peak factor where a catalog
 * prices peak hours double (`options.catalog`, `options.at`). Undefined when
 * the model has no price.
 */
export function estimateCost(entry, usage, { catalog, at } = {}) {
  const cost = entry?.cost;
  if (!isRecord(cost) || !isRecord(usage)) return undefined;
  const input = Number(usage.inputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const total = input + cacheRead + cacheWrite;
  let rates = cost;
  for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) if (total > tier.above && tier.above > (rates.above ?? -1)) rates = tier;
  return peakFactor(catalog, entry?.id, at) * ((rates.input ?? 0) * input + (rates.output ?? 0) * output + (rates.cacheRead ?? 0) * cacheRead + (rates.cacheWrite ?? 0) * cacheWrite) / 1e6;
}

export class CatalogStore {
  #file;
  #fs;
  #now;
  #chain = Promise.resolve();
  #cache;
  #cacheStamp;
  /** Models that failed as unavailable in this process, per endpoint. */
  #unusable = new Map();

  constructor({ file = settingsPath(), fs = defaultFs, now = () => Date.now() } = {}) {
    this.#file = file;
    this.#fs = fs;
    this.#now = now;
  }

  path() {
    return this.#file;
  }

  /**
   * The file as it is (`fresh`: re-read regardless, under the lock). A file that cannot be read throws — the user's
   * model choices are not written over with an empty state; a corrupt one is set aside (safe.js).
   */
  async #read({ fresh = false } = {}) {
    let stamp;
    try {
      const info = await this.#fs.stat(this.#file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stamp = "absent";
    }
    if (!fresh && this.#cache !== undefined && stamp === this.#cacheStamp) return this.#cache;
    let state = { version: VERSION, endpoints: {} };
    if (stamp !== "absent") {
      const raw = await readJsonFile(this.#fs, this.#file);
      if (isRecord(raw) && isRecord(raw.endpoints)) state = { version: VERSION, endpoints: raw.endpoints };
    }
    this.#cache = state;
    this.#cacheStamp = stamp;
    return state;
  }

  #mutate(fn) {
    // Under the store's lock file and read afresh: another process writing it meanwhile is not written over.
    const run = this.#chain.then(() => withFileLock(this.#fs, this.#file, async () => {
      const next = fn(structuredClone(await this.#read({ fresh: true })));
      await this.#fs.mkdir(dirname(this.#file), { recursive: true });
      // A unique sibling per write (see the key store).
      const temp = `${this.#file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.new`;
      await this.#fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await replaceFile(this.#fs, temp, this.#file);
      this.#cache = next;
      try {
        const info = await this.#fs.stat(this.#file);
        this.#cacheStamp = `${info.mtimeMs}:${info.size}`;
      } catch {
        this.#cacheStamp = undefined;
      }
      return next;
    }));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Every model an endpoint offers: the snapshot the key can see, then the live models the snapshot does not know. */
  async models(endpointId) {
    const endpoint = endpointById(endpointId);
    const snapshot = bundled(endpoint);
    const state = (await this.#read()).endpoints[endpointId];
    const live = Array.isArray(state?.live) && state.live.length ? state.live : null;
    if (!live) return snapshot;
    const liveById = new Map(live.map((item) => [item.id, item]));
    const known = new Set(snapshot.map((entry) => entry.id));
    // A snapshot model the live list cannot show (Cloudflare's third-party ones) stays.
    const seen = snapshot.filter((entry) => liveById.has(entry.id) || entry.offList === true).map((entry) => {
      const item = liveById.get(entry.id);
      if (!item) return entry;
      // Vercel's live prices are its own, tiers included, and beat the snapshot's. Elsewhere a
      // snapshot price of 0 gives way to a live price: a launch offer outlives its launch there
      // (inclusionai/ling-3.1-flash, free in pi-ai's data, $0.3 / $0.9 live on 2026-10-17).
      const liveCost = isRecord(item.cost) ? item.cost : null;
      const livePriced = Boolean(liveCost && (liveCost.input > 0 || liveCost.output > 0));
      const snapshotFree = isRecord(entry.cost) && entry.cost.input === 0 && entry.cost.output === 0;
      const merged = {
        ...entry,
        ...(item.context ? { context: item.context } : {}),
        ...(item.output && !entry.output ? { output: item.output } : {}),
        ...(liveCost && (!entry.cost || endpoint?.vendor === "vercel" || (snapshotFree && livePriced)) ? { cost: liveCost } : {}),
        ...(item.image === true ? { image: true } : {}),
        ...(item.paidPlan ? { paidPlan: true } : {}),
        // Vercel: what the key's team may use, and a model's announced end.
        ...(item.restricted ? { restricted: item.restricted } : {}),
        ...(item.retiring ? { retiring: item.retiring } : {}),
      };
      // A model the live list prices is not free, whatever the snapshot said.
      if (livePriced) delete merged.free;
      return merged;
    });
    // A short list (xAI) is all chat models worth offering; a long one (OpenAI lists everything) is not ticked.
    const extra = live.filter((item) => !known.has(item.id)).map((item) => unknownModel(item.id, item, endpoint));
    return [...seen, ...extra];
  }

  /** When the live list was fetched (null: never). */
  async fetchedAt(endpointId) {
    return (await this.#read()).endpoints[endpointId]?.fetchedAt ?? null;
  }

  /** Whether the live list is missing or old. */
  async stale(endpointId) {
    const endpoint = endpointById(endpointId);
    if (!endpoint?.liveModels) return false;
    const at = await this.fetchedAt(endpointId);
    return !at || this.#now() - at > CATALOG_TTL_MS;
  }

  /** Store a live list. */
  async storeLive(endpointId, entries) {
    await this.#mutate((state) => ({
      ...state,
      endpoints: { ...state.endpoints, [endpointId]: { ...state.endpoints[endpointId], live: entries, fetchedAt: this.#now() } },
    }));
    this.#unusable.delete(endpointId);
  }

  /** The selection (null: the default). */
  async enabledIds(endpointId) {
    const ids = (await this.#read()).endpoints[endpointId]?.enabledIds;
    return Array.isArray(ids) ? ids : null;
  }

  /** Replace the selection (null: back to the default). */
  async setEnabled(endpointId, ids) {
    const next = ids === null ? null : [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
    await this.#mutate((state) => {
      const current = { ...state.endpoints[endpointId] };
      if (next === null) delete current.enabledIds;
      else current.enabledIds = next;
      return { ...state, endpoints: { ...state.endpoints, [endpointId]: current } };
    });
    return next;
  }

  /** Forget endpoints that have no key any more. */
  async prune(endpointIds) {
    const keep = new Set(endpointIds);
    const state = await this.#read();
    if (Object.keys(state.endpoints).every((id) => keep.has(id))) return;
    await this.#mutate((current) => ({ ...current, endpoints: Object.fromEntries(Object.entries(current.endpoints).filter(([id]) => keep.has(id))) }));
  }

  /** Remember, for this process, that a model failed as unavailable on an endpoint. */
  markUnusable(endpointId, modelId, reason) {
    if (!this.#unusable.has(endpointId)) this.#unusable.set(endpointId, new Map());
    this.#unusable.get(endpointId).set(modelId, reason);
  }

  /** Every model with its selection and availability (the dialog's rows). */
  async options(endpointId) {
    const endpoint = endpointById(endpointId);
    const models = await this.models(endpointId);
    const enabled = await this.enabledIds(endpointId);
    const unusable = this.#unusable.get(endpointId) ?? new Map();
    return models.map((entry) => {
      const blocked = blockedReason(entry, endpoint) ?? restrictedReason(entry, endpoint);
      return {
        ...entry,
        free: isFreeModel(entry, endpoint),
        // A model that can never answer here is never offered, ticked or not.
        enabled: !blocked && (enabled === null ? entry.recommended === true : enabled.includes(entry.id)),
        blocked,
        unusable: unusable.get(entry.id) ?? null,
      };
    });
  }

  /** What the picker offers for an endpoint. */
  async selected(endpointId) {
    return (await this.options(endpointId)).filter((entry) => entry.enabled && !entry.unusable);
  }

  /** One model of an endpoint, selected or not (an unknown id gets defaults). */
  async find(endpointId, modelId) {
    const endpoint = endpointById(endpointId);
    const models = await this.models(endpointId);
    return models.find((entry) => entry.id === modelId)
      ?? bundled(endpoint).find((entry) => entry.id === modelId)
      ?? unknownModel(modelId, {}, endpoint);
  }
}
