/**
 * Anthropic Messages: Claude, and the Claude (and some Qwen) models OpenCode
 * and OpenRouter serve over it.
 *
 * Prompt caching is explicit here, and the bill depends on it: breakpoints go
 * on the system prompt, the last tool, and the last block of the newest user
 * turn, so each request reads the conversation so far from the cache. Newer
 * models think adaptively at an effort level; older ones take a thinking
 * budget. Thinking blocks go back with their signature (redacted ones as their
 * opaque payload) — only to the same endpoint and model.
 *
 * @module dsh-intl-models/protocols/messages
 */
import { classifyFailure, KIND_LABELS, providerLevel } from "../dialects.js";
import { messagesBaseOf } from "../endpoints.js";
import { asNumber, asString, cnError, CODES, isRecord, safeJson } from "../errors.js";
import { argumentsOf, callIdFor, clean, loadImage, normalizeHistory, replayOf, replayState, sanitizeSchema, textOf, toolList } from "../request.js";
import { ANTHROPIC_VERSION, ssePayloads } from "../wire.js";

export const PROTOCOL = "messages";
const CACHE = Object.freeze({ type: "ephemeral" });
/** Thinking budgets of models without adaptive thinking (pi-ai's defaults). */
const BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 32000 });

/** One user-side content list → Messages content blocks. */
async function userBlocks(content, context) {
  const blocks = [];
  for (const block of Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) blocks.push({ type: "text", text: clean(block.text) });
    else if (block?.type === "image") {
      const image = await loadImage(block, context);
      blocks.push(image.placeholder ? { type: "text", text: image.placeholder } : { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
    }
  }
  return blocks;
}

/**
 * The request for one streaming call.
 * @param {object} input - `{ options, endpoint, model, effort, attachments }`.
 * @returns `{ url, body, auth, headers }`.
 */
export async function buildRequest({ options, endpoint, model, effort, attachments }) {
  const flags = model.flags ?? {};
  const history = normalizeHistory(options);
  const context = { model, attachments, signal: options.signal };
  const messages = [];
  const pushUser = (blocks) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === "user") last.content.push(...blocks);
    else messages.push({ role: "user", content: blocks });
  };
  for (const message of history.messages) {
    if (message.role === "developer") {
      const text = textOf(message.content);
      if (text) pushUser([{ type: "text", text: clean(text) }]);
    } else if (message.role === "assistant") {
      const replay = replayOf(message, { endpoint: endpoint.id, protocol: PROTOCOL, model: model.id });
      const blocks = [];
      (Array.isArray(message.content) ? message.content : []).forEach((block, index) => {
        const entry = replay?.[index] ?? {};
        if (block?.type === "reasoning") {
          if (!replay) return;
          if (asString(entry.redacted)) blocks.push({ type: "redacted_thinking", data: entry.redacted });
          else if (asString(entry.signature)) blocks.push({ type: "thinking", thinking: clean(block.text), signature: entry.signature });
        } else if (block?.type === "text") {
          if (String(block.text ?? "").trim()) blocks.push({ type: "text", text: clean(block.text) });
        } else if (block?.type === "tool-call") {
          blocks.push({ type: "tool_use", id: callIdFor(block.id), name: block.name, input: argumentsOf(block) });
        }
      });
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
    } else if (message.role === "tool") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = textOf(blocks) || (message.isError ? "Tool failed" : "(no output)");
      const images = model.image ? blocks.filter((block) => block?.type === "image") : [];
      const content = images.length ? [{ type: "text", text: clean(text) }, ...(await userBlocks(images, context))] : clean(text);
      pushUser([{ type: "tool_result", tool_use_id: callIdFor(message.toolCallId), content, ...(message.isError ? { is_error: true } : {}) }]);
    } else pushUser(await userBlocks(message.content, context));
  }
  if (messages.length === 0 || messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  // Cache the conversation so far: the newest user turn's last block.
  const last = messages.at(-1);
  if (last?.role === "user" && last.content.length) last.content[last.content.length - 1] = { ...last.content.at(-1), cache_control: CACHE };

  const body = { model: model.id, messages, stream: true };
  if (history.system) body.system = [{ type: "text", text: history.system, cache_control: CACHE }];
  const tools = toolList(options.tools);
  if (tools) {
    body.tools = tools.map((tool, index) => ({
      name: tool.name,
      ...(tool.description ? { description: clean(tool.description) } : {}),
      input_schema: sanitizeSchema(tool.parameters),
      ...(index === tools.length - 1 ? { cache_control: CACHE } : {}),
    }));
  }
  const requested = Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : undefined;
  const ceiling = model.output ?? 64000;
  let maxTokens = Math.min(requested ?? ceiling, ceiling);
  let thinkingOn = false;
  const betas = [];
  if (model.reasoning && effort !== undefined) {
    if (effort === "off") {
      if (model.reasoning.off) body.thinking = { type: "disabled" };
    } else if (flags.adaptive) {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: providerLevel(model, effort) };
      thinkingOn = true;
    } else {
      // A budget shares max_tokens with the answer: leave the answer its room.
      const budget = BUDGETS[effort] ?? BUDGETS.high;
      maxTokens = Math.min(ceiling, (requested ?? Math.min(ceiling, 32000)) + budget);
      body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(budget, maxTokens - 1024)), display: "summarized" };
      thinkingOn = true;
      if (tools && endpoint.vendor === "anthropic") betas.push("interleaved-thinking-2025-05-14");
    }
  }
  // With thinking on, a tool loop's last assistant turn must open with a thinking block; another
  // provider's turn has none to give, so this one request goes without thinking (where allowed).
  const lastAssistant = messages.findLast((item) => item.role === "assistant");
  if (thinkingOn && model.reasoning.off && lastAssistant && lastAssistant === messages.at(-2)
    && lastAssistant.content.some((block) => block.type === "tool_use") && !["thinking", "redacted_thinking"].includes(lastAssistant.content[0]?.type)) {
    body.thinking = { type: "disabled" };
    delete body.output_config;
    thinkingOn = false;
    maxTokens = Math.min(requested ?? ceiling, ceiling);
  }
  body.max_tokens = maxTokens;
  // Sampling is incompatible with extended thinking, and refused by the newest models.
  if (typeof options.temperature === "number" && !thinkingOn && !flags.noTemperature) body.temperature = Math.min(1, options.temperature);
  if (Array.isArray(options.stop) && options.stop.length) body.stop_sequences = options.stop.slice(0, 8);
  // OpenRouter and Cloudflare take the Messages API with their usual bearer key; Anthropic and OpenCode want `x-api-key`.
  const auth = endpoint.messagesAuth ?? (endpoint.vendor === "openrouter" ? "bearer" : "anthropic");
  const headers = { ...(auth === "bearer" ? { "anthropic-version": ANTHROPIC_VERSION } : {}), ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}) };
  return { url: `${messagesBaseOf(endpoint, model)}/v1/messages`, body, auth, headers };
}

/** Harness usage from Messages usage (`input_tokens` is already the uncached part). */
export function mapUsage(usage) {
  if (!isRecord(usage)) return undefined;
  const input = asNumber(usage.input_tokens) ?? 0;
  const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = asNumber(usage.cache_creation_input_tokens) ?? 0;
  const output = asNumber(usage.output_tokens) ?? 0;
  const reasoning = asNumber(usage.output_tokens_details?.thinking_tokens) ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + cacheRead + cacheWrite + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Translate one streaming response.
 * @param {Response} response - the 2xx SSE response.
 * @param {object} meta - `{ vendor, endpoint, endpointName, protocol, model, keyId, idle, plan, report }`.
 * @returns an async iterable of harness chunks; throws classified errors.
 */
export async function* parseStream(response, meta) {
  const replay = [];
  const blocks = new Map();
  let blockCount = 0;
  let calls = 0;
  let stopReason;
  let usage = {};
  let sawContent = false;
  let stopped = false;

  for await (const payload of ssePayloads(response, meta.idle)) {
    const event = safeJson(payload);
    if (!isRecord(event)) continue;
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message?.usage)) usage = { ...event.message.usage };
        break;
      case "content_block_start": {
        const source = event.content_block;
        let block;
        if (source?.type === "text") block = { type: "text", text: "" };
        else if (source?.type === "thinking") block = { type: "reasoning", text: "", signature: asString(source.signature) ?? "" };
        else if (source?.type === "redacted_thinking") block = { type: "reasoning", text: "", redacted: asString(source.data) ?? "" };
        else if (source?.type === "tool_use") {
          block = { type: "tool-call", id: asString(source.id) ?? `toolu_${blockCount}`, name: asString(source.name) ?? "", args: "" };
          calls += 1;
        }
        if (!block) break;
        block.index = blockCount++;
        blocks.set(event.index, block);
        replay.push({});
        yield { type: "block-start", index: block.index, blockType: block.type };
        if (block.type === "text" && asString(source.text)) {
          block.text = source.text;
          sawContent = true;
          yield { type: "text-delta", index: block.index, text: source.text };
        }
        break;
      }
      case "content_block_delta": {
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (!block || !isRecord(delta)) break;
        if (delta.type === "text_delta" && block.type === "text" && delta.text) {
          block.text += delta.text;
          sawContent = true;
          yield { type: "text-delta", index: block.index, text: delta.text };
        } else if (delta.type === "thinking_delta" && block.type === "reasoning" && delta.thinking) {
          block.text += delta.thinking;
          sawContent = true;
          yield { type: "reasoning-delta", index: block.index, text: delta.thinking };
        } else if (delta.type === "signature_delta" && block.type === "reasoning") {
          block.signature = `${block.signature ?? ""}${delta.signature ?? ""}`;
        } else if (delta.type === "input_json_delta" && block.type === "tool-call" && typeof delta.partial_json === "string") {
          block.args += delta.partial_json;
          sawContent = true;
          if (delta.partial_json) yield { type: "tool-call-delta", index: block.index, id: block.id, name: block.name, argumentsDelta: delta.partial_json };
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(event.index);
        if (!block || block.closed) break;
        block.closed = true;
        if (block.type === "reasoning") {
          replay[block.index] = block.redacted ? { redacted: block.redacted } : block.signature ? { signature: block.signature } : {};
          yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } };
        } else if (block.type === "tool-call") {
          sawContent = true;
          yield { type: "block-end", index: block.index, block: { type: "tool-call", id: block.id, name: block.name, arguments: block.args.trim() ? block.args : "{}" } };
        } else yield { type: "block-end", index: block.index, block: { type: "text", text: block.text } };
        break;
      }
      case "message_delta":
        if (asString(event.delta?.stop_reason)) stopReason = event.delta.stop_reason;
        if (isRecord(event.usage)) for (const [name, value] of Object.entries(event.usage)) if (value !== null && value !== undefined) usage[name] = value;
        break;
      case "message_stop":
        stopped = true;
        break;
      case "error": {
        const failure = classifyFailure(meta.vendor, 200, event, { plan: meta.plan });
        throw cnError(failure.code, `${meta.endpointName}：${KIND_LABELS[failure.kind] ?? "请求失败"}：${failure.message}`, { kind: failure.kind, keyId: meta.keyId, endpoint: meta.endpoint, vendorCode: failure.vendorCode, resetAt: failure.resetAt });
      }
      default:
        break;
    }
  }
  for (const block of blocks.values()) {
    if (block.closed) continue;
    block.closed = true;
    yield { type: "block-end", index: block.index, block: block.type === "tool-call" ? { type: "tool-call", id: block.id, name: block.name, arguments: block.args.trim() ? block.args : "{}" } : { type: block.type, text: block.text } };
  }
  if (!stopped && !stopReason) throw cnError(CODES.transport, `${meta.endpointName}：回答在结束前中断`, { kind: "transport" });
  if (!sawContent) {
    if (stopReason === "refusal") throw cnError(CODES.badRequest, `${meta.endpointName}：模型拒绝回答`, { kind: "moderation" });
    throw cnError(CODES.empty, `${meta.endpointName} 没有返回内容（${meta.model}）`, { kind: "empty" });
  }
  const mapped = mapUsage(usage);
  if (mapped) yield { type: "usage", usage: mapped };
  if (meta.report && asNumber(usage.cost) !== undefined) meta.report.cost = asNumber(usage.cost);
  let finish;
  if (calls > 0 && stopReason !== "max_tokens") finish = { kind: "tool-calls" };
  else if (stopReason === "max_tokens") finish = { kind: "max-tokens" };
  else if (stopReason === "model_context_window_exceeded") finish = { kind: "error", failure: { message: "超出上下文长度", code: CODES.context } };
  else if (stopReason === "refusal" || stopReason === "sensitive") finish = { kind: "error", failure: { message: "模型拒绝继续回答", code: CODES.badRequest } };
  else finish = { kind: "stop" };
  yield { type: "finish", reason: finish, replayState: replayState(meta, replay) };
}
