/**
 * OpenAI Chat Completions: OpenRouter, and OpenCode's open models (DeepSeek,
 * GLM, Kimi, MiniMax, Qwen…).
 *
 * Reasoning: OpenRouter takes one normalized `reasoning: { effort }` and
 * streams `reasoning` text plus `reasoning_details` (with signatures or
 * encrypted payloads, which go back as received so Claude and Gemini behind
 * it keep their chain); OpenCode passes `reasoning_effort` through, or a
 * model's own switch (`thinking`, `enable_thinking`). Models that require it
 * get every assistant turn's `reasoning_content` back (empty for another
 * provider's turns). Vercel takes the same `reasoning: { effort }` (switched
 * off with `enabled: false`) and streams OpenRouter's fields; both report the
 * request's cost in the final usage.
 *
 * @module dsh-intl-models/protocols/chat
 */
import { randomBytes } from "node:crypto";
import { classifyFailure, KIND_LABELS, providerLevel } from "../dialects.js";
import { asNumber, asString, cnError, CODES, isRecord, safeJson } from "../errors.js";
import { argumentsText, callIdFor, clean, loadImage, normalizeHistory, replayOf, replayState, sanitizeSchema, textOf, toolList } from "../request.js";
import { ssePayloads } from "../wire.js";

export const PROTOCOL = "chat";

/** One user-side content list → Chat Completions content parts. */
async function userParts(content, context) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push({ type: "text", text: clean(block.text) });
    else if (block?.type === "image") {
      const image = await loadImage(block, context);
      parts.push(image.placeholder ? { type: "text", text: image.placeholder } : { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
    }
  }
  return parts;
}

/** Text-only parts read as a plain string (the most widely accepted form). */
const contentValue = (parts) => (parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n\n") : parts);

/**
 * The request for one streaming call.
 * @param {object} input - `{ options, endpoint, model, effort, attachments }`.
 * @returns `{ url, body, auth }`.
 */
export async function buildRequest({ options, endpoint, model, effort, attachments }) {
  const flags = model.flags ?? {};
  const history = normalizeHistory(options);
  const context = { model, attachments, signal: options.signal };
  const out = [];
  const pushUser = (parts) => {
    if (parts.length === 0) return;
    const last = out.at(-1);
    if (last?.role === "user") {
      const previous = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
      last.content = contentValue([...previous, ...parts]);
    } else out.push({ role: "user", content: contentValue(parts) });
  };
  for (const message of history.messages) {
    if (message.role === "developer") {
      const text = textOf(message.content);
      if (text) pushUser([{ type: "text", text: clean(text) }]);
    } else if (message.role === "assistant") {
      const replay = replayOf(message, { endpoint: endpoint.id, protocol: PROTOCOL, model: model.id });
      let text = "";
      let reasoning = "";
      const details = [];
      const calls = [];
      (Array.isArray(message.content) ? message.content : []).forEach((block, index) => {
        if (block?.type === "text") text += String(block.text ?? "");
        else if (block?.type === "reasoning" && replay) {
          reasoning += String(block.text ?? "");
          if (Array.isArray(replay[index]?.details)) details.push(...replay[index].details);
        } else if (block?.type === "tool-call") calls.push({ id: callIdFor(block.id), type: "function", function: { name: block.name, arguments: argumentsText(block) } });
      });
      const entry = { role: "assistant", content: clean(text) };
      if (details.length) entry.reasoning_details = details;
      if (flags.reasoningOnAssistant) entry.reasoning_content = reasoning;
      if (calls.length) entry.tool_calls = calls;
      if (entry.content || entry.tool_calls || entry.reasoning_details) out.push(entry);
    } else if (message.role === "tool") {
      const output = textOf(message.content) || (message.isError ? "Tool failed" : "(no output)");
      out.push({ role: "tool", tool_call_id: callIdFor(message.toolCallId), content: clean(output) });
      // Images a tool returned travel in a following user turn (tool messages are text only).
      const images = (Array.isArray(message.content) ? message.content : []).filter((block) => block?.type === "image");
      if (images.length && model.image) pushUser(await userParts(images, context));
    } else pushUser(await userParts(message.content, context));
  }
  if (out.length === 0 || out[0].role !== "user") out.unshift({ role: "user", content: "(continue)" });
  if (history.system) out.unshift({ role: "system", content: history.system });

  const body = { model: model.id, messages: out, stream: true, stream_options: { include_usage: true } };
  const tools = toolList(options.tools);
  if (tools) body.tools = tools.map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description ? { description: clean(tool.description) } : {}), parameters: sanitizeSchema(tool.parameters) } }));
  Object.assign(body, thinkingFields(endpoint, model, effort));
  if (typeof options.temperature === "number" && !flags.noTemperature) body.temperature = options.temperature;
  if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) body[flags.maxTokensField ?? "max_tokens"] = Math.min(options.maxTokens, model.output ?? Infinity);
  if (Array.isArray(options.stop) && options.stop.length) body.stop = options.stop.slice(0, 4);
  // OpenRouter reports the request's cost in the final usage.
  if (endpoint.vendor === "openrouter") body.usage = { include: true };
  return { url: `${endpoint.baseUrl}/chat/completions`, body, auth: "bearer" };
}

/** The reasoning fields for one model and effort (`undefined`: the model does not reason). */
export function thinkingFields(endpoint, model, effort) {
  if (!model.reasoning || effort === undefined) return {};
  const on = effort !== "off";
  const level = providerLevel(model, effort);
  const format = model.flags?.thinkingFormat ?? (endpoint.vendor === "openrouter" || endpoint.vendor === "vercel" ? endpoint.vendor : "effort");
  switch (format) {
    case "openrouter":
      return { reasoning: { effort: on ? level : typeof model.reasoning.map?.off === "string" ? model.reasoning.map.off : "none" } };
    case "vercel":
      return { reasoning: on ? { effort: level } : typeof model.reasoning.map?.off === "string" ? { effort: model.reasoning.map.off } : { enabled: false } };
    case "deepseek":
      return { thinking: { type: on ? "enabled" : "disabled" }, ...(on && model.flags?.reasoningEffort !== false ? { reasoning_effort: level } : {}) };
    case "qwen":
      return { enable_thinking: on, ...(on && model.flags?.reasoningEffort !== false ? { reasoning_effort: level } : {}) };
    default:
      if (model.flags?.reasoningEffort === false) return {};
      if (on) return { reasoning_effort: level };
      return typeof model.reasoning.map?.off === "string" ? { reasoning_effort: model.reasoning.map.off } : {};
  }
}

/** Harness usage from a Chat Completions usage object (disjoint counts) plus the reported cost. */
export function mapUsage(usage) {
  if (!isRecord(usage)) return undefined;
  const prompt = asNumber(usage.prompt_tokens) ?? 0;
  const completion = asNumber(usage.completion_tokens) ?? 0;
  // None (or all zeros) is no usage: DSH then estimates the context itself instead of reading 0 %.
  if (prompt <= 0 && completion <= 0) return undefined;
  const cacheRead = asNumber(usage.prompt_tokens_details?.cached_tokens) ?? asNumber(usage.cached_tokens) ?? asNumber(usage.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = asNumber(usage.prompt_tokens_details?.cache_write_tokens) ?? asNumber(usage.cache_creation_input_tokens) ?? 0;
  const reasoning = asNumber(usage.completion_tokens_details?.reasoning_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    outputTokens: completion,
    ...(asNumber(usage.total_tokens) ? { totalTokens: asNumber(usage.total_tokens) } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** Merge streamed `reasoning_details` pieces into whole entries: text joined per index, other fields (signature, data) kept. */
function mergeDetails(target, pieces) {
  for (const piece of pieces) {
    if (!isRecord(piece)) continue;
    const key = piece.index ?? piece.id ?? target.length;
    const existing = target.find((item) => (item.index ?? item.id) === key);
    if (!existing) {
      target.push({ ...piece });
      continue;
    }
    for (const [name, value] of Object.entries(piece)) {
      if (value === undefined || value === null) continue;
      if ((name === "text" || name === "summary") && typeof value === "string") existing[name] = `${existing[name] ?? ""}${value}`;
      else if (name !== "index") existing[name] = value;
    }
  }
}

/**
 * Translate one streaming response.
 * @param {Response} response - the 2xx SSE response.
 * @param {object} meta - `{ vendor, endpoint, endpointName, protocol, model, keyId, idle, plan, report }`; `report.cost` receives a reported cost.
 * @returns an async iterable of harness chunks; throws classified errors.
 */
export async function* parseStream(response, meta) {
  const replay = [];
  let blockCount = 0;
  let current;
  const tools = new Map();
  let openTool;
  let finishReason;
  let usage;
  let sawContent = false;

  const close = function* () {
    if (!current) return;
    if (current.details) replay[current.index] = { details: current.details };
    yield { type: "block-end", index: current.index, block: { type: current.type, text: current.text } };
    current = undefined;
  };
  const closeTool = function* () {
    if (openTool === undefined) return;
    const tool = tools.get(openTool);
    openTool = undefined;
    if (!tool || tool.closed) return;
    tool.closed = true;
    yield { type: "block-end", index: tool.index, block: { type: "tool-call", id: tool.id, name: tool.name, arguments: tool.args.trim() ? tool.args : "{}" } };
  };
  const emit = function* (type, text, details) {
    if (!text && !details) return;
    yield* closeTool();
    if (!current || current.type !== type) {
      yield* close();
      current = { type, text: "", index: blockCount++ };
      replay.push({});
      yield { type: "block-start", index: current.index, blockType: type };
    }
    if (details) mergeDetails((current.details ??= []), details);
    if (!text) return;
    current.text += text;
    sawContent = true;
    yield { type: type === "text" ? "text-delta" : "reasoning-delta", index: current.index, text };
  };

  for await (const payload of ssePayloads(response, meta.idle)) {
    const frame = safeJson(payload);
    if (!isRecord(frame)) continue;
    if (isRecord(frame.error)) {
      const status = asNumber(frame.error.code) ?? 200;
      const failure = classifyFailure(meta.vendor, status >= 100 && status <= 599 ? status : 200, frame, { plan: meta.plan });
      throw cnError(failure.code, `${meta.endpointName}：${KIND_LABELS[failure.kind] ?? "请求失败"}：${failure.message}`, { kind: failure.kind, keyId: meta.keyId, endpoint: meta.endpoint, vendorCode: failure.vendorCode, resetAt: failure.resetAt });
    }
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
    if (isRecord(frame.usage)) usage = frame.usage;
    if (!choice) continue;
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
    const details = Array.isArray(delta.reasoning_details) && delta.reasoning_details.length ? delta.reasoning_details : undefined;
    const reasoningText = asString(delta.reasoning_content) ?? asString(delta.reasoning)
      ?? (details ? details.map((item) => (typeof item?.text === "string" ? item.text : typeof item?.summary === "string" ? item.summary : "")).join("") : "");
    if (reasoningText || details) yield* emit("reasoning", reasoningText, details);
    if (typeof delta.content === "string" && delta.content) yield* emit("text", delta.content);
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRecord(call)) continue;
      const position = Number.isInteger(call.index) ? call.index : tools.size;
      let tool = tools.get(position);
      if (!tool) {
        yield* close();
        yield* closeTool();
        tool = { id: asString(call.id) ?? `call_${randomBytes(6).toString("hex")}`, name: asString(call.function?.name) ?? "", args: "", index: blockCount++, closed: false };
        tools.set(position, tool);
        replay.push({});
        openTool = position;
        yield { type: "block-start", index: tool.index, blockType: "tool-call" };
      } else if (!tool.name && asString(call.function?.name)) tool.name = call.function.name;
      const piece = typeof call.function?.arguments === "string" ? call.function.arguments : isRecord(call.function?.arguments) ? JSON.stringify(call.function.arguments) : "";
      sawContent = true;
      tool.args += piece;
      if (!tool.closed && piece) yield { type: "tool-call-delta", index: tool.index, id: tool.id, ...(tool.name ? { name: tool.name } : {}), argumentsDelta: piece };
    }
    if (asString(choice.finish_reason)) finishReason = choice.finish_reason;
  }
  yield* close();
  for (const position of tools.keys()) {
    openTool = position;
    yield* closeTool();
  }

  const reason = String(finishReason ?? "").toLowerCase();
  if (!sawContent) {
    if (reason === "content_filter") throw cnError(CODES.badRequest, `${meta.endpointName}：内容审核未通过`, { kind: "moderation" });
    throw cnError(CODES.empty, `${meta.endpointName} 没有返回内容（${meta.model}）`, { kind: "empty" });
  }
  const mapped = mapUsage(usage);
  if (mapped) yield { type: "usage", usage: mapped };
  if (meta.report && asNumber(usage?.cost) !== undefined) meta.report.cost = asNumber(usage.cost);
  // Cloudflare Workers AI bills in neurons (a daily free allocation, then the Workers plan).
  if (meta.report && asNumber(usage?.neurons) !== undefined) meta.report.neurons = asNumber(usage.neurons);
  let finish;
  if (tools.size > 0) finish = { kind: "tool-calls" };
  else if (reason === "length") finish = { kind: "max-tokens" };
  else if (reason === "content_filter") finish = { kind: "error", failure: { message: "内容审核未通过，回答被截断", code: CODES.badRequest } };
  else if (reason === "error") finish = { kind: "error", failure: { message: `${meta.endpointName} 服务端中断`, code: CODES.server } };
  else finish = { kind: "stop" };
  yield { type: "finish", reason: finish, replayState: replayState(meta, replay) };
}
