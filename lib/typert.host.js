/**
 * Typert manifest for the `intlModels` Remote namespace.
 *
 * Hand-written in the shape `dsh-typert-generator` emits, so `typert-loader`
 * registers it when this package's loader row mounts. Every request codec is
 * strict: unknown fields and wrong types are rejected at the wire boundary
 * (a throw becomes `gateway/input-invalid`). The loader validates this file
 * during its activation pass and a defect would fail it for every plugin, so
 * `test/verify.mjs` runs a port of that validation.
 *
 * @module dsh-intl-models/typert
 */

const PACKAGE = "dsh-intl-models";

function object(value, subject) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${subject} must be an object`);
  return value;
}

function only(value, allowed, subject) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${subject} has an unexpected field ${JSON.stringify(key)}`);
}

function text(value, key, subject, { required = false, max = 4096, nullable = false } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (value[key] === null && nullable) return null;
  if (typeof value[key] !== "string" || (required && value[key].length === 0) || value[key].length > max) {
    throw new TypeError(`${subject}.${key} must be a ${required ? "non-empty " : ""}string of at most ${max} characters${nullable ? " or null" : ""}`);
  }
  return value[key];
}

/** A small map of strings (a key's params: `account`, `gateway`). */
function strings(value, key, subject, names) {
  if (value[key] === undefined) return undefined;
  const map = object(value[key], `${subject}.${key}`);
  for (const [name, item] of Object.entries(map)) {
    if (!names.includes(name)) throw new TypeError(`${subject}.${key} has an unexpected field ${JSON.stringify(name)}`);
    if (item !== null && (typeof item !== "string" || item.length > 64)) throw new TypeError(`${subject}.${key}.${name} must be a string of at most 64 characters or null`);
  }
  return map;
}

function flag(value, key, subject) {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "boolean") throw new TypeError(`${subject}.${key} must be a boolean`);
  return value[key];
}

function ids(value, key, subject, { nullable = false, required = false } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (value[key] === null && nullable) return null;
  if (!Array.isArray(value[key]) || value[key].length > 500 || value[key].some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) {
    throw new TypeError(`${subject}.${key} must be an array of ids${nullable ? " or null" : ""}`);
  }
  return value[key];
}

/** Drop undefined fields so the handler sees exactly what was sent. */
const defined = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

/** One strict codec over a parse function. */
const codec = (type, parse) => ({ mode: "strict", typeSymbol: `${PACKAGE}/types#${type}`, create: () => ({ parse }) });

/** A request with exactly these fields. */
const shape = (type, method, read) => codec(type, (value) => {
  const subject = `intlModels.${method} request`;
  const request = object(value, subject);
  return read(request, subject);
});

const CODECS = {
  status: shape("StatusRequest", "status", (request, subject) => {
    only(request, [], subject);
    return {};
  }),
  checkKeys: shape("CheckKeysRequest", "checkKeys", (request, subject) => {
    only(request, ["keyIds", "deep", "vendor", "mode"], subject);
    const mode = text(request, "mode", subject, { max: 20 });
    if (mode !== undefined && !["auto", "validity", "funds"].includes(mode)) throw new TypeError(`${subject}.mode must be "auto", "validity" or "funds"`);
    return defined({ keyIds: ids(request, "keyIds", subject), deep: flag(request, "deep", subject), vendor: text(request, "vendor", subject, { max: 20 }), mode });
  }),
  addKeys: shape("AddKeysRequest", "addKeys", (request, subject) => {
    only(request, ["text", "vendor", "endpoint", "label", "source", "params"], subject);
    return defined({
      text: text(request, "text", subject, { required: true, max: 64 * 1024 }),
      params: strings(request, "params", subject, ["account", "gateway"]),
      vendor: text(request, "vendor", subject, { max: 20 }),
      endpoint: text(request, "endpoint", subject, { max: 40 }),
      label: text(request, "label", subject, { max: 60 }),
      source: text(request, "source", subject, { max: 40 }),
    });
  }),
  importDshKeys: shape("ImportDshKeysRequest", "importDshKeys", (request, subject) => {
    only(request, ["vendor"], subject);
    return defined({ vendor: text(request, "vendor", subject, { max: 20 }) });
  }),
  updateKey: shape("UpdateKeyRequest", "updateKey", (request, subject) => {
    only(request, ["keyId", "label", "params"], subject);
    return defined({
      keyId: text(request, "keyId", subject, { required: true, max: 200 }),
      label: text(request, "label", subject, { max: 60, nullable: true }),
      params: strings(request, "params", subject, ["account", "gateway"]),
    });
  }),
  removeKey: shape("RemoveKeyRequest", "removeKey", (request, subject) => {
    only(request, ["keyId"], subject);
    return { keyId: text(request, "keyId", subject, { required: true, max: 200 }) };
  }),
  switchKey: shape("SwitchKeyRequest", "switchKey", (request, subject) => {
    only(request, ["keyId"], subject);
    return { keyId: text(request, "keyId", subject, { required: true, max: 200 }) };
  }),
  reorderKeys: shape("ReorderKeysRequest", "reorderKeys", (request, subject) => {
    only(request, ["endpoint", "keyIds"], subject);
    const keyIds = ids(request, "keyIds", subject, { required: true });
    if (keyIds.length === 0) throw new TypeError(`${subject}.keyIds must list the keys in their new order`);
    return { endpoint: text(request, "endpoint", subject, { required: true, max: 40 }), keyIds };
  }),
  refreshModels: shape("RefreshModelsRequest", "refreshModels", (request, subject) => {
    only(request, ["endpoint"], subject);
    return { endpoint: text(request, "endpoint", subject, { required: true, max: 40 }) };
  }),
  updateSettings: shape("UpdateSettingsRequest", "updateSettings", (request, subject) => {
    only(request, ["vendor", "autoSwitch", "rotateOnRateLimit", "hiddenVendors", "endpoint", "enabledModelIds"], subject);
    const parsed = defined({
      vendor: text(request, "vendor", subject, { max: 20 }),
      autoSwitch: flag(request, "autoSwitch", subject),
      rotateOnRateLimit: flag(request, "rotateOnRateLimit", subject),
      hiddenVendors: ids(request, "hiddenVendors", subject),
      endpoint: text(request, "endpoint", subject, { max: 40 }),
      enabledModelIds: ids(request, "enabledModelIds", subject, { nullable: true }),
    });
    if (parsed.enabledModelIds !== undefined && !parsed.endpoint) throw new TypeError(`${subject}.enabledModelIds needs an endpoint`);
    return parsed;
  }),
  exportKeys: shape("ExportKeysRequest", "exportKeys", (request, subject) => {
    only(request, ["vendor"], subject);
    return { vendor: text(request, "vendor", subject, { required: true, max: 20 }) };
  }),
};

const SUMMARY = {
  status: "The keys, their state, the endpoints, and each endpoint's models.",
  checkKeys: "Re-check the named keys, one vendor's, or all: validity or balance (`mode`); `deep` also probes whether there is money behind each key.",
  addKeys: "Add pasted keys (to one vendor's tab, or anywhere), detecting each key's endpoint unless one is given.",
  importDshKeys: "Add the keys DSH already stores for these vendors.",
  updateKey: "Change a key's label, or its params (Cloudflare's gateway).",
  removeKey: "Forget one key.",
  switchKey: "Make one key its endpoint's active key.",
  reorderKeys: "Put one endpoint's keys in a new order (also the order switching tries them in).",
  refreshModels: "Re-fetch one endpoint's model list.",
  updateSettings: "Change a vendor's switching settings, the hidden vendor tabs, or one endpoint's selected models.",
  exportKeys: "Write one vendor's keys to a text file (one `Vendor: key` line each) and return its path.",
};

const REQUEST_TYPES = {
  status: "StatusRequest",
  checkKeys: "CheckKeysRequest",
  addKeys: "AddKeysRequest",
  importDshKeys: "ImportDshKeysRequest",
  updateKey: "UpdateKeyRequest",
  removeKey: "RemoveKeyRequest",
  switchKey: "SwitchKeyRequest",
  reorderKeys: "ReorderKeysRequest",
  refreshModels: "RefreshModelsRequest",
  updateSettings: "UpdateSettingsRequest",
  exportKeys: "ExportKeysRequest",
};

const DECLARATIONS = {
  StatusRequest: "export interface StatusRequest {}",
  CheckKeysRequest: "export interface CheckKeysRequest {\n    readonly keyIds?: readonly string[];\n    readonly deep?: boolean;\n    readonly vendor?: string;\n    readonly mode?: \"auto\" | \"validity\" | \"funds\";\n}",
  AddKeysRequest: "export interface AddKeysRequest {\n    readonly text: string;\n    readonly vendor?: string;\n    readonly endpoint?: string;\n    readonly label?: string;\n    readonly source?: string;\n    readonly params?: { readonly account?: string | null; readonly gateway?: string | null };\n}",
  ImportDshKeysRequest: "export interface ImportDshKeysRequest {\n    readonly vendor?: string;\n}",
  UpdateKeyRequest: "export interface UpdateKeyRequest {\n    readonly keyId: string;\n    readonly label?: string | null;\n    readonly params?: { readonly account?: string | null; readonly gateway?: string | null };\n}",
  RemoveKeyRequest: "export interface RemoveKeyRequest {\n    readonly keyId: string;\n}",
  SwitchKeyRequest: "export interface SwitchKeyRequest {\n    readonly keyId: string;\n}",
  ReorderKeysRequest: "export interface ReorderKeysRequest {\n    readonly endpoint: string;\n    readonly keyIds: readonly string[];\n}",
  RefreshModelsRequest: "export interface RefreshModelsRequest {\n    readonly endpoint: string;\n}",
  ExportKeysRequest: "export interface ExportKeysRequest {\n    readonly vendor: string;\n}",
  UpdateSettingsRequest: "export interface UpdateSettingsRequest {\n    readonly vendor?: string;\n    readonly autoSwitch?: boolean;\n    readonly rotateOnRateLimit?: boolean;\n    readonly hiddenVendors?: readonly string[];\n    readonly endpoint?: string;\n    readonly enabledModelIds?: readonly string[] | null;\n}",
  IntlModelsStatus: "export interface IntlModelsStatus {\n    readonly autoSwitch: boolean;\n    readonly rotateOnRateLimit: boolean;\n    readonly keys: readonly KeySummary[];\n    readonly endpoints: readonly unknown[];\n    readonly models: Readonly<Record<string, unknown>>;\n}",
  KeySummary: "export interface KeySummary {\n    readonly id: string;\n    readonly endpoint: string;\n    readonly label: string | null;\n    readonly masked: string;\n    readonly active: boolean;\n    readonly status: string;\n    readonly balance: unknown;\n    readonly quota: unknown;\n    readonly limitedUntil: string | null;\n}",
};

export const METHODS = Object.keys(CODECS);

export const TYPERT = {
  package: PACKAGE,
  face: "host",
  schemas: [],
  invocations: METHODS.map((method) => ({
    id: `${PACKAGE}#intlModels/${method}`,
    service: "intlModelsKeys",
    namespace: "intlModels",
    method,
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: CODECS[method] }],
    cancellation: { parameter: "signal" },
    result: { mode: "strict", typeSymbol: `${PACKAGE}#intlModels/${method}:result`, create: () => ({ parse: (value) => value }) },
  })),
  model: {
    services: [{
      key: "intlModelsKeys",
      exportName: "IntlModelsKeys",
      description: "Key and model management behind `ctx.remote.intlModels`: many API keys per international vendor endpoint, their validity, balance and spending, switching, and the selected models.",
      summary: "Key and model management behind `ctx.remote.intlModels`.",
      jsDoc: "/** Key and model management behind `ctx.remote.intlModels`. */",
      tags: [],
      members: METHODS.map((method) => ({
        kind: "method",
        name: method,
        signature: `${method}(request: ${REQUEST_TYPES[method]}, signal: AbortSignal): Promise<IntlModelsStatus>`,
        summary: SUMMARY[method],
        jsDoc: `/** ${SUMMARY[method]} */`,
      })),
      types: Object.entries(DECLARATIONS).map(([name, declaration]) => ({ name, declaration })),
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
