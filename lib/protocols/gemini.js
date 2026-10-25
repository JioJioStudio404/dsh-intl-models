/**
 * Google Gemini (`generateContent`, streamed as SSE): Gemini, and OpenCode's
 * Gemini models.
 *
 * Thought signatures (opaque, on any part — thoughts, text, function calls)
 * go back exactly where they came, to the same endpoint and model only.
 * Gemini 3 thinks at a level (`thinkingLevel`), 2.5 within a token budget
 * (`thinkingBudget`, 0 switches it off). Function calls and responses carry
 * ids on Gemini 3; a response names its function, which the history supplies.
 *
 * @module dsh-intl-models/protocols/gemini
 */
import { randomBytes } from "node:crypto";
import { classifyFailure, KIND_LABELS, providerLevel } from "../dialects.js";
import { geminiBaseOf } from "../endpoints.js";
import { asNumber, asString, cnError, CODES, isRecord, safeJson } from "../errors.js";
import { argumentsOf, callIdFor, clean, loadImage, normalizeHistory, replayOf, replayState, sanitizeSchema, textOf, toolList } from "../request.js";
import { ssePayloads } from "../wire.js";

export const PROTOCOL = "gemini";
/** Thinking budgets of Gemini 2.5 (pi-ai's per-model values). */
const BUDGETS = Object.freeze({
  pro: { minimal: 128, low: 2048, medium: 8192, high: 32768 },
  "flash-lite": { minimal: 512, low: 2048, medium: 8192, high: 24576 },
  flash: { minimal: 128, low: 2048, medium: 8192, high: 24576 },
});
const SAFETY = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

const major = (id) => Number(/^gemini(?:-live)?-(\d+)/i.exec(String(id))?.[1] ?? NaN);
/** Whether the model takes a discrete `thinkingLevel` (Gemini 3 Pro / Flash, Gemma 4) rather than a budget. */
export const usesThinkingLevel = (id) => /gemini-3(?:\.\d+)?-(?:pro|flash)|gemini-flash(-lite)?-latest|gemma-?4/i.test(String(id));
/** Whether function calls and responses must carry ids (Gemini 3+). */
const needsCallIds = (id) => major(id) >= 3;

function budgetOf(id, level) {
  const family = /flash-lite/i.test(id) ? "flash-lite" : /flash/i.test(id) ? "flash" : "pro";
  return BUDGETS[family][level === "xhigh" || level === "max" ? "high" : level] ?? -1;
}

/** One user-side content list → Gemini parts. */
async function userParts(content, context) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push({ text: clean(block.text) });
    else if (block?.type === "image") {
      const image = await loadImage(block, context);
      parts.push(image.placeholder ? { text: image.placeholder } : { inlineData: { mimeType: image.mediaType, data: image.data } });
    }
  }
  return parts;
}

/** The thinking part of `generationConfig`. */
function thinkingConfig(model, effort) {
  if (!model.reasoning || effort === undefined) return undefined;
  if (effort === "off") return usesThinkingLevel(model.id) ? undefined : { thinkingBudget: 0 };
  if (usesThinkingLevel(model.id)) return { includeThoughts: true, thinkingLevel: String(providerLevel(model, effort)).toUpperCase() };
  return { includeThoughts: true, thinkingBudget: budgetOf(model.id, effort) };
}

/**
 * The request for one streaming call.
 * @param {object} input - `{ options, endpoint, model, effort, attachments }`.
 * @returns `{ url, body, auth }`.
 */
export async function buildRequest({ options, endpoint, model, effort, attachments }) {
  const history = normalizeHistory(options);
  const context = { model, attachments, signal: options.signal };
  const ids = needsCallIds(model.id);
  const contents = [];
  const push = (role, parts) => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of history.messages) {
    if (message.role === "developer") {
      const text = textOf(message.content);
      if (text) push("user", [{ text: clean(text) }]);
    } else if (message.role === "assistant") {
      const replay = replayOf(message, { endpoint: endpoint.id, protocol: PROTOCOL, model: model.id });
      const parts = [];
      (Array.isArray(message.content) ? message.content : []).forEach((block, index) => {
        const signature = replay ? asString(replay[index]?.thoughtSignature) : undefined;
        if (block?.type === "reasoning") {
          if (replay && (String(block.text ?? "").trim() || signature)) parts.push({ thought: true, text: clean(block.text), ...(signature ? { thoughtSignature: signature } : {}) });
        } else if (block?.type === "text") {
          // An empty part that carries a signature is echoed back too (the chain breaks without it).
          if (String(block.text ?? "").trim() || signature) parts.push({ text: clean(block.text), ...(signature ? { thoughtSignature: signature } : {}) });
        } else if (block?.type === "tool-call") {
          parts.push({ functionCall: { name: block.name, args: argumentsOf(block), ...(ids ? { id: callIdFor(block.id) } : {}) }, ...(signature ? { thoughtSignature: signature } : {}) });
        }
      });
      push("model", parts);
    } else if (message.role === "tool") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = clean(textOf(blocks) || (message.isError ? "Tool failed" : "(no output)"));
      const images = model.image ? blocks.filter((block) => block?.type === "image") : [];
      const imageParts = images.length ? await userParts(images, context) : [];
      const multimodal = imageParts.length > 0 && major(model.id) >= 3;
      push("user", [{
        functionResponse: {
          name: history.toolNames.get(message.toolCallId) ?? "tool",
          response: message.isError ? { error: text } : { output: text },
          ...(multimodal ? { parts: imageParts } : {}),
          ...(ids ? { id: callIdFor(message.toolCallId) } : {}),
        },
      }]);
      if (imageParts.length && !multimodal) push("user", [{ text: "Tool result image:" }, ...imageParts]);
    } else push("user", await userParts(message.content, context));
  }
  if (contents.length === 0 || contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "(continue)" }] });

  const body = { contents };
  if (history.system) body.systemInstruction = { parts: [{ text: history.system }] };
  const tools = toolList(options.tools);
  if (tools) body.tools = [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: clean(tool.description) } : {}), parametersJsonSchema: sanitizeSchema(tool.parameters) })) }];
  const generation = {};
  if (typeof options.temperature === "number") generation.temperature = options.temperature;
  if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) generation.maxOutputTokens = Math.min(options.maxTokens, model.output ?? Infinity);
  if (Array.isArray(options.stop) && options.stop.length) generation.stopSequences = options.stop.slice(0, 5);
  const thinking = thinkingConfig(model, effort);
  if (thinking) generation.thinkingConfig = thinking;
  if (Object.keys(generation).length) body.generationConfig = generation;
  return { url: `${geminiBaseOf(endpoint, model)}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`, body, auth: "gemini" };
}

/** Harness usage from `usageMetadata` (the prompt count includes the cached part). */
export function mapUsage(meta) {
  if (!isRecord(meta)) return undefined;
  const prompt = asNumber(meta.promptTokenCount) ?? 0;
  const cached = asNumber(meta.cachedContentTokenCount) ?? 0;
  const thoughts = asNumber(meta.thoughtsTokenCount) ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: (asNumber(meta.candidatesTokenCount) ?? 0) + thoughts,
    ...(asNumber(meta.totalTokenCount) ? { totalTokens: asNumber(meta.totalTokenCount) } : {}),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
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
  let blockCount = 0;
  let current;
  let calls = 0;
  let finishReason;
  let usage;
  let sawContent = false;
  const seenIds = new Set();
  const close = function* () {
    if (!current) return;
    replay[current.index] = current.signature ? { thoughtSignature: current.signature } : {};
    yield { type: "block-end", index: current.index, block: { type: current.type, text: current.text } };
    current = undefined;
  };

  for await (const payload of ssePayloads(response, meta.idle)) {
    const chunk = safeJson(payload);
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.error)) {
      const failure = classifyFailure(meta.vendor, asNumber(chunk.error.code) ?? 200, chunk, { plan: meta.plan });
      throw cnError(failure.code, `${meta.endpointName}：${KIND_LABELS[failure.kind] ?? "请求失败"}：${failure.message}`, { kind: failure.kind, keyId: meta.keyId, endpoint: meta.endpoint, vendorCode: failure.vendorCode, resetAt: failure.resetAt });
    }
    if (asString(chunk.promptFeedback?.blockReason)) throw cnError(CODES.badRequest, `${meta.endpointName}：内容审核未通过（${chunk.promptFeedback.blockReason}）`, { kind: "moderation" });
    if (isRecord(chunk.usageMetadata)) usage = chunk.usageMetadata;
    const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined;
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") {
        const type = part.thought === true ? "reasoning" : "text";
        if (!current || current.type !== type) {
          yield* close();
          current = { type, text: "", index: blockCount++ };
          replay.push({});
          yield { type: "block-start", index: current.index, blockType: type };
        }
        if (asString(part.thoughtSignature)) current.signature = part.thoughtSignature;
        if (part.text) {
          current.text += part.text;
          sawContent = true;
          yield { type: type === "text" ? "text-delta" : "reasoning-delta", index: current.index, text: part.text };
        }
      }
      if (isRecord(part.functionCall)) {
        yield* close();
        const given = asString(part.functionCall.id);
        const id = given && !seenIds.has(given) ? given : `${callIdFor(part.functionCall.name ?? "call")}_${randomBytes(4).toString("hex")}`;
        seenIds.add(id);
        const index = blockCount++;
        const args = JSON.stringify(isRecord(part.functionCall.args) ? part.functionCall.args : {});
        replay.push(asString(part.thoughtSignature) ? { thoughtSignature: part.thoughtSignature } : {});
        calls += 1;
        sawContent = true;
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id, name: String(part.functionCall.name ?? ""), argumentsDelta: args };
        yield { type: "block-end", index, block: { type: "tool-call", id, name: String(part.functionCall.name ?? ""), arguments: args } };
      }
    }
    if (asString(candidate?.finishReason)) finishReason = candidate.finishReason;
  }
  yield* close();
  if (!finishReason) throw cnError(CODES.transport, `${meta.endpointName}：回答在结束前中断`, { kind: "transport" });
  if (!sawContent) {
    if (SAFETY.has(finishReason)) throw cnError(CODES.badRequest, `${meta.endpointName}：内容审核未通过（${finishReason}）`, { kind: "moderation" });
    throw cnError(CODES.empty, `${meta.endpointName} 没有返回内容（${meta.model}，${finishReason}）`, { kind: "empty" });
  }
  const mapped = mapUsage(usage);
  if (mapped) yield { type: "usage", usage: mapped };
  let finish;
  if (calls > 0 && finishReason === "STOP") finish = { kind: "tool-calls" };
  else if (finishReason === "STOP") finish = { kind: "stop" };
  else if (finishReason === "MAX_TOKENS") finish = { kind: "max-tokens" };
  else if (SAFETY.has(finishReason)) finish = { kind: "error", failure: { message: `内容审核未通过（${finishReason}）`, code: CODES.badRequest } };
  else finish = { kind: "error", failure: { message: `回答异常结束（${finishReason}）`, code: CODES.server } };
  yield { type: "finish", reason: finish, replayState: replayState(meta, replay) };
}
