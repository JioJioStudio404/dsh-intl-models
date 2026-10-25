/**
 * Where this plugin keeps its files.
 *
 * DSH's own home resolution is `DSH_HOME`, then `~/.dsh` (the documented
 * default of `resolveDshHome`), on every platform. A third-party plugin cannot
 * import `@deepseek-ai/dsh-home-paths`, so the rule is restated here.
 *
 * @module dsh-intl-models/paths
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The DSH home directory.
 * @param {Record<string, string | undefined>} [env] - environment.
 * @returns the absolute home path.
 */
export function dshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return configured.length > 0 ? configured : join(homedir(), ".dsh");
}

/** A path under `$DSH_HOME/storages`. */
export function storagePath(name, env = process.env) {
  return join(dshHome(env), "storages", name);
}

/** The key store (API keys and their state), like Antigravity's account store. */
export const keysPath = (env) => storagePath("intl-models-keys.json", env);

/** Per-endpoint model lists and selections. */
export const settingsPath = (env) => storagePath("intl-models-settings.json", env);
