/**
 * HTTP to the vendors: JSON calls, the streaming call, and its SSE frames.
 *
 * Three ways to present a key: `bearer` (`Authorization: Bearer …` — OpenAI,
 * xAI, OpenRouter, OpenCode), `anthropic` (`x-api-key` plus
 * `anthropic-version`), `gemini` (`x-goog-api-key`, never in the URL). Every
 * request names DeepSeek Harness the way DSH's own adapters do — its product
 * token with its version (`deepseek-harness/<version>`), then this plugin's —
 * and nothing else: the plugin never presents itself as another client.
 * Redirects are followed within the vendor's origin only: Node's fetch drops
 * `Authorization` on a redirect elsewhere but keeps `x-api-key` and
 * `x-goog-api-key`.
 * Plain `fetch` is used throughout, so DSH's proxy (HTTPS_PROXY in the
 * environment or `$DSH_HOME/.env`) applies.
 *
 * @module dsh-intl-models/wire
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { cnError, CODES, jsonText, safeJson } from "./errors.js";

export const VERSION = "0.4.5";

/**
 * DeepSeek Harness's own version — its LLM package's, the one DSH's adapters name — read where the host process
 * resolves it: from its entry (the desktop host, the CLI), else from its working directory (the profile). Null
 * outside DSH (a test).
 */
export function harnessVersion({ argv = process.argv, cwd = process.cwd() } = {}) {
  for (const from of [argv?.[1], join(cwd, "package.json")]) {
    if (typeof from !== "string" || !from) continue;
    try {
      const version = createRequire(from)("@deepseek-ai/dsh-llm/package.json")?.version;
      if (typeof version === "string" && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version)) return version;
    } catch {
      /* not resolvable from there */
    }
  }
  return null;
}

/** The version named when the host's cannot be read: the oldest DeepSeek Harness this plugin runs on (my choice). */
const HARNESS_FALLBACK = "0.2.2";
export const HARNESS_VERSION = harnessVersion() ?? HARNESS_FALLBACK;
export const USER_AGENT = `deepseek-harness/${HARNESS_VERSION} dsh-intl-models/${VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`;
export const ANTHROPIC_VERSION = "2023-06-01";

/** Default wait for a JSON call. */
const JSON_TIMEOUT_MS = 20_000;

/** The headers that present a key. */
export function authHeaders(key, auth = "bearer") {
  if (auth === "anthropic") return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  if (auth === "gemini") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

/** Request headers for one key. */
export function headersFor(key, { auth = "bearer", accept = "application/json", json = false, extra } = {}) {
  return {
    ...authHeaders(key, auth),
    "user-agent": USER_AGENT,
    accept,
    ...(json ? { "content-type": "application/json" } : {}),
    ...extra,
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Redirects followed within one origin at most. */
const MAX_REDIRECTS = 5;

/** The answer that stands for a redirect not followed: the site's status, a body saying why. */
function refusedRedirect(response, target) {
  const message = target
    ? `站点将请求重定向至其他来源（${target}）；为避免密钥随请求发往该来源，未跟随该重定向`
    : "站点的重定向未被跟随（次数过多，或请求内容无法重发）";
  return new Response(JSON.stringify({ error: { message, type: "redirect_refused" } }), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "application/json" },
  });
}

/**
 * fetch that follows a redirect only within the request's origin (scheme, host and port). The headers that present a
 * key go with every hop that is followed — Node's fetch drops `Authorization` on a cross-origin redirect but keeps
 * `x-api-key` and a site's own headers — so a redirect to another origin, or from HTTPS to HTTP, is not followed: it
 * comes back as the site's answer with its status, its body saying why. The same host from HTTP to HTTPS is followed
 * (an upgrade: the key stays with the host). 307 and 308 repeat the request as it was;
 * 303, and 301 / 302 after a POST, continue with a GET (as fetch does). A body that is not text (a stream) is not
 * sent twice.
 * @param {Function} fetchImpl - the fetch to call (DSH's proxy applies to the global one).
 */
export async function fetchSameOrigin(fetchImpl, url, init = {}) {
  let current = String(url);
  let method = String(init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, { ...init, method, body, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.("location") : null;
    if (!location) return response;
    let target;
    try {
      target = new URL(location, current);
    } catch {
      return response;
    }
    try {
      await response.body?.cancel();
    } catch {
      /* nothing to drain */
    }
    const from = new URL(current);
    // The same origin, or the same host moving from HTTP to HTTPS (the key stays with the host, now encrypted; my choice).
    const upgrade = from.protocol === "http:" && target.protocol === "https:" && from.hostname === target.hostname;
    if (target.origin !== from.origin && !upgrade) return refusedRedirect(response, target.origin);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    const replayable = body === undefined || body === null || typeof body === "string";
    if (hop >= MAX_REDIRECTS || !replayable) return refusedRedirect(response, null);
    current = target.href;
  }
}

/**
 * One JSON request. Never throws on an HTTP error: the caller classifies it.
 * @returns `{ status, ok, body, text, headers }`; status 0 for a transport failure.
 */
export async function requestJson(url, key, { method = "GET", body, auth = "bearer", headers, signal, timeoutMs = JSON_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchSameOrigin(fetchImpl, url, {
      method,
      headers: headersFor(key, { auth, json: body !== undefined, extra: headers }),
      body: body === undefined ? undefined : jsonText(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, body: safeJson(text), text, headers: response.headers };
  } catch (error) {
    if (signal?.aborted) throw cnError(CODES.aborted, "request aborted");
    const timedOut = timeout.aborted;
    return { status: 0, ok: false, body: undefined, text: timedOut ? "timed out" : String(error?.cause?.code ?? error?.message ?? error), headers: undefined, timedOut };
  }
}

/**
 * The status a JSON error body stands for (one a vendor sent with a 2xx), or null when the body is no error: the
 * status it names (`error.http_code`, `error.code`, `status` in 400–599), else 200 — the classifier reads its
 * code and words either way.
 */
export function jsonErrorStatus(text) {
  const body = safeJson(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = body.error;
  const base = Number(body.base_resp?.status_code);
  const failed = (error && (typeof error === "object" || typeof error === "string")) || body.type === "error" || (Number.isFinite(base) && base !== 0) || body.success === false;
  if (!failed) return null;
  const named = Number(error?.http_code ?? error?.status ?? error?.code ?? body.status);
  return Number.isInteger(named) && named >= 400 && named <= 599 ? named : 200;
}

/**
 * Open a streaming call. An idle stream (no byte for `idleMs`) is cut, so a
 * stalled connection fails as TIMEOUT instead of hanging the turn.
 * @returns `{ response, idle }` on 2xx (`idle.touch()` on every chunk), or `{ status, text, headers }` on failure.
 */
export async function openStream(url, key, body, { auth = "bearer", headers, signal, fetchImpl = fetch, connectTimeoutMs = 120_000, idleMs = 600_000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  let timer = setTimeout(() => controller.abort(new Error("connect timeout")), connectTimeoutMs);
  const idle = {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error("idle timeout")), idleMs);
    },
    stop() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    },
    get timedOut() {
      return controller.signal.aborted && !signal?.aborted;
    },
  };
  try {
    const response = await fetchSameOrigin(fetchImpl, url, {
      method: "POST",
      headers: headersFor(key, { auth, json: true, accept: "text/event-stream", extra: headers }),
      body: jsonText(body),
      signal: controller.signal,
    });
    if (response.ok) {
      // A 2xx that is no stream but a JSON error (a vendor refusing so: MiniMax's `base_resp`, an error envelope): the
      // refusal it is — classified, a key switched where it says so — not an empty answer losing the vendor's words.
      const type = response.headers?.get?.("content-type") ?? "";
      if (/json/i.test(type) && !/event-stream/i.test(type)) {
        const text = await response.text();
        const status = jsonErrorStatus(text);
        if (status !== null) {
          idle.stop();
          return { status, text, headers: response.headers };
        }
        idle.touch();
        return { response: new Response(text, { status: response.status, headers: response.headers }), idle };
      }
      idle.touch();
      return { response, idle };
    }
    const text = await response.text();
    idle.stop();
    return { status: response.status, text, headers: response.headers };
  } catch (error) {
    idle.stop();
    if (signal?.aborted) throw cnError(CODES.aborted, "request aborted by the caller");
    if (controller.signal.aborted) throw cnError(CODES.timeout, "the vendor did not answer in time");
    return { status: 0, text: String(error?.cause?.code ?? error?.message ?? error), headers: undefined };
  }
}

/**
 * SSE `data:` payloads of a response. `event:` lines are skipped — every
 * vendor repeats the event name as the payload's `type` — and so are comments
 * (keep-alives), which still count as activity.
 */
export async function* ssePayloads(response, idle) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending = [];
  const flush = function* () {
    if (pending.length) yield pending.join("\n");
    pending = [];
  };
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (idle?.timedOut) throw cnError(CODES.timeout, "the vendor stopped sending (idle timeout)");
        throw cnError(CODES.transport, `the stream broke: ${error?.message ?? error}`);
      }
      if (chunk.done) break;
      idle?.touch();
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") yield* flush();
        else if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          if (data === "[DONE]") return;
          pending.push(data);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) {
      const data = buffer.slice(5).trimStart();
      if (data !== "[DONE]") pending.push(data);
    }
    yield* flush();
  } finally {
    idle?.stop();
    reader.releaseLock?.();
  }
}
