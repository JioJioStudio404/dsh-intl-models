/**
 * What differs between the vendors: reasoning levels, and what a failure
 * means for the key that got it.
 *
 * Failures are classified from the vendor's own error body, not the HTTP
 * status alone: OpenAI says "no credits" with a 429 (`insufficient_quota`) —
 * or inside a 200 stream —, Anthropic with a 400 ("credit balance is too
 * low"), OpenRouter with a 402 that names which budget ran out, Google with a
 * 403 `CONSUMER_SUSPENDED` for a dead project. Shapes were checked against
 * live answers on 2026-10-15 where a key allowed it, else the vendors' docs.
 *
 * @module dsh-intl-models/dialects
 */
import { asNumber, isRecord, safeJson } from "./errors.js";

/** Reasoning level names, in order (the harness shows these). */
export const EFFORT_ORDER = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const EFFORT_NAMES = Object.freeze({ off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });

/**
 * The reasoning efforts one model offers (catalog `reasoning`: `levels` in
 * order, `off` when thinking can be switched off).
 */
export function effortsOf(model) {
  const reasoning = model?.reasoning;
  if (!isRecord(reasoning)) return [];
  const levels = Array.isArray(reasoning.levels) ? reasoning.levels.filter((level) => EFFORT_ORDER.includes(level) && level !== "off") : [];
  return [...(reasoning.off ? ["off"] : []), ...EFFORT_ORDER.filter((level) => levels.includes(level))];
}

/** The default effort: "high" when offered, else the strongest below it, else the first. */
export function defaultEffortOf(model) {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return undefined;
  for (const level of ["high", "medium", "low", "minimal"]) if (efforts.includes(level)) return level;
  return efforts.find((effort) => effort !== "off") ?? efforts[0];
}

/** A requested effort, checked against what the model offers (unknown → the default). */
export function resolveEffort(model, requested, purpose) {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return undefined;
  // Titles and compaction need no deliberation where it can be switched off; else the lightest level.
  if (purpose === "session-title" || purpose === "compaction") return efforts.includes("off") ? "off" : efforts.find((level) => level !== "off");
  return efforts.includes(requested) ? requested : defaultEffortOf(model);
}

/** The vendor's own value for a level (the catalog maps some, e.g. OpenAI's "off" is "none"). */
export const providerLevel = (model, level) => (typeof model?.reasoning?.map?.[level] === "string" ? model.reasoning.map[level] : level);

/**
 * What a failure means for the key that got it:
 *  - `invalid-key`, `expired`: the key is dead → mark it, try the next key;
 *  - `no-balance`, `plan-quota`: the key (account) is out → mark it until it recovers, try the next key;
 *  - `forbidden`: this key may not use this → try the next key, leave the key's status;
 *  - `rate-limit`: per organization or project → back off (DSH retries), next key only if the user allows;
 *  - `region`: the vendor refuses this network location → no key helps; say so;
 *  - `free-tier`: OpenCode's free models answer only inside the OpenCode app → no key helps; the model is withdrawn;
 *  - `paid-model`: Vercel's free tier does not serve this model → the model is withdrawn for now (credits lift it);
 *  - `moderation`, `bad-request`, `context`, `too-large`, `not-found`: the request itself → never switch keys;
 *  - `overloaded`, `server`, `transport`, `timeout`: transient → DSH retries.
 */
export const ROTATE_KINDS = Object.freeze(new Set(["invalid-key", "expired", "no-balance", "plan-quota", "forbidden"]));

/** The harness code each kind surfaces as. */
export const KIND_CODES = Object.freeze({
  "invalid-key": "INVALID_CREDENTIAL",
  expired: "INVALID_CREDENTIAL",
  forbidden: "INVALID_CREDENTIAL",
  region: "INVALID_REQUEST",
  "free-tier": "INVALID_REQUEST",
  "paid-model": "INVALID_REQUEST",
  "no-balance": "QUOTA",
  "plan-quota": "QUOTA",
  "rate-limit": "RATE_LIMIT",
  overloaded: "SERVER",
  server: "SERVER",
  moderation: "INVALID_REQUEST",
  "bad-request": "INVALID_REQUEST",
  context: "CONTEXT_WINDOW_EXCEEDED",
  // The body is over the vendor's size limit (HTTP 413): the adapter asks DSH to drop images or compact.
  "too-large": "CONTEXT_WINDOW_EXCEEDED",
  "not-found": "UNKNOWN_MODEL",
  transport: "TRANSPORT",
  timeout: "TIMEOUT",
});

/** A short Chinese label per kind (status chips, error text). */
export const KIND_LABELS = Object.freeze({
  "invalid-key": "Key 无效",
  expired: "无套餐或已过期",
  forbidden: "无权使用",
  region: "所在地区不受支持（需要代理）",
  "free-tier": "OpenCode 的免费模型只能在 OpenCode 客户端里使用（平台限制）",
  "paid-model": "免费层不能用这个模型（需购买额度）",
  "no-balance": "余额不足",
  "plan-quota": "额度用尽",
  "rate-limit": "被限流",
  overloaded: "服务繁忙",
  server: "服务端错误",
  moderation: "内容审核未通过",
  "bad-request": "请求参数错误",
  context: "超出上下文长度",
  "too-large": "请求体超过上限",
  "not-found": "模型不存在",
  transport: "网络错误",
  timeout: "超时",
});

/** Retry-After (seconds or an HTTP date) in ms. */
export function retryAfterMs(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}

/**
 * The parts of an error body every vendor's rules read: OpenAI
 * `{error:{type,code,message}}`, Anthropic `{type:"error",error:{type,message,details}}`,
 * Google `{error:{code,status,message,details:[{reason}…]}}`, OpenRouter
 * `{error:{code,message,metadata}}`, a Responses `error` event.
 */
export function errorParts(status, text) {
  const body = typeof text === "string" ? safeJson(text) : text;
  const error = isRecord(body?.error) ? body.error : isRecord(body) ? body : {};
  // xAI: `{ code: "<gRPC status text>", error: "<message>" }`.
  // Cloudflare: `{ success: false, errors: [{ code, message }] }`.
  const listed = Array.isArray(body?.errors) && isRecord(body.errors[0]) ? body.errors[0] : {};
  const message = String(error.message ?? body?.message ?? listed.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? (typeof text === "string" && !isRecord(body) ? text : "") ?? "");
  const details = Array.isArray(error.details) ? error.details : [];
  const reason = String(details.find((item) => isRecord(item) && item.reason)?.reason ?? "");
  const code = String(error.code ?? body?.code ?? error.details?.error_code ?? listed.code ?? "");
  const type = String(error.type ?? error.status ?? "");
  const retry = details.find((item) => isRecord(item) && /RetryInfo/.test(String(item["@type"])))?.retryDelay;
  const quotaIds = details.flatMap((item) => (Array.isArray(item?.violations) ? item.violations.map((violation) => String(violation?.quotaId ?? "")) : []));
  return {
    status,
    code,
    type,
    reason,
    message,
    limitSource: String(error.metadata?.limit_source ?? ""),
    errorCode: String(error.details?.error_code ?? ""),
    quotaIds,
    retryDelayMs: typeof retry === "string" && /^\d+(\.\d+)?s$/.test(retry) ? Math.round(Number.parseFloat(retry) * 1000) : undefined,
  };
}

const has = (pattern, ...values) => values.some((value) => pattern.test(String(value ?? "")));

/** "You will regain access on 2026-09-01 at 00:00 UTC." → ms. */
function regainAt(message) {
  const match = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))? ?UTC/i.exec(message);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2] ?? "00:00"}:00Z`);
  return Number.isFinite(at) ? at : undefined;
}

/** The next midnight in US Pacific time (Google's daily quotas reset then). */
function nextPacificMidnight(now = Date.now()) {
  const pacific = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = new Date(now).getTime() - pacific.getTime();
  const midnight = new Date(pacific);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() + offset;
}

/**
 * Classify one failed response.
 * @param {string} vendor - endpoint vendor.
 * @param {number} status - HTTP status (0 for transport; 200 for an error inside a stream).
 * @param {string | object} text - response body or error frame.
 * @param {object} [extra] - `{ plan, headers }`.
 * @returns `{ kind, code, message, vendorCode, retryAfterMs?, resetAt? }`.
 */
export function classifyFailure(vendor, status, text, { plan, headers } = {}) {
  const parts = errorParts(status, text);
  const { code, type, reason, message, limitSource, errorCode } = parts;
  let resetAt;
  const kind = (() => {
    // 0. Where the request comes from, not the key.
    if (has(/unsupported_country_region_territory|country, region, or territory not supported|not available in your (country|region)|User location is not supported/i, code, message)) return "region";
    if (vendor === "anthropic" && status === 403 && /request not allowed/i.test(message)) return "region";
    // 1. The request itself was refused: never a key problem.
    if (vendor === "openrouter" && status === 403 && /moderation|flagged/i.test(message)) return "moderation";
    if (has(/content_policy_violation|content_filter|invalid_prompt|responsible ai|safety system|flagged|PROHIBITED_CONTENT|SAFETY/i, code, type, reason) && status !== 401) return "moderation";
    // 2. The key is not accepted (or its project is gone).
    if (status === 401) return "invalid-key";
    if (has(/^(invalid_api_key|incorrect_api_key|authentication_error|invalid_authentication|unauthenticated)$/i, code, type)) return "invalid-key";
    if (has(/^(API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|ACCOUNT_STATE_INVALID|CONSUMER_SUSPENDED|API_KEY_EXPIRED)$/, reason)) return "invalid-key";
    if (has(/api key (not valid|expired)|invalid (api )?key|incorrect api key|invalid credential|has been suspended|organization has been disabled|key (is )?(blocked|disabled|revoked)/i, message)) return "invalid-key";
    // A suspended account or workspace (one suspended for its balance is read as such below).
    if ((has(/account_suspended|account_disabled/i, code, type) || has(/(account|workspace|organization).{0,40}(is|has been) suspended/i, message)) && !/balance|余额|欠费|arrear|recharge|quota|credit/i.test(message)) return "invalid-key";
    // Google words its rate limits like OpenAI's "no credits" ("You exceeded your current quota,
    // please check your plan and billing details"): read its quota ids instead. A daily quota
    // waits for midnight Pacific; a free-tier limit of 0 means the model needs billing.
    if (vendor === "gemini" && (status === 429 || type === "RESOURCE_EXHAUSTED")) {
      if (/limit: 0\b/.test(message)) return "no-balance";
      if (parts.quotaIds.some((id) => /PerDay/i.test(id))) {
        resetAt = nextPacificMidnight();
        return "plan-quota";
      }
      return "rate-limit";
    }
    // OpenCode Zen / Go name their account caps by type (as OpenCode's own client reads them).
    // Its gateway also keeps an upstream code as a "[code]" label: "Upstream request failed: [code] …".
    if (vendor === "opencode") {
      const label = /^[^:\n]+: \[([A-Za-z0-9_.-]+)\]/.exec(message)?.[1] ?? "";
      // Its free models answer only inside the OpenCode app (403 `FreeTierError`, with or without a key): no key helps.
      if (has(/^FreeTierError$/i, code, type, label) || has(/free tier can only be used from within OpenCode/i, message)) return "free-tier";
      if (has(/active OpenCode Go subscription is required|subscription is required/i, message)) return "expired";
      // A workspace setting, per model: "This Go model requires Global regions. Select Global in your workspace's Privacy settings".
      if (has(/requires Global regions|Select Global in your workspace/i, message)) return "forbidden";
      if (has(/^(GoUsageLimitError|FreeUsageLimitError|CreditLimitExceeded)$/i, code, type, label)) return "plan-quota";
      if (has(/^billing_error$/i, code, type, label)) return "no-balance";
      if (has(/^usage_not_included$/i, code, type, label)) return "forbidden";
    }
    // Cloudflare (live 2026-10-16): 1000 a bad token, 10000 a token without Workers AI, 7003 a wrong
    // account ("Could not route … object identifier is invalid") — and a model gone (5007, 5028, 7010).
    if (vendor === "cloudflare") {
      if (code === "1000" || code === "10000" || /Could not route|object identifier is invalid/i.test(message)) return "invalid-key";
      if (/daily free allocation|free allocation of [\d,]+ neurons|used up your daily/i.test(message)) {
        const now = new Date();
        resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        return "plan-quota";
      }
      if (/Workers Paid|paid plan/i.test(message)) return "forbidden";
      if (["5007", "5028", "7010"].includes(code) || /has been deprecated|No such model|Model not found/i.test(message)) return "not-found";
    }
    // Vercel AI Gateway (live 2026-10-17): its free tier serves a subset of models (403
    // `RestrictedModelsError` "Free tier users do not have access to this model", before inference;
    // an early-access model words it "requires an active Pro plan with purchased AI Gateway credits");
    // a budget caps a team, project, key or user (402 `quota_for_entity_exceeded`); free credits need a
    // payment method on file (403 `customer_verification_required`). Other 402s: no credits left.
    if (vendor === "vercel") {
      if (/free tier users do not have access|RestrictedModelsError|requires an active Pro plan|with purchased AI Gateway credits/i.test(message)) return "paid-model";
      if (has(/^quota_for_entity_exceeded$/i, code, type)) return "plan-quota";
      if (has(/^customer_verification_required$/i, code, type)) return "forbidden";
    }
    // OpenRouter's free models: so many a day per account, back at midnight UTC.
    if (vendor === "openrouter" && status === 429 && /free-models-per-day/i.test(message)) {
      const now = new Date();
      resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      return "plan-quota";
    }
    // 3. The account has no money.
    if (vendor === "openrouter" && status === 402) {
      if (limitSource === "openrouter_in_flight_budget") return "rate-limit";
      return limitSource === "openrouter_key_limit" ? "plan-quota" : "no-balance";
    }
    if (has(/^(insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active)$/i, code, type)) return "no-balance";
    // xAI: "Your newly created team doesn't have any credits yet. You can purchase credits on …".
    if (has(/credit balance is too low|no credits remaining|insufficient (account )?(balance|credits|funds)|used all available credits|out of credits|exceeded your current quota|add credits|billing (details|hard limit)|payment required|(does not|doesn't|do not|don't) have any credits|purchase credits|exhausted (its|your|their) credits/i, message)) return "no-balance";
    if (status === 402) return "no-balance";
    // 4. A spend cap or plan window is used up (often with a date).
    if (errorCode === "enforced_spend_limit_reached" || has(/reached your (specified )?(workspace )?API usage limits|monthly (spending|spend) limit|spending limit/i, message)) {
      resetAt = regainAt(message);
      return "plan-quota";
    }
    if (vendor === "opencode" && plan && status === 429 && /limit|quota|subscription/i.test(message)) return "plan-quota";
    if (has(/subscription (has )?(expired|is not active|inactive)|no active (subscription|plan)|does not have (an active )?subscription/i, message)) return "expired";
    // 5. Too fast right now.
    if (has(/rate_limit|rate limit|too many requests|RESOURCE_EXHAUSTED|requests per (minute|day)|tokens per minute/i, code, type, message)) return "rate-limit";
    if (status === 429) return "rate-limit";
    // 6. The request does not fit: its bytes (413), then its tokens.
    if (status === 413 || has(/request body is too large|request body too large|payload too large|request entity too large|request_too_large|body size limit|failed to buffer the request body/i, code, type, message)) return "too-large";
    if (has(/context_length_exceeded|context.?(length|window)|maximum context|prompt is too long|too many tokens|exceeds the maximum number of tokens|input token count/i, code, message)) return "context";
    if (status === 404 || has(/model_not_found|not_found_error|does not exist|no such model|unknown model|NOT_FOUND|is not found for API version/i, code, type, message)) return "not-found";
    if (status === 403) return "forbidden";
    if (status === 529 || status === 503 || has(/overloaded|capacity|UNAVAILABLE|temporarily unavailable/i, type, message)) return "overloaded";
    if (status === 400 || status === 422) return "bad-request";
    if (status === 0) return "transport";
    return "server";
  })();
  const after = retryAfterMs(headers) ?? parts.retryDelayMs;
  return {
    kind,
    code: KIND_CODES[kind],
    message: message || `HTTP ${status}`,
    vendorCode: code || reason || null,
    ...(after ? { retryAfterMs: after } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}
