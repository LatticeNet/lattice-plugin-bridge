/**
 * What the query bar offers at the caret (src/lib/query/syntax.ts): field
 * names while a word has no operator yet, flags after `is:`, sortable fields
 * after `sort:`, and the field's known values after `field:`. Pure, so the
 * menu's contents are tested without a browser.
 */
import type { FieldType, QueryFieldInfo } from "./engine.js";

export type CompletionKind = "field" | "flag" | "sort" | "value";

export interface Completion {
  /** What the menu shows. */
  label: string;
  /** What replaces the text from `start` to `end`. */
  insert: string;
  kind: CompletionKind;
  /** The field's hint, when it has one. */
  hint?: string;
  type?: FieldType;
}

export interface CompletionResult {
  items: Completion[];
  /** The source range an accepted item replaces. */
  start: number;
  end: number;
}

const NONE: CompletionResult = { items: [], start: 0, end: 0 };
const WORD_BREAK = /[\s()|]/;
const ORDERED: ReadonlySet<FieldType> = new Set(["number", "duration", "time"]);

/** Quote a value the scanner would otherwise split or read as syntax. */
export function quoteQueryValue(value: string): string {
  return /[\s"(),|\\]/.test(value) || value === "" ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function rank(name: string, prefix: string): number {
  if (name === prefix) return 0;
  if (name.startsWith(prefix)) return 1;
  if (name.includes(prefix)) return 2;
  return -1;
}

function byRank<T>(items: { item: T; rank: number }[]): T[] {
  return items
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.item);
}

function findField(fields: readonly QueryFieldInfo[], key: string): QueryFieldInfo | undefined {
  return fields.find((field) => field.key === key || field.aliases.includes(key));
}

/** The best rank of a field's key or aliases against a prefix, -1 when none matches. */
function fieldRank(field: QueryFieldInfo, prefix: string): number {
  const ranks = [field.key, ...field.aliases].map((name) => rank(name.toLowerCase(), prefix)).filter((r) => r >= 0);
  return ranks.length ? Math.min(...ranks) : -1;
}

export function completeQuery(input: string, caret: number, fields: readonly QueryFieldInfo[], limit = 12): CompletionResult {
  let start = caret;
  while (start > 0 && !WORD_BREAK.test(input[start - 1]!)) start -= 1;
  let end = caret;
  while (end < input.length && !WORD_BREAK.test(input[end]!)) end += 1;
  if (input[start] === "-" && start < caret) start += 1;
  const word = input.slice(start, caret);
  // Inside a quote the word is a value as typed; the menu stays out of the way.
  if (word.includes('"')) return NONE;

  const op = word.search(/[:<>=]/);
  if (op < 0) {
    const prefix = word.toLowerCase();
    if (!prefix) return NONE;
    const ranked: { item: Completion; rank: number }[] = [];
    for (const field of fields) {
      const r = fieldRank(field, prefix);
      if (r < 0) continue;
      if (field.flag) {
        // A flag is complete as it stands: is:offline, not offline:yes.
        ranked.push({ item: { label: `is:${field.key}`, insert: `is:${field.key} `, kind: "flag", hint: field.hint, type: field.type }, rank: r + 0.25 });
        continue;
      }
      const operator = ORDERED.has(field.type) ? ">" : ":";
      ranked.push({ item: { label: field.key, insert: `${field.key}${operator}`, kind: "field", hint: field.hint, type: field.type }, rank: r });
    }
    for (const special of ["is", "sort"] as const) {
      const r = rank(special, prefix);
      if (r >= 0) ranked.push({ item: { label: `${special}:`, insert: `${special}:`, kind: special === "is" ? "flag" : "sort" }, rank: r + 0.5 });
    }
    return { items: byRank(ranked).slice(0, limit), start, end };
  }

  const key = word.slice(0, op).toLowerCase();
  const afterOp = word.slice(op).match(/^(:>=|:<=|:=|:>|:<|>=|<=|==|[:<>=])/)?.[0] ?? word[op]!;
  const valueText = word.slice(op + afterOp.length);
  const comma = valueText.lastIndexOf(",");
  const segment = valueText.slice(comma + 1);
  const segmentStart = start + op + afterOp.length + comma + 1;

  if (key === "is") {
    const prefix = segment.toLowerCase();
    const ranked = fields
      .filter((field) => field.flag)
      .map((field) => ({ item: { label: `is:${field.key}`, insert: `${field.key} `, kind: "flag" as const, hint: field.hint }, rank: fieldRank(field, prefix) }))
      .filter((entry) => entry.rank >= 0 || !prefix);
    return { items: byRank(ranked).slice(0, limit), start: segmentStart, end };
  }

  if (key === "sort") {
    const desc = segment.startsWith("-");
    const prefix = (desc ? segment.slice(1) : segment).toLowerCase();
    const sign = desc ? "-" : "";
    const ranked = fields
      .filter((field) => field.sortable)
      .map((field) => ({ item: { label: `sort:${sign}${field.key}`, insert: `${sign}${field.key} `, kind: "sort" as const, hint: field.hint }, rank: fieldRank(field, prefix) }))
      .filter((entry) => entry.rank >= 0 || !prefix);
    return { items: byRank(ranked).slice(0, limit), start: segmentStart, end };
  }

  const field = findField(fields, key);
  if (!field || !field.values.length || ORDERED.has(field.type)) return { items: [], start: segmentStart, end };
  const prefix = segment.toLowerCase();
  const ranked = field.values
    .map((value) => ({
      item: { label: value, insert: `${quoteQueryValue(value)} `, kind: "value" as const, type: field.type },
      rank: prefix ? rank(value.toLowerCase(), prefix) : 1,
    }))
    .filter((entry) => entry.rank >= 0);
  return { items: byRank(ranked).slice(0, limit), start: segmentStart, end };
}
