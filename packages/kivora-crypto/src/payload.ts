/**
 * The message payload.
 *
 * Everything a message carries — its text, its attachments and their keys —
 * is one JSON object that gets encrypted as a unit. Putting attachment keys in
 * here rather than in a field beside the ciphertext is the whole reason the
 * server cannot open a photo it is storing.
 *
 * Older messages were plain text with no JSON wrapper, and `decodePayload`
 * still reads them: a format change should never turn existing history into
 * "could not be decrypted".
 */

import { fromUtf8, utf8 } from "./bytes.ts";
import type { FileKey } from "./files.ts";

export const PAYLOAD_VERSION = 1;

export interface AttachmentPayload {
  /** Upload id on the server. */
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mime: string;
  /** Original file name, which is metadata the server never sees. */
  name: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  /** A tiny inline preview, so a photo has something to show before download. */
  thumb?: string;
  key: FileKey;
}

export interface MessagePayload {
  v: number;
  text: string;
  attachments?: AttachmentPayload[];
  /** Set on messages the client generated itself, e.g. "call ended". */
  system?: string;
}

export function encodePayload(payload: Omit<MessagePayload, "v">): Uint8Array {
  return utf8(JSON.stringify({ v: PAYLOAD_VERSION, ...payload }));
}

export function decodePayload(plaintext: Uint8Array): MessagePayload {
  const text = fromUtf8(plaintext);
  // A payload always starts with `{`; anything else is a pre-format message.
  if (!text.startsWith("{")) return { v: 0, text };
  try {
    const parsed = JSON.parse(text) as Partial<MessagePayload>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.text !== "string") {
      return { v: 0, text };
    }
    return {
      v: typeof parsed.v === "number" ? parsed.v : 0,
      text: parsed.text,
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : undefined,
      system: typeof parsed.system === "string" ? parsed.system : undefined,
    };
  } catch {
    return { v: 0, text };
  }
}

/** What the chat list shows as the preview line for a message. */
export function summarize(payload: MessagePayload): { icon: "image" | "video" | "file" | null; text: string } {
  if (payload.text.trim()) return { icon: null, text: payload.text };
  const first = payload.attachments?.[0];
  if (!first) return { icon: null, text: "" };
  const icon = first.kind === "image" ? "image" : first.kind === "video" ? "video" : "file";
  return { icon, text: first.name };
}
