/**
 * The `intlModels` Remote namespace: key and model management for the
 * browser half (the vendor tabs and the Models-page cards).
 *
 * It goes through the DSH Remote gateway rather than a raw `webServer` route
 * (web routes carry no authentication). The status carries each key in full
 * (shown in the vendor tabs) and masked; logs and error messages never carry
 * one.
 *
 * @module dsh-intl-models/service
 */
import * as defaultFs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENDPOINTS, VENDORS, VENDOR_IDS, candidateEndpoints, checkParams, displayNameOf, endpointById, normalizeVendor, vendorOfKeyShape } from "./endpoints.js";
import { asString, cnError, CODES, isRecord, redact } from "./errors.js";
import { maskKey } from "./keys.js";
import { dshHome } from "./paths.js";
import { authenticated, checkKey, detectEndpoint, fundsKind, probeKind } from "./probe.js";

/** The property Typert's `remoteMethods()` reads (a plain string in dsh-typert-protocol). */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** Remote methods, in manifest order. */
export const REMOTE_METHODS = [
  "status",
  "checkKeys",
  "addKeys",
  "importDshKeys",
  "updateKey",
  "removeKey",
  "switchKey",
  "reorderKeys",
  "refreshModels",
  "updateSettings",
  "exportKeys",
];

/** How `checkKeys` may check: see probe.js. */
const CHECK_MODES = ["auto", "validity", "funds"];
/** At most this many keys in one paste. */
const MAX_KEYS_PER_ADD = 50;
/** Keys of one paste are detected and checked this many at a time. */
const ADD_CONCURRENCY = 4;
/** Key shapes in pasted text: `sk-…` (OpenAI, Anthropic, OpenRouter, OpenCode), `xai-…`, Google's `AIza…` / `AQ.…`, Cloudflare's `cfut_…` / `cfat_…`, Vercel's `vck_…`. */
const KEY_PATTERN = /(?<![A-Za-z0-9_.-])(?:sk-[A-Za-z0-9_~+/=-]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_.-]{20,}|cf[ua]t_[A-Za-z0-9_-]{20,}|vck_[A-Za-z0-9_-]{20,})/g;
/** A Cloudflare account id: 32 hex characters on their own. */
const ACCOUNT_PATTERN = /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/i;
/** A gateway named on a line: `Gateway ID: x`, `gateway=x`. */
const GATEWAY_PATTERN = /gateway(?:[ _-]?id)?\s*[:=：]\s*([A-Za-z0-9_-]{1,64})/i;

/** Map with bounded concurrency, results in input order. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

const tabOf = (vendorId) => VENDORS.find((vendor) => vendor.id === vendorId)?.tab ?? vendorId;

/**
 * Keys in pasted text, with the vendor the line names before the key (a word
 * like `openai:` or `Claude:`, an env name like `ANTHROPIC_API_KEY=`), if any,
 * and the params it needs (Cloudflare): an account id and a gateway on the
 * key's own line, or on lines of their own in its block (lines between blank
 * ones: "Account ID: …", "Gateway ID: …", then "Token: …").
 * `#` comments are skipped; an export file reads back as is.
 * @returns `[{ key, vendor?, params? }]`.
 */
export function parseKeyText(text) {
  const out = [];
  let block = [];
  let shared = {};
  const flush = () => {
    for (const item of block) {
      const params = { ...shared, ...item.params };
      out.push({ key: item.key, ...(item.vendor ? { vendor: item.vendor } : {}), ...(Object.keys(params).length ? { params } : {}) });
    }
    block = [];
    shared = {};
  };
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("#")) continue;
    const keys = line.match(KEY_PATTERN) ?? [];
    const rest = keys.reduce((value, key) => value.split(key).join(" "), line);
    const account = ACCOUNT_PATTERN.exec(rest)?.[0]?.toLowerCase();
    const gateway = GATEWAY_PATTERN.exec(rest)?.[1];
    if (keys.length === 0) {
      if (account && !shared.account) shared.account = account;
      if (gateway && !shared.gateway) shared.gateway = gateway;
      continue;
    }
    const vendor = normalizeVendor(line.slice(0, line.indexOf(keys[0])).replace(/_?API_?KEY/i, ""));
    const params = { ...(account ? { account } : {}), ...(gateway ? { gateway } : {}) };
    for (const key of keys) block.push({ key, vendor, params });
  }
  flush();
  return out;
}

/** A key's params as an export line writes them (`account=… gateway=…`). */
const paramsText = (params) => [params?.account ? `account=${params.account}` : null, params?.gateway ? `gateway=${params.gateway}` : null].filter(Boolean).join(" ");

/** The endpoint list the tabs and the add dialog show (no secrets). */
function endpointView(endpoint) {
  return {
    id: endpoint.id,
    vendor: endpoint.vendor,
    name: endpoint.name,
    displayName: displayNameOf(endpoint),
    plan: endpoint.plan,
    host: new URL(endpoint.baseUrl).host,
    // Whether a key out of money can be re-checked for free (a balance to read, or a free probe).
    freeCheck: Boolean(endpoint.check.funds) || probeKind(endpoint) === "free",
    // How a key's money is found out where no balance shows: "free", "request" (one tiny request, on ✓), or null.
    probe: probeKind(endpoint),
    showsBalance: Boolean(endpoint.check.funds),
    showsQuota: Boolean(endpoint.check.quota),
    // What a key needs besides itself (the add and edit dialogs ask for it).
    params: endpoint.params ? endpoint.params.map(({ id, label, required }) => ({ id, label, required })) : null,
  };
}

/** Where exports go: the user's Downloads folder when it exists, else `$DSH_HOME/exports`. */
async function defaultExportDir(fs) {
  const downloads = join(homedir(), "Downloads");
  try {
    if ((await fs.stat(downloads)).isDirectory()) return downloads;
  } catch {
    /* no Downloads folder */
  }
  return join(dshHome(), "exports");
}

/**
 * Build the service object.
 * @param {object} deps - `{ keys, catalog, adapter, checker, credentials, onRoutesChanged, onModelsChanged, log, lastSwitches, fetchImpl, fs, exportDir, now }`.
 * @returns the service value to `ctx.provide`.
 */
export function createIntlModelsService({ keys, catalog, adapter, checker, credentials = () => undefined, onRoutesChanged = () => {}, onModelsChanged = () => {}, log = () => {}, lastSwitches = () => ({}), fetchImpl = fetch, fs = defaultFs, exportDir = defaultExportDir, now = () => Date.now() }) {
  /** The whole public state. */
  async function status() {
    const summary = await keys.summary();
    const used = [...new Set(summary.keys.map((key) => key.endpoint))];
    const models = {};
    for (const id of used) {
      const options = await catalog.options(id);
      models[id] = {
        options: options.map((entry) => ({
          id: entry.id,
          name: entry.name,
          image: entry.image === true,
          reasoning: Boolean(entry.reasoning),
          context: entry.context ?? null,
          enabled: entry.enabled,
          recommended: entry.recommended === true,
          newer: entry.newer === true,
          free: entry.free === true,
          price: entry.cost ? { input: entry.cost.input, output: entry.cost.output } : null,
          unusable: entry.unusable ?? null,
          // Shown, never offered: OpenCode's free models answer only inside the OpenCode app;
          // Vercel's paid models while the key's team is on the free tier (the reason says which).
          blocked: entry.blocked ?? null,
          // The day a model is announced to go (Vercel's `deprecated_at`).
          retiring: entry.retiring ?? null,
          // Cloudflare: needs the Workers Paid plan; paid from AI Gateway credits (a third-party model).
          paidPlan: entry.paidPlan === true,
          credits: entry.credits === true,
        })),
        fetchedAt: await catalog.fetchedAt(id),
        live: endpointById(id).liveModels,
      };
    }
    return {
      ...summary,
      vendors: VENDORS.map(({ id, name, tab }) => ({ id, name, tab })),
      endpoints: ENDPOINTS.map(endpointView),
      active: summary.endpoints,
      models,
      // The last automatic switch of each vendor (each tab shows its own).
      lastSwitches: lastSwitches(),
    };
  }

  /** Add one key (already detected or chosen), check it, and report a result line. */
  async function addOne({ key, endpoint, label, source, result, params }) {
    const { record, created } = await keys.add({ endpoint: endpoint.id, key, label, source, ...(endpoint.params && params ? { params } : {}) });
    const check = result ?? (await checkKey(record, { mode: "full", fetchImpl }));
    if (!check.unchanged) await keys.patch(record.id, Object.fromEntries(Object.entries(check).filter(([name]) => name !== "unchanged" && name !== "authenticated")));
    const after = (await keys.summary()).keys.find((item) => item.id === record.id);
    return { ok: true, created, id: record.id, key, masked: after.masked, planLabel: after.planLabel, endpoint: endpoint.id, endpointName: displayNameOf(endpoint), status: after.status, statusMessage: after.statusMessage, balance: after.balance, probe: probeKind(endpoint), probedAt: after.probedAt, probeError: after.probeError };
  }

  /**
   * Add pasted keys. A vendor tab adds only that vendor's keys (`vendor`):
   * detection then tries that vendor's endpoints only, and a key that is
   * plainly another vendor's — by its prefix or its line's vendor word — is
   * pointed at the right tab. With an explicit endpoint every key goes there.
   * A key no endpoint accepts is not added.
   */
  async function addKeys(request, signal) {
    const items = parseKeyText(request.text).slice(0, MAX_KEYS_PER_ADD);
    if (items.length === 0) throw cnError(CODES.badRequest, "没有在粘贴的内容里找到 API Key");
    const scope = asString(request.vendor);
    if (scope && !VENDOR_IDS.includes(scope)) throw cnError(CODES.badRequest, `unknown vendor "${scope}"`);
    const forced = asString(request.endpoint) && request.endpoint !== "auto" ? endpointById(request.endpoint) : undefined;
    if (asString(request.endpoint) && request.endpoint !== "auto" && !forced) throw cnError(CODES.badRequest, `unknown endpoint "${request.endpoint}"`);
    if (forced && scope && forced.vendor !== scope) throw cnError(CODES.badRequest, `endpoint "${forced.id}" is not ${tabOf(scope)}'s`);
    // Params the dialog gives (Cloudflare's account id), under what a key's own lines say.
    const given = isRecord(request.params) ? request.params : {};
    const results = await mapLimited(items, ADD_CONCURRENCY, async (item) => {
      const masked = maskKey(item.key);
      const key = item.key;
      try {
        let params = { ...given, ...item.params };
        const needs = (forced ? [forced] : candidateEndpoints(item.key, scope ?? item.vendor).map(endpointById)).find((endpoint) => endpoint?.params);
        if (needs) {
          const checked = checkParams(needs, params);
          if (checked.error) return { ok: false, key, masked, kind: "params", error: `${checked.error}（${tabOf(needs.vendor)} 的 Key 需要它）` };
          params = checked.params;
        }
        if (scope) {
          const other = [item.vendor, vendorOfKeyShape(item.key)].find((vendor) => vendor && vendor !== scope);
          if (other) return { ok: false, key, masked, kind: "wrong-vendor", vendor: other, error: `这是 ${tabOf(other)} 的 Key，请在 ${tabOf(other)} 标签导入` };
        }
        let endpoint = forced;
        let result;
        if (!endpoint) {
          const found = await detectEndpoint(item.key, scope ?? item.vendor, { fetchImpl, signal, params });
          if (!found.endpoint) return { ok: false, key, masked, kind: found.result?.status === "invalid" ? "invalid-key" : "unknown", error: found.result?.statusMessage ?? found.result?.validityError ?? "无法识别这个 Key 属于哪个接入点", tried: found.tried };
          endpoint = found.endpoint;
          result = found.result;
        } else {
          result = await checkKey({ endpoint: endpoint.id, key: item.key, ...(endpoint.params ? { params } : {}) }, { mode: "full", fetchImpl, signal });
          if (!authenticated(result) && result.status !== "error" && !result.unchanged) {
            return { ok: false, key, masked, endpoint: endpoint.id, endpointName: displayNameOf(endpoint), kind: result.status === "invalid" ? "invalid-key" : result.status, error: result.statusMessage ?? "Key 无效" };
          }
        }
        return await addOne({ key: item.key, endpoint, label: request.label, source: request.source ?? "pasted", result, params });
      } catch (error) {
        return { ok: false, key, masked, error: redact(error?.message ?? error) };
      }
    });
    const added = results.filter((result) => result.ok);
    if (added.length) {
      onRoutesChanged();
      for (const endpointId of new Set(added.map((result) => result.endpoint))) {
        if (await catalog.stale(endpointId)) await adapter.refreshModels(endpointId, { signal }).catch(() => undefined);
      }
      onModelsChanged();
      // With the model list fresh: is there money behind each new key (where no balance shows)?
      const probed = added.filter((result) => probeKind(endpointById(result.endpoint)) && !["invalid", "expired"].includes(result.status));
      await mapLimited(probed, ADD_CONCURRENCY, (result) => checker.check(result.id, { mode: "probe", signal }));
      if (probed.length) {
        const after = new Map((await keys.summary()).keys.map((key) => [key.id, key]));
        for (const result of probed) {
          const key = after.get(result.id);
          if (key) Object.assign(result, { status: key.status, statusMessage: key.statusMessage, probedAt: key.probedAt, probeError: key.probeError });
        }
      }
    }
    return { ...(await status()), added: results };
  }

  const handlers = {
    status,

    /**
     * Re-check keys: the named ones, else one vendor's (`vendor`), else all.
     * `mode`: `validity` (does the vendor accept the key), `funds` (balance),
     * or `auto` (funds where the vendor shows any, else validity; a free
     * probe when due). `deep`: also probe for money where no balance shows.
     */
    async checkKeys(request, signal) {
      const mode = CHECK_MODES.includes(request?.mode) ? request.mode : "auto";
      const deep = request?.deep === true;
      const all = await keys.keys();
      const scoped = asString(request?.vendor) ? all.filter((record) => endpointById(record.endpoint)?.vendor === request.vendor) : all;
      const named = Array.isArray(request?.keyIds) && request.keyIds.length ? all.filter((record) => request.keyIds.includes(record.id)) : scoped;
      // A funds refresh skips keys the vendor shows no funds for.
      const ids = named.filter((record) => mode !== "funds" || fundsKind(record)).map((record) => record.id);
      const results = [];
      const queue = [...ids];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) results.push(await checker.check(queue.shift(), { mode, deep, signal }));
      }));
      return { ...(await status()), checked: results };
    },

    addKeys,

    /** Add the keys DSH itself already stores (its credential references for one vendor, or all). */
    async importDshKeys(request, signal) {
      const service = credentials();
      if (!service || typeof service.resolve !== "function") throw cnError(CODES.missing, "DSH 的凭据服务不可用");
      const lines = [];
      const found = [];
      for (const vendor of VENDORS) {
        if (asString(request.vendor) && vendor.id !== request.vendor) continue;
        for (const ref of vendor.dshRefs) {
          let value;
          try {
            value = (await service.resolve(ref))?.value;
          } catch {
            value = undefined;
          }
          if (asString(value)) {
            // What else the vendor's key needs, where DSH keeps it too (Cloudflare's account id).
            const params = {};
            for (const [name, refs] of Object.entries(vendor.dshParams ?? {})) {
              for (const paramRef of refs) {
                const param = await Promise.resolve(service.resolve(paramRef)).then((resolved) => resolved?.value, () => undefined);
                if (asString(param)) {
                  params[name] = param.trim();
                  break;
                }
              }
            }
            lines.push(`${vendor.id}: ${paramsText(params)} ${value.trim()}`.replace(/: {2,}/, ": "));
            found.push(ref);
          }
        }
      }
      if (lines.length === 0) return { ...(await status()), added: [], refs: [] };
      const out = await addKeys({ text: lines.join("\n"), source: "dsh", ...(asString(request.vendor) ? { vendor: request.vendor } : {}) }, signal);
      return { ...out, refs: found };
    },

    async updateKey(request) {
      const record = await keys.get(request.keyId);
      if (!record) throw cnError(CODES.badRequest, "unknown key");
      if (request.label !== undefined) await keys.update(record.id, { label: request.label });
      // Only the gateway changes: the account is part of the key (another account is another key).
      const endpoint = endpointById(record.endpoint);
      if (isRecord(request.params) && endpoint?.params) {
        const checked = checkParams(endpoint, { ...record.params, ...request.params });
        if (checked.error) throw cnError(CODES.badRequest, checked.error);
        if (checked.params.account !== record.params?.account) throw cnError(CODES.badRequest, "Account ID 不能修改：换帐户请删除这个 Key 后重新添加");
        await keys.update(record.id, { params: { gateway: checked.params.gateway ?? null } });
      }
      return status();
    },

    async removeKey(request) {
      if (!(await keys.remove(request.keyId))) throw cnError(CODES.badRequest, "unknown key");
      await catalog.prune(await keys.endpointIds());
      onRoutesChanged();
      return status();
    },

    async switchKey(request) {
      if (!(await keys.setActive(request.keyId))) throw cnError(CODES.badRequest, "unknown key");
      return status();
    },

    async reorderKeys(request) {
      await keys.reorder(request.endpoint, request.keyIds);
      return status();
    },

    async refreshModels(request, signal) {
      const outcome = await adapter.refreshModels(request.endpoint, { signal });
      return { ...(await status()), modelsRefreshed: outcome };
    },

    /**
     * Switching settings (one vendor's with `vendor`), which vendor tabs are
     * hidden, or one endpoint's selected models.
     */
    async updateSettings(request) {
      if (asString(request.vendor) && !VENDOR_IDS.includes(request.vendor)) throw cnError(CODES.badRequest, `unknown vendor "${request.vendor}"`);
      if (typeof request.autoSwitch === "boolean" || typeof request.rotateOnRateLimit === "boolean") {
        await keys.setSettings({ vendor: asString(request.vendor), autoSwitch: request.autoSwitch, rotateOnRateLimit: request.rotateOnRateLimit });
      }
      if (Array.isArray(request.hiddenVendors)) {
        const hidden = [...new Set(request.hiddenVendors.filter((id) => VENDOR_IDS.includes(id)))];
        if (hidden.length >= VENDOR_IDS.length) throw cnError(CODES.badRequest, "至少保留一个厂商标签");
        await keys.setSettings({ hiddenVendors: hidden });
        // A hidden vendor's models leave the model picker too (its keys stay).
        onRoutesChanged();
      }
      if (asString(request.endpoint) && (request.enabledModelIds === null || Array.isArray(request.enabledModelIds))) {
        await catalog.setEnabled(request.endpoint, request.enabledModelIds);
        onModelsChanged();
      }
      return status();
    },

    /**
     * Write one vendor's keys to a text file, one `Vendor: key` line each (the
     * add dialog reads it back). The file goes to the Downloads folder (else
     * `$DSH_HOME/exports`), mode 0600.
     * @returns `{ path, count, vendor }`.
     */
    async exportKeys(request) {
      const vendor = asString(request.vendor);
      if (!vendor || !VENDOR_IDS.includes(vendor)) throw cnError(CODES.badRequest, `unknown vendor "${request.vendor}"`);
      const own = (await keys.keys()).filter((record) => endpointById(record.endpoint)?.vendor === vendor);
      if (own.length === 0) throw cnError(CODES.badRequest, `${tabOf(vendor)} 还没有 Key`);
      const text = `${own.map((record) => `${tabOf(vendor)}: ${record.params ? `${paramsText(record.params)} ` : ""}${record.key}`).join("\n")}\n`;
      const date = new Date(now());
      const pad = (value) => String(value).padStart(2, "0");
      const name = `dsh-intl-models-${vendor}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
      const dir = await exportDir(fs);
      await fs.mkdir(dir, { recursive: true });
      const path = join(dir, name);
      await fs.writeFile(path, text, { encoding: "utf8", mode: 0o600 });
      log("info", `exported ${own.length} ${vendor} key(s) to ${path}`);
      return { path, count: own.length, vendor };
    },
  };

  // SRC discovery reads the methods from the PROTOTYPE and derives wire
  // parameters from each signature: plain identifiers, `signal` last.
  const prototype = {};
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) }))),
    }),
  });
  const wrap = (method) => async function remote(request, signal) {
    try {
      return await handlers[method](isRecord(request) ? request : {}, signal);
    } catch (error) {
      log("warn", `${method} failed: ${redact(error?.message ?? error)}`);
      const failure = new Error(redact(error?.message ?? error));
      failure.isDSHRemoteError = true;
      failure.code = `intl-models/${String(error?.code ?? "error").toLowerCase()}`;
      failure.details = {};
      throw failure;
    }
  };
  for (const method of REMOTE_METHODS) {
    Object.defineProperty(prototype, method, { value: wrap(method), writable: true, configurable: true });
  }
  const service = Object.create(prototype);
  Object.defineProperty(service, "typertRemote", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: "intlModelsKeys", namespace: "intlModels" },
  });
  return service;
}
