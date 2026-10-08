/**
 * The list query grammar: one search, filter and sort syntax for every page
 * that narrows a list in the browser (Nodes, SSH Guard and the other
 * node-centric lists). This file reads the text into a tree; `engine.ts`
 * checks the tree against a page's typed fields and runs it.
 *
 *   tag:edge status:offline OR status:degraded -cap:root sort:-cpu
 *
 * - Space-separated terms must all match. `AND` between terms says the same.
 * - `OR` or `|` between two terms matches either. OR binds tighter than the
 *   space, as in a web search: `a b OR c` reads as a and (b or c).
 * - Parentheses group. `-term`, `-(group)` and `NOT term` negate.
 * - The older call forms `AND(a, b)`, `OR(a, b)` and `NOT(a)` still parse as
 *   they did (src/lib/filterExpressions.ts): case-insensitive names, commas
 *   between arguments, empty arguments dropped, NOT taking exactly one.
 * - `field:value` is a term. The operator is `:` (contains), `:=` or `=`
 *   (exact), or a comparison `>`, `>=`, `<`, `<=` (also written `:>` and so
 *   on). `field:a,b` lists values, any of which may match.
 * - Anywhere else a comma separates terms like a space does, so `hk, sg`
 *   or a pasted `cd, VDS` searches both words instead of failing.
 * - Double quotes keep a value whole: `name:"edge sg"`, `"OR"`. Inside quotes
 *   `\"` and `\\` stand for a quote and a backslash.
 * - `sort:field` or `sort:-field` orders the result; repeat it, or list
 *   fields with commas, to break ties. Only at the top level.
 *
 * Every node and every error carries source offsets, so the bar can point
 * at the character that is wrong. Kept free of Vue so `node --test` covers
 * it directly and the plugin bridge can export it. This is that export,
 * ported from lattice-dashboard src/lib/query/syntax.ts; vectors.json holds
 * the two to one behaviour.
 */

export type CompareOp = ":" | "=" | ">" | ">=" | "<" | "<=";

export interface QueryValue {
  text: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface TermNode {
  kind: "term";
  /** The key as typed, lowercased. */
  field: string;
  op: CompareOp;
  values: QueryValue[];
  /** The whole term, key to last value. */
  start: number;
  end: number;
  /** The key alone. */
  fieldStart: number;
  fieldEnd: number;
  /** The word as typed, for a key that turns out to be text after all. */
  raw: string;
}

export interface TextNode {
  kind: "text";
  value: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface SortNode {
  kind: "sort";
  keys: SortKey[];
  start: number;
  end: number;
}

export interface SortKey {
  /** The field as typed, lowercased, without the leading minus. */
  field: string;
  desc: boolean;
  start: number;
  end: number;
}

export type QueryNode =
  | { kind: "and"; items: QueryNode[]; start: number; end: number }
  | { kind: "or"; items: QueryNode[]; start: number; end: number }
  | { kind: "not"; item: QueryNode; start: number; end: number }
  | TermNode
  | TextNode;

export type QueryErrorCode =
  | "unclosedParen"
  | "unexpectedParen"
  | "unclosedQuote"
  | "danglingOperator"
  | "nothingToNegate"
  | "emptyGroup"
  | "notArity"
  | "callArity"
  | "sortNested"
  | "emptyValue"
  | "unknownField"
  | "unknownValue"
  | "unknownFlag"
  | "unknownSort"
  | "badNumber"
  | "badDuration"
  | "badTime"
  | "badBool"
  | "badVersion"
  | "noCompare"
  | "needsCompare";

export interface QueryError {
  code: QueryErrorCode;
  /** Source offsets of the offending text; `end` may equal `start` at the end of input. */
  start: number;
  end: number;
  params?: Record<string, string | number>;
}

export type ParseResult =
  | {
      ok: true;
      tree: QueryNode | null;
      sorts: SortKey[];
      /** Where each `sort:` term sits in the source, so it can be taken out. */
      sortTerms: { start: number; end: number }[];
    }
  | { ok: false; error: QueryError };

/* ------------------------------------------------------------------ */
/* Lexing                                                              */
/* ------------------------------------------------------------------ */

interface WordTok {
  t: "word";
  start: number;
  end: number;
  /** The word with quotes removed and escapes applied. */
  text: string;
  /** Source offset of each character of `text`. */
  at: number[];
  /** Index in `text` where the first quoted run begins; `text.length` when nothing was quoted. */
  bare: number;
}

interface PunctTok {
  t: "lparen" | "rparen" | "comma" | "pipe" | "minus";
  start: number;
  end: number;
}

type Tok = WordTok | PunctTok;

class Fail extends Error {
  readonly detail: QueryError;
  constructor(detail: QueryError) {
    super(detail.code);
    this.detail = detail;
  }
}

function fail(code: QueryErrorCode, start: number, end: number, params?: QueryError["params"]): never {
  throw new Fail(params ? { code, start, end, params } : { code, start, end });
}

const BREAK = new Set(["(", ")", ",", "|"]);

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === " ";
}

function lex(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") toks.push({ t: "lparen", start: i, end: i + 1 });
    else if (ch === ")") toks.push({ t: "rparen", start: i, end: i + 1 });
    else if (ch === ",") toks.push({ t: "comma", start: i, end: i + 1 });
    else if (ch === "|") toks.push({ t: "pipe", start: i, end: i + 1 });
    else if (ch === "-" && input[i + 1] !== "-") {
      // A minus that opens a word or a group negates it: -cap:root, -(a OR b).
      // Inside a word it is a character: sing-box, sort:-cpu.
      toks.push({ t: "minus", start: i, end: i + 1 });
    } else {
      i = lexWord(input, i, toks);
      continue;
    }
    i += 1;
  }
  return toks;
}

function lexWord(input: string, from: number, toks: Tok[]): number {
  let text = "";
  const at: number[] = [];
  let bare = -1;
  let i = from;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === '"') {
      if (bare < 0) bare = text.length;
      const open = i;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = input[i]!;
        if (c === "\\" && i + 1 < n) {
          text += input[i + 1];
          at.push(i + 1);
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        text += c;
        at.push(i);
        i += 1;
      }
      if (!closed) fail("unclosedQuote", open, n);
      continue;
    }
    if (isSpace(ch) || BREAK.has(ch)) break;
    text += ch;
    at.push(i);
    i += 1;
  }
  toks.push({ t: "word", start: from, end: i, text, at, bare: bare < 0 ? text.length : bare });
  return i;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const KEY = /^[a-z][a-z0-9_-]*$/i;
const CALL_NAMES = new Set(["and", "or", "not"]);

type Parsed = QueryNode | SortNode;

interface Ctx {
  /** The innermost bracket is an AND(...)/OR(...)/NOT(...) call: commas separate arguments. */
  inCall: boolean;
  /** Inside a group, a call, an OR or a negation: sort: is refused here. */
  nested: boolean;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  private readonly input: string;
  constructor(toks: Tok[], input: string) {
    this.toks = toks;
    this.input = input;
  }

  private peek(offset = 0): Tok | undefined {
    return this.toks[this.pos + offset];
  }

  private next(): Tok {
    const tok = this.toks[this.pos]!;
    this.pos += 1;
    return tok;
  }

  private isKeyword(tok: Tok | undefined, word: "AND" | "OR" | "NOT"): boolean {
    return tok?.t === "word" && tok.bare === tok.text.length && tok.text === word;
  }

  /**
   * The next word names a call (`and`, `OR`, `Not`) with "(" after it. Only
   * asked where an operand is expected: after an operand, `OR (a b)` is the
   * operator and a group, never a call.
   */
  private isCall(offset = 0): boolean {
    const tok = this.peek(offset);
    if (tok?.t !== "word" || tok.bare !== tok.text.length || !CALL_NAMES.has(tok.text.toLowerCase())) return false;
    return this.peek(offset + 1)?.t === "lparen";
  }

  private atStop(ctx: Ctx): boolean {
    const tok = this.peek();
    if (!tok) return true;
    if (tok.t === "rparen") return true;
    return tok.t === "comma" && ctx.inCall;
  }

  parseQuery(): Parsed | null {
    const ctx: Ctx = { inCall: false, nested: false };
    const tree = this.parseAnd(ctx);
    const tok = this.peek();
    // Outside a call only a ")" stops the top level.
    if (tok) fail("unexpectedParen", tok.start, tok.end);
    return tree;
  }

  private parseAnd(ctx: Ctx): Parsed | null {
    const items: Parsed[] = [];
    let pendingAnd: Tok | undefined;
    while (!this.atStop(ctx)) {
      const tok = this.peek()!;
      if (tok.t === "comma") {
        // Outside a call a comma separates terms as a space does (a call stops at it above).
        this.next();
        continue;
      }
      // After an operand AND is the operator, even with "(" after it; right
      // after that operator, AND( is a call: a AND AND(b, c).
      if (items.length > 0 && this.isKeyword(tok, "AND") && !(pendingAnd && this.isCall())) {
        if (pendingAnd) fail("danglingOperator", pendingAnd.start, pendingAnd.end, { op: "AND" });
        pendingAnd = this.next();
        continue;
      }
      items.push(this.parseOr(ctx));
      pendingAnd = undefined;
    }
    if (pendingAnd) fail("danglingOperator", pendingAnd.start, pendingAnd.end, { op: "AND" });
    if (items.length === 0) return null;
    if (items.length === 1) return items[0]!;
    return { kind: "and", items: items as QueryNode[], start: items[0]!.start, end: items[items.length - 1]!.end };
  }

  /** OR in operator position: `|`, or the word OR, "(" after it or not. */
  private isOr(tok: Tok | undefined): boolean {
    return tok?.t === "pipe" || this.isKeyword(tok, "OR");
  }

  /** An operand starts here: not the end, a comma, `|`, or a bare AND/OR that is not a call. */
  private operandFollows(ctx: Ctx): boolean {
    if (this.atStop(ctx)) return false;
    const tok = this.peek()!;
    if (tok.t === "comma" || tok.t === "pipe") return false;
    return !((this.isKeyword(tok, "AND") || this.isKeyword(tok, "OR")) && !this.isCall());
  }

  private parseOr(ctx: Ctx): Parsed {
    const first = this.parseUnary(ctx);
    if (!this.isOr(this.peek())) return first;
    const inner: Ctx = { ...ctx, nested: true };
    const items: Parsed[] = [first];
    while (this.isOr(this.peek())) {
      const op = this.next();
      if (!this.operandFollows(ctx)) fail("danglingOperator", op.start, op.end, { op: op.t === "pipe" ? "|" : "OR" });
      items.push(this.parseUnary(inner));
    }
    // A sort inside an OR is refused; the first operand was read before the OR was seen.
    for (const item of items) if (item.kind === "sort") fail("sortNested", item.start, item.end);
    return { kind: "or", items: items as QueryNode[], start: first.start, end: items[items.length - 1]!.end };
  }

  private parseUnary(ctx: Ctx): Parsed {
    const tok = this.peek();
    if (tok?.t === "minus" || (this.isKeyword(tok, "NOT") && !this.isCall())) {
      const op = this.next();
      if (!this.operandFollows(ctx)) fail("nothingToNegate", op.start, op.end);
      const item = this.parseUnary({ ...ctx, nested: true });
      if (item.kind === "sort") fail("sortNested", op.start, item.end);
      return { kind: "not", item, start: op.start, end: item.end };
    }
    return this.parsePrimary(ctx);
  }

  private parsePrimary(ctx: Ctx): Parsed {
    const tok = this.peek()!;
    switch (tok.t) {
      case "lparen": {
        this.next();
        if (this.peek()?.t === "rparen") fail("emptyGroup", tok.start, this.peek()!.end);
        const inner = this.parseAnd({ inCall: false, nested: true });
        const close = this.peek();
        if (close?.t !== "rparen") fail("unclosedParen", tok.start, tok.end);
        this.next();
        if (!inner) fail("emptyGroup", tok.start, close.end);
        return inner;
      }
      case "rparen":
        return fail("unexpectedParen", tok.start, tok.end);
      case "comma":
      case "pipe":
        return fail("danglingOperator", tok.start, tok.end, { op: tok.t === "pipe" ? "|" : "," });
      default:
        break;
    }
    if (this.isCall()) return this.parseCall();
    if (this.isKeyword(tok, "AND") || this.isKeyword(tok, "OR")) fail("danglingOperator", tok.start, tok.end, { op: (tok as WordTok).text });
    return this.parseWord(ctx);
  }

  private parseCall(): Parsed {
    const name = this.next() as WordTok;
    const open = this.next();
    const op = name.text.toUpperCase();
    const args: QueryNode[] = [];
    const ctx: Ctx = { inCall: true, nested: true };
    for (;;) {
      const tok = this.peek();
      if (!tok) fail("unclosedParen", open.start, open.end);
      if (tok.t === "rparen") break;
      if (tok.t === "comma") {
        // Empty arguments are dropped, as the old evaluator did: OR(a,,b) is OR(a, b).
        this.next();
        continue;
      }
      const arg = this.parseAnd(ctx);
      if (arg) {
        if (arg.kind === "sort") fail("sortNested", arg.start, arg.end);
        args.push(arg);
      }
    }
    const close = this.next();
    if (op === "NOT") {
      if (args.length !== 1) fail("notArity", name.start, close.end);
      return { kind: "not", item: args[0]!, start: name.start, end: close.end };
    }
    if (args.length === 0) fail("callArity", name.start, close.end, { op });
    if (args.length === 1) return args[0]!;
    return { kind: op === "AND" ? "and" : "or", items: args, start: name.start, end: close.end };
  }

  private parseWord(ctx: Ctx): Parsed {
    const word = this.next() as WordTok;
    const term = readTerm(word);
    if (!term) return { kind: "text", value: word.text, quoted: word.bare < word.text.length, start: word.start, end: word.end };

    // field:a,b lists values. Inside a call the comma separates arguments instead.
    if (!ctx.inCall) this.readValueList(term);

    if (term.field === "sort") {
      if (ctx.nested) fail("sortNested", term.start, term.end);
      const keys: SortKey[] = [];
      for (const value of term.values) {
        if (!value.text || value.text === "-") fail("emptyValue", value.start, value.end, { field: "sort" });
        const desc = value.text.startsWith("-");
        keys.push({ field: (desc ? value.text.slice(1) : value.text).toLowerCase(), desc, start: value.start, end: value.end });
      }
      return { kind: "sort", keys, start: term.start, end: term.end };
    }
    return term;
  }

  private readValueList(term: TermNode): void {
    for (;;) {
      const comma = this.peek();
      if (comma?.t !== "comma" || comma.start !== term.end) return;
      // A member may start with a minus, which the lexer read as negation: sort:name,-cpu.
      const minus = this.peek(1)?.t === "minus" && this.peek(1)!.start === comma.end ? this.peek(1) : undefined;
      const after = this.peek(minus ? 2 : 1);
      if (after?.t !== "word" || after.start !== (minus ?? comma).end) {
        // "status:offline," while typing: the empty member is named.
        fail("emptyValue", comma.start, comma.end, { field: term.field });
      }
      this.next();
      if (minus) this.next();
      const word = this.next() as WordTok;
      term.values.push({
        text: minus ? `-${word.text}` : word.text,
        quoted: word.bare < word.text.length,
        start: minus ? minus.start : word.start,
        end: word.end,
      });
      term.end = word.end;
      term.raw = this.input.slice(term.start, term.end);
    }
  }
}

/**
 * A word as a field term, or undefined when it is text. The key must be typed
 * outside quotes and start with a letter, so `"node:x"`, `2001:db8::1` and
 * `10.0.0.1:22` stay text. Whether the key names a field is the engine's
 * question, not the parser's.
 */
function readTerm(word: WordTok): TermNode | undefined {
  const { text, at, bare } = word;
  let i = 0;
  while (i < bare && !":<>=".includes(text[i]!)) i += 1;
  if (i === 0 || i >= bare) return undefined;
  const key = text.slice(0, i);
  if (!KEY.test(key)) return undefined;
  let j = i;
  let op: CompareOp;
  const rest = text.slice(i, Math.min(bare, i + 3));
  if (rest.startsWith(":>=") || rest.startsWith(":<=")) {
    op = rest.slice(1, 3) as CompareOp;
    j += 3;
  } else if (rest.startsWith(":=") || rest.startsWith(":>") || rest.startsWith(":<")) {
    op = rest[1] === "=" ? "=" : (rest[1] as CompareOp);
    j += 2;
  } else if (rest.startsWith(">=") || rest.startsWith("<=")) {
    op = rest.slice(0, 2) as CompareOp;
    j += 2;
  } else if (rest.startsWith("==")) {
    op = "=";
    j += 2;
  } else {
    op = rest[0] as CompareOp;
    j += 1;
  }
  const valueText = text.slice(j);
  const valueStart = j < at.length ? at[j]! : word.end;
  return {
    kind: "term",
    field: key.toLowerCase(),
    op,
    values: [{ text: valueText, quoted: bare < text.length && bare >= j, start: valueStart, end: word.end }],
    start: word.start,
    end: word.end,
    fieldStart: word.start,
    fieldEnd: at[i - 1]! + 1,
    raw: text,
  };
}

/** Pull the top-level sorts out; a sort anywhere else was refused while parsing. */
function splitSorts(tree: Parsed | null): { tree: QueryNode | null; sorts: SortKey[]; sortTerms: { start: number; end: number }[] } {
  if (!tree) return { tree: null, sorts: [], sortTerms: [] };
  if (tree.kind === "sort") return { tree: null, sorts: tree.keys, sortTerms: [{ start: tree.start, end: tree.end }] };
  if (tree.kind !== "and") return { tree, sorts: [], sortTerms: [] };
  const sorts: SortKey[] = [];
  const sortTerms: { start: number; end: number }[] = [];
  const items: QueryNode[] = [];
  for (const item of tree.items as Parsed[]) {
    if (item.kind === "sort") {
      sorts.push(...item.keys);
      sortTerms.push({ start: item.start, end: item.end });
    } else items.push(item);
  }
  if (items.length === 0) return { tree: null, sorts, sortTerms };
  if (items.length === 1) return { tree: items[0]!, sorts, sortTerms };
  return { tree: { kind: "and", items, start: items[0]!.start, end: items[items.length - 1]!.end }, sorts, sortTerms };
}

export function parseQuery(input: string): ParseResult {
  try {
    const toks = lex(input);
    const parser = new Parser(toks, input);
    const parsed = parser.parseQuery();
    return { ok: true, ...splitSorts(parsed) };
  } catch (error) {
    if (error instanceof Fail) return { ok: false, error: error.detail };
    throw error;
  }
}

/**
 * The query with its `sort:` terms taken out, the rest as typed. A table
 * header click hands the order back to the table this way. A query that does
 * not parse loses the words that start with `sort:`.
 */
export function withoutSorts(input: string): string {
  const parsed = parseQuery(input);
  if (!parsed.ok) return input.replace(/(^|\s)sort:\S*/g, "$1").trim();
  let out = input;
  for (const span of [...parsed.sortTerms].sort((x, y) => y.start - x.start)) {
    // Take one neighbouring space with the term, so "a sort:x b" reads "a b".
    let { start, end } = span;
    if (start > 0 && /\s/.test(out[start - 1]!)) start -= 1;
    else if (end < out.length && /\s/.test(out[end]!)) end += 1;
    out = out.slice(0, start) + out.slice(end);
  }
  return out.trim();
}
