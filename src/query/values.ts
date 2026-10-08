/**
 * Typed values for the list query (src/lib/query/syntax.ts): numbers with
 * the units a field is measured in, durations, times, wildcards and agent
 * versions. Pure functions; `undefined` means the text is not a value of
 * that kind, and the engine turns that into a positioned error.
 *
 * Ported from lattice-dashboard src/lib/query/values.ts. TOKEN_ALIASES lives
 * in the console's src/lib/filterExpressions.ts; the bridge has no such
 * module, so it lives here.
 */

/** Words operators type for a value the agent spells differently. */
export const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  macos: "darwin",
  mac: "darwin",
  drawin: "darwin",
};

/** How a number field is measured, which decides the suffixes it accepts. */
export type NumberUnit = "plain" | "percent" | "bytes" | "rate";

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1000,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
};

const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(.*)$/;

/**
 * A number in the field's unit. Percent takes `80` or `80%`. Sizes and rates
 * take `512`, `10MiB`, `1.5GB`, `10M` (single letters are binary, as in most
 * shell tools) and a rate may end in `/s`.
 */
export function parseNumber(text: string, unit: NumberUnit = "plain"): number | undefined {
  const match = NUMBER.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  let suffix = match[2]!.trim().toLowerCase();
  if (!suffix) return value;
  if (unit === "percent") return suffix === "%" ? value : undefined;
  if (unit !== "bytes" && unit !== "rate") return undefined;
  // A rate is a size per second: 10MiB/s, 10MBps.
  if (unit === "rate") suffix = suffix.replace(/\/s$|ps$/, "");
  const factor = SIZE_UNITS[suffix];
  return factor === undefined ? undefined : value * factor;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  m: 60,
  min: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/**
 * Seconds in `30s`, `10m`, `2h`, `3d`, `1w` or a run of them (`1h30m`). A
 * bare number is seconds, the unit the agent reports uptime in.
 */
export function parseDuration(text: string): number | undefined {
  const src = text.trim().toLowerCase();
  if (!src) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(src)) return Number(src);
  const part = /(\d+(?:\.\d+)?)(sec|min|s|m|h|d|w)/y;
  let total = 0;
  let i = 0;
  while (i < src.length) {
    part.lastIndex = i;
    const match = part.exec(src);
    if (!match) return undefined;
    total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
    i = part.lastIndex;
  }
  return total;
}

const MOMENT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A moment as epoch milliseconds: `2026-10-01`, `2026-10-01T12:00`, full ISO.
 * Without a zone the moment is the operator's local time, for a bare date
 * (local midnight) as much as for a date and time; Date.parse would read
 * the bare date as UTC and the two forms would disagree. A date the calendar
 * does not have (2026-02-30) is refused, not rolled into March.
 */
export function parseTime(text: string): number | undefined {
  const match = MOMENT.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  const millis = Number((match[7] ?? "0").padEnd(3, "0"));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const zone = match[8];
  if (!zone) return new Date(year, month - 1, day, hour, minute, second, millis).getTime();
  const offset = zone.toUpperCase() === "Z" ? 0 : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60_000;
}

/** A time a field holds, as epoch ms; the zero time Go serialises counts as never. */
export function timeValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).getUTCFullYear() <= 1) return undefined;
  return ms;
}

const BOOL_WORDS: Record<string, boolean> = {
  true: true,
  yes: true,
  on: true,
  y: true,
  "1": true,
  false: false,
  no: false,
  off: false,
  n: false,
  "0": false,
};

export function parseBool(text: string): boolean | undefined {
  return BOOL_WORDS[text.trim().toLowerCase()];
}

/** A pattern with `*` as its only wildcard, anchored at both ends, case-insensitive. */
export function globPattern(text: string): RegExp {
  const body = text
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Agent versions compare segment by segment, numerically: 0.3.10 is newer
 * than 0.3.9. A leading `v` is ignored, and a prerelease (`-alpha.2`) sorts
 * before its release.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const clean = v.trim().replace(/^v/i, "");
    const dash = clean.indexOf("-");
    return { core: (dash < 0 ? clean : clean.slice(0, dash)).split("."), pre: dash < 0 ? "" : clean.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  const len = Math.max(x.core.length, y.core.length);
  for (let i = 0; i < len; i += 1) {
    const p = x.core[i] ?? "0";
    const q = y.core[i] ?? "0";
    const pn = Number(p);
    const qn = Number(q);
    const diff = !Number.isNaN(pn) && !Number.isNaN(qn) ? pn - qn : p.localeCompare(q);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** A version as typed: digits first, or a v and digits. */
export function looksLikeVersion(text: string): boolean {
  return /^v?\d+(\.\d+)*(-[0-9a-z.]+)?$/i.test(text.trim());
}

/** Relevance of one word in one text: exact 100, prefix 70, substring 50, subsequence 20. */
export function textScore(haystack: string, needle: string, fuzzy: boolean): number {
  if (!needle) return 0;
  if (haystack === needle) return 100;
  if (haystack.startsWith(needle)) return 70;
  if (haystack.includes(needle)) return 50;
  if (fuzzy && subsequence(haystack, needle)) return 20;
  return 0;
}

/** Every character of the needle, in order: "gmhk" finds "gomami-hkg". */
export function subsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** Edit distance, capped: enough to suggest `status` for `stauts`. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length]!;
}
