/**
 * Errors the harness can classify without importing `@deepseek-ai/dsh-llm`.
 *
 * `normalizeLlmFailure` trusts a thrown error's own data properties when its
 * `code` and `failure.code` agree, so the code survives the package boundary
 * and the harness retry policy sees it (it retries RATE_LIMIT, SERVER,
 * TIMEOUT, TRANSPORT and EMPTY_RESPONSE by default).
 *
 * @module dsh-intl-models/errors
 */

/** Stable failure codes, matching the harness taxonomy. */
export const CODES = Object.freeze({
  quota: "QUOTA",
  rateLimit: "RATE_LIMIT",
  server: "SERVER",
  timeout: "TIMEOUT",
  transport: "TRANSPORT",
  empty: "EMPTY_RESPONSE",
  auth: "INVALID_CREDENTIAL",
  missing: "MISSING_CREDENTIAL",
  context: "CONTEXT_WINDOW_EXCEEDED",
  badRequest: "INVALID_REQUEST",
  unknownModel: "UNKNOWN_MODEL",
  aborted: "ABORTED",
  malformed: "MALFORMED_RESPONSE",
});

/**
 * Redact anything key-shaped before it is logged or shown: `sk-…` keys of
 * every vendor (`sk-proj-`, `sk-ant-`, `sk-or-v1-`, legacy `sk-`), `xai-…`,
 * Google's `AIza…` and `AQ.…`, Cloudflare's `cfut_…` / `cfat_…`, Vercel's
 * `vck_…`, bearer headers, `?key=` in URLs.
 */
export function redact(text) {
  return String(text ?? "")
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._~+/=-]{12,}/g, "[redacted-key]")
    .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
    .replace(/\bAQ\.[0-9A-Za-z_.-]{16,}/g, "[redacted-key]")
    // Cloudflare's API tokens (`cfut_` / `cfat_`), Vercel's AI Gateway keys (`vck_`).
    .replace(/\b(?:cf[ua]t|vck)_[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    // OpenAI echoes a rejected key as `sk-proj-****…****RkgA`: keep the message short.
    .replace(/\*{8,}/g, "…")
    .replace(/("?(?:api[_-]?key|authorization|x-api-key|x-goog-api-key|key)"?\s*[:=]\s*")[^"]*(")/gi, "$1[redacted]$2");
}

/**
 * Build a classifiable error.
 * @param {string} code - one of {@link CODES}.
 * @param {string} message - user-facing message (redacted here).
 * @param {object} [extra] - `status`, `retryAfterMs`, `kind`, `keyId`, `endpoint`, `resetAt`, `vendorCode`.
 * @returns the error.
 */
export function cnError(code, message, extra = {}) {
  const text = redact(message).slice(0, 900) || "request failed";
  const error = new Error(text);
  error.name = "IntlModelsError";
  const failure = { message: text, code };
  if (Number.isInteger(extra.status) && extra.status >= 100 && extra.status <= 599) failure.status = extra.status;
  if (Number.isFinite(extra.retryAfterMs) && extra.retryAfterMs > 0) failure.providerRetryAfterMs = Math.round(extra.retryAfterMs);
  if (typeof extra.requestId === "string" && extra.requestId) failure.requestId = extra.requestId;
  Object.defineProperty(error, "code", { value: code, enumerable: true, writable: false });
  Object.defineProperty(error, "failure", { value: Object.freeze(failure), enumerable: true, writable: false });
  for (const key of ["status", "kind", "keyId", "endpoint", "resetAt", "vendorCode"]) {
    if (extra[key] !== undefined) Object.defineProperty(error, key, { value: extra[key], enumerable: true });
  }
  return error;
}

/** Whether a value is a plain object. */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
export function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** JSON.parse without throwing. */
export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A finite number from a number or numeric string, or undefined. */
export function asNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}
