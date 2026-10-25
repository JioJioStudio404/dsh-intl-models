/**
 * OpenAI Responses: OpenAI, xAI, and OpenCode's GPT / Grok models.
 *
 * Stateless (`store: false`): reasoning comes back as encrypted items
 * (`include: ["reasoning.encrypted_content"]`), which this plugin keeps in its
 * replay state and sends back before the message or function call they led
 * to; the visible reasoning is the summary (`summary: "auto"`). A refusal can
 * arrive inside a 200 stream as an `error` event or `response.failed` (an
 * account out of credits does, as live-checked) and is classified like an HTTP
 * failure. xAI reports the request's cost (`cost_in_usd_ticks`).
 *
 * @module dsh-intl-models/protocols/responses
 */
import { classifyFailure, KIND_LABELS, providerLevel } from "../dialects.js";
import { asNumber, asString, cnError, CODES, isRecord, safeJson } from "../errors.js";
import { argumentsText, callIdFor, clean, loadImage, normalizeHistory, replayOf, replayState, sanitizeSchema, textOf, toolList } from "../request.js";
import { ssePayloads } from "../wire.js";

export const PROTOCOL = "responses";
/** OpenAI rejects `max_output_tokens` below 16. */
const MIN_OUTPUT_TOKENS = 16;

/** One user-side content list → Responses input content. */
async function userContent(content, context) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push({ type: "input_text", text: clean(block.text) });
    else if (block?.type === "image") {
      const image = await loadImage(block, context);
      parts.push(image.placeholder ? { type: "input_text", text: image.placeholder } : { type: "input_image", detail: "auto", image_url: `data:${image.mediaType};base64,${image.data}` });
    }
  }
  return parts;
}

/** A reasoning item as the API takes it back (output-only fields dropped). */
function reasoningItem(item) {
  if (!isRecord(item) || item.type !== "reasoning") return undefined;
  return {
    type: "reasoning",
    ...(asString(item.id) ? { id: item.id } : {}),
    summary: Array.isArray(item.summary) ? item.summary.filter(isRecord).map((part) => ({ type: "summary_text", text: String(part.text ?? "") })) : [],
    ...(asString(item.encrypted_content) ? { encrypted_content: item.encrypted_content } : {}),
  };
}

/**
 * The request for one streaming call.
 * @param {object} input - `{ options, endpoint, model, effort, attachments }`.
 * @returns `{ url, body, auth }`.
 */
export async function buildRequest({ options, endpoint, model, effort, attachments }) {
  const history = normalizeHistory(options);
  const context = { model, attachments, signal: options.signal };
  const input = [];
  // Reasoning models take their instructions as a developer message.
  if (history.system) input.push({ role: model.reasoning ? "developer" : "system", content: history.system });
  for (const message of history.messages) {
    if (message.role === "developer") {
      const text = textOf(message.content);
      if (text) input.push({ role: "user", content: [{ type: "input_text", text: clean(text) }] });
    } else if (message.role === "assistant") {
      const replay = replayOf(message, { endpoint: endpoint.id, protocol: PROTOCOL, model: model.id });
      (Array.isArray(message.content) ? message.content : []).forEach((block, index) => {
        const entry = replay?.[index] ?? {};
        if (block?.type === "reasoning") {
          const item = replay ? reasoningItem(entry.item) : undefined;
          if (item) input.push(item);
        } else if (block?.type === "text") {
          const text = clean(block.text);
          if (!text) return;
          input.push(asString(entry.messageId)
            ? { type: "message", role: "assistant", id: entry.messageId, status: "completed", content: [{ type: "output_text", text, annotations: [] }] }
            : { role: "assistant", content: text });
        } else if (block?.type === "tool-call") {
          input.push({ type: "function_call", call_id: callIdFor(block.id), name: block.name, arguments: argumentsText(block), ...(replay && /^fc_/.test(String(entry.itemId ?? "")) ? { id: entry.itemId } : {}) });
        }
      });
    } else if (message.role === "tool") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = textOf(blocks) || (message.isError ? "Tool failed" : "(no output)");
      const images = model.image ? blocks.filter((block) => block?.type === "image") : [];
      const output = images.length ? [{ type: "input_text", text: clean(text) }, ...(await userContent(images, context))] : clean(text);
      input.push({ type: "function_call_output", call_id: callIdFor(message.toolCallId), output });
    } else {
      const content = await userContent(message.content, context);
      if (content.length) input.push({ role: "user", content });
    }
  }
  if (!input.some((item) => item.role === "user")) input.push({ role: "user", content: [{ type: "input_text", text: "(continue)" }] });

  const body = { model: model.id, input, stream: true, store: false };
  const tools = toolList(options.tools);
  if (tools) body.tools = tools.map((tool) => ({ type: "function", name: tool.name, ...(tool.description ? { description: clean(tool.description) } : {}), parameters: sanitizeSchema(tool.parameters), strict: false }));
  if (model.reasoning && effort !== undefined) {
    if (effort === "off") body.reasoning = { effort: typeof model.reasoning.map?.off === "string" ? model.reasoning.map.off : "none" };
    else {
      body.reasoning = { effort: providerLevel(model, effort), summary: "auto" };
      body.include = ["reasoning.encrypted_content"];
    }
    // xAI's reasoning is encrypted whatever the effort; keep it for the next turn.
    if (endpoint.vendor === "xai") body.include = ["reasoning.encrypted_content"];
  }
  // Reasoning models refuse sampling parameters.
  if (typeof options.temperature === "number" && !model.reasoning && !model.flags?.noTemperature) body.temperature = options.temperature;
  if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) body.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(options.maxTokens, model.output ?? Infinity));
  if (typeof options.sessionId === "string" && options.sessionId) body.prompt_cache_key = options.sessionId.slice(0, 64);
  return { url: `${endpoint.baseUrl}/responses`, body, auth: "bearer" };
}

/** Harness usage from a Responses usage object (`input_tokens` includes the cached ones). */
export function mapUsage(usage) {
  if (!isRecord(usage)) return undefined;
  const input = asNumber(usage.input_tokens) ?? 0;
  const cacheRead = asNumber(usage.input_tokens_details?.cached_tokens) ?? 0;
  const cacheWrite = asNumber(usage.input_tokens_details?.cache_write_tokens) ?? 0;
  const reasoning = asNumber(usage.output_tokens_details?.reasoning_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: asNumber(usage.output_tokens) ?? 0,
    ...(asNumber(usage.total_tokens) ? { totalTokens: asNumber(usage.total_tokens) } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** A classified error from an `error` event or a failed response. */
function streamFailure(meta, payload) {
  const failure = classifyFailure(meta.vendor, 200, payload, { plan: meta.plan });
  return cnError(failure.code, `${meta.endpointName}：${KIND_LABELS[failure.kind] ?? "请求失败"}：${failure.message}`, { kind: failure.kind, keyId: meta.keyId, endpoint: meta.endpoint, vendorCode: failure.vendorCode, resetAt: failure.resetAt });
}

/**
 * Translate one streaming response.
 * @param {Response} response - the 2xx SSE response.
 * @param {object} meta - `{ vendor, endpoint, endpointName, protocol, model, keyId, idle, plan, report }`.
 * @returns an async iterable of harness chunks; throws classified errors.
 */
export async function* parseStream(response, meta) {
  const replay = [];
  const slots = new Map();
  let blockCount = 0;
  let calls = 0;
  let terminal;
  let sawContent = false;
  const open = (outputIndex, type) => {
    const slot = { type, index: blockCount++, text: "", args: "", done: false };
    slots.set(outputIndex, slot);
    replay.push({});
    return slot;
  };
  const slotOf = (outputIndex, type) => {
    const slot = slots.get(outputIndex);
    return slot?.type === type && !slot.done ? slot : undefined;
  };

  for await (const payload of ssePayloads(response, meta.idle)) {
    const event = safeJson(payload);
    if (!isRecord(event)) continue;
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item;
        if (item?.type === "reasoning") {
          const slot = open(event.output_index, "reasoning");
          yield { type: "block-start", index: slot.index, blockType: "reasoning" };
        } else if (item?.type === "message") {
          const slot = open(event.output_index, "text");
          yield { type: "block-start", index: slot.index, blockType: "text" };
        } else if (item?.type === "function_call") {
          const slot = open(event.output_index, "tool-call");
          slot.callId = asString(item.call_id) ?? `call_${blockCount}`;
          slot.itemId = asString(item.id);
          slot.name = asString(item.name) ?? "";
          slot.args = typeof item.arguments === "string" ? item.arguments : "";
          calls += 1;
          yield { type: "block-start", index: slot.index, blockType: "tool-call" };
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const slot = slotOf(event.output_index, "reasoning");
        if (!slot || typeof event.delta !== "string" || !event.delta) break;
        slot.text += event.delta;
        sawContent = true;
        yield { type: "reasoning-delta", index: slot.index, text: event.delta };
        break;
      }
      case "response.reasoning_summary_part.done": {
        const slot = slotOf(event.output_index, "reasoning");
        if (!slot || !slot.text) break;
        slot.text += "\n\n";
        yield { type: "reasoning-delta", index: slot.index, text: "\n\n" };
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const slot = slotOf(event.output_index, "text");
        if (!slot || typeof event.delta !== "string" || !event.delta) break;
        slot.text += event.delta;
        sawContent = true;
        yield { type: "text-delta", index: slot.index, text: event.delta };
        break;
      }
      case "response.function_call_arguments.delta": {
        const slot = slotOf(event.output_index, "tool-call");
        if (!slot || typeof event.delta !== "string") break;
        slot.args += event.delta;
        sawContent = true;
        yield { type: "tool-call-delta", index: slot.index, id: slot.callId, name: slot.name, argumentsDelta: event.delta };
        break;
      }
      case "response.function_call_arguments.done": {
        const slot = slotOf(event.output_index, "tool-call");
        if (!slot || typeof event.arguments !== "string") break;
        if (event.arguments.startsWith(slot.args) && event.arguments.length > slot.args.length) {
          const rest = event.arguments.slice(slot.args.length);
          yield { type: "tool-call-delta", index: slot.index, id: slot.callId, name: slot.name, argumentsDelta: rest };
        }
        slot.args = event.arguments;
        sawContent = true;
        break;
      }
      case "response.output_item.done": {
        const item = event.item;
        const slot = slots.get(event.output_index) ?? (item?.type === "function_call" ? open(event.output_index, "tool-call") : undefined);
        if (!slot || slot.done) break;
        slot.done = true;
        if (item?.type === "reasoning" && slot.type === "reasoning") {
          const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text ?? "").filter(Boolean).join("\n\n") : "";
          const content = Array.isArray(item.content) ? item.content.map((part) => part?.text ?? "").filter(Boolean).join("\n\n") : "";
          const text = summary || content || slot.text.trim();
          replay[slot.index] = { item: reasoningItem(item) };
          yield { type: "block-end", index: slot.index, block: { type: "reasoning", text } };
        } else if (item?.type === "message" && slot.type === "text") {
          const text = Array.isArray(item.content) ? item.content.map((part) => (part?.type === "output_text" ? part.text : part?.refusal ?? "")).join("") : slot.text;
          replay[slot.index] = asString(item.id) ? { messageId: item.id } : {};
          if (text) sawContent = true;
          yield { type: "block-end", index: slot.index, block: { type: "text", text: text || slot.text } };
        } else if (item?.type === "function_call" && slot.type === "tool-call") {
          slot.callId = asString(item.call_id) ?? slot.callId;
          slot.name = asString(item.name) ?? slot.name;
          const args = typeof item.arguments === "string" && item.arguments ? item.arguments : slot.args;
          replay[slot.index] = asString(item.id) ? { itemId: item.id } : {};
          sawContent = true;
          yield { type: "block-end", index: slot.index, block: { type: "tool-call", id: slot.callId, name: slot.name, arguments: args.trim() ? args : "{}" } };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
        terminal = event.response;
        // Some hosts give the encrypted reasoning only in the terminal output: backfill it.
        for (const item of Array.isArray(terminal?.output) ? terminal.output : []) {
          if (item?.type !== "reasoning" || !asString(item.encrypted_content)) continue;
          const entry = replay.find((value) => value?.item?.id === item.id && !value.item.encrypted_content);
          if (entry) entry.item.encrypted_content = item.encrypted_content;
        }
        break;
      case "error":
        throw streamFailure(meta, event);
      case "response.failed":
        throw streamFailure(meta, { error: event.response?.error ?? { message: "the response failed" } });
      default:
        break;
    }
  }
  // Close anything a truncated stream left open.
  for (const slot of slots.values()) {
    if (slot.done) continue;
    slot.done = true;
    if (slot.type === "tool-call") yield { type: "block-end", index: slot.index, block: { type: "tool-call", id: slot.callId, name: slot.name, arguments: slot.args.trim() ? slot.args : "{}" } };
    else yield { type: "block-end", index: slot.index, block: { type: slot.type, text: slot.text } };
  }
  if (!terminal) throw cnError(CODES.transport, `${meta.endpointName}：回答在结束前中断`, { kind: "transport" });
  if (!sawContent) throw cnError(CODES.empty, `${meta.endpointName} 没有返回内容（${meta.model}）`, { kind: "empty" });
  const mapped = mapUsage(terminal.usage);
  if (mapped) yield { type: "usage", usage: mapped };
  const ticks = asNumber(terminal.usage?.cost_in_usd_ticks);
  if (meta.report && ticks !== undefined) meta.report.cost = ticks / 1e10;
  const reason = String(terminal.incomplete_details?.reason ?? "");
  let finish;
  if (calls > 0) finish = { kind: "tool-calls" };
  else if (terminal.status === "incomplete" && reason === "max_output_tokens") finish = { kind: "max-tokens" };
  else if (terminal.status === "incomplete" && reason === "content_filter") finish = { kind: "error", failure: { message: "内容审核未通过，回答被截断", code: CODES.badRequest } };
  else if (terminal.status === "incomplete") finish = { kind: "error", failure: { message: `回答未完成（${reason || "unknown"}）`, code: CODES.server } };
  else finish = { kind: "stop" };
  yield { type: "finish", reason: finish, replayState: replayState(meta, replay) };
}
