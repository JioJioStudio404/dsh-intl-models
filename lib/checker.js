/**
 * Keeps every key's validity, balance and plan quota current.
 *
 * `check` runs one key's check (`auto`, `validity`, `funds` or `full`, see
 * probe.js) and stores the result; `afterUse` re-reads a key's balance or plan
 * window shortly after it served (or refused) a request, so the tab follows
 * real use. After-use checks are always free ones: a key that can only be
 * probed by a one-token request is not re-tested behind the user's back.
 *
 * A probe tries the endpoint's models in the user's order — the selected ones
 * (newest first, as the catalog sorts them), then the recommended, then the
 * rest the key can see —, and a model it finds gone is marked unusable.
 *
 * @module dsh-intl-models/checker
 */
import { endpointById } from "./endpoints.js";
import { redact } from "./errors.js";
import { checkKey, probeKind } from "./probe.js";

/** A request is followed by its key's check after this long (the vendor books it first). */
const AFTER_USE_DELAY_MS = 3_000;
/** A balance that grew this much (USD) was topped up: what the team may use can have changed. */
const TOP_UP_USD = 1;
/** …and at most this often per key (an agent turn makes many requests). */
const AFTER_USE_GAP_MS = 30_000;

/**
 * @param {object} deps - `{ keys, catalog, onModelsChanged, onToppedUp, fetchImpl, log, now, delayMs, gapMs }`;
 * `onToppedUp(endpointId)` follows a balance that grew (Vercel: a free tier's paid models open up with credits).
 * @returns `{ check(id, { mode, deep, signal }), afterUse(id), probeModels(endpointId) }`.
 */
export function createChecker({ keys, catalog, onModelsChanged = () => {}, onToppedUp = () => {}, fetchImpl = fetch, log = () => {}, now = () => Date.now(), delayMs = AFTER_USE_DELAY_MS, gapMs = AFTER_USE_GAP_MS, retryDelayMs }) {
  const running = new Map();

  /** The models a probe of an endpoint's keys tries, in order. */
  async function probeModels(endpointId) {
    if (!catalog || !probeKind(endpointById(endpointId))) return [];
    const usable = (await catalog.options(endpointId)).filter((entry) => !entry.unusable && !entry.blocked);
    return [
      ...usable.filter((entry) => entry.enabled),
      ...usable.filter((entry) => !entry.enabled && entry.recommended),
      ...usable.filter((entry) => !entry.enabled && !entry.recommended && !entry.newer),
    ].map((entry) => ({ id: entry.id, protocol: entry.protocol }));
  }

  /** Check one key and store what was learned. Concurrent callers share one check. */
  function check(id, { mode = "auto", deep = false, signal } = {}) {
    const key = `${id}:${mode}:${deep}`;
    if (running.has(key)) return running.get(key);
    const run = (async () => {
      const record = await keys.get(id);
      if (!record) return { id, ok: false, error: "unknown key" };
      try {
        const models = await probeModels(record.endpoint).catch(() => []);
        const result = await checkKey(record, { mode, deep, models, fetchImpl, signal, now, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}) });
        const { unchanged, authenticated, unusableModels, ...patch } = result;
        await keys.patch(id, unchanged ? { checkedAt: patch.checkedAt } : patch);
        const before = record.balance?.amount;
        const after = patch.balance?.amount;
        if (typeof before === "number" && typeof after === "number" && after - before >= TOP_UP_USD) onToppedUp(record.endpoint);
        if (unusableModels?.length && catalog) {
          for (const [model, reason] of unusableModels) catalog.markUnusable(record.endpoint, model, reason);
          onModelsChanged();
        }
        return { id, ok: true, status: unchanged ? record.status ?? "unknown" : patch.status };
      } catch (error) {
        log("warn", `check of ${id} failed: ${redact(error?.message ?? error)}`);
        return { id, ok: false, error: redact(error?.message ?? error) };
      }
    })().finally(() => running.delete(key));
    running.set(key, run);
    return run;
  }

  const pending = new Set();
  const lastRun = new Map();
  /** Re-read one key's balance or plan window shortly after it was used. */
  function afterUse(id) {
    if (!id || pending.has(id)) return;
    const wait = Math.max(delayMs, (lastRun.get(id) ?? 0) + gapMs - now());
    pending.add(id);
    const timer = setTimeout(() => {
      pending.delete(id);
      lastRun.set(id, now());
      check(id).catch(() => undefined);
    }, wait);
    timer.unref?.();
  }

  return { check, afterUse, probeModels };
}
