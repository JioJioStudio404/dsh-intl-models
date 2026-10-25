/**
 * The harness adapter: one DSH route per endpoint that has keys
 * (`intl-openai`, `intl-anthropic`, …), duck-typed `LlmAdapter`.
 *
 * Each model speaks its own protocol (Responses, Messages, Chat Completions
 * or Gemini — OpenCode and OpenRouter mix them). A request starts on the
 * endpoint's active key; if that key cannot serve it (dead, out of balance,
 * a spend cap reached — known from an earlier answer or a check) or the
 * vendor refuses it for one of those reasons before anything was streamed,
 * the next usable key of the same endpoint, in the tab's order, takes the same
 * request and becomes active. Rate limits are per organization or project,
 * so they are left to the harness's retry unless the user lets them switch
 * keys too. A refusal of the request itself (moderation, a bad parameter, too
 * long, a region the vendor does not serve) never switches keys.
 *
 * @module dsh-intl-models/adapter
 */
import { blockedReason, estimateCost, parseModelList, toModelInfo } from "./catalog.js";
import { classifyFailure, KIND_LABELS, resolveEffort, ROTATE_KINDS } from "./dialects.js";
import { VENDORS, displayNameOf, endpointById, endpointFor, endpointOfRoute } from "./endpoints.js";
import { cnError, CODES, redact } from "./errors.js";
import { vendorSettings } from "./keys.js";
import { statusFromFailure } from "./probe.js";
import { protocolOf } from "./protocols/index.js";
import { requestTarget, sessionIdOf } from "./request.js";
import { openStream, requestJson } from "./wire.js";

/** A vendor's tab label, for advice in error messages. */
const tabOfVendor = (vendor) => VENDORS.find((item) => item.id === vendor)?.tab ?? vendor;

/** How long a key is passed over after a refusal that names no time. */
const FORBIDDEN_HOLD_MS = 10 * 60_000;
const RATE_HOLD_MS = 60_000;

/** How each endpoint lists its models (the endpoint as one key sees it: see endpointFor). */
export function modelListRequest(endpoint) {
  if (endpoint.modelsUrl) return { url: endpoint.modelsUrl, auth: "bearer" };
  switch (endpoint.check.validity) {
    case "anthropic": return { url: `${endpoint.baseUrl}/models?limit=1000`, auth: "anthropic" };
    case "gemini": return { url: `${endpoint.baseUrl}/models?pageSize=1000`, auth: "gemini" };
    default: return { url: `${endpoint.baseUrl}/models`, auth: "bearer" };
  }
}

export class IntlAdapter {
  #keys;
  #catalog;
  #attachments;
  #fetch;
  #log;
  #onModelsChanged;
  #onSwitched;
  #onUsed;
  #idleMs;
  #refreshing = new Map();

  /**
   * @param {object} options - wiring: `keys` (KeyStore), `catalog` (CatalogStore),
   * `attachments` (resolves the DSH attachment service), `fetchImpl`, `log`,
   * `onModelsChanged()`, `onSwitched(endpointId, from, to, reason, detail)`,
   * `onUsed(keyId)`, `idleMs`.
   */
  constructor({ keys, catalog, attachments, fetchImpl = fetch, log = () => {}, onModelsChanged = () => {}, onSwitched = () => {}, onUsed = () => {}, idleMs = 600_000 }) {
    this.#keys = keys;
    this.#catalog = catalog;
    this.#attachments = attachments ?? (() => undefined);
    this.#fetch = fetchImpl;
    this.#log = log;
    this.#onModelsChanged = onModelsChanged;
    this.#onSwitched = onSwitched;
    this.#onUsed = onUsed;
    this.#idleMs = idleMs;
  }

  providerInfo(route) {
    const endpoint = endpointOfRoute(route);
    return { id: route, name: endpoint ? displayNameOf(endpoint) : route };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  /** The size and byte budget an image is sent at (DSH 0.2.1 calls this directly). */
  imageRequestTarget(_route, _model, image) {
    return requestTarget(image);
  }

  /** The endpoint's selected models; a stale live list refreshes in the background. */
  async listModels(route) {
    const endpoint = endpointOfRoute(route);
    if (!endpoint) return [];
    if (await this.#catalog.stale(endpoint.id)) this.refreshModelsInBackground(endpoint.id);
    return (await this.#catalog.selected(endpoint.id)).map((entry) => toModelInfo(route, entry));
  }

  /** Metadata for one exact id, selected or not. */
  async resolveModel(route, model) {
    const endpoint = endpointOfRoute(route);
    return toModelInfo(route, await this.#catalog.find(endpoint?.id, model));
  }

  async prepareCall(route, model, signal) {
    const info = await this.resolveModel(route, model, signal);
    return { model: info, stream: (options) => this.stream({ ...options, provider: route, model }) };
  }

  /**
   * Fetch an endpoint's live model list with one of its keys (the active one
   * first; a key without balance still lists models).
   * @returns `{ ok, count }`.
   */
  async refreshModels(endpointId, { signal } = {}) {
    const endpoint = endpointById(endpointId);
    if (!endpoint?.liveModels) return { ok: false, reason: "this endpoint has no model list" };
    const active = await this.#keys.active(endpointId);
    const candidates = [active, ...(await this.#keys.keysFor(endpointId))]
      .filter((record, index, list) => record && list.indexOf(record) === index && !["invalid", "expired"].includes(record.status));
    for (const record of candidates) {
      const target = endpointFor(endpoint, record);
      if (!target) continue;
      const { url, auth } = modelListRequest(target);
      const response = await requestJson(url, record.key, { auth, fetchImpl: this.#fetch, signal });
      if (!response.ok) continue;
      const entries = parseModelList(response.body, endpoint);
      if (entries.length === 0) continue;
      await this.#catalog.storeLive(endpointId, entries);
      this.#onModelsChanged();
      return { ok: true, count: entries.length };
    }
    return { ok: false, reason: "no key could list the models" };
  }

  /** {@link refreshModels} without blocking; one per endpoint at a time. */
  refreshModelsInBackground(endpointId) {
    if (this.#refreshing.has(endpointId)) return this.#refreshing.get(endpointId);
    const run = this.refreshModels(endpointId)
      .catch((error) => this.#log("warn", `model list of ${endpointId} not refreshed: ${redact(error?.message ?? error)}`))
      .finally(() => this.#refreshing.delete(endpointId));
    this.#refreshing.set(endpointId, run);
    return run;
  }

  /** The key a request starts with, or the next one to try. */
  async #pick(endpoint, tried) {
    const state = await this.#keys.read();
    const own = state.keys.filter((record) => record.endpoint === endpoint.id);
    const active = own.find((record) => record.id === state.endpoints[endpoint.id]?.activeKeyId) ?? own[0];
    const ready = (record) => record && !tried.has(record.id) && this.#keys.usable(record);
    if (ready(active)) return active;
    if (vendorSettings(state, endpoint.vendor).autoSwitch) {
      for (const record of own) if (ready(record)) return record;
    }
    // Nothing better: the active key is tried once anyway (a hold may have ended early).
    if (active && !tried.has(active.id) && !["invalid", "expired"].includes(active.status)) return active;
    return undefined;
  }

  /** Why a request does not start on the active key (when it does not). */
  async #whyNotActive(endpoint, record) {
    const state = await this.#keys.read();
    const activeId = state.endpoints[endpoint.id]?.activeKeyId;
    if (!record || !activeId || activeId === record.id) return undefined;
    const active = state.keys.find((item) => item.id === activeId);
    if (!active) return undefined;
    if (active.status === "invalid" || active.status === "expired") return active.status === "invalid" ? "invalid-key" : "expired";
    return active.limitedReason ?? "unusable";
  }

  /**
   * Remember what a refusal says about the key. A hold never gets shorter:
   * a spend cap known to lift on the 1st is not cut to a guess by the refusal
   * of a request that tried anyway.
   */
  async #mark(record, error) {
    const now = Date.now();
    const kind = error?.kind;
    let patch;
    if (kind === "forbidden") patch = { limitedUntil: now + FORBIDDEN_HOLD_MS, limitedReason: "forbidden", limitedExact: false, statusMessage: error.message };
    else if (kind === "rate-limit") patch = { limitedUntil: now + (error.failure?.providerRetryAfterMs ?? RATE_HOLD_MS), limitedReason: "rate-limit", limitedExact: false };
    else patch = { ...statusFromFailure({ kind, message: error.message, resetAt: error.resetAt }, now), checkedAt: new Date(now).toISOString() };
    const current = await this.#keys.get(record.id);
    const currentHeld = typeof current?.limitedUntil === "number" && current.limitedUntil > Date.now();
    if (typeof patch.limitedUntil === "number" && currentHeld) {
      // The vendor's own reset time beats a guess, sooner or later; between two guesses the longer stands.
      const keepCurrent = current.limitedExact === true ? patch.limitedExact !== true : patch.limitedExact !== true && current.limitedUntil > patch.limitedUntil;
      if (keepCurrent) {
        patch.limitedUntil = current.limitedUntil;
        patch.limitedExact = current.limitedExact;
      }
    }
    await this.#keys.patch(record.id, patch);
  }

  /**
   * The error for "no key of this endpoint can serve". It names the earliest
   * recovery only when a vendor said when (a spend cap's date, a daily quota);
   * a guessed hold (no balance) is a retry time, not a promise, and reads as advice.
   */
  async #exhausted(endpoint, first) {
    const own = await this.#keys.keysFor(endpoint.id);
    const now = Date.now();
    const held = own.filter((record) => typeof record.limitedUntil === "number" && record.limitedUntil > now);
    // What this request met comes first; then what the store says of the other keys.
    const met = first?.kind && first.kind !== "exhausted" ? [first.kind === "invalid-key" ? "invalid" : first.kind] : [];
    const reasons = [...new Set([...met, ...own.map((record) => (record.status === "ok" || record.status === "unknown" ? record.limitedReason : record.status))].filter(Boolean))];
    const labels = reasons.map((reason) => KIND_LABELS[reason === "invalid" ? "invalid-key" : reason] ?? reason).join("、");
    const exact = held.filter((record) => record.limitedExact).map((record) => record.limitedUntil);
    const wait = held.length ? Math.min(...held.map((record) => record.limitedUntil)) - now : undefined;
    const tab = tabOfVendor(endpoint.vendor);
    const when = exact.length
      ? `，最早 ${new Date(Math.min(...exact)).toLocaleString("zh-CN", { hour12: false })} 恢复`
      : reasons.includes("no-balance") ? `，请充值后在 ${tab} 标签页点 ✓ 重新检测`
        : reasons.some((reason) => reason === "invalid" || reason === "expired") ? `，请在 ${tab} 标签页更换 Key`
          : held.length ? `，约 ${new Date(now + wait).toLocaleTimeString("zh-CN", { hour12: false })} 自动重试` : "";
    // With no request made, every key is dead (invalid, no plan) or held (no money, used up).
    const dead = reasons.length > 0 && reasons.every((reason) => reason === "invalid" || reason === "expired");
    return cnError(first?.code ?? (dead ? CODES.auth : CODES.quota), `${displayNameOf(endpoint)}：${own.length} 个 Key 都不可用（${labels || "无可用 Key"}）${when}`, {
      status: first?.status,
      retryAfterMs: wait,
      kind: first?.kind ?? "exhausted",
      endpoint: endpoint.id,
    });
  }

  /**
   * Stream one call.
   * @param {object} options - harness GenerateOptions (+ provider, model).
   */
  async *stream(options) {
    const endpoint = endpointOfRoute(options.provider);
    if (!endpoint) throw cnError(CODES.unknownModel, `unknown route "${options.provider}"`);
    const model = await this.#catalog.find(endpoint.id, options.model);
    // A model that can never answer here (OpenCode's free tier) fails at once, without a request or a key switch.
    const blocked = blockedReason(model, endpoint);
    if (blocked) throw cnError(CODES.badRequest, `${displayNameOf(endpoint)}：${model.id}：${blocked}（请在模型列表里换用付费模型）`, { kind: "free-tier", endpoint: endpoint.id });
    const effort = resolveEffort(model, options.reasoningEffort, options.purpose);
    const tried = new Set();
    let record = await this.#pick(endpoint, tried);
    if (!record) {
      const own = await this.#keys.keysFor(endpoint.id);
      if (own.length === 0) throw cnError(CODES.missing, `${displayNameOf(endpoint)} 还没有 Key，请在 ${tabOfVendor(endpoint.vendor)} 标签页添加。`);
      throw await this.#exhausted(endpoint);
    }
    const startReason = await this.#whyNotActive(endpoint, record);
    let first;
    while (record) {
      const current = record;
      tried.add(record.id);
      let started = false;
      try {
        for await (const chunk of this.#streamWith(record, endpoint, model, effort, options)) {
          started = true;
          yield chunk;
        }
        const state = await this.#keys.read();
        const from = state.endpoints[endpoint.id]?.activeKeyId ?? null;
        if (from !== record.id) {
          await this.#keys.setActive(record.id);
          this.#onSwitched(endpoint.id, from, record.id, first?.kind ?? startReason ?? "unusable", { model: model.id });
        }
        return;
      } catch (error) {
        if (started || options.signal?.aborted) throw error;
        if (error?.kind === "not-found" || error?.kind === "free-tier" || error?.kind === "paid-model") {
          this.#catalog.markUnusable(endpoint.id, model.id, error.message);
          this.#onModelsChanged();
        }
        const settings = vendorSettings(await this.#keys.read(), endpoint.vendor);
        const switchable = ROTATE_KINDS.has(error?.kind) || (error?.kind === "rate-limit" && settings.rotateOnRateLimit);
        if (!switchable) throw error;
        first ??= error;
        await this.#mark(record, error).catch(() => undefined);
        if (!settings.autoSwitch) throw error;
        const next = await this.#pick(endpoint, tried);
        if (!next) throw await this.#exhausted(endpoint, first);
        this.#log("warn", `${endpoint.id}: switching from ${record.id} to ${next.id} (${error.kind})`);
        record = next;
      } finally {
        // Served or refused, this key's balance changed: re-read it shortly.
        this.#onUsed(current.id);
      }
    }
    throw first ?? (await this.#exhausted(endpoint));
  }

  /** One attempt with one key, in the model's protocol. */
  async *#streamWith(record, endpoint, model, effort, options) {
    const protocol = protocolOf(model.protocol ?? endpoint.protocol);
    // The endpoint as this key sees it (Cloudflare: its account in the URL, its gateway in a header).
    const target = endpointFor(endpoint, record);
    if (!target) throw cnError(CODES.auth, `${displayNameOf(endpoint)}：这个 Key 缺少 ${endpoint.params.filter((param) => param.required).map((param) => param.label).join("、")}，请在 ${tabOfVendor(endpoint.vendor)} 标签页编辑`, { kind: "invalid-key", keyId: record.id, endpoint: endpoint.id });
    const request = await protocol.buildRequest({ options, endpoint: target, model, effort, attachments: this.#attachments() });
    // OpenCode: one stable session id per conversation, whatever the protocol.
    const headers = { ...target.headers, ...request.headers, ...(endpoint.sessionHeader ? { [endpoint.sessionHeader]: sessionIdOf(options) } : {}) };
    const opened = await openStream(request.url, record.key, request.body, { auth: request.auth, headers, signal: options.signal, fetchImpl: this.#fetch, idleMs: this.#idleMs });
    if (!opened.response) {
      const failure = classifyFailure(endpoint.vendor, opened.status, opened.text, { plan: Boolean(endpoint.plan), headers: opened.headers });
      const advice = failure.kind === "region" ? "（请在 $DSH_HOME/.env 设置 HTTPS_PROXY，或开启代理的 TUN 模式）"
        : failure.kind === "free-tier" ? "（请在模型列表里换用付费模型）"
          : failure.kind === "paid-model" ? "（请换用免费层可用的模型，或在 Vercel 购买额度后在模型窗口点「获取列表」）" : "";
      throw cnError(failure.code, `${displayNameOf(endpoint)}：${KIND_LABELS[failure.kind] ?? "请求失败"}（${opened.status || "网络"}）：${failure.message}${advice}`, {
        status: opened.status || undefined,
        retryAfterMs: failure.retryAfterMs,
        kind: failure.kind,
        keyId: record.id,
        endpoint: endpoint.id,
        resetAt: failure.resetAt,
        vendorCode: failure.vendorCode,
      });
    }
    let usage;
    const report = {};
    for await (const chunk of protocol.parseStream(opened.response, {
      vendor: endpoint.vendor,
      endpoint: endpoint.id,
      endpointName: displayNameOf(endpoint),
      protocol: protocol.PROTOCOL,
      model: model.id,
      keyId: record.id,
      plan: Boolean(endpoint.plan),
      idle: opened.idle,
      report,
    })) {
      if (chunk.type === "usage") usage = chunk.usage;
      yield chunk;
    }
    // The key's local counters (today, this month), with what the request cost:
    // the vendor's own figure when it gives one, else the catalog's prices.
    // A Workers AI request is counted in neurons, not priced per token (the free allocation comes first).
    const cost = Number.isFinite(report.cost) ? report.cost : Number.isFinite(report.neurons) ? 0 : estimateCost(model, usage);
    this.#keys.noteUsage(record.id, { ...usage, ...(Number.isFinite(report.neurons) ? { neurons: report.neurons } : {}) }, cost, model.id).catch(() => undefined);
  }
}
