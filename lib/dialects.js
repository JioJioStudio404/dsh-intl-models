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
  // OpenAI Responses: a failed stream says why in `response.error` (`{ type: "response.failed", response: { error } }`).
  const error = isRecord(body?.error) ? body.error : isRecord(body?.response?.error) ? body.response.error : isRecord(body) ? body : {};
  // xAI: `{ code: "<gRPC status text>", error: "<message>" }`.
  // Cloudflare: `{ success: false, errors: [{ code, message }] }`.
  const listed = Array.isArray(body?.errors) && isRecord(body.errors[0]) ? body.errors[0] : {};
  // DeepInfra and NVIDIA: `{ detail }` (NVIDIA's beside `{ status, title }`), DeepInfra's sometimes `{ detail: { error } }`.
  const detail = typeof body?.detail === "string" ? body.detail : isRecord(body?.detail) ? body.detail.error ?? body.detail.message : undefined;
  const message = String(error.message ?? body?.message ?? listed.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? detail ?? (typeof text === "string" && !isRecord(body) ? text : "") ?? "");
  const details = Array.isArray(error.details) ? error.details : [];
  // Novita: `{ code, reason, message }`.
  const reason = String(details.find((item) => isRecord(item) && item.reason)?.reason ?? (typeof body?.reason === "string" ? body.reason : ""));
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
    // When a budget's window rolls over: OpenRouter's `metadata.resets_at`, OpenCode's `metadata.resetsAt` (ISO).
    resetsAt: String(error.metadata?.resets_at ?? error.metadata?.resetsAt ?? ""),
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

/** An ISO time still ahead, in ms; undefined for anything else (a past time, null, words). */
function ahead(value) {
  const at = Date.parse(String(value ?? ""));
  return Number.isFinite(at) && at > Date.now() ? at : undefined;
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
/**
 * Wordings vendors and relays use beyond the English ones (magpie's collection, 2026-11):
 * - the conversation too long: "内容太长了，请精简输入或开启新对话" (a relay at ~730K of a 1M model),
 *   z.ai's "Prompt 超长", iFlytek's "…字数太多，需要精简输入", "输入长度超过限制". Not a field's length
 *   ("超出最大长度"), a daily allowance ("token数量超过上限"), an output ("输出过长");
 * - its pace: "请求过于频繁", "频率过高", "限流", "并发数过高", "请稍后重试";
 * - a provider busy for now, even under a 400: "Concurrency limit exceeded for account, please retry later".
 * Money and quota wordings are read before these.
 */
const CJK_TOO_LONG = /内容太长|Prompt ?超长|(输入|上下文|内容|提示词?)(长度)?(超长|超过(限制|上限|最大))|字数太多|请精简输入/i;
const PACE_WORDS = /请求(过于|太)?频繁|过于频繁|频率过高|访问频率|速率(限制|超限|过高)|限流|并发(数|请求)?(过高|超限|超过|上限|限制)|稍后(再试|重试)/;
const BUSY_WORDS = /concurrency limit|too many (pending|concurrent|in-?flight) requests|retry later|服务繁忙|系统繁忙/i;
/** Money or quota named beside pace words ("用户额度不足，请稍后重试"): never a pace refusal. */
const MONEY_WORDS = /余额|欠费|额度|充值|quota|credit|balance|billing/i;
const paced = (message) => PACE_WORDS.test(message) && !MONEY_WORDS.test(message);
const busy = (message) => BUSY_WORDS.test(message) && !MONEY_WORDS.test(message);

/**
 * A refusal of reasoning this request replayed — an Anthropic thinking signature, OpenAI / xAI sealed
 * reasoning, a Gemini thought signature — made by another account or conversation (another key took
 * over). magpie's collection, 2026-11: "Invalid signature in thinking block. The block is bound to a
 * different conversation", "invalid_encrypted_content", Azure's "invalid encrypted summary", xAI's
 * "Could not decode the compaction blob". The request is sent again without it.
 */
export const REPLAY_REFUSED = /invalid `?signature`? in `?thinking`? block|bound to a different conversation|not created in this conversation|invalid data in `?redacted_thinking`? block|invalid_encrypted_content|invalid[ _]encrypted[ _](summary|content)|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content|could not (decode|decrypt).{0,20}compaction[ _]blob|thought[ _]signature.{0,40}(invalid|not valid)|invalid.{0,20}thought[ _]signature|item with id '?rs_[\w-]+'? not found/i;

/** The fields any API error names, in its body or its error object: a JSON object with none of them says nothing of why. */
const ERROR_FIELDS = ["error", "message", "msg", "code", "type", "param", "detail", "reason", "description"];
const bareBody = (text) => {
  const body = typeof text === "string" ? safeJson(text.trim()) : text;
  return isRecord(body) && !ERROR_FIELDS.some((field) => field in body);
};

/**
 * The output a credit balance still covers, when the refusal says so: OpenRouter's 402 "This request requires
 * more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1234" — the
 * request's size, not a balance at 0. Undefined otherwise.
 */
export function affordableOutput(text) {
  const match = /fewer max_tokens[\s\S]{0,120}?can only afford (\d+)|can only afford (\d+)/i.exec(String(text ?? ""));
  return match ? Number(match[1] ?? match[2]) : undefined;
}
/** The smallest output worth asking again with (DSH's own floor for a reply): below it the balance is spent. */
export const AFFORD_MIN = 4096;

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
    // OpenAI: the project's or organization's IP allowlist (401 "Your request IP does not match the configured IP
    // allowlist for your project or organization", error codes 2026-11) — where the request comes from, not a bad
    // key (another project's key may pass).
    if (has(/IP allowlist|ip_not_authorized|IP not authorized/i, code, message)) return "forbidden";
    // OpenAI's enforced spend limits and the usage limit it assigns (429 `organization_spend_limit_exceeded`,
    // `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`; error codes 2026-11): used up until the
    // limit is raised or the monthly cycle turns, never a pace — by code, also when the type says
    // `insufficient_quota` and inside a stream.
    if (has(/^(organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded)$/i, code)) return "plan-quota";
    // Groq: an organization's spend limit reached (400 `blocked_api_access` for every key of it; back on the 1st of
    // the month, spend-limits 2026-11).
    if (vendor === "groq" && has(/^blocked_api_access$/i, code, type)) return "plan-quota";
    // OpenRouter: a budget spent — a guardrail's, a workspace's, the key's own (403 before any provider, or 402;
    // `metadata.limit_source`, `metadata.resets_at`; errors 2026-11). A null reset is a lifetime budget.
    if (vendor === "openrouter" && (status === 402 || status === 403) && /^openrouter_(guardrail_budget|workspace_budget|key_limit)$/.test(limitSource)) {
      resetAt = ahead(parts.resetsAt);
      return "plan-quota";
    }
    // 2. The key is not accepted (or its project is gone).
    if (status === 401) return "invalid-key";
    // NVIDIA answers a wrong key 403 { title: "Forbidden", detail: "Authorization failed" }.
    if (vendor === "nvidia" && status === 403 && /authoriz|unauthenticated|invalid (api )?key/i.test(message)) return "invalid-key";
    // Novita names its refusals: INVALID_API_KEY / FAILED_TO_AUTH, NOT_ENOUGH_BALANCE.
    if (vendor === "novita") {
      if (/^(INVALID_API_KEY|FAILED_TO_AUTH|API_KEY_NOT_FOUND)$/i.test(reason)) return "invalid-key";
      if (/BALANCE|CREDIT/i.test(reason)) return "no-balance";
    }
    // Hugging Face: a PRO account's monthly included credits are a window ("exceeded your monthly included
    // credits for Inference Providers"); without a payment method nothing goes on until the next month.
    if (vendor === "huggingface" && /monthly included credits|included credits/i.test(message)) return "plan-quota";
    // Groq's free tier caps a model's tokens or requests a day (TPD, RPD): "… Please try again in 7m12.5s".
    if (vendor === "groq" && status === 429 && /per day \((TPD|RPD)\)/i.test(message)) {
      const wait = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
      const ms = wait ? ((Number(wait[1]) || 0) * 3600 + (Number(wait[2]) || 0) * 60 + (Number(wait[3]) || 0)) * 1000 : 0;
      if (ms > 0) resetAt = Date.now() + ms;
      return "plan-quota";
    }
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
      // A billing account's tier spend cap ("Your project has exceeded its monthly spending cap": paused until the
      // next billing cycle, caps reset on the 1st) and prepaid credits used up ("Your prepayment credits are
      // depleted"): money, not a pace (wordings from Google's forum, 2026-11).
      if (/spending cap/i.test(message)) return "plan-quota";
      if (/prepayment credits? (are|is|have been) (depleted|exhausted|used up)|prepaid credits? (are|is|have been) (depleted|exhausted|used up)/i.test(message)) return "no-balance";
      if (parts.quotaIds.some((id) => /PerDay/i.test(id))) {
        resetAt = nextPacificMidnight();
        return "plan-quota";
      }
      return "rate-limit";
    }
    // OpenCode Zen / Go name their account caps by type (as OpenCode's own client reads them).
    // Its gateway also keeps an upstream code as a "[code]" label: "Upstream request failed: [code] …".
    if (vendor === "opencode") {
      // A 400 that is no error at all, `{"model":"deepseek-v4.1-flash"}` (magpie #3740: several over some
      // seconds at a turn's start, then the same request served): the gateway's moment, retried, no key blamed.
      if (status === 400 && bareBody(text)) return "overloaded";
      const label = /^[^:\n]+: \[([A-Za-z0-9_.-]+)\]/.exec(message)?.[1] ?? "";
      // Its free models answer only inside the OpenCode app (403 `FreeTierError`, with or without a key): no key helps.
      if (has(/^FreeTierError$/i, code, type, label) || has(/free tier can only be used from within OpenCode/i, message)) return "free-tier";
      if (has(/active OpenCode Go subscription is required|subscription is required/i, message)) return "expired";
      // A workspace setting, per model: "This Go model requires Global regions. Select Global in your workspace's Privacy settings".
      if (has(/requires Global regions|Select Global in your workspace/i, message)) return "forbidden";
      if (has(/^(GoUsageLimitError|FreeUsageLimitError|CreditLimitExceeded)$/i, code, type, label)) return "plan-quota";
      // A workspace's budget policy reached (429 `BudgetLimitError` "A budget policy for this model has been
      // reached", `metadata.resetsAt`; in Google's envelope as `details[].reason`) or the account's ("Account budget
      // exceeded"): as OpenCode's own client reads them (anomalyco/opencode provider-error.ts, 2026-11).
      if (has(/^BudgetLimitError$/i, code, type, label, reason) || /account budget exceeded|budget policy .{0,40}reached/i.test(message)) {
        resetAt = ahead(parts.resetsAt);
        return "plan-quota";
      }
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
    // Chinese relays in front of these vendors (one-api, new-api): "用户额度不足", "余额不足", "账户欠费".
    if (/(余额|额度)(不足|已用完|用尽)|欠费/.test(message)) return "no-balance";
    if (status === 402) return "no-balance";
    // 4. A spend cap or plan window is used up (often with a date).
    if (errorCode === "enforced_spend_limit_reached" || has(/reached your (specified )?(workspace )?API usage limits|monthly (spending|spend) limit|spending limit/i, message)) {
      resetAt = regainAt(message);
      return "plan-quota";
    }
    if (vendor === "opencode" && plan && status === 429 && /limit|quota|subscription/i.test(message)) return "plan-quota";
    if (has(/subscription (has )?(expired|is not active|inactive)|no active (subscription|plan)|does not have (an active )?subscription/i, message)) return "expired";
    // A stream's error frame names no status: a quota or key limit used up, said in words ("quota exhausted for this
    // plan window", OpenRouter's "Key limit exceeded (daily limit)"), is the key's window, not the server's.
    if (has(/quota.{0,12}(exceeded|exhausted|reached|insufficient)|usage limit (reached|exceeded)|key limit exceeded|额度.{0,6}(用尽|上限|不足)|用量上限/i, message)) return "plan-quota";
    // 5. Too fast right now.
    if (has(/rate_limit|rate limit|too many requests|RESOURCE_EXHAUSTED|requests per (minute|day)|tokens per minute/i, code, type, message) || paced(message)) return "rate-limit";
    if (status === 429) return "rate-limit";
    // 6. The request does not fit: its bytes (413), then its tokens.
    if (status === 413 || has(/request body is too large|request body too large|payload too large|request entity too large|request_too_large|body size limit|failed to buffer the request body|请求体(过大|太大)/i, code, type, message)) return "too-large";
    if (has(/context_length_exceeded|context.?(length|window)|maximum context|prompt is too long|too many tokens|exceeds the maximum number of tokens|input token count/i, code, message) || CJK_TOO_LONG.test(message)) return "context";
    // 410: a model retired (NVIDIA's "Gone", live 2026-11-04), no retry brings it back.
    if (status === 404 || status === 410 || has(/model_not_found|not_found_error|does not exist|no such model|unknown model|NOT_FOUND|is not found for API version/i, code, type, message)) return "not-found";
    if (status === 403) return "forbidden";
    if (status === 529 || status === 503 || has(/overloaded|capacity|UNAVAILABLE|temporarily unavailable/i, type, message) || busy(message)) return "overloaded";
    if (status === 400 || status === 422) return "bad-request";
    if (status === 0) return "transport";
    return "server";
  })();
  const after = retryAfterMs(headers) ?? parts.retryDelayMs;
  // A used-up window the vendor says the end of only in Retry-After (OpenCode's GoUsageLimitError, a month out): the
  // key is held until then, not for a guessed hour.
  if (kind === "plan-quota" && !resetAt && after) resetAt = Date.now() + after;
  return {
    kind,
    code: KIND_CODES[kind],
    message: message || `HTTP ${status}`,
    vendorCode: code || reason || null,
    ...(after ? { retryAfterMs: after } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}
