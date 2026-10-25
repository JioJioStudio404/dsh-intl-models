/**
 * International vendors and their endpoints.
 *
 * Each endpoint is one DSH route (`intl-openai`, `intl-anthropic`, …) with
 * many keys. A model's wire protocol comes from the catalog (OpenCode and
 * OpenRouter serve several), the endpoint gives the hosts and how a key is
 * checked:
 *  - validity: `models` (`GET /models`, which checks the key), `anthropic`
 *    (`GET /v1/models` with `x-api-key`), `gemini` (`GET /models` with
 *    `x-goog-api-key`), `xai` (`GET /api-key`: also says whether the key or its
 *    team is blocked), `openrouter` (`GET /key`), `vercel` (`GET /credits`);
 *  - funds: OpenRouter (`GET /key`, `GET /credits`) and Vercel (`GET /credits`,
 *    the team's balance, current to a few seconds). The others show no
 *    balance to an API key; the plugin estimates spending from token counts;
 *  - probe (is there money behind the key?): `free` — a request the vendor
 *    refuses before it runs, after its balance check (OpenAI `n: 0`, Anthropic
 *    `max_tokens: 0`); `request` — one tiny request (Gemini, xAI, OpenCode),
 *    sent only when the user asks (✓, 验证全部, import).
 *
 * `sessionHeader`: OpenCode asks third-party agents for a stable session id
 * per conversation (Go refuses a request without one: `MissingSessionID`).
 *
 * `params`: what a key needs besides itself, stored with it — Cloudflare's
 * account id (every token works in one account, and the account is part of
 * every URL) and an optional AI Gateway id. `{name}` in the endpoint's URLs
 * and `headers` is filled from the key's params (`{name|fallback}` when it
 * may be missing); see {@link endpointFor}.
 *
 * @module dsh-intl-models/endpoints
 */

/** Vendors, in tab order: id, the tab's English label, a long name, and DSH credential references to import from. */
export const VENDORS = Object.freeze([
  { id: "openai", tab: "OpenAI", name: "OpenAI", dshRefs: ["OPENAI_API_KEY"] },
  { id: "anthropic", tab: "Claude", name: "Anthropic Claude", dshRefs: ["ANTHROPIC_API_KEY"] },
  { id: "xai", tab: "xAI", name: "xAI Grok", dshRefs: ["XAI_API_KEY"] },
  { id: "openrouter", tab: "OpenRouter", name: "OpenRouter", dshRefs: ["OPENROUTER_API_KEY"] },
  { id: "opencode", tab: "OpenCode", name: "OpenCode Zen / Go", dshRefs: ["OPENCODE_API_KEY"] },
  { id: "gemini", tab: "Gemini", name: "Google Gemini", dshRefs: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
  { id: "cloudflare", tab: "Cloudflare", name: "Cloudflare Workers AI", dshRefs: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN"], dshParams: { account: ["CLOUDFLARE_ACCOUNT_ID"], gateway: ["CLOUDFLARE_GATEWAY_ID"] } },
  { id: "vercel", tab: "Vercel", name: "Vercel AI Gateway", dshRefs: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"] },
].map((vendor) => Object.freeze(vendor)));

export const VENDOR_IDS = Object.freeze(VENDORS.map((vendor) => vendor.id));

/**
 * Endpoints. `baseUrl` serves Chat Completions, Responses and `/models`;
 * `messagesBase` the Anthropic Messages API (`<messagesBase>/v1/messages`);
 * `geminiBase` the Gemini API (`<geminiBase>/models/<id>:streamGenerateContent`).
 * `protocol` is the default for a model the catalog does not know.
 */
export const ENDPOINTS = Object.freeze([
  {
    id: "openai", vendor: "openai", name: "OpenAI", plan: null,
    baseUrl: "https://api.openai.com/v1", catalog: "openai", protocol: "responses",
    check: { validity: "models", probe: "free" }, liveModels: true,
  },
  {
    id: "anthropic", vendor: "anthropic", name: "Claude", plan: null,
    baseUrl: "https://api.anthropic.com/v1", messagesBase: "https://api.anthropic.com", catalog: "anthropic", protocol: "messages",
    check: { validity: "anthropic", probe: "free" }, liveModels: true,
  },
  {
    id: "xai", vendor: "xai", name: "xAI", plan: null,
    baseUrl: "https://api.x.ai/v1", catalog: "xai", protocol: "responses",
    check: { validity: "xai", probe: "request" }, liveModels: true,
  },
  {
    id: "openrouter", vendor: "openrouter", name: "OpenRouter", plan: null,
    baseUrl: "https://openrouter.ai/api/v1", messagesBase: "https://openrouter.ai/api", catalog: "openrouter", protocol: "chat",
    check: { validity: "openrouter", funds: "openrouter" }, liveModels: true,
  },
  {
    id: "opencode-zen", vendor: "opencode", name: "OpenCode Zen", plan: null,
    baseUrl: "https://opencode.ai/zen/v1", messagesBase: "https://opencode.ai/zen", geminiBase: "https://opencode.ai/zen/v1", catalog: "opencode", protocol: "chat",
    check: { validity: "models", probe: "request" }, liveModels: true, sessionHeader: "x-opencode-session",
  },
  {
    id: "opencode-go", vendor: "opencode", name: "OpenCode Go", plan: "Go",
    baseUrl: "https://opencode.ai/zen/go/v1", messagesBase: "https://opencode.ai/zen/go", geminiBase: "https://opencode.ai/zen/go/v1", catalog: "opencode-go", protocol: "chat",
    check: { validity: "models", probe: "request" }, liveModels: true, sessionHeader: "x-opencode-session",
  },
  {
    id: "gemini", vendor: "gemini", name: "Gemini", plan: null,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", geminiBase: "https://generativelanguage.googleapis.com/v1beta", catalog: "google", protocol: "gemini",
    check: { validity: "gemini", probe: "request" }, liveModels: true,
  },
  {
    // Cloudflare's account-wide REST API: Workers AI models (`@cf/…`, a daily free allocation of
    // neurons, then the Workers plan) and third-party ones (`openai/…`, `anthropic/…`, paid from
    // AI Gateway credits). Workers AI requests name a gateway: the default one unless the key says.
    id: "cloudflare", vendor: "cloudflare", name: "Cloudflare", plan: null,
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
    messagesBase: "https://api.cloudflare.com/client/v4/accounts/{account}/ai",
    modelsUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/models/search?task=Text%20Generation&per_page=500",
    headers: { "cf-aig-gateway-id": "{gateway|default}" },
    params: [
      { id: "account", label: "Account ID", pattern: "^[0-9a-f]{32}$", required: true, lower: true },
      { id: "gateway", label: "Gateway ID", pattern: "^[A-Za-z0-9_-]{1,64}$", required: false },
    ],
    catalog: "cloudflare", protocol: "chat", messagesAuth: "bearer",
    check: { validity: "cloudflare", probe: "request", quota: "cloudflare-neurons" }, liveModels: true,
  },
  {
    // Vercel AI Gateway: every vendor's models at list price, from the team's credits (a free tier
    // gets a monthly credit for a subset of models). Claude goes over its Messages API (thinking
    // signatures, cache breakpoints), the rest over Chat Completions, which reports each request's cost.
    // The model list with `include_availability` says which models the key's team may use (free).
    id: "vercel", vendor: "vercel", name: "Vercel", plan: null,
    baseUrl: "https://ai-gateway.vercel.sh/v1", messagesBase: "https://ai-gateway.vercel.sh",
    modelsUrl: "https://ai-gateway.vercel.sh/v1/models?include_availability",
    catalog: "vercel", protocol: "chat", messagesAuth: "bearer",
    check: { validity: "vercel", funds: "vercel" }, liveModels: true,
  },
].map((endpoint) => Object.freeze(endpoint)));

const BY_ID = new Map(ENDPOINTS.map((endpoint) => [endpoint.id, endpoint]));
const PREFIX = "intl-";

/** The DSH route of an endpoint (prefixed so it never collides with DSH's own `openai`, `anthropic`, …). */
export const routeOf = (endpointId) => `${PREFIX}${endpointId}`;

/** The endpoint behind a DSH route, or undefined. */
export function endpointOfRoute(route) {
  return typeof route === "string" && route.startsWith(PREFIX) ? BY_ID.get(route.slice(PREFIX.length)) : undefined;
}

/** One endpoint by id, or undefined. */
export const endpointById = (id) => BY_ID.get(id);

/** `{name}` / `{name|fallback}` in a template, from a key's params (undefined when a required one is missing). */
function fill(template, params) {
  let missing = false;
  const out = template.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_, name, fallback) => {
    const value = typeof params?.[name] === "string" && params[name] ? params[name] : fallback;
    if (value === undefined) missing = true;
    return encodeURIComponent(value ?? "");
  });
  return missing ? undefined : out;
}

/**
 * The endpoint as one key sees it: its URLs and headers with the key's params
 * filled in (Cloudflare's account id). An endpoint without params is itself.
 * @returns the endpoint, or undefined when the key lacks a required param.
 */
export function endpointFor(endpoint, record) {
  if (!endpoint?.params) return endpoint;
  const params = record?.params ?? {};
  const out = { ...endpoint };
  for (const name of ["baseUrl", "messagesBase", "geminiBase", "modelsUrl"]) {
    if (typeof endpoint[name] !== "string") continue;
    out[name] = fill(endpoint[name], params);
    if (out[name] === undefined) return undefined;
  }
  if (endpoint.headers) out.headers = Object.fromEntries(Object.entries(endpoint.headers).map(([name, value]) => [name, fill(value, params)]).filter(([, value]) => value));
  return out;
}

/** A key's params, checked against what its endpoint declares: `{ params }` or `{ error }`. */
export function checkParams(endpoint, params = {}) {
  const out = {};
  for (const param of endpoint?.params ?? []) {
    const raw = typeof params[param.id] === "string" ? params[param.id].trim() : "";
    const value = param.lower ? raw.toLowerCase() : raw;
    if (!value) {
      if (param.required) return { error: `缺少 ${param.label}` };
      continue;
    }
    if (param.pattern && !new RegExp(param.pattern).test(value)) return { error: `${param.label} 格式不对` };
    out[param.id] = value;
  }
  return { params: out };
}

/** The vendor record of an endpoint. */
export const vendorOf = (endpoint) => VENDORS.find((vendor) => vendor.id === endpoint?.vendor);

/** The picker's group name: the endpoint plus a marker that it is this plugin's multi-key route. */
export const displayNameOf = (endpoint) => `${endpoint.name}（多 Key）`;

/**
 * Endpoints a key may belong to, most likely first, from its shape and an
 * optional vendor hint (`openai:`, `claude:`, … in pasted text). Detection
 * then probes them in this order.
 */
export function candidateEndpoints(key, vendorHint) {
  const vendor = normalizeVendor(vendorHint);
  const ids = [];
  const add = (...list) => { for (const id of list) if (!ids.includes(id)) ids.push(id); };
  const shape = vendorOfKeyShape(key);
  if (shape) add(...ENDPOINTS.filter((endpoint) => endpoint.vendor === shape).map((endpoint) => endpoint.id));
  if (vendor) add(...ENDPOINTS.filter((endpoint) => endpoint.vendor === vendor).map((endpoint) => endpoint.id));
  // A plain `sk-…` key: OpenAI's legacy keys and OpenCode's look alike.
  if (ids.length === 0 && String(key).startsWith("sk-")) add("openai", "opencode-zen");
  return vendor ? ids.filter((id) => BY_ID.get(id).vendor === vendor) : ids;
}

/**
 * The vendor a key's shape names beyond doubt (`sk-ant-` Anthropic, `sk-or-`
 * OpenRouter, `xai-` xAI, `AIza…` / `AQ.…` Google, `sk-proj-` / `sk-svcacct-`
 * OpenAI), or undefined for a plain `sk-…`.
 */
export function vendorOfKeyShape(key) {
  const value = String(key ?? "");
  if (value.startsWith("sk-ant-")) return "anthropic";
  if (value.startsWith("sk-or-")) return "openrouter";
  if (value.startsWith("xai-")) return "xai";
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(value) || /^AQ\.[0-9A-Za-z_.-]{20,}$/.test(value)) return "gemini";
  if (/^sk-(proj|svcacct|admin)-/.test(value)) return "openai";
  // Cloudflare's API tokens: `cfut_` (a user's), `cfat_` (an account's).
  if (/^cf[ua]t_/.test(value)) return "cloudflare";
  // Vercel AI Gateway's API keys.
  if (/^vck_/.test(value)) return "vercel";
  return undefined;
}

/** A vendor id from loose text ("claude", "grok", "google", "zen", …). */
export function normalizeVendor(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (/openrouter/.test(value)) return "openrouter";
  if (/opencode|\bzen\b/.test(value)) return "opencode";
  if (/openai|chatgpt|\bgpt/.test(value)) return "openai";
  if (/anthropic|claude/.test(value)) return "anthropic";
  if (/\bxai\b|x\.ai|grok/.test(value)) return "xai";
  if (/gemini|google/.test(value)) return "gemini";
  if (/cloudflare|workers ai|\bcf\b/.test(value)) return "cloudflare";
  if (/vercel/.test(value)) return "vercel";
  return undefined;
}

/** The Anthropic Messages host of a model on an endpoint. */
export const messagesBaseOf = (endpoint, entry) => entry?.base ?? endpoint.messagesBase ?? endpoint.baseUrl;
/** The Gemini API host of a model on an endpoint. */
export const geminiBaseOf = (endpoint, entry) => entry?.base ?? endpoint.geminiBase ?? endpoint.baseUrl;
