/**
 * Localisation.
 *
 * Small enough to be hand-rolled: a dictionary per language, `{placeholder}`
 * interpolation, and plural forms written as `one|few|many`. Russian needs
 * three forms and English two, which is the whole reason the plural rule is a
 * function per language rather than a lookup table.
 *
 * The language is detected from the browser once and then remembered, so a user
 * whose system is English but who wants Russian is not overruled on every load.
 */

import { ru } from "./ru.ts";
import { en } from "./en.ts";
import type { Key } from "./ru.ts";

export type { Key };
export type Lang = "ru" | "en";

const DICTS: Record<Lang, Record<Key, string>> = { ru, en };
const STORAGE_KEY = "kivora.lang";

/** Languages whose speakers are far more likely to want the Russian build. */
const RUSSIAN_LOCALES = ["ru", "be", "kk", "ky", "uk", "uz", "tg", "hy", "az"];

export function detectLang(): Lang {
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ].filter(Boolean) as string[];
  for (const tag of candidates) {
    const base = tag.toLowerCase().split("-")[0]!;
    if (RUSSIAN_LOCALES.includes(base)) return "ru";
    if (base === "en") return "en";
  }
  return "en";
}

let current: Lang = readStored() ?? detectLang();
const listeners = new Set<() => void>();

function readStored(): Lang | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "ru" || raw === "en" ? raw : null;
  } catch {
    return null;
  }
}

export function getLang(): Lang {
  return current;
}

/** `null` clears the override and goes back to following the browser. */
export function setLang(lang: Lang | null): void {
  try {
    if (lang) window.localStorage.setItem(STORAGE_KEY, lang);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: the choice simply does not persist */
  }
  current = lang ?? detectLang();
  document.documentElement.lang = current;
  for (const fn of listeners) fn();
}

export function isLangOverridden(): boolean {
  return readStored() !== null;
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Russian: 1, 2–4, 5+. English: 1, everything else. */
function pluralIndex(lang: Lang, n: number): number {
  if (lang === "en") return n === 1 ? 0 : 1;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return 2;
}

export type Params = Record<string, string | number>;

export function t(key: Key, params?: Params): string {
  const template = DICTS[current][key] ?? DICTS.en[key] ?? key;
  let text = template;

  if (text.includes("|")) {
    const forms = text.split("|");
    const count = Number(params?.count ?? 0);
    text = forms[Math.min(pluralIndex(current, count), forms.length - 1)] ?? forms[0]!;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** BCP-47 tag for `Intl`, so dates and numbers follow the chosen language. */
export function locale(): string {
  return current === "ru" ? "ru-RU" : "en-US";
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { day: "numeric", month: "long" });
}

export function formatShortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

/** "18:42" for today, "26.08" for anything older — the chat-list convention. */
export function formatListStamp(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? formatTime(ts) : formatShortDate(ts);
}

export function formatDayBreak(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return t("common.today");
  if (d.toDateString() === yesterday.toDateString()) return t("common.yesterday");
  return formatDate(ts);
}

export function formatBytes(bytes: number): string {
  const units = current === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString(locale())} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
