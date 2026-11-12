/**
 * Safe handling of the plugin's own files and of names that come from outside.
 *
 * - Names as object keys: a model name a site's log, plaza or statistics carries, a model id a site lists, a
 *   conversation id, a site id. `__proto__`, `constructor` and `prototype` are never used as keys
 *   ({@link isSafeKey}); every other name is reached as the object's own entry ({@link slot}, {@link hasOwn}), so an
 *   inherited one (`toString`, `valueOf`) never stands in for it.
 * - Store files read strictly ({@link readJsonFile}): a missing file is empty; a file that is there but cannot be read
 *   (permission, a lock, a disk error) throws, so nothing writes over it as if it were empty; a file that holds no
 *   valid JSON is set aside beside the store (`<file>.corrupt-<time>`) and read as empty.
 * - Writes from several processes on one DeepSeek Harness home (the desktop host, the terminal) serialized by a lock
 *   file beside the store ({@link withFileLock}).
 *
 * @module dsh-intl-models/safe
 */
import { dirname } from "node:path";
import { isRecord, safeJson } from "./errors.js";

/** Names that, as an object key, reach the object's prototype or constructor instead of an entry of its own. */
export const UNSAFE_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
const UNSAFE = new Set(UNSAFE_KEYS);

/** Whether a name may be an object key (a string that is none of {@link UNSAFE_KEYS}). */
export const isSafeKey = (name) => typeof name === "string" && !UNSAFE.has(name);

/** Whether an object holds an entry of its own under a name (never an inherited one). */
export const hasOwn = (target, name) => target !== null && typeof target === "object" && Object.hasOwn(target, name);

/** Set an object's own entry (a plain data property, whatever the name). */
export function put(target, name, value) {
  Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

/** An object's own entry under a name, made with `make()` first when there is none. */
export function slot(target, name, make) {
  return Object.hasOwn(target, name) ? target[name] : put(target, name, make());
}

/** Transient errors Windows reports for a file another process holds this instant (they clear within milliseconds). */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const removeQuietly = async (fs, path) => {
  try {
    await (typeof fs.rm === "function" ? fs.rm(path, { force: true }) : fs.unlink(path));
  } catch {
    /* gone already, or held: a stale lock is broken by the next writer */
  }
};

/** The name a corrupt store file is set aside under. */
export const corruptName = (file, now = Date.now()) => `${file}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;

/**
 * A store file's JSON object, read strictly: null when the file is missing or empty; a read error other than a
 * missing file throws (after a few quick retries of a transient one), so the caller neither caches nor writes an
 * empty state over a file it could not read. A file whose text is not a JSON object is renamed aside
 * ({@link corruptName}: kept for the user, never overwritten) and read as empty; when it cannot be set aside, the
 * read throws.
 * @param {object} fs - `node:fs/promises` or a test double.
 * @param {string} file - the store's path.
 * @returns {Promise<object | null>}
 */
export async function readJsonFile(fs, file) {
  let text;
  for (let attempt = 0; ; attempt += 1) {
    try {
      text = await fs.readFile(file, "utf8");
      break;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (!BUSY.has(error?.code) || attempt >= 4) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
  if (String(text ?? "").trim() === "") return null;
  const value = safeJson(text);
  if (isRecord(value)) return value;
  await fs.rename(file, corruptName(file));
  return null;
}

/** A lock older than this was left by a process that ended without releasing it: it is broken. */
export const LOCK_STALE_MS = 10_000;
/** How long a write waits for another process's lock before it fails (the caller keeps what it would write). */
export const LOCK_WAIT_MS = 15_000;

/**
 * Run `fn` holding the store's lock file (`<file>.lock`, created exclusively): another process writing the same store
 * waits, so neither writes over what the other just wrote. The holder touches the lock while it works; a lock left
 * untouched for {@link LOCK_STALE_MS} (its process ended or hangs) is broken. A holder removes the lock only while it
 * is still its own (it names the holder). Without `fs.open` (a test double) `fn` runs unlocked.
 */
export async function withFileLock(fs, file, fn, { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS } = {}) {
  if (typeof fs?.open !== "function") return fn();
  const lock = `${file}.lock`;
  const owner = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const started = Date.now();
  let handle;
  await fs.mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      handle = await fs.open(lock, "wx", 0o600);
      try {
        await handle.writeFile(owner, "utf8");
      } catch {
        /* the lock holds without its name; it is then removed on release regardless */
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" && !(BUSY.has(error?.code) && attempt < 20)) throw error;
      let info;
      try {
        info = await fs.stat(lock);
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - info.mtimeMs > staleMs) {
        await removeQuietly(fs, lock);
        continue;
      }
      if (Date.now() - started > waitMs) {
        const busy = new Error(`store locked by another process: ${lock}`);
        busy.code = "ELOCKED";
        throw busy;
      }
      await sleep(Math.min(100, 10 + attempt * 5));
    }
  }
  // Touched while `fn` works, so a long write is never taken for a lock left behind.
  const beat = setInterval(() => {
    const now = new Date();
    Promise.resolve(typeof handle.utimes === "function" ? handle.utimes(now, now) : fs.utimes?.(lock, now, now)).catch(() => undefined);
  }, Math.max(20, Math.floor(staleMs / 4)));
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await handle.close().catch(() => undefined);
    // Another process broke this lock (this one hung past the stale time) and holds its own now: that one stays.
    let current = owner;
    try {
      current = await fs.readFile(lock, "utf8");
    } catch {
      /* gone, or unreadable: removed as ours */
    }
    if (current === owner || current === "") await removeQuietly(fs, lock);
  }
}
