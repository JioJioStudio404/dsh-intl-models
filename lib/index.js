/**
 * dsh-intl-models — international LLM vendors for DeepSeek Harness (OpenAI,
 * Anthropic Claude, xAI, OpenRouter, OpenCode Zen / Go, Google Gemini,
 * Cloudflare Workers AI, Vercel AI Gateway), with many API keys per endpoint.
 *
 * Host half: one LLM route per endpoint that has keys (`intl-openai`,
 * `intl-anthropic`, …) over each model's own protocol (Responses, Messages,
 * Chat Completions, Gemini), with reasoning effort, tool calling and
 * reasoning replay; every key's validity (and OpenRouter's and Vercel's balance); spending
 * per key; automatic switching to the next key when one runs out; and the
 * `intlModels` Remote namespace the browser half manages them through.
 *
 * Imports no `@deepseek-ai/*` package: a third-party plugin cannot resolve
 * them from a profile, and the host duck-types adapters.
 *
 * @module dsh-intl-models
 */
import { readFileSync } from "node:fs";
import { IntlAdapter } from "./adapter.js";
import { CatalogStore } from "./catalog.js";
import { createChecker } from "./checker.js";
import { displayNameOf, endpointById, endpointOfRoute, routeOf } from "./endpoints.js";
import { isRecord, safeJson } from "./errors.js";
import { KeyStore } from "./keys.js";
import { keysPath } from "./paths.js";
import { createIntlModelsService } from "./service.js";

export const name = "dsh-intl-models";
export const inject = ["llm"];

/**
 * Duck-typed Config schema (cordis validates it on load; dsh-settings lists a
 * namespace — and so a Models-page row for each route — only for a schema with
 * `toJSON`, `meta.volatile` and `type`). The form is empty: keys and models are
 * managed in the vendor tabs of a conversation.
 */
export const Config = {
  type: "object",
  meta: { volatile: true, default: {} },
  dict: {},
  toJSON() {
    return { type: "object", meta: { volatile: true, default: {} }, dict: {} };
  },
  "~standard": {
    version: 1,
    vendor: "dsh-intl-models",
    validate(value) {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value === "object" && !Array.isArray(value)) return { value };
      return { issues: [{ message: `expected object but got ${Array.isArray(value) ? "array" : typeof value}` }] };
    },
  },
};

/** Service key of the Remote namespace. */
export const SERVICE_KEY = "intlModelsKeys";

/**
 * The endpoints that get a route: those with keys, minus the vendors whose tab
 * is switched off (their models leave the model picker; the keys stay).
 */
export function routedEndpoints(state) {
  if (!isRecord(state) || !Array.isArray(state.keys)) return [];
  const hidden = new Set(Array.isArray(state.hiddenVendors) ? state.hiddenVendors : []);
  return [...new Set(state.keys.map((record) => record?.endpoint))].filter((id) => endpointById(id) && !hidden.has(endpointById(id).vendor));
}

/** {@link routedEndpoints}, read synchronously so the routes exist before the first request. */
function initialEndpoints(file) {
  try {
    return routedEndpoints(safeJson(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/**
 * Mount the adapter, the routes, and the key service.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[dsh-intl-models] ${message}`);
    } catch {
      /* diagnostics never fail a request */
    }
  };
  const llm = ctx?.llm;
  if (!llm || typeof llm.registerAdapter !== "function") {
    log("warn", "ctx.llm.registerAdapter is unavailable; no route is registered");
    return;
  }
  const keys = new KeyStore();
  const catalog = new CatalogStore();
  // A topped-up balance re-reads the model list: Vercel opens its paid models to a team with credits.
  const checker = createChecker({ keys, catalog, log, onModelsChanged: () => modelsChanged(), onToppedUp: (endpointId) => adapter.refreshModelsInBackground(endpointId) });
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? name;

  // Routes follow the endpoints that have keys. The registry announces every
  // change itself (`llm/adapters-updated`, forwarded to the model pickers).
  let routes = initialEndpoints(keys.path()).map(routeOf);
  let registration;
  let directory;
  const entries = () => routes.map((route) => ({ provider: route, displayName: displayNameOf(endpointOfRoute(route)), settingsNs, settingsPath: [] }));
  const commit = () => {
    try {
      if (!registration && routes.length) registration = llm.registerAdapter([...routes], adapter);
      else registration?.replace([...routes]);
    } catch (error) {
      log("warn", `routes not registered: ${error?.message ?? error}`);
    }
    if (typeof llm.registerConfigurableProviders !== "function") return;
    try {
      if (!directory && routes.length) directory = llm.registerConfigurableProviders(entries());
      else directory?.replace(entries());
    } catch (error) {
      log("warn", `Models-page rows not registered: ${error?.message ?? error}`);
    }
  };
  let announcing = false;
  const modelsChanged = () => {
    if (announcing) return;
    announcing = true;
    queueMicrotask(() => {
      announcing = false;
      if (registration) commit();
      else {
        try {
          ctx.emit("llm/adapters-updated");
        } catch {
          /* nothing registered yet: nothing to announce */
        }
      }
    });
  };
  const routesChanged = () => {
    keys.read().then((state) => {
      const next = routedEndpoints(state).map(routeOf);
      if (next.join() === routes.join()) return modelsChanged();
      routes = next;
      commit();
    }).catch((error) => log("warn", `routes not updated: ${error?.message ?? error}`));
  };

  // The last automatic switch of each vendor (process memory only).
  const lastSwitches = {};
  const adapter = new IntlAdapter({
    keys,
    catalog,
    attachments: () => ctx.get("attachments"),
    log,
    onModelsChanged: modelsChanged,
    onUsed: (keyId) => checker.afterUse(keyId),
    onSwitched: (endpointId, from, to, reason, detail) => {
      const vendor = endpointById(endpointId)?.vendor ?? endpointId;
      lastSwitches[vendor] = { endpoint: endpointId, from: from ?? null, to, reason, model: detail?.model ?? null, at: new Date().toISOString() };
      log("info", `${endpointId}: active key switched (${reason}): ${from ?? "none"} -> ${to}`);
    },
  });
  commit();

  try {
    ctx.inject?.(["settings"], (child) => {
      try {
        if (typeof child?.settings?.configure === "function") child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
      } catch {
        /* settings seam unavailable */
      }
    });
  } catch {
    /* ctx.inject unavailable */
  }

  const service = createIntlModelsService({
    keys,
    catalog,
    adapter,
    checker,
    credentials: () => ctx.get("credentials"),
    onRoutesChanged: routesChanged,
    onModelsChanged: modelsChanged,
    log,
    lastSwitches: () => ({ ...lastSwitches }),
  });
  if (ctx.get(SERVICE_KEY) === undefined) ctx.provide(SERVICE_KEY, service);
  else log("warn", `${SERVICE_KEY} is already provided; keeping the mounted service`);

  // Warm up without blocking the boot: free checks for keys not checked lately, stale model lists.
  (async () => {
    try {
      const all = await keys.keys();
      const stale = all.filter((record) => !record.checkedAt || Date.now() - Date.parse(record.checkedAt) > 10 * 60_000);
      for (const record of stale) await checker.check(record.id).catch(() => undefined);
      for (const id of await keys.endpointIds()) if (await catalog.stale(id)) await adapter.refreshModelsInBackground(id);
      log("info", `${all.length} key(s) on ${routes.length} route(s); store=${keys.path()}`);
    } catch (error) {
      log("warn", `warmup failed: ${error?.message ?? error}`);
    }
  })();
}

export default { name, inject, apply, Config };
