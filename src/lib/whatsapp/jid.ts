import { isJidGroup, isLidUser, isPnUser, jidNormalizedUser } from "@whiskeysockets/baileys";

export const isGroupJid = (jid?: string | null) => Boolean(jid && isJidGroup(jid));
export const isLid = (jid?: string | null) => Boolean(jid && isLidUser(jid));
export const isPn = (jid?: string | null) => Boolean(jid && isPnUser(jid));

/** "34600111222@s.whatsapp.net" → "34600111222"; LID jids return undefined. */
export function phoneFromJid(jid?: string | null): string | undefined {
  if (!jid || !isPn(jid)) return undefined;
  return jidNormalizedUser(jid).split("@")[0];
}

/** Accepts "+34 600 111 222", "34600111222", "34600111222@s.whatsapp.net" or a group jid. */
export function toJid(input: string): string {
  const v = input.trim();
  if (v.includes("@")) return v;
  const digits = v.replace(/[^\d]/g, "");
  if (!digits) throw new Error(`Cannot convert "${input}" to a WhatsApp jid`);
  return `${digits}@s.whatsapp.net`;
}

export function normalizeUser(jid: string): string {
  return jidNormalizedUser(jid);
}
