/**
 * What every protocol's request builder shares: text cleanup, images, tool
 * schemas, call ids, history normalization, and this plugin's replay state.
 *
 * Replay: a turn this plugin produced keeps, per content block, what the
 * vendor needs back on the next request — an OpenAI reasoning item (with its
 * encrypted content), an Anthropic thinking signature or redacted payload, a
 * Gemini thought signature, a message or function-call item id. It is replayed
 * only to the same endpoint, protocol and model; another provider's reasoning
 * never passes as this one's (it is dropped, its text and tool calls stay).
 *
 * @module dsh-intl-models/request
 */
import { createHash } from "node:crypto";
import { cnError, CODES, isRecord } from "./errors.js";

export const REPLAY_KIND = "intl-models";
export const REPLAY_VERSION = 1;

/** Strip lone surrogates (they break JSON on some vendors) and NULs. */
export const clean = (text) => String(text ?? "").replace(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�").replace(/\u0000/g, "");

/** The text of a content list (or a string). */
export function textOf(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

/**
 * Clamp an image to the request budget without importing the attachment
 * package; the adapter reports the same target (`imageRequestTarget`).
 */
export function requestTarget(ref, maxPixels = 2048 * 2048, maxBytes = 5 * 1024 * 1024) {
  const width = Number(ref?.width) || 2048;
  const height = Number(ref?.height) || 2048;
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), maxBytes };
}

/**
 * A stable id for the conversation a request belongs to: the harness's own
 * session id, else a hash of the conversation's start (the system prompt and
 * the first message), which stays the same turn after turn.
 */
export function sessionIdOf(options) {
  if (typeof options?.sessionId === "string" && options.sessionId.trim()) return options.sessionId.trim().slice(0, 128);
  const first = (Array.isArray(options?.messages) ? options.messages : []).find((message) => message?.role === "user");
  const seed = `${typeof options?.system === "string" ? options.system : textOf(options?.system)}\n${textOf(first?.content)}`;
  return `dsh-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

/** A call id every vendor accepts (`^[A-Za-z0-9_-]{1,64}$`), stable per input. */
export function callIdFor(id) {
  const safe = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
  return safe || "call_0";
}

/** JSON Schema cleanup: no meta declarations (`$schema`, `$id`, `$defs`…), which several vendors reject. */
export function sanitizeSchema(schema) {
  const META = new Set(["$schema", "$id", "$anchor", "$comment", "$vocabulary", "$dynamicAnchor"]);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) if (!META.has(key)) out[key] = walk(value);
    return out;
  };
  const root = walk(isRecord(schema) ? schema : { type: "object", properties: {} });
  if (root.type === undefined) root.type = "object";
  if (root.type === "object" && !isRecord(root.properties)) root.properties = {};
  return root;
}

/** Harness tool list (`[{ name, description, parameters }]`), or undefined when empty. */
export const toolList = (tools) => (Array.isArray(tools) && tools.length ? tools.filter((tool) => typeof tool?.name === "string" && tool.name) : undefined);

/**
 * Load one image block for a request.
 * @returns `{ mediaType, data }` (base64), or `{ placeholder }` when it cannot or must not be sent.
 */
export async function loadImage(block, { model, attachments, signal }) {
  const ref = block?.attachment;
  if (!model?.image) return { placeholder: "[an image was attached; this model does not take images]" };
  if (block.offloaded === true || !ref) return { placeholder: `[image ${ref?.attachmentId ?? ""} offloaded]` };
  if (typeof attachments?.readImageRequest !== "function") throw cnError(CODES.badRequest, "image input needs the DSH attachment service");
  const version = await attachments.readImageRequest(ref, requestTarget(ref), signal);
  return { mediaType: version.mediaType ?? ref.mediaType ?? "image/png", data: Buffer.from(version.data).toString("base64") };
}

/** The tool-call arguments of a harness block as an object (malformed JSON reads as `{}`). */
export function argumentsOf(block) {
  if (isRecord(block?.arguments)) return block.arguments;
  try {
    const parsed = JSON.parse(String(block?.arguments ?? "{}"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The tool-call arguments of a harness block as a JSON string. */
export const argumentsText = (block) => JSON.stringify(argumentsOf(block));

/**
 * This plugin's replay entries for an assistant message, when it came from the
 * same endpoint, protocol and model; else undefined.
 */
export function replayOf(message, { endpoint, protocol, model }) {
  const state = message?.source?.replayState;
  if (!isRecord(state) || !isRecord(state.response) || state.response.kind !== REPLAY_KIND || state.response.version !== REPLAY_VERSION) return undefined;
  const response = state.response;
  if (response.endpoint !== endpoint || response.protocol !== protocol || response.model !== model) return undefined;
  return Array.isArray(state.blocks) ? state.blocks : [];
}

/** The replay envelope one finished response carries. */
export function replayState(meta, blocks, extra = {}) {
  return {
    response: { kind: REPLAY_KIND, version: REPLAY_VERSION, endpoint: meta.endpoint, protocol: meta.protocol, model: meta.model, ...(meta.keyId ? { keyId: meta.keyId } : {}), ...extra },
    blocks,
  };
}

/**
 * The history every protocol converts: system text gathered, `developer`
 * notes kept in place (they read as user notes), and every tool call answered —
 * a call with no result (an interrupted turn) gets an error result, since
 * OpenAI and Anthropic reject an unanswered call.
 * @returns `{ system, messages, toolNames }` (`toolNames`: call id → tool name).
 */
export function normalizeHistory(options) {
  const system = [];
  if (typeof options.system === "string" && options.system.trim()) system.push(clean(options.system));
  const messages = [];
  const toolNames = new Map();
  let open = [];
  const answered = new Set();
  const closeOpen = () => {
    for (const call of open) {
      if (!answered.has(call.id)) messages.push({ role: "tool", toolCallId: call.id, content: [{ type: "text", text: "No result provided" }], isError: true });
    }
    open = [];
    answered.clear();
  };
  for (const message of options.messages ?? []) {
    if (message?.role === "system") {
      const text = textOf(message.content);
      if (text) system.push(clean(text));
      continue;
    }
    if (message?.role === "tool") {
      answered.add(message.toolCallId);
      messages.push(message);
      continue;
    }
    closeOpen();
    if (message?.role === "assistant") {
      const calls = (Array.isArray(message.content) ? message.content : []).filter((block) => block?.type === "tool-call");
      for (const call of calls) toolNames.set(call.id, call.name);
      open = calls;
    }
    messages.push(message);
  }
  closeOpen();
  return { system: system.join("\n\n"), messages, toolNames };
}
