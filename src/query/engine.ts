/**
 * Runs a list query (src/lib/query/syntax.ts) against a page's typed fields.
 *
 * A page declares its fields once: a key, its aliases, a type, how to read
 * it from a row, and where its suggested values come from. The engine checks
 * every term against that registry before anything is filtered, so a typo
 * (`stauts:offline`, `cpu>eighty`) is an error that names the field and the
 * character, never a silent empty list.
 *
 * Types and what they take:
 *
 * - string, list: `:` contains, `:=` exact, `*` wildcard (anchored). A list
 *   matches when any member does.
 * - enum: a fixed vocabulary; `:` matches the values that contain the word,
 *   and a word that is in none of them is an error listing the vocabulary.
 * - bool: `field:yes|no`, and `is:field` for the ones marked as flags.
 * - number: `=`, `>`, `>=`, `<`, `<=` with the field's unit (`80%`, `10MiB`).
 * - duration: comparisons with `30s 10m 2h 3d 1w`.
 * - time: comparisons against an age (`last_seen>10m`: longer ago than ten
 *   minutes) or a date (`last_seen<2026-10-01`).
 * - version: like string for `:`, and comparisons that read 0.3.10 as newer
 *   than 0.3.9.
 *
 * A bare word searches the page's default text with the fuzzy relevance the
 * Nodes search always had (exact, prefix, substring, then subsequence) and
 * the shared value aliases (mac finds darwin). Under a negation a bare word
 * matches by substring only: `-test` must not drop every row whose name
 * happens to hold t, e, s, t in order. With no `sort:`, rows that a bare
 * word matched float up by relevance; `sort:` replaces that order.
 *
 * Kept free of Vue, like the parser. Ported from lattice-dashboard
 * src/lib/query/engine.ts; vectors.json holds the two to one behaviour.
 */
import {
  parseQuery,
  type CompareOp,
  type QueryError,
  type QueryErrorCode,
  type QueryNode,
  type QueryValue,
  type TermNode,
  type TextNode,
} from "./syntax.js";
import {
  compareVersions,
  editDistance,
  globPattern,
  looksLikeVersion,
  parseBool,
  parseDuration,
  parseNumber,
  parseTime,
  textScore,
  timeValue,
  TOKEN_ALIASES,
  type NumberUnit,
} from "./values.js";

export type FieldType = "string" | "list" | "enum" | "bool" | "number" | "duration" | "time" | "version";

export interface QueryField<T> {
  /** The canonical name, lowercase. */
  key: string;
  aliases?: readonly string[];
  type: FieldType;
  /** For number fields: which suffixes a value may carry. */
  unit?: NumberUnit;
  /** For enum fields: the vocabulary, in the order `sort:` uses. */
  values?: readonly string[];
  /** Words that stand for a value: `never` for `never_reported`. */
  valueAliases?: Readonly<Record<string, string>>;
  /**
   * The row's value: a string, a string list, a number (or a list of them),
   * a boolean, or a time as an ISO string or epoch ms. Undefined when the
   * row has none; a missing value matches no positive term.
   */
  get: (row: T) => unknown;
  /**
   * A matcher for `:` and `=` that knows more than the value does (an agent
   * capability is a rule over several flags). Undefined falls back to the
   * value.
   */
  match?: (row: T, value: string, exact: boolean) => boolean | undefined;
  /** Values worth suggesting after `field:`, from the rows on the page. */
  suggest?: (rows: readonly T[]) => readonly string[];
  /** What the field holds, in a few words, for the help and the menu. */
  hint?: string;
  /** A bool field listed under `is:`. */
  flag?: boolean;
  /** What `sort:` orders by; false when the field does not sort. Defaults to `get`. */
  sort?: false | ((row: T) => unknown);
}

export interface QuerySchema<T> {
  fields: readonly QueryField<T>[];
  /** The texts a bare word searches. */
  text: (row: T) => readonly (string | null | undefined)[];
  /** One more way a bare word may match a row (an agent capability word), scored like an alias. */
  bare?: (row: T, word: string) => boolean;
  /** Value aliases for text and string fields; defaults to the shared ones. */
  aliases?: Readonly<Record<string, string>>;
}

export interface QuerySort<T> {
  field: QueryField<T>;
  desc: boolean;
}

export interface CompiledQuery<T> {
  source: string;
  /** Whether a row passes. `now` is what ages are measured against. */
  test: (row: T, now: number) => boolean;
  /** Relevance from the bare words outside a negation; absent when there are none. */
  score?: (row: T) => number;
  sorts: QuerySort<T>[];
  /** The query asks for nothing: every row, in the page's order. */
  empty: boolean;
}

export type CompileResult<T> = { ok: true; query: CompiledQuery<T> } | { ok: false; error: QueryError };

/* ------------------------------------------------------------------ */
/* Field lookup                                                        */
/* ------------------------------------------------------------------ */

type FieldIndex<T> = Map<string, QueryField<T>>;

const indexes = new WeakMap<object, FieldIndex<never>>();

function fieldIndex<T>(schema: QuerySchema<T>): FieldIndex<T> {
  const cached = indexes.get(schema) as FieldIndex<T> | undefined;
  if (cached) return cached;
  // The first field to claim a name keeps it: a page lists its own fields
  // before the shared node fields, so its `region` wins over the node's.
  const index: FieldIndex<T> = new Map();
  for (const field of schema.fields) {
    for (const name of [field.key, ...(field.aliases ?? [])]) {
      if (!index.has(name.toLowerCase())) index.set(name.toLowerCase(), field);
    }
  }
  indexes.set(schema, index as FieldIndex<never>);
  return index;
}

/** The name closest to a typo, among keys and aliases. */
function closest(word: string, names: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const name of names) {
    if (name.startsWith(word) && word.length >= 2) return name;
    const distance = editDistance(word, name, 2);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

class Refusal extends Error {
  readonly detail: QueryError;
  constructor(detail: QueryError) {
    super(detail.code);
    this.detail = detail;
  }
}

function refuse(code: QueryErrorCode, span: { start: number; end: number }, params?: QueryError["params"]): never {
  throw new Refusal(params ? { code, start: span.start, end: span.end, params } : { code, start: span.start, end: span.end });
}

/** `fe80::1` and its kind read as text, not as a field named fe80. */
function looksLikeIPv6(raw: string): boolean {
  return /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(%\S+)?$/i.test(raw) || /^[0-9a-f:]+:\d+\.\d+\.\d+\.\d+$/i.test(raw);
}

/* ------------------------------------------------------------------ */
/* Compiling                                                           */
/* ------------------------------------------------------------------ */

type Test<T> = (row: T, now: number) => boolean;

function lowerTexts(values: unknown): string[] {
  if (values === undefined || values === null || values === "") return [];
  const list = Array.isArray(values) ? values : [values];
  return list.filter((v) => v !== undefined && v !== null && v !== "").map((v) => String(v).toLowerCase());
}

function numbers(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function compare(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    default:
      return a === b;
  }
}

class Compiler<T> {
  readonly scorers: ((row: T) => number)[] = [];
  private readonly schema: QuerySchema<T>;
  private readonly index: FieldIndex<T>;
  private readonly aliases: Readonly<Record<string, string>>;
  private readonly textCache = new WeakMap<object, string[]>();

  constructor(schema: QuerySchema<T>) {
    this.schema = schema;
    this.index = fieldIndex(schema);
    this.aliases = schema.aliases ?? TOKEN_ALIASES;
  }

  private texts(row: T): string[] {
    if (typeof row !== "object" || row === null) return lowerTexts(this.schema.text(row));
    const hit = this.textCache.get(row);
    if (hit) return hit;
    const texts = lowerTexts(this.schema.text(row));
    this.textCache.set(row, texts);
    return texts;
  }

  node(node: QueryNode, negated: boolean): Test<T> {
    switch (node.kind) {
      case "and": {
        const items = node.items.map((item) => this.node(item, negated));
        return (row, now) => items.every((test) => test(row, now));
      }
      case "or": {
        const items = node.items.map((item) => this.node(item, negated));
        return (row, now) => items.some((test) => test(row, now));
      }
      case "not": {
        const item = this.node(node.item, !negated);
        return (row, now) => !item(row, now);
      }
      case "text":
        return this.text(node, negated);
      case "term":
        return this.term(node, negated);
    }
  }

  private text(node: TextNode, negated: boolean): Test<T> {
    const word = node.value.toLowerCase();
    if (!word) return () => true;
    const bare = this.schema.bare;
    let score: (row: T) => number;
    if (!node.quoted && word.includes("*")) {
      const glob = globPattern(word);
      score = (row) => (this.texts(row).some((text) => glob.test(text)) ? 50 : 0);
    } else {
      const alias = node.quoted ? undefined : this.aliases[word];
      const fuzzy = !node.quoted && !negated;
      score = (row) => {
        let best = 0;
        for (const text of this.texts(row)) best = Math.max(best, textScore(text, word, fuzzy));
        if (best < 60 && alias && this.texts(row).some((text) => text.includes(alias))) best = 60;
        if (best < 60 && !node.quoted && bare?.(row, word)) best = 60;
        return best;
      };
    }
    if (!negated) this.scorers.push(score);
    return (row) => score(row) > 0;
  }

  private resolve(term: TermNode): QueryField<T> | undefined {
    return this.index.get(term.field);
  }

  private term(term: TermNode, negated: boolean): Test<T> {
    if (term.field === "is") return this.flags(term);
    const field = this.resolve(term);
    if (!field) {
      if (looksLikeIPv6(term.raw)) return this.text({ kind: "text", value: term.raw, quoted: false, start: term.start, end: term.end }, negated);
      refuse("unknownField", { start: term.fieldStart, end: term.fieldEnd }, {
        field: term.field,
        suggestion: closest(term.field, this.index.keys()) ?? "",
      });
    }
    for (const value of term.values) {
      if (!value.text) refuse("emptyValue", value.start === value.end ? term : value, { field: field.key });
    }
    const exact = term.op === "=";
    const ordered = term.op !== ":" && term.op !== "=";
    switch (field.type) {
      case "string":
      case "list":
        if (ordered) refuse("noCompare", term, { field: field.key });
        return this.stringMatch(field, term.values, exact);
      case "version":
        if (ordered) return this.versionCompare(field, term);
        return this.stringMatch(field, term.values, exact);
      case "enum":
        if (ordered) refuse("noCompare", term, { field: field.key });
        return this.enumMatch(field, term.values, exact);
      case "bool": {
        if (ordered) refuse("noCompare", term, { field: field.key });
        const wanted = term.values.map((value) => {
          const parsed = parseBool(value.text);
          if (parsed === undefined) refuse("badBool", value, { field: field.key });
          return parsed;
        });
        return (row) => {
          const v = field.get(row);
          return typeof v === "boolean" && wanted.includes(v);
        };
      }
      case "number": {
        const unit = field.unit ?? "plain";
        const wanted = term.values.map((value) => {
          const parsed = parseNumber(value.text, unit);
          if (parsed === undefined) refuse("badNumber", value, { field: field.key, unit });
          return parsed;
        });
        const op = ordered ? term.op : "=";
        return (row) => {
          const have = numbers(field.get(row));
          return have.some((n) => wanted.some((w) => compare(n, op, w)));
        };
      }
      case "duration": {
        if (!ordered) refuse("needsCompare", term, { field: field.key, example: `${field.key}>1h` });
        const wanted = term.values.map((value) => {
          const parsed = parseDuration(value.text);
          if (parsed === undefined) refuse("badDuration", value, { field: field.key });
          return parsed;
        });
        return (row) => {
          const have = numbers(field.get(row));
          return have.some((n) => wanted.some((w) => compare(n, term.op, w)));
        };
      }
      case "time": {
        if (!ordered) refuse("needsCompare", term, { field: field.key, example: `${field.key}>10m` });
        const checks = term.values.map((value): ((t: number, now: number) => boolean) => {
          const age = parseDuration(value.text);
          // An age: last_seen>10m is longer ago than ten minutes.
          if (age !== undefined) return (t, now) => compare((now - t) / 1000, term.op, age);
          const at = parseTime(value.text);
          if (at === undefined) refuse("badTime", value, { field: field.key });
          return (t) => compare(t, term.op, at);
        });
        return (row, now) => {
          const t = timeValue(field.get(row));
          return t !== undefined && checks.some((check) => check(t, now));
        };
      }
    }
  }

  private stringMatch(field: QueryField<T>, values: QueryValue[], exact: boolean): Test<T> {
    const matchers = values.map((value) => {
      const word = value.text.toLowerCase();
      const alias = value.quoted ? undefined : this.aliases[word];
      const glob = !value.quoted && word.includes("*") ? globPattern(word) : undefined;
      return { word, alias, glob, raw: value.text };
    });
    return (row) => {
      for (const m of matchers) {
        const custom = field.match?.(row, m.raw, exact);
        if (custom !== undefined) {
          if (custom) return true;
          continue;
        }
        const have = lowerTexts(field.get(row));
        if (m.glob) {
          if (have.some((text) => m.glob!.test(text))) return true;
          continue;
        }
        const hit = (word: string) => have.some((text) => (exact ? text === word : text.includes(word)));
        if (hit(m.word) || (m.alias !== undefined && hit(m.alias))) return true;
      }
      return false;
    };
  }

  private versionCompare(field: QueryField<T>, term: TermNode): Test<T> {
    const wanted = term.values.map((value) => {
      if (!looksLikeVersion(value.text)) refuse("badVersion", value, { field: field.key });
      return value.text;
    });
    return (row) => {
      const have = lowerTexts(field.get(row)).filter(looksLikeVersion);
      return have.some((v) => wanted.some((w) => compare(compareVersions(v, w), term.op, 0)));
    };
  }

  private enumMatch(field: QueryField<T>, values: QueryValue[], exact: boolean): Test<T> {
    const vocabulary = (field.values ?? []).map((v) => v.toLowerCase());
    const allowed = new Set<string>();
    for (const value of values) {
      const word = value.text.toLowerCase();
      const canonical = (field.valueAliases?.[word] ?? word).toLowerCase();
      const glob = !value.quoted && canonical.includes("*") ? globPattern(canonical) : undefined;
      // A word that is a value means that value (cap:singbox is not singbox-drift); otherwise the values that contain it.
      const named = vocabulary.filter((v) => v === canonical);
      const hits = glob ? vocabulary.filter((v) => glob.test(v)) : exact || named.length ? named : vocabulary.filter((v) => v.includes(canonical));
      if (!hits.length) refuse("unknownValue", value, { field: field.key, value: value.text, values: (field.values ?? []).join(", ") });
      for (const hit of hits) allowed.add(hit);
    }
    return (row) => lowerTexts(field.get(row)).some((v) => allowed.has(v));
  }

  private flags(term: TermNode): Test<T> {
    if (term.op !== ":" && term.op !== "=") refuse("noCompare", term, { field: "is" });
    const flags = this.flagFields();
    const tests = term.values.map((value) => {
      if (!value.text) refuse("emptyValue", term, { field: "is" });
      const field = this.index.get(value.text.toLowerCase());
      if (!field || field.type !== "bool") {
        refuse("unknownFlag", value, { flag: value.text, suggestion: closest(value.text.toLowerCase(), flags) ?? "" });
      }
      return field;
    });
    return (row) => tests.some((field) => field.get(row) === true);
  }

  private flagFields(): string[] {
    return this.schema.fields.filter((f) => f.type === "bool").flatMap((f) => [f.key, ...(f.aliases ?? [])]);
  }
}

/** Read a query against a schema: a runnable query, or the first problem and where it is. */
export function compileQuery<T>(input: string, schema: QuerySchema<T>): CompileResult<T> {
  const parsed = parseQuery(input);
  if (!parsed.ok) return parsed;
  const compiler = new Compiler(schema);
  const index = fieldIndex(schema);
  try {
    const sorts: QuerySort<T>[] = parsed.sorts.map((key) => {
      const field = index.get(key.field);
      if (!field || field.sort === false) {
        const sortable = schema.fields.filter((f) => f.sort !== false).flatMap((f) => [f.key, ...(f.aliases ?? [])]);
        refuse("unknownSort", key, { field: key.field, suggestion: closest(key.field, sortable) ?? "" });
      }
      return { field, desc: key.desc };
    });
    const test = parsed.tree ? compiler.node(parsed.tree, false) : () => true;
    const scorers = compiler.scorers;
    const score = scorers.length ? (row: T) => scorers.reduce((sum, s) => sum + s(row), 0) : undefined;
    return { ok: true, query: { source: input, test, score, sorts, empty: !parsed.tree && sorts.length === 0 } };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.detail };
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

function sortKeyOf<T>(field: QueryField<T>, row: T): number | string | undefined {
  const raw = typeof field.sort === "function" ? field.sort(row) : field.get(row);
  switch (field.type) {
    case "number":
    case "duration": {
      const list = numbers(raw);
      return list.length ? Math.min(...list) : undefined;
    }
    case "time":
      return timeValue(raw);
    case "bool":
      return typeof raw === "boolean" ? (raw ? 1 : 0) : undefined;
    case "enum": {
      if (typeof field.sort === "function" && typeof raw === "number") return raw;
      const first = lowerTexts(raw)[0];
      if (first === undefined) return undefined;
      const at = (field.values ?? []).findIndex((v) => v.toLowerCase() === first);
      return at < 0 ? first : at;
    }
    default: {
      if (typeof raw === "number") return raw;
      const list = Array.isArray(raw) ? raw.filter((v) => v !== undefined && v !== null && v !== "") : raw;
      if (list === undefined || list === null || list === "" || (Array.isArray(list) && !list.length)) return undefined;
      return Array.isArray(list) ? list.join(", ") : String(list);
    }
  }
}

function compareKeys(a: number | string | undefined, b: number | string | undefined, version: boolean): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (version) return compareVersions(String(a), String(b));
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** A comparator for the query's sorts; missing values go last whichever the direction. */
export function querySorter<T>(sorts: readonly QuerySort<T>[]): ((a: T, b: T) => number) | undefined {
  if (!sorts.length) return undefined;
  return (a, b) => {
    for (const { field, desc } of sorts) {
      const x = sortKeyOf(field, a);
      const y = sortKeyOf(field, b);
      if (x === undefined || y === undefined) {
        const diff = compareKeys(x, y, false);
        if (diff) return diff;
        continue;
      }
      const diff = compareKeys(x, y, field.type === "version");
      if (diff) return desc ? -diff : diff;
    }
    return 0;
  };
}

/**
 * Filter and order rows. The rows arrive in the page's own order; a sort
 * replaces it, relevance floats bare-word matches up within it, and ties
 * keep it.
 */
export function applyQuery<T>(rows: readonly T[], query: CompiledQuery<T>, now = Date.now()): T[] {
  if (query.empty) return [...rows];
  const kept = rows.filter((row) => query.test(row, now));
  const sorter = querySorter(query.sorts);
  if (sorter) return kept.sort(sorter);
  if (query.score) {
    const scores = new Map<T, number>();
    for (const row of kept) scores.set(row, query.score(row));
    return kept.sort((a, b) => scores.get(b)! - scores.get(a)!);
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* For the bar                                                         */
/* ------------------------------------------------------------------ */

export interface QueryFieldInfo {
  key: string;
  aliases: readonly string[];
  type: FieldType;
  unit?: NumberUnit;
  hint?: string;
  flag: boolean;
  sortable: boolean;
  /** Known values: the vocabulary, or what the rows hold now. */
  values: readonly string[];
}

const MAX_SUGGESTED_VALUES = 200;

/**
 * What the bar needs to suggest and explain fields, with values read from the
 * rows on the page. A field whose key an earlier field already claims is left
 * out, and so is any alias claimed earlier, so the menu offers only names
 * that reach the field they describe.
 */
export function describeFields<T>(schema: QuerySchema<T>, rows: readonly T[]): QueryFieldInfo[] {
  const index = fieldIndex(schema);
  const reachable = schema.fields.filter((field) => index.get(field.key.toLowerCase()) === field);
  return reachable.map((field) => {
    let values: readonly string[] = field.values ?? [];
    if (!field.values && field.suggest) {
      const seen = new Set<string>();
      for (const value of field.suggest(rows)) if (value) seen.add(value);
      values = [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, MAX_SUGGESTED_VALUES);
    }
    return {
      key: field.key,
      aliases: (field.aliases ?? []).filter((alias) => index.get(alias.toLowerCase()) === field),
      type: field.type,
      unit: field.unit,
      hint: field.hint,
      flag: field.type === "bool" && !!field.flag,
      sortable: field.sort !== false,
      values,
    };
  });
}
