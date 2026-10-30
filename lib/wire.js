/**
 * HTTP to the vendors: JSON calls, the streaming call, and its SSE frames.
 *
 * Three ways to present a key: `bearer` (`Authorization: Bearer …` — OpenAI,
 * xAI, OpenRouter, OpenCode), `anthropic` (`x-api-key` plus
 * `anthropic-version`), `gemini` (`x-goog-api-key`, never in the URL). Every
 * request carries a real User-Agent naming DeepSeek Harness and this plugin.
 * Plain `fetch` is used throughout, so DSH's proxy (HTTPS_PROXY in the
 * environment or `$DSH_HOME/.env`) applies.
 *
 * @module dsh-intl-models/wire
 */
import { cnError, CODES, safeJson } from "./errors.js";

export const VERSION = "0.4.2";
export const USER_AGENT = `deepseek-harness dsh-intl-models/${VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`;
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

/**
 * One JSON request. Never throws on an HTTP error: the caller classifies it.
 * @returns `{ status, ok, body, text, headers }`; status 0 for a transport failure.
 */
export async function requestJson(url, key, { method = "GET", body, auth = "bearer", headers, signal, timeoutMs = JSON_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: headersFor(key, { auth, json: body !== undefined, extra: headers }),
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const response = await fetchImpl(url, {
      method: "POST",
      headers: headersFor(key, { auth, json: true, accept: "text/event-stream", extra: headers }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) {
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
