/**
 * The wire protocols, by catalog name: each builds one streaming request and
 * translates its SSE answer into harness chunks.
 *
 * @module dsh-intl-models/protocols
 */
import * as chat from "./chat.js";
import * as gemini from "./gemini.js";
import * as messages from "./messages.js";
import * as responses from "./responses.js";

export const PROTOCOLS = Object.freeze({ chat, responses, messages, gemini });

/** The protocol module of a model (an unknown name falls back to Chat Completions). */
export const protocolOf = (name) => PROTOCOLS[name] ?? chat;
