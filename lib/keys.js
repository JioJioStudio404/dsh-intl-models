/**
 * The key store.
 *
 * One file, `$DSH_HOME/storages/intl-models-keys.json` (mode 0600), holds every
 * API key with its endpoint, label, last known state (valid, balance, why and
 * until when it is held back), and local usage counts with their cost; plus
 * which key each endpoint uses now and the switching settings. The same design
 * as dsh-antigravity-local's account store: writes are serialized within the
 * process and land atomically (sibling `.new` + rename), and a file changed by
 * another process is re-read on its next use.
 *
 * {@link summarizeKey} carries the key itself (the user asked to see keys in
 * full in the vendor tabs; the page gets it over the authenticated Remote
 * gateway) plus a masked form for compact places. Logs and error messages
 * still redact every key shape.
 *
 * @module dsh-intl-models/keys
 */
import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { VENDOR_IDS, endpointById } from "./endpoints.js";
import { asString, isRecord, safeJson } from "./errors.js";
import { keysPath } from "./paths.js";

const VERSION = 1;

/**
 * Rename a finished temp file over the store. Windows refuses a rename onto a
 * file another writer or reader holds this instant (EPERM / EACCES / EBUSY);
 * that clears within milliseconds, so retry briefly. A final failure removes
 * the temp file and surfaces.
 */
export async function replaceFile(fs, from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 8) {
        try {
          await fs.rm?.(from, { force: true });
        } catch {
          /* best effort */
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/** States a key can be in. `unknown`: not checked yet. */
export const STATUSES = Object.freeze(["unknown", "ok", "invalid", "expired", "no-balance", "plan-quota", "error"]);
/** Dead until the user changes or re-tests it. */
const DEAD = new Set(["invalid", "expired"]);

/**
 * A stable key id from its endpoint and value — and the account it works in,
 * where the endpoint has one (the same Cloudflare token in two accounts is two keys).
 */
export function keyIdOf(endpoint, key, params) {
  const account = typeof params?.account === "string" && params.account ? `\n${params.account}` : "";
  return `key_${createHash("sha256").update(`${endpoint}\n${key}${account}`).digest("hex").slice(0, 12)}`;
}

/** `f2ec…d125`: an account id, short. */
export const maskAccount = (value) => (typeof value === "string" && value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value ?? null);

/** `sk-ant-api03-…5AAA`: a key's type prefix and last four characters. */
export function maskKey(key) {
  const value = String(key ?? "");
  if (value.length <= 10) return "•".repeat(Math.max(4, value.length));
  const prefix = /^(sk-ant-api\d+-|sk-ant-|sk-or-v\d+-|sk-proj-|sk-svcacct-|sk-admin-|sk-|xai-|AIza|AQ\.|cf[ua]t_|vck_)/.exec(value)?.[1] ?? value.slice(0, 3);
  return `${prefix}…${value.slice(-4)}`;
}

/** The plan a key's endpoint is (OpenCode Go), or null. */
export function planLabelOf(record) {
  return endpointById(record?.endpoint)?.plan ?? null;
}

/** What a key's funds column shows: "balance" (OpenRouter, Vercel), "quota" (Cloudflare), or null when the vendor shows nothing. */
function fundsOf(record, endpoint) {
  return endpoint?.check?.funds ? "balance" : endpoint?.check?.quota ? "quota" : null;
}

/** Whether a key is a subscription key (by its endpoint). */
export function isPlanKey(record) {
  return Boolean(endpointById(record?.endpoint)?.plan);
}

const pad = (value) => String(value).padStart(2, "0");
/** Local calendar day and month, for usage buckets. */
export const dayOf = (ms) => { const date = new Date(ms); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export const monthOf = (ms) => dayOf(ms).slice(0, 7);

const emptyBucket = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, neurons: 0 });
const emptyState = () => ({ version: VERSION, autoSwitch: true, rotateOnRateLimit: false, vendors: {}, hiddenVendors: [], endpoints: {}, keys: [] });

/** One vendor's switching settings (unset ones follow the store-wide defaults). */
export function vendorSettings(state, vendor) {
  const own = isRecord(state?.vendors?.[vendor]) ? state.vendors[vendor] : {};
  return {
    autoSwitch: typeof own.autoSwitch === "boolean" ? own.autoSwitch : state?.autoSwitch !== false,
    rotateOnRateLimit: typeof own.rotateOnRateLimit === "boolean" ? own.rotateOnRateLimit : state?.rotateOnRateLimit === true,
  };
}

/** Coerce whatever is on disk into a valid state. */
function coerce(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.keys)) return emptyState();
  const keys = raw.keys.filter((record) => isRecord(record) && asString(record.id) && asString(record.key) && endpointById(record.endpoint));
  const endpoints = {};
  for (const [id, value] of Object.entries(isRecord(raw.endpoints) ? raw.endpoints : {})) {
    if (!endpointById(id) || !isRecord(value)) continue;
    const own = keys.filter((record) => record.endpoint === id);
    if (own.length === 0) continue;
    endpoints[id] = { ...value, activeKeyId: own.some((record) => record.id === value.activeKeyId) ? value.activeKeyId : own[0].id };
  }
  for (const record of keys) {
    if (!endpoints[record.endpoint]) endpoints[record.endpoint] = { activeKeyId: record.id };
  }
  const vendors = {};
  for (const [id, value] of Object.entries(isRecord(raw.vendors) ? raw.vendors : {})) {
    if (!VENDOR_IDS.includes(id) || !isRecord(value)) continue;
    vendors[id] = Object.fromEntries(Object.entries(value).filter(([name, item]) => ["autoSwitch", "rotateOnRateLimit"].includes(name) && typeof item === "boolean"));
  }
  const hidden = Array.isArray(raw.hiddenVendors) ? [...new Set(raw.hiddenVendors.filter((id) => VENDOR_IDS.includes(id)))] : [];
  // At least one vendor tab stays visible.
  const hiddenVendors = hidden.length >= VENDOR_IDS.length ? hidden.slice(0, VENDOR_IDS.length - 1) : hidden;
  return { version: VERSION, autoSwitch: raw.autoSwitch !== false, rotateOnRateLimit: raw.rotateOnRateLimit === true, vendors, hiddenVendors, endpoints, keys };
}

/** One key's usage, with buckets from another day or month read as empty. */
function usageView(record, now) {
  const day = record.usage?.day?.date === dayOf(now) ? record.usage.day : { date: dayOf(now), ...emptyBucket() };
  const month = record.usage?.month?.month === monthOf(now) ? record.usage.month : { month: monthOf(now), ...emptyBucket() };
  return { day, month };
}

/**
 * The public, secret-free view of one key.
 * @param {object} record - stored key.
 * @param {string | null} activeId - the endpoint's active key id.
 */
export function summarizeKey(record, activeId, now = Date.now()) {
  const endpoint = endpointById(record.endpoint);
  return {
    id: record.id,
    endpoint: record.endpoint,
    label: record.label ?? null,
    key: record.key,
    masked: maskKey(record.key),
    planLabel: planLabelOf(record),
    plan: isPlanKey(record),
    active: record.id === activeId,
    // What the key needs besides itself (Cloudflare: its account and gateway), and the account short.
    params: record.params ?? null,
    account: maskAccount(record.params?.account),
    status: record.status ?? "unknown",
    statusMessage: record.statusMessage ?? null,
    checkedAt: record.checkedAt ?? null,
    // The two checks, apart: when the vendor last accepted the key, and when its funds were last read.
    validatedAt: record.validatedAt ?? null,
    validityError: record.validityError ?? null,
    quotaAt: record.quotaAt ?? null,
    quotaError: record.quotaError ?? null,
    // Why the vendor's quota cannot be shown for this key (a permission it lacks), when it cannot.
    quotaHint: record.quotaHint ?? null,
    // When a request last proved there is money behind the key (a probe or a served request), on which model, and a probe that got no verdict.
    probedAt: record.probedAt ?? null,
    probeModel: record.probeModel ?? null,
    probeError: record.probeError ?? null,
    probeNote: record.probeNote ?? null,
    // What the vendor shows for this key: "balance", "quota", or null (nothing to read).
    funds: fundsOf(record, endpoint),
    balance: record.balance ?? null,
    quota: record.quota ?? null,
    limitedUntil: typeof record.limitedUntil === "number" && record.limitedUntil > now ? new Date(record.limitedUntil).toISOString() : null,
    limitedReason: typeof record.limitedUntil === "number" && record.limitedUntil > now ? record.limitedReason ?? null : null,
    // Whether the hold ends at the vendor's own reset time (else it is when the plugin tries again).
    limitedExact: typeof record.limitedUntil === "number" && record.limitedUntil > now ? record.limitedExact === true : null,
    // A custom base URL is shown by host only.
    customHost: record.baseUrl && endpoint && record.baseUrl !== endpoint.baseUrl ? new URL(record.baseUrl).host : null,
    usage: usageView(record, now),
    lastUsedAt: record.lastUsedAt ?? null,
    source: record.source ?? null,
    addedAt: record.addedAt ?? null,
  };
}

export class KeyStore {
  #file;
  #fs;
  #now;
  #chain = Promise.resolve();
  #cache;
  #cacheStamp;

  /**
   * @param {object} [options] - wiring.
   * @param {string} [options.file] - store path (default `$DSH_HOME/storages/intl-models-keys.json`).
   * @param {object} [options.fs] - `node:fs/promises` or a test double.
   * @param {() => number} [options.now] - clock.
   */
  constructor({ file = keysPath(), fs = defaultFs, now = () => Date.now() } = {}) {
    this.#file = file;
    this.#fs = fs;
    this.#now = now;
  }

  /** The store's path. */
  path() {
    return this.#file;
  }

  /** Current state, re-read when another process changed the file. */
  async read() {
    let stamp;
    try {
      const info = await this.#fs.stat(this.#file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stamp = "absent";
    }
    if (this.#cache !== undefined && stamp === this.#cacheStamp) return this.#cache;
    let state = emptyState();
    if (stamp !== "absent") {
      try {
        state = coerce(safeJson(await this.#fs.readFile(this.#file, "utf8")));
      } catch {
        state = emptyState();
      }
    }
    this.#cache = state;
    this.#cacheStamp = stamp;
    return state;
  }

  async #write(state) {
    await this.#fs.mkdir(dirname(this.#file), { recursive: true });
    // A unique sibling per write: another store instance or process writing at the same time
    // (the terminal importer, a second mount) cannot rename this one away first.
    const next = `${this.#file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.new`;
    await this.#fs.writeFile(next, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await replaceFile(this.#fs, next, this.#file);
    this.#cache = state;
    try {
      const info = await this.#fs.stat(this.#file);
      this.#cacheStamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      this.#cacheStamp = undefined;
    }
  }

  /**
   * Serialized read-modify-write. `fn` receives a deep copy and returns the
   * next state (or undefined to leave the file untouched) plus a result.
   */
  mutate(fn) {
    const run = this.#chain.then(async () => {
      const current = structuredClone(await this.read());
      const outcome = await fn(current);
      if (outcome?.state !== undefined) await this.#write(coerce(outcome.state));
      return outcome?.result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Every key, in their stored (drag) order. */
  async keys() {
    return (await this.read()).keys;
  }

  /** One endpoint's keys, in order. */
  async keysFor(endpointId) {
    return (await this.keys()).filter((record) => record.endpoint === endpointId);
  }

  /** One key by id. */
  async get(id) {
    return (await this.keys()).find((record) => record.id === id);
  }

  /** Endpoints that have at least one key, in first-key order. */
  async endpointIds() {
    return [...new Set((await this.keys()).map((record) => record.endpoint))];
  }

  /** The key an endpoint uses now. */
  async active(endpointId) {
    const state = await this.read();
    const own = state.keys.filter((record) => record.endpoint === endpointId);
    return own.find((record) => record.id === state.endpoints[endpointId]?.activeKeyId) ?? own[0];
  }

  /** The public view of the whole store. */
  async summary() {
    const state = await this.read();
    const now = this.#now();
    return {
      autoSwitch: state.autoSwitch,
      rotateOnRateLimit: state.rotateOnRateLimit,
      vendorSettings: Object.fromEntries(VENDOR_IDS.map((id) => [id, vendorSettings(state, id)])),
      hiddenVendors: state.hiddenVendors,
      endpoints: Object.fromEntries(Object.entries(state.endpoints).map(([id, value]) => [id, { activeKeyId: value.activeKeyId }])),
      keys: state.keys.map((record) => summarizeKey(record, state.endpoints[record.endpoint]?.activeKeyId ?? null, now)),
    };
  }

  /**
   * Add a key, or update the same key on the same endpoint.
   * @param {object} input - `{ endpoint, key, label?, baseUrl?, params?, source? }`.
   * @returns `{ record, created }`.
   */
  async add({ endpoint, key, label, baseUrl, params, source }) {
    const now = this.#now();
    const own = params && Object.keys(params).length ? params : undefined;
    return this.mutate((state) => {
      const id = keyIdOf(endpoint, key, own);
      const existing = state.keys.find((record) => record.id === id);
      const record = {
        ...existing,
        id,
        endpoint,
        key,
        ...(asString(label) ? { label: label.trim().slice(0, 60) } : {}),
        ...(asString(baseUrl) ? { baseUrl } : {}),
        ...(own ? { params: own } : {}),
        status: existing?.status ?? "unknown",
        source: existing?.source ?? source ?? null,
        addedAt: existing?.addedAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      const keys = existing ? state.keys.map((item) => (item === existing ? record : item)) : [...state.keys, record];
      return { state: { ...state, keys }, result: { record, created: !existing } };
    });
  }

  /** Change a key's label, base URL (`null` clears either) or params (the account id stays: it is part of the key). */
  async update(id, { label, baseUrl, params } = {}) {
    return this.mutate((state) => {
      const record = state.keys.find((item) => item.id === id);
      if (!record) return { result: false };
      if (label !== undefined) record.label = asString(label?.trim?.()) ? label.trim().slice(0, 60) : null;
      if (baseUrl !== undefined) {
        if (asString(baseUrl)) record.baseUrl = baseUrl;
        else delete record.baseUrl;
        // A changed address is a new chance: re-check before trusting the old verdict.
        record.status = "unknown";
        delete record.limitedUntil;
      }
      if (params !== undefined) {
        const next = { ...record.params, ...params };
        for (const [name, value] of Object.entries(next)) if (value === null || value === "") delete next[name];
        record.params = next;
      }
      record.updatedAt = new Date(this.#now()).toISOString();
      return { state, result: true };
    });
  }

  /** Forget one key. */
  async remove(id) {
    return this.mutate((state) => {
      const keys = state.keys.filter((record) => record.id !== id);
      return keys.length === state.keys.length ? { result: false } : { state: { ...state, keys }, result: true };
    });
  }

  /**
   * Put one endpoint's keys in the given order (the tab's drag order, which is
   * also the order switching tries them in). Unknown ids are ignored; the
   * endpoint's other keys keep their relative order after the listed ones.
   */
  async reorder(endpointId, ids) {
    return this.mutate((state) => {
      const own = state.keys.filter((record) => record.endpoint === endpointId);
      const listed = [...new Set(ids)].map((id) => own.find((record) => record.id === id)).filter(Boolean);
      const ordered = [...listed, ...own.filter((record) => !listed.includes(record))];
      let index = 0;
      const keys = state.keys.map((record) => (record.endpoint === endpointId ? ordered[index++] : record));
      if (keys.every((record, position) => record === state.keys[position])) return { result: false };
      return { state: { ...state, keys }, result: true };
    });
  }

  /** Make one key its endpoint's active key. */
  async setActive(keyId) {
    return this.mutate((state) => {
      const record = state.keys.find((item) => item.id === keyId);
      if (!record) return { result: false };
      if (state.endpoints[record.endpoint]?.activeKeyId === keyId) return { result: true };
      return { state: { ...state, endpoints: { ...state.endpoints, [record.endpoint]: { ...state.endpoints[record.endpoint], activeKeyId: keyId } } }, result: true };
    });
  }

  /** Merge non-secret facts into one key (status, balance, quota, limits). */
  async patch(id, values) {
    return this.mutate((state) => {
      const record = state.keys.find((item) => item.id === id);
      if (!record) return { result: false };
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete record[name];
        else record[name] = value;
      }
      return { state, result: true };
    });
  }

  /**
   * Count one finished request against today's and this month's buckets.
   * `cost`: what it cost in USD (reported by the vendor, or estimated from prices).
   * A served request also proves the key usable: an older "no balance" or
   * "used up" verdict (and its hold) is over.
   */
  async noteUsage(id, usage = {}, cost, model) {
    const now = this.#now();
    return this.mutate((state) => {
      const record = state.keys.find((item) => item.id === id);
      if (!record) return { result: false };
      const { day, month } = usageView(record, now);
      for (const bucket of [day, month]) {
        bucket.requests += 1;
        bucket.input += Number(usage.inputTokens) || 0;
        bucket.output += Number(usage.outputTokens) || 0;
        bucket.cacheRead += Number(usage.cacheReadTokens) || 0;
        bucket.cacheWrite += Number(usage.cacheWriteTokens) || 0;
        bucket.cost = (Number(bucket.cost) || 0) + (Number.isFinite(cost) && cost > 0 ? cost : 0);
        bucket.neurons = (Number(bucket.neurons) || 0) + (Number(usage.neurons) || 0);
      }
      record.usage = { day, month };
      record.lastUsedAt = new Date(now).toISOString();
      record.probedAt = record.lastUsedAt;
      if (model) record.probeModel = model;
      delete record.probeError;
      if (record.status !== "ok") {
        record.status = "ok";
        record.statusMessage = null;
      }
      if (record.limitedReason === "no-balance" || record.limitedReason === "plan-quota") {
        for (const name of ["limitedUntil", "limitedReason", "limitedExact"]) delete record[name];
      }
      return { state, result: true };
    });
  }

  /**
   * Switching settings: one vendor's (with `vendor`), else the defaults every
   * vendor without its own follows. `hiddenVendors`: vendor tabs not shown.
   */
  async setSettings({ vendor, autoSwitch, rotateOnRateLimit, hiddenVendors } = {}) {
    return this.mutate((state) => {
      const patch = {
        ...(typeof autoSwitch === "boolean" ? { autoSwitch } : {}),
        ...(typeof rotateOnRateLimit === "boolean" ? { rotateOnRateLimit } : {}),
      };
      const next = vendor
        ? { ...state, vendors: { ...state.vendors, [vendor]: { ...state.vendors?.[vendor], ...patch } } }
        : { ...state, ...patch };
      if (Array.isArray(hiddenVendors)) next.hiddenVendors = hiddenVendors;
      return { state: next, result: true };
    });
  }

  /** Whether a key may serve a request now. */
  usable(record) {
    if (!record || DEAD.has(record.status)) return false;
    return !(typeof record.limitedUntil === "number" && record.limitedUntil > this.#now());
  }
}
