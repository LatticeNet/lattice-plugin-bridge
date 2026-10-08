/**
 * The shared list query vectors: one runner and one data file (vectors.json)
 * that hold the console's query core and the plugin bridge's port of it to
 * the same behaviour. Both files are byte-identical in the two repositories:
 *
 *   lattice-dashboard      src/lib/query/vectors.ts, src/lib/query/vectors.json
 *   lattice-plugin-bridge  src/query/vectors.ts,     src/query/vectors.json
 *
 * Each repository's test suite runs them against its own core, and the
 * bridge's CI also runs them against the console's core and compares the two
 * copies. Change the grammar in one place, and the other fails until it is
 * ported. Change a vector in both copies, never in one.
 *
 * No imports, so the file reads the same under node --test and vitest; the
 * core is handed in, and the schema is built from plain data.
 */

type Row = Record<string, unknown>;

export interface VectorField {
  key: string;
  aliases?: string[];
  type: string;
  unit?: string;
  values?: string[];
  valueAliases?: Record<string, string>;
  flag?: boolean;
  /** false: the field does not sort. */
  sort?: false;
  /** The row property the field reads. */
  path: string;
  /** Suggest the values the rows hold. */
  suggest?: boolean;
}

export interface VectorError {
  code: string;
  start?: number;
  end?: number;
  params?: Record<string, string>;
}

export interface QueryVectors {
  /** What ages are measured against, as an ISO time. */
  now: string;
  schema: { text: string[]; fields: VectorField[] };
  rows: Row[];
  parse: { query: string; tree?: unknown; sorts?: [string, boolean][]; error?: [string, number, number] }[];
  withoutSorts: [string, string][];
  /** `ids` in order, or `set` in any order, or the `error`; `rows` replaces the shared rows. */
  run: { query: string; ids?: string[]; set?: string[]; error?: VectorError; rows?: Row[] }[];
  complete: { input: string; caret?: number; labels?: string[]; first?: { label: string; insert: string }; start?: number; end?: number }[];
  values: {
    number: [string, string, number | null][];
    duration: [string, number | null][];
    /** `utc` is epoch ms; `local` is Date's own arguments (month from 0), read in the runner's zone. */
    time: [string, { utc: number } | { local: number[] } | null][];
    versions: [string, string, number][];
  };
}

interface TreeNode {
  kind: string;
  items?: TreeNode[];
  item?: TreeNode;
  value?: string;
  quoted?: boolean;
  field?: string;
  op?: string;
  values?: { text: string }[];
}

interface ErrorOut {
  code: string;
  start: number;
  end: number;
  params?: Record<string, string | number>;
}

interface ParseOut {
  ok: boolean;
  tree?: TreeNode | null;
  sorts?: { field: string; desc: boolean }[];
  error?: ErrorOut;
}

interface CompileOut {
  ok: boolean;
  query?: unknown;
  error?: ErrorOut;
}

interface SchemaIn {
  fields: Record<string, unknown>[];
  text: (row: Row) => unknown[];
}

/** The functions a list query core exports, as the runner calls them. */
export interface QueryCore {
  parseQuery(input: string): ParseOut;
  withoutSorts(input: string): string;
  compileQuery(input: string, schema: SchemaIn): CompileOut;
  applyQuery(rows: readonly Row[], query: unknown, now?: number): Row[];
  describeFields(schema: SchemaIn, rows: readonly Row[]): unknown[];
  completeQuery(input: string, caret: number, fields: unknown[], limit?: number): { items: { label: string; insert: string }[]; start: number; end: number };
  parseNumber(text: string, unit?: string): number | undefined;
  parseDuration(text: string): number | undefined;
  parseTime(text: string): number | undefined;
  compareVersions(a: string, b: string): number;
}

function texts(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null && v !== "").map(String);
}

function buildSchema(spec: QueryVectors["schema"]): SchemaIn {
  return {
    fields: spec.fields.map((field) => ({
      key: field.key,
      aliases: field.aliases,
      type: field.type,
      unit: field.unit,
      values: field.values,
      valueAliases: field.valueAliases,
      flag: field.flag,
      sort: field.sort,
      get: (row: Row) => row[field.path],
      suggest: field.suggest ? (rows: readonly Row[]) => rows.flatMap((row) => texts(row[field.path])) : undefined,
    })),
    text: (row) => spec.text.flatMap((path) => texts(row[path])),
  };
}

/** The tree without offsets, as nested arrays, as the console's tests print it. */
function shape(node: TreeNode | null | undefined): unknown {
  if (!node) return null;
  switch (node.kind) {
    case "and":
    case "or":
      return [node.kind, ...(node.items ?? []).map(shape)];
    case "not":
      return ["not", shape(node.item)];
    case "text":
      return node.quoted ? `"${node.value}"` : node.value;
    case "term":
      return `${node.field}${node.op}${(node.values ?? []).map((v) => v.text).join(",")}`;
    default:
      return node.kind;
  }
}

const show = (value: unknown): string => JSON.stringify(value);

/** Run every vector against a core; the failures, one line each, empty when the core agrees. */
export function runQueryVectors(core: QueryCore, vectors: QueryVectors): string[] {
  const failures: string[] = [];
  const check = (label: string, got: unknown, want: unknown): void => {
    if (show(got) !== show(want)) failures.push(`${label}: want ${show(want)}, got ${show(got)}`);
  };
  const schema = buildSchema(vectors.schema);
  const now = Date.parse(vectors.now);
  const ids = (rows: readonly Row[]) => rows.map((row) => String(row.id));

  for (const vector of vectors.parse) {
    const parsed = core.parseQuery(vector.query);
    const label = `parse ${show(vector.query)}`;
    if (vector.error) {
      check(label, parsed.ok ? "ok" : [parsed.error?.code, parsed.error?.start, parsed.error?.end], vector.error);
      continue;
    }
    if (!parsed.ok) {
      failures.push(`${label}: refused with ${parsed.error?.code} at ${parsed.error?.start}`);
      continue;
    }
    if ("tree" in vector) check(label, shape(parsed.tree), vector.tree);
    if (vector.sorts) check(`${label} sorts`, (parsed.sorts ?? []).map((s) => [s.field, s.desc]), vector.sorts);
  }

  for (const [input, want] of vectors.withoutSorts) check(`withoutSorts ${show(input)}`, core.withoutSorts(input), want);

  for (const vector of vectors.run) {
    const label = `run ${show(vector.query)}`;
    const compiled = core.compileQuery(vector.query, schema);
    if (vector.error) {
      if (compiled.ok) {
        failures.push(`${label}: want ${vector.error.code}, got a query`);
        continue;
      }
      const error = compiled.error!;
      const got: Record<string, unknown> = { code: error.code };
      if (vector.error.start !== undefined) got.start = error.start;
      if (vector.error.end !== undefined) got.end = error.end;
      if (vector.error.params) {
        const params: Record<string, string> = {};
        for (const key of Object.keys(vector.error.params)) params[key] = String(error.params?.[key] ?? "");
        got.params = params;
      }
      check(label, got, vector.error);
      continue;
    }
    if (!compiled.ok) {
      failures.push(`${label}: refused with ${compiled.error?.code} at ${compiled.error?.start}`);
      continue;
    }
    const kept = ids(core.applyQuery(vector.rows ?? vectors.rows, compiled.query, now));
    if (vector.ids) check(label, kept, vector.ids);
    if (vector.set) check(`${label} (any order)`, [...kept].sort(), [...vector.set].sort());
  }

  const fields = core.describeFields(schema, vectors.rows);
  for (const vector of vectors.complete) {
    const caret = vector.caret ?? vector.input.length;
    const result = core.completeQuery(vector.input, caret, fields);
    const label = `complete ${show(vector.input)} at ${caret}`;
    if (vector.labels) check(label, result.items.map((item) => item.label), vector.labels);
    if (vector.first) check(`${label} first`, result.items[0] ? { label: result.items[0].label, insert: result.items[0].insert } : null, vector.first);
    if (vector.start !== undefined) check(`${label} start`, result.start, vector.start);
    if (vector.end !== undefined) check(`${label} end`, result.end, vector.end);
  }

  for (const [text, unit, want] of vectors.values.number) check(`parseNumber ${show(text)} ${unit}`, core.parseNumber(text, unit) ?? null, want);
  for (const [text, want] of vectors.values.duration) check(`parseDuration ${show(text)}`, core.parseDuration(text) ?? null, want);
  for (const [text, want] of vectors.values.time) {
    let expected: number | null = null;
    if (want && "utc" in want) expected = want.utc;
    else if (want && "local" in want) {
      const [year = 0, month = 0, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = want.local;
      expected = new Date(year, month, day, hour, minute, second, ms).getTime();
    }
    check(`parseTime ${show(text)}`, core.parseTime(text) ?? null, expected);
  }
  for (const [a, b, want] of vectors.values.versions) check(`compareVersions ${a} ${b}`, core.compareVersions(a, b), want);

  return failures;
}
