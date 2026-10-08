/**
 * The words the query field says: error sentences, type names, and the
 * syntax card. The console keeps these in its English locale under
 * `common.listQuery`; plugin pages are English and share no i18n with the
 * console, so the same sentences live here as plain functions, usable with
 * or without Vue.
 *
 * The syntax card draws its examples from the page's own fields. The console
 * shows fixed examples (`cpu>80`, `last_seen>10m`) because every console list
 * has node metrics; a plugin page may have none, and an example the page
 * would refuse teaches the wrong thing.
 */
import type { FieldType, QueryFieldInfo } from "./engine.js";
import type { QueryError } from "./syntax.js";

/** The short name of a field type, for the menu and the help. */
export const FIELD_TYPE_LABELS: Readonly<Record<FieldType, string>> = {
  string: "text",
  list: "list",
  enum: "one of a set",
  bool: "yes or no",
  number: "number",
  duration: "duration",
  time: "time",
  version: "version",
};

const BAD_NUMBER: Readonly<Record<string, string>> = {
  plain: "{field} takes a number.",
  percent: "{field} takes a percent, such as 80 or 80%.",
  bytes: "{field} takes a size, such as 512, 10MiB or 1.5GB.",
  rate: "{field} takes a rate, such as 512, 10MiB or 1.5GB per second.",
};

const ERRORS: Readonly<Record<string, string>> = {
  unclosedParen: "This parenthesis is never closed.",
  unexpectedParen: "This parenthesis closes nothing.",
  unclosedQuote: "This quote is never closed.",
  danglingOperator: "{op} needs a term on each side.",
  nothingToNegate: "Nothing follows this minus or NOT.",
  emptyGroup: "These parentheses hold nothing.",
  notArity: "NOT() takes exactly one expression.",
  callArity: "{op}() needs at least one expression.",
  sortNested: "sort: orders the whole list, so it stays outside parentheses, OR and NOT.",
  emptyValue: "{field} needs a value after the operator.",
  unknownField: "There is no field called {field}. To search for the text, put it in quotes.",
  unknownFieldSuggest: "There is no field called {field}. Did you mean {suggestion}?",
  unknownValue: "{field} has no value {value}. It takes {values}.",
  unknownFlag: "is:{flag} is not a flag on this page.",
  unknownFlagSuggest: "is:{flag} is not a flag on this page. Did you mean is:{suggestion}?",
  unknownSort: "This page cannot sort by {field}.",
  unknownSortSuggest: "This page cannot sort by {field}. Did you mean {suggestion}?",
  badDuration: "{field} takes a duration, such as 30s, 10m, 2h, 3d or 1w.",
  badTime: "{field} takes an age, such as 10m or 3d, or a date, such as 2026-10-01.",
  badBool: "{field} takes yes or no.",
  badVersion: "{field} compares against a version, such as 0.3.10.",
  noCompare: "{field} does not compare with > or <. Use {field}:value.",
  needsCompare: "{field} needs a comparison, such as {example}.",
};

function fill(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The sentence for a query error, in the console's words. */
export function queryErrorMessage(error: QueryError): string {
  const params = error.params ?? {};
  if (error.code === "badNumber") return fill(BAD_NUMBER[String(params.unit ?? "plain")] ?? BAD_NUMBER.plain!, params);
  const key = params.suggestion && ERRORS[`${error.code}Suggest`] ? `${error.code}Suggest` : error.code;
  return fill(ERRORS[key] ?? error.code, params);
}

/** The other things the field says, in one place so a page can quote them in its own copy. */
export const QUERY_COPY = {
  clear: "Clear the query",
  help: "Query syntax",
  helpTitle: "Search, filter and sort",
  examples: "On this page",
  syntax: "Syntax",
  fields: "Fields",
  flags: "Flags",
  recent: "Recent",
  recentQueries: "Recent queries",
  menuFlags: "flags",
  menuSort: "order the list",
  precedence:
    "OR binds tighter than a space: a b OR c reads as a, and b or c. The older AND(a, b), OR(a, b) and NOT(a) still work.",
  stale: "The list still shows the last query that read.",
  staleAll: "The list shows every row until the query reads.",
  count: (shown: number, total: number) => `${shown} of ${total}`,
  staleFor: (shown: number, total: number, query: string) => `The list still shows ${shown} of ${total} for ${query}.`,
  column: (n: number) => `(at character ${n})`,
  useSuggestion: (name: string) => `Use ${name}`,
} as const;

export interface SyntaxRow {
  /** Stable name of the row: word, contains, exact, and so on. */
  key: string;
  query: string;
  note: string;
}

export interface SyntaxHelp {
  rows: SyntaxRow[];
  precedence: string;
  /** How a comparison treats a row with no value, with an example from the page; absent when nothing compares. */
  missing?: string;
}

const ORDERED: ReadonlySet<FieldType> = new Set(["number", "duration", "time"]);

function numberExample(field: QueryFieldInfo): string {
  switch (field.unit) {
    case "percent":
      return `${field.key}>=90%`;
    case "bytes":
    case "rate":
      return `${field.key}>10MiB`;
    default:
      return `${field.key}>10`;
  }
}

/**
 * The syntax card for a page: the console's rows, each example written with
 * a field the page has. A row whose kind of field the page lacks (no number,
 * no time, no flag) is left out.
 */
export function querySyntaxHelp(fields: readonly QueryFieldInfo[]): SyntaxHelp {
  const text = fields.find((f) => f.key === "name" && (f.type === "string" || f.type === "list")) ?? fields.find((f) => f.type === "string" || f.type === "list");
  // Contains and leave-out read best on a list of short words, tags on a node page, as the console's examples do.
  const words = fields.find((f) => f.key === "tag" && f.type === "list") ?? fields.find((f) => f.type === "list" && f.values.length > 0) ?? text;
  const choice = fields.find((f) => f.type === "enum" && f.values.length >= 2) ?? fields.find((f) => !f.flag && f.type !== "bool" && !ORDERED.has(f.type) && f.values.length >= 2);
  const numbers = fields.filter((f) => f.type === "number");
  const ages = fields.filter((f) => f.type === "time" || f.type === "duration");
  const flag = fields.find((f) => f.flag);
  const ordered = fields.find((f) => f.sortable && ORDERED.has(f.type));
  const sortable = fields.filter((f) => f.sortable);

  const rows: SyntaxRow[] = [{ key: "word", query: "edge", note: "Rows whose text holds the word, fuzzy" }];
  if (text) {
    rows.push(
      { key: "contains", query: `${words!.key}:edge`, note: "A field contains the value" },
      { key: "exact", query: `${text.key}:=hk-1`, note: "A field is exactly the value" },
      { key: "wildcard", query: `${text.key}:hk*`, note: "A star stands for any text" },
    );
  }
  if (choice) rows.push({ key: "anyOf", query: `${choice.key}:${choice.values.slice(0, 2).join(",")}`, note: "Any of the listed values" });
  else if (text) rows.push({ key: "anyOf", query: `${text.key}:hk,sg`, note: "Any of the listed values" });
  if (numbers.length) rows.push({ key: "compare", query: numbers.slice(0, 2).map(numberExample).join(" "), note: "Compare a number; percents and sizes take units" });
  if (ages.length) {
    rows.push({
      key: "age",
      query: ages.slice(0, 2).map((f) => (f.type === "time" ? `${f.key}>10m` : `${f.key}<1d`)).join(" "),
      note: "Ages and durations: s, m, h, d, w",
    });
  }
  if (flag) rows.push({ key: "flag", query: `is:${flag.key}`, note: "A yes or no flag" });
  const negated = words ? `-${words.key}:lab` : "-lab";
  rows.push(
    { key: "and", query: "a b", note: "Both" },
    { key: "or", query: "a OR b    a | b", note: "Either" },
    { key: "not", query: `${negated}    NOT edge`, note: "Leave out" },
    { key: "group", query: "(a OR b) c", note: "Group terms" },
  );
  if (sortable.length) {
    const first = ordered ?? sortable[0]!;
    const second = sortable.find((f) => f !== first);
    rows.push({
      key: "sort",
      query: second ? `sort:-${first.key} sort:${second.key}` : `sort:-${first.key}`,
      note: "Order the list; a minus sorts high to low, repeat to break ties",
    });
  }
  rows.push({ key: "quote", query: '"two words"', note: "Keep spaces in a value" });

  let missing: string | undefined;
  const compared = numbers[0] ?? ages[0];
  if (compared) {
    const bound = compared.type === "number" ? (compared.unit === "percent" ? "50" : "10") : "1h";
    missing = `A comparison skips rows that have no value for its field. Negating the opposite keeps them: -${compared.key}<${bound} is ${compared.key}>=${bound} plus the rows with no ${compared.key}.`;
  }
  return { rows, precedence: QUERY_COPY.precedence, missing };
}
