/**
 * Is a key valid, and what does it have left? Three checks:
 *
 * - **validity** (free everywhere): `GET /models` (OpenAI, OpenCode — which
 *   checks a key it is sent), Anthropic `GET /v1/models`, Gemini
 *   `GET /models`, xAI `GET /api-key` (which also says whether the key or its
 *   team is blocked), OpenRouter `GET /key`, Vercel `GET /credits`;
 * - **funds**: OpenRouter — `GET /key` (the key's own limit, its spend
 *   today / this week / this month, free-model requests left today) and
 *   `GET /credits` (the account balance); Vercel — `GET /credits` (the team's
 *   balance and total spend, booked within seconds of a request). The others
 *   show nothing to an API key; spending is estimated per request instead
 *   (catalog prices);
 *   Cloudflare: its token (`/user/tokens/verify`, or the account's for an
 *   account token) and then the account itself (its free model search: a
 *   wrong account id fails there);
 * - **availability** (is there money behind the key?), where no balance can be
 *   read: one request on the newest model the user selected (the next one when
 *   a model is gone, busy or not offered to this key). OpenAI (`n: 0`) and
 *   Anthropic (`max_tokens: 0`) check the balance before the parameters, so
 *   a broke account gets its "no credits" while a funded one gets a free 400;
 *   Gemini, xAI and OpenCode get one real one-token request (OpenCode checks
 *   funds and the Go subscription first, but refuses some models before that).
 *
 * `auto` (timer, after use) reads funds where there are any, else validity,
 * plus the free probe when it is due; `full` (import) runs both; `deep`
 * (✓, 验证全部) adds the availability probe; `probe` runs it alone. A
 * transient failure (network, 5xx) is retried once and then kept as
 * `validityError` / `quotaError` / `probeError` beside the last verdict.
 * Shapes checked live on 2026-10-15 (OpenAI, OpenRouter, Anthropic, Gemini and
 * OpenCode refusals), else from the vendors' docs (xAI).
 *
 * @module dsh-intl-models/probe
 */
import { randomUUID } from "node:crypto";
import { classifyFailure, KIND_LABELS } from "./dialects.js";
import { candidateEndpoints, endpointById, endpointFor, geminiBaseOf, messagesBaseOf } from "./endpoints.js";
import { asNumber, asString, isRecord, redact } from "./errors.js";
import { requestJson } from "./wire.js";

/** How long a key with no balance is held back before it is tried again. */
export const NO_BALANCE_HOLD_MS = 30 * 60_000;
/** How long a used-up limit is held back when the vendor names no reset time. */
export const PLAN_HOLD_MS = 60 * 60_000;
/** A failed check request (network, 5xx) is retried once after this long. */
const RETRY_DELAY_MS = 800;
/** The automatic checks re-run a free probe at most this often (a served request proves more). */
export const PROBE_TTL_MS = 6 * 60 * 60_000;
/** One probe request waits at most this long. */
const PROBE_TIMEOUT_MS = 25_000;
/** A probe tries at most this many models. */
const PROBE_TRIES = 3;

const NO_HOLD = { limitedUntil: undefined, limitedReason: undefined, limitedExact: undefined };
/** Statuses a validity check may overturn: a funds verdict is not its business. */
const VALIDITY_OWNS = new Set([undefined, "unknown", "invalid", "error"]);

/**
 * A key's state from one classified failure.
 * @returns the patch for the key store.
 */
export function statusFromFailure(failure, now = Date.now()) {
  switch (failure.kind) {
    case "invalid-key":
      return { status: "invalid", statusMessage: failure.message, ...NO_HOLD };
    case "expired":
      return { status: "expired", statusMessage: failure.message, ...NO_HOLD };
    case "no-balance":
      return { status: "no-balance", statusMessage: failure.message, limitedUntil: now + NO_BALANCE_HOLD_MS, limitedReason: "no-balance", limitedExact: false };
    case "plan-quota": {
      const exact = Boolean(failure.resetAt && failure.resetAt > now);
      return { status: "plan-quota", statusMessage: failure.message, limitedUntil: exact ? failure.resetAt : now + PLAN_HOLD_MS, limitedReason: "plan-quota", limitedExact: exact };
    }
    // The key got through authentication: it is valid, just busy or refused this one request.
    case "rate-limit":
    case "overloaded":
    case "moderation":
    case "bad-request":
    case "context":
    case "not-found":
    case "region":
      return { status: "ok", statusMessage: failure.message };
    default:
      return { status: "error", statusMessage: failure.message };
  }
}

/** How an endpoint's keys are validated. */
export const validityKind = (endpoint) => endpoint?.check?.validity ?? "models";
/** Where one key's funds (a balance, or quota windows) are read; null when the vendor offers nothing. */
export const fundsKind = (record, endpoint = endpointById(record?.endpoint)) => endpoint?.check?.funds ?? endpoint?.check?.quota ?? null;

/** Workers AI's free allocation: neurons a day per account, back at 00:00 UTC. */
export const CLOUDFLARE_FREE_NEURONS = 10_000;
const NEURONS_QUERY = "query ($accountTag: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) { aiInferenceAdaptiveGroups(filter: { datetime_geq: $start, datetime_leq: $end }, limit: 1) { sum { totalNeurons } } } } }";

/**
 * Today's Workers AI neurons of the key's account (every caller's, not just
 * this plugin's), from Cloudflare's GraphQL analytics — free, and it needs the
 * token's "Account Analytics: Read" (checked live 2026-10-17). Shown as the
 * share of the daily free allocation left; past it the Workers plan bills (or,
 * on the Free plan, requests stop with 4006 — that refusal holds the key).
 */
async function cloudflareNeurons(record, ctx) {
  const validity = await checkValidity(record, ctx);
  if (!authenticated(validity)) return validity;
  const now = ctx.now();
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const response = await ctx.call("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    body: { query: NEURONS_QUERY, variables: { accountTag: record.params.account, start: new Date(start).toISOString(), end: new Date(now).toISOString() } },
  });
  const errors = Array.isArray(response.body?.errors) ? response.body.errors : [];
  if (!response.ok || errors.length || !response.body?.data) {
    // No analytics permission: nothing to show, which is not a failed check.
    if (errors.some((error) => error?.extensions?.code === "authz")) return { ...validity, quota: null, quotaAt: ctx.checkedAt, quotaError: null, quotaHint: "Token 缺少「帐户 → 帐户分析 → 读取」权限，查不到今日 neurons" };
    return { ...validity, quotaAt: ctx.checkedAt, quotaError: ctx.why(response, { message: errors[0]?.message }) };
  }
  const groups = response.body.data.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
  const used = groups.reduce((sum, group) => sum + (asNumber(group?.sum?.totalNeurons) ?? 0), 0);
  const left = Math.max(0, CLOUDFLARE_FREE_NEURONS - used);
  return {
    ...validity,
    quota: { windows: [{ id: "day", used: Math.round(used * 100) / 100, limit: CLOUDFLARE_FREE_NEURONS, remainingPercent: Math.floor((left / CLOUDFLARE_FREE_NEURONS) * 100), resetAt: new Date(start + 86_400_000).toISOString() }] },
    quotaAt: ctx.checkedAt,
    quotaError: null,
    quotaHint: null,
  };
}

const transient = (response) => response.status === 0 || response.status >= 500;

/** When an OpenRouter key limit resets ("daily" / "weekly" / "monthly", UTC). */
function limitResetAt(reset, now) {
  const date = new Date(now);
  if (reset === "daily") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  if (reset === "weekly") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7));
  if (reset === "monthly") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return undefined;
}

/** How an endpoint's keys are probed: `free`, `request`, or null (see endpoints.js). */
export const probeKind = (endpoint) => endpoint?.check?.probe ?? null;

/**
 * Models a probe may use, per vendor: OpenAI's on Chat Completions and billed
 * per token (no codex / pro / realtime / search …); Gemini's flash models (a
 * pro model has no free tier, so its refusal says nothing about the key);
 * OpenCode's Chat Completions ones.
 */
const PROBE_MODELS = {
  // Workers AI's own models (neurons from the daily free allocation), never one paid from credits.
  cloudflare: (entry) => String(entry.id).startsWith("@cf/"),
  openai: (entry) => !/codex|-pro\b|realtime|audio|search|deep-research|image|tts|transcribe|computer-use|instruct/i.test(entry.id),
  xai: (entry) => !/image|imagine|video/i.test(entry.id),
  opencode: (entry) => (entry.protocol ?? "chat") === "chat",
  gemini: (entry) => !/-pro\b|image|tts|live|embedding|robotics|computer-use/i.test(entry.id),
};

const HELLO = [{ role: "user", content: "hi" }];

/**
 * The probe request for one model. `refusalPasses`: a parameter refusal means
 * the balance check before it passed (OpenAI, Anthropic). `ownProtocol`: the
 * probe speaks the model's own protocol, so "no such model" means it is gone
 * (OpenAI and xAI chat over Responses but are probed over Chat Completions).
 */
function probeRequest(endpoint, model) {
  switch (endpoint.vendor) {
    case "openai":
      return { url: `${endpoint.baseUrl}/chat/completions`, body: { model, messages: HELLO, n: 0 }, refusalPasses: true };
    case "anthropic":
      return { url: `${messagesBaseOf(endpoint)}/v1/messages`, auth: "anthropic", body: { model, max_tokens: 0, messages: HELLO }, refusalPasses: true, ownProtocol: true };
    // A real one-token request: OpenCode refuses some models with a 400 before it looks at
    // funds or the Go subscription ("This Go model requires Global regions"), so a refusal proves nothing.
    case "opencode":
      return {
        url: `${endpoint.baseUrl}/chat/completions`,
        body: { model, messages: HELLO, max_tokens: 1 },
        headers: endpoint.sessionHeader ? { [endpoint.sessionHeader]: `dsh-probe-${randomUUID()}` } : undefined,
        ownProtocol: true,
      };
    case "xai":
      return { url: `${endpoint.baseUrl}/chat/completions`, body: { model, messages: HELLO, max_tokens: 1 } };
    case "cloudflare":
      return { url: `${endpoint.baseUrl}/chat/completions`, body: { model, messages: HELLO, max_tokens: 1 }, headers: endpoint.headers, ownProtocol: true };
    case "gemini":
      return { url: `${geminiBaseOf(endpoint)}/models/${encodeURIComponent(model)}:generateContent`, auth: "gemini", body: { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } }, ownProtocol: true };
    default:
      return undefined;
  }
}

/** Whether the automatic checks should run a key's free probe now. */
export function probeDue(record, now = Date.now()) {
  if (typeof record.limitedUntil === "number" && record.limitedUntil > now) return false;
  if (record.status === "no-balance" || record.status === "plan-quota") return true;
  const at = Date.parse(record.probedAt ?? "");
  return !Number.isFinite(at) || now - at > PROBE_TTL_MS;
}

/** Shared wiring of one check run. */
function context(record, { fetchImpl, signal, now, retryDelayMs }) {
  const base = endpointById(record.endpoint);
  // The endpoint as this key sees it (Cloudflare: the key's account in every URL); undefined when a param is missing.
  const endpoint = endpointFor(base, record);
  const checkedAt = new Date(now()).toISOString();
  const call = async (url, extra) => {
    const first = await requestJson(url, record.key, { fetchImpl, signal, ...extra });
    if (!transient(first) || retryDelayMs < 0) return first;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return requestJson(url, record.key, { fetchImpl, signal, ...extra });
  };
  const classify = (response) => classifyFailure(base.vendor, response.status, response.text, { plan: Boolean(base.plan), headers: response.headers });
  const why = (response, failure) => (response.timedOut ? "请求超时" : response.status === 0 ? `网络错误：${redact(response.text)}` : redact(failure?.message ?? `HTTP ${response.status}`));
  return { endpoint, base, checkedAt, now, call, classify, why, fetchImpl, signal };
}

/** A failed validity request: a verdict when the vendor gave one, else a note beside the last one. */
function validityFailed(record, ctx, response) {
  const failure = ctx.classify(response);
  const verdict = statusFromFailure(failure, ctx.now());
  // The vendor said the key (or its account) is not accepted: that holds whatever the status (Cloudflare: 404 for a wrong account).
  if (verdict.status === "invalid" && !transient(response)) return { ...verdict, checkedAt: ctx.checkedAt, validityError: null, authenticated: false };
  // A 404 or a 5xx / network failure proves nothing about the key.
  if (response.status === 404 || transient(response) || verdict.status === "error") {
    const message = response.status === 404 ? "检测接口不可用（404）" : ctx.why(response, failure);
    return { checkedAt: ctx.checkedAt, validityError: message, ...(record.status === undefined || record.status === "unknown" ? { status: "error", statusMessage: message } : {}) };
  }
  if (verdict.status === "invalid") return { ...verdict, checkedAt: ctx.checkedAt, validityError: null, authenticated: false };
  if (verdict.status === "ok") return passed(record, ctx);
  return { ...verdict, checkedAt: ctx.checkedAt, validatedAt: ctx.checkedAt, validityError: null, authenticated: true };
}

/** The vendor accepted the key. */
function passed(record, ctx) {
  return { checkedAt: ctx.checkedAt, validatedAt: ctx.checkedAt, validityError: null, authenticated: true, ...(VALIDITY_OWNS.has(record.status) ? { status: "ok", statusMessage: null } : {}) };
}

/** OpenRouter `GET /key` (+ `GET /credits`): validity and funds in one read. */
async function openrouter(record, ctx, { funds }) {
  const response = await ctx.call(`${ctx.endpoint.baseUrl}/key`);
  if (!response.ok) return funds ? { ...validityFailed(record, ctx, response), ...(transient(response) ? { quotaError: ctx.why(response) } : {}) } : validityFailed(record, ctx, response);
  if (!funds) return passed(record, ctx);
  const data = isRecord(response.body?.data) ? response.body.data : {};
  const credits = await ctx.call(`${ctx.endpoint.baseUrl}/credits`);
  const total = asNumber(credits.body?.data?.total_credits);
  const used = asNumber(credits.body?.data?.total_usage);
  const remaining = asNumber(data.limit_remaining);
  const balance = {
    currency: "USD",
    amount: total !== undefined && used !== undefined ? Math.max(0, Math.round((total - used) * 1e4) / 1e4) : null,
    keyLimit: asNumber(data.limit) ?? null,
    keyRemaining: remaining ?? null,
    keyReset: asString(data.limit_reset) ?? null,
    spent: { day: asNumber(data.usage_daily) ?? null, week: asNumber(data.usage_weekly) ?? null, month: asNumber(data.usage_monthly) ?? null, total: asNumber(data.usage) ?? null },
    freeTier: data.is_free_tier === true,
    ...(isRecord(data.free_model_daily_requests) ? { freeRequests: { used: asNumber(data.free_model_daily_requests.used) ?? 0, limit: asNumber(data.free_model_daily_requests.limit) ?? 0, remaining: asNumber(data.free_model_daily_requests.remaining) ?? 0 } } : {}),
  };
  const base = { ...passed(record, ctx), status: "ok", statusMessage: null, ...NO_HOLD, balance, quotaAt: ctx.checkedAt, quotaError: credits.ok ? null : ctx.why(credits) };
  // The key's own cap is spent: this key is out until its limit resets (other keys may not be).
  if (remaining !== undefined && remaining <= 0 && balance.keyLimit !== null) {
    const reset = limitResetAt(balance.keyReset, ctx.now());
    return { ...base, status: "plan-quota", statusMessage: "这个 Key 的额度上限已用完", limitedUntil: reset ?? ctx.now() + PLAN_HOLD_MS, limitedReason: "plan-quota", limitedExact: Boolean(reset) };
  }
  // No credits is not "out": free models still answer (so many a day, back at midnight UTC). A paid model's 402 will say so.
  if (balance.amount === 0 && balance.freeRequests && balance.freeRequests.limit > 0 && balance.freeRequests.remaining <= 0) {
    return { ...base, status: "plan-quota", statusMessage: "余额为 0，今日免费模型次数已用完", limitedUntil: limitResetAt("daily", ctx.now()), limitedReason: "plan-quota", limitedExact: true };
  }
  return base;
}

/**
 * Vercel `GET /credits`: the team's balance and lifetime spend in USD (decimal
 * strings) — validity and funds in one free read, booked within ~3 s of a
 * request (checked live 2026-10-17). A free-tier team's balance is its monthly
 * credit. A hold this read cannot judge (a budget used up, free credits that
 * need a payment method, a rate limit) stays: the balance says nothing of it.
 */
async function vercel(record, ctx, { funds }) {
  const response = await ctx.call(`${ctx.endpoint.baseUrl}/credits`);
  if (!response.ok) return funds ? { ...validityFailed(record, ctx, response), ...(transient(response) ? { quotaError: ctx.why(response) } : {}) } : validityFailed(record, ctx, response);
  if (!funds) return passed(record, ctx);
  const amount = asNumber(response.body?.balance);
  const used = asNumber(response.body?.total_used);
  const balance = { currency: "USD", amount: amount ?? null, totalUsed: used ?? null };
  const base = { ...passed(record, ctx), balance, quotaAt: ctx.checkedAt, quotaError: null };
  const now = ctx.now();
  const otherHold = typeof record.limitedUntil === "number" && record.limitedUntil > now && record.limitedReason !== "no-balance";
  if (otherHold) return base;
  if (amount !== undefined && amount <= 0) return { ...base, status: "no-balance", statusMessage: "Vercel 额度已用完", limitedUntil: now + NO_BALANCE_HOLD_MS, limitedReason: "no-balance", limitedExact: false };
  return { ...base, status: "ok", statusMessage: null, ...NO_HOLD };
}

/**
 * Does the vendor accept the key? Every check is free.
 * @returns a patch with `authenticated`.
 */
async function checkValidity(record, ctx) {
  const { endpoint } = ctx;
  switch (validityKind(endpoint)) {
    case "openrouter":
      return openrouter(record, ctx, { funds: false });
    case "vercel":
      return vercel(record, ctx, { funds: false });
    case "anthropic": {
      const response = await ctx.call(`${endpoint.baseUrl}/models?limit=1`, { auth: "anthropic" });
      return response.ok ? passed(record, ctx) : validityFailed(record, ctx, response);
    }
    case "gemini": {
      const response = await ctx.call(`${endpoint.baseUrl}/models?pageSize=1`, { auth: "gemini" });
      return response.ok ? passed(record, ctx) : validityFailed(record, ctx, response);
    }
    case "cloudflare": {
      // A user's token (`cfut_`) verifies at /user, an account's (`cfat_`) at its account.
      const api = "https://api.cloudflare.com/client/v4";
      let verified = await ctx.call(`${api}/user/tokens/verify`);
      if (!verified.ok && verified.status === 401) {
        const own = await ctx.call(`${api}/accounts/${encodeURIComponent(record.params.account)}/tokens/verify`);
        if (own.ok || !String(record.key).startsWith("cfut_")) verified = own;
      }
      if (!verified.ok) return validityFailed(record, ctx, verified);
      const state = verified.body?.result?.status;
      if (state === "disabled" || state === "expired") {
        return { status: state === "expired" ? "expired" : "invalid", statusMessage: state === "expired" ? "Token 已过期" : "Token 已停用", ...NO_HOLD, checkedAt: ctx.checkedAt, validityError: null, authenticated: false };
      }
      // The account: a wrong id or a token without Workers AI fails here (free).
      const models = await ctx.call(endpoint.modelsUrl);
      return models.ok ? passed(record, ctx) : validityFailed(record, ctx, models);
    }
    case "xai": {
      const response = await ctx.call(`${endpoint.baseUrl}/api-key`);
      if (response.status === 404) {
        const models = await ctx.call(`${endpoint.baseUrl}/models`);
        return models.ok ? passed(record, ctx) : validityFailed(record, ctx, models);
      }
      if (!response.ok) return validityFailed(record, ctx, response);
      const body = isRecord(response.body) ? response.body : {};
      if (body.api_key_blocked === true || body.api_key_disabled === true || body.team_blocked === true) {
        const message = body.team_blocked === true ? "xAI 团队已被封禁" : body.api_key_disabled === true ? "Key 已停用" : "Key 已被封禁";
        return { status: "invalid", statusMessage: message, ...NO_HOLD, checkedAt: ctx.checkedAt, validityError: null, authenticated: false };
      }
      return passed(record, ctx);
    }
    default: {
      const response = await ctx.call(`${endpoint.baseUrl}/models`);
      return response.ok ? passed(record, ctx) : validityFailed(record, ctx, response);
    }
  }
}

/**
 * Read one key's funds.
 * @returns a patch, or `{ unchanged }` where the vendor shows nothing.
 */
async function checkFunds(record, ctx) {
  if (fundsKind(record, ctx.endpoint) === "openrouter") return openrouter(record, ctx, { funds: true });
  if (fundsKind(record, ctx.endpoint) === "cloudflare-neurons") return cloudflareNeurons(record, ctx);
  if (fundsKind(record, ctx.endpoint) === "vercel") return vercel(record, ctx, { funds: true });
  return { checkedAt: ctx.checkedAt, unchanged: true };
}

/**
 * Is there money behind the key? One probe request per model, newest selected
 * first, until one answers for the account.
 * @param {Array<{ id: string, protocol?: string }>} models - candidates, in order.
 * @returns a patch (`probedAt` when the vendor gave a verdict, else `probeError`), plus `unusableModels` (`[[id, reason]]`: gone on this endpoint).
 */
async function checkAvailability(record, ctx, models) {
  const { endpoint } = ctx;
  const eligible = PROBE_MODELS[endpoint.vendor] ?? (() => true);
  const candidates = models.filter((entry) => entry?.id && eligible(entry)).slice(0, PROBE_TRIES);
  if (candidates.length === 0) return { checkedAt: ctx.checkedAt, probeError: "没有可用来检测的模型（请在模型列表里勾选）" };
  const unusableModels = [];
  const notes = [];
  // Gemini words a refusal for one model like one for the account (no free tier for it, its daily quota): all must agree.
  const modelOnly = [];
  const verdict = (failure, model) => ({
    ...statusFromFailure(failure, ctx.now()),
    checkedAt: ctx.checkedAt,
    ...(failure.kind === "invalid-key" ? { authenticated: false } : { validatedAt: ctx.checkedAt, authenticated: true }),
    validityError: null,
    probedAt: ctx.checkedAt,
    probeModel: model,
    probeError: null,
    probeNote: notes.join("；") || null,
    unusableModels,
  });
  for (const entry of candidates) {
    const request = probeRequest(endpoint, entry.id);
    if (!request) break;
    const response = await requestJson(request.url, record.key, { method: "POST", body: request.body, auth: request.auth, headers: request.headers, fetchImpl: ctx.fetchImpl, signal: ctx.signal, timeoutMs: PROBE_TIMEOUT_MS });
    const failure = response.ok ? null : ctx.classify(response);
    const passes = response.ok || failure.kind === "rate-limit" || (request.refusalPasses && ["bad-request", "context", "moderation"].includes(failure.kind));
    if (passes) {
      return {
        status: "ok", statusMessage: null, ...NO_HOLD,
        checkedAt: ctx.checkedAt, validatedAt: ctx.checkedAt, validityError: null, authenticated: true,
        probedAt: ctx.checkedAt, probeModel: entry.id, probeError: null, probeNote: notes.join("；") || null,
        unusableModels,
      };
    }
    switch (failure.kind) {
      case "invalid-key":
      case "expired":
        return verdict(failure, entry.id);
      case "no-balance":
      case "plan-quota":
        if (endpoint.vendor !== "gemini") return verdict(failure, entry.id);
        modelOnly.push({ failure, model: entry.id });
        notes.push(`${entry.id}：${KIND_LABELS[failure.kind]}`);
        break;
      case "not-found":
        if (request.ownProtocol) unusableModels.push([entry.id, redact(failure.message)]);
        notes.push(`${entry.id}：${KIND_LABELS["not-found"]}`);
        break;
      case "region":
        return { checkedAt: ctx.checkedAt, probeError: KIND_LABELS.region, unusableModels };
      default:
        notes.push(`${entry.id}：${response.timedOut ? KIND_LABELS.timeout : KIND_LABELS[failure.kind] ?? ctx.why(response, failure)}`);
    }
  }
  // Every model tried refused for want of money (Gemini: billing needed for all of them).
  if (modelOnly.length && modelOnly.length === candidates.length) {
    const first = modelOnly.find((item) => item.failure.kind === "no-balance") ?? modelOnly[0];
    return verdict(first.failure, first.model);
  }
  return { checkedAt: ctx.checkedAt, probeError: notes.join("；") || "没有得到结论", unusableModels };
}

/**
 * Check one key.
 * @param {object} record - the stored key (with its secret).
 * @param {object} [options] - `mode` (`auto` | `validity` | `funds` | `full` | `probe`), `deep` (add the availability probe), `models` (probe candidates, newest selected first), `fetchImpl`, `signal`, `now`, `retryDelayMs`.
 * @returns a patch for the key store, plus `authenticated`, `unchanged` and `unusableModels` for the caller.
 */
export async function checkKey(record, { mode = "auto", deep = false, models = [], fetchImpl = fetch, signal, now = () => Date.now(), retryDelayMs = RETRY_DELAY_MS } = {}) {
  const ctx = context(record, { fetchImpl, signal, now, retryDelayMs });
  if (!ctx.endpoint) {
    const missing = ctx.base.params.filter((param) => param.required && !record.params?.[param.id]).map((param) => param.label).join("、");
    return { status: "invalid", statusMessage: `缺少 ${missing}`, ...NO_HOLD, checkedAt: ctx.checkedAt, validityError: null, authenticated: false };
  }
  const funds = fundsKind(record, ctx.endpoint);
  const probe = probeKind(ctx.endpoint);
  if (mode === "funds") return checkFunds(record, ctx);
  if (mode === "probe" && probe) return checkAvailability(record, ctx, models);
  // OpenRouter's one read answers both; elsewhere validity is the only thing to read.
  const result = mode === "validity" || !funds ? await checkValidity(record, ctx) : await checkFunds(record, ctx);
  if (!probe || !models.length || !authenticated(result)) return result;
  // The free probe runs with the automatic checks when due; one that costs a token only when asked.
  const merged = { ...record, ...result };
  if (!(deep || mode === "probe" || (probe === "free" && probeDue(merged, now())))) return result;
  return { ...result, ...(await checkAvailability(merged, ctx, models)) };
}

/** Whether a check proved the key belongs here (whatever its balance). */
export const authenticated = (result) => result?.authenticated === true;

/**
 * Find the endpoint a key belongs to: its candidates (from its shape and the
 * vendor) are checked in parallel, and the first in priority order that
 * accepts the key wins (OpenCode Zen before Go: the same key serves both, Go
 * only with a subscription — choose it in the add dialog).
 * @returns `{ endpoint, result, tried }` for the winner, else `{ endpoint: undefined, result, tried }` (the most telling failure).
 */
export async function detectEndpoint(key, vendorHint, { fetchImpl = fetch, signal, now, retryDelayMs, params } = {}) {
  const ids = candidateEndpoints(key, vendorHint).filter((id) => id !== "opencode-go");
  const results = await Promise.all(ids.map((id) => checkKey({ endpoint: id, key, ...(params && endpointById(id).params ? { params } : {}) }, { mode: "full", fetchImpl, signal, now, retryDelayMs }).then((result) => [id, result])));
  let last;
  for (const [id, result] of results) {
    if (authenticated(result)) return { endpoint: endpointById(id), result, tried: ids };
    if (!last || (last.status === "error" && result.status !== "error") || (!last.status && result.status)) last = result;
  }
  return { endpoint: undefined, result: last, tried: ids };
}
