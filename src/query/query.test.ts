/**
 * The console's list query tests (lattice-dashboard
 * src/lib/__tests__/listQuery.test.ts), ported to vitest and to the plugin
 * node field set, plus what only the bridge has: node facts without the
 * console's record, `only`, and the English copy. The generic grammar and
 * engine cases also live in vectors.json, which both repositories run.
 */
import { describe, expect, it } from "vitest";

import {
  applyQuery,
  compileQuery,
  completeQuery,
  compareVersions,
  describeFields,
  nodeQueryFields,
  nodeQuerySchema,
  nodeStatusOf,
  parseDuration,
  parseNumber,
  parseQuery,
  parseTime,
  queryErrorMessage,
  querySyntaxHelp,
  withoutSorts,
  type CompiledQuery,
  type PluginNodeFacts,
  type QueryError,
  type QueryNode,
  type QuerySchema,
} from "./index";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function node(over: Partial<PluginNodeFacts> & { id: string }): PluginNodeFacts {
  return { name: over.id, online: true, status: "online", last_seen: ago(5), ...over };
}

const FLEET: PluginNodeFacts[] = [
  node({
    id: "n-hk",
    name: "[cd]-gomami-hkg",
    tags: ["edge", "cd"],
    role: "relay",
    public_ip: "203.0.113.10",
    public_ipv6: "2001:db8::10",
    agent_version: "0.3.10",
    host_facts: { os: "linux", platform: "debian", platform_version: "12", arch: "amd64", hostname: "gomami" },
    geo: { country: "HK", region: "Hong Kong", city: "Kowloon", provider: "Gomami", as_org: "GOMAMI-AS", asn: 64500 },
    group_ids: ["g1"],
  }),
  node({
    id: "n-fsn",
    name: "[cd]-hetzner-fsn",
    tags: ["core"],
    public_ip: "198.51.100.7",
    agent_version: "0.3.9",
    host_facts: { os: "linux", platform: "ubuntu", arch: "arm64" },
    geo: { country: "DE", region: "Saxony", city: "Falkenstein", provider: "Hetzner" },
  }),
  node({
    id: "n-mac",
    name: "studio-mac",
    tags: ["home"],
    internal_ip: "10.0.0.20",
    agent_version: "0.3.10-alpha.2",
    host_facts: { os: "darwin", platform: "darwin", arch: "arm64" },
  }),
  node({
    id: "n-dmit",
    name: "DMIT-4",
    status: "offline",
    online: false,
    last_seen: ago(6 * 86400),
    tags: ["edge"],
    agent_version: "0.3.8",
    host_facts: { os: "linux", arch: "amd64" },
  }),
  // The API sends the Go zero time for a node that never reported.
  node({ id: "n-new", name: "fresh-box", status: "never_reported", online: false, last_seen: "0001-01-01T00:00:00Z" }),
];

const groups: Record<string, string> = { g1: "Asia relays" };
const schema = nodeQuerySchema({ groupName: (id) => groups[id] });

function run(query: string, rows: readonly PluginNodeFacts[] = FLEET): string[] {
  const compiled = compileQuery(query, schema);
  if (!compiled.ok) throw new Error(`${query}: ${compiled.error.code} at ${compiled.error.start}`);
  return applyQuery(rows, compiled.query, NOW).map((n) => n.id);
}

function errorOf(query: string): QueryError {
  const compiled = compileQuery(query, schema);
  expect(compiled.ok, `${query} should be refused`).toBe(false);
  return (compiled as { ok: false; error: QueryError }).error;
}

/** The tree without offsets, as nested arrays: easier to read in a failure. */
function shape(tree: QueryNode | null): unknown {
  if (!tree) return null;
  switch (tree.kind) {
    case "and":
    case "or":
      return [tree.kind, ...tree.items.map(shape)];
    case "not":
      return ["not", shape(tree.item)];
    case "text":
      return tree.quoted ? `"${tree.value}"` : tree.value;
    case "term":
      return `${tree.field}${tree.op}${tree.values.map((v) => v.text).join(",")}`;
  }
}

function tree(query: string): unknown {
  const parsed = parseQuery(query);
  expect(parsed.ok, `${query} should parse`).toBe(true);
  return parsed.ok ? shape(parsed.tree) : undefined;
}

/* ------------------------------------------------------------------ */
/* Grammar                                                             */
/* ------------------------------------------------------------------ */

describe("grammar", () => {
  it("space is AND, OR and | bind tighter, parentheses group", () => {
    expect(tree("a b")).toEqual(["and", "a", "b"]);
    expect(tree("a AND b")).toEqual(["and", "a", "b"]);
    expect(tree("a b OR c")).toEqual(["and", "a", ["or", "b", "c"]]);
    expect(tree("a | b c")).toEqual(["and", ["or", "a", "b"], "c"]);
    expect(tree("(a b) OR c")).toEqual(["or", ["and", "a", "b"], "c"]);
    expect(tree("x OR (a b)")).toEqual(["or", "x", ["and", "a", "b"]]);
  });

  it("-term, -(group) and NOT term negate; a minus inside a word is a character", () => {
    expect(tree("-a b")).toEqual(["and", ["not", "a"], "b"]);
    expect(tree("-(a OR b)")).toEqual(["not", ["or", "a", "b"]]);
    expect(tree("NOT a b")).toEqual(["and", ["not", "a"], "b"]);
    expect(tree("sing-box -cap:root")).toEqual(["and", "sing-box", ["not", "cap:root"]]);
  });

  it("field terms: operators, comma lists and quoted values", () => {
    expect(tree("cpu>80 cpu:>=80% mem<=50 disk<10 name:=a ip=1")).toEqual(["and", "cpu>80", "cpu>=80%", "mem<=50", "disk<10", "name=a", "ip=1"]);
    expect(tree("status:offline,degraded")).toEqual("status:offline,degraded");
    expect(tree('name:"edge sg" "OR"')).toEqual(["and", "name:edge sg", '"OR"']);
    expect(tree('"node:x" 2001:db8::1 example.com:443')).toEqual(["and", '"node:x"', "2001:db8::1", "example.com:443"]);
  });

  it("sort: is pulled out of the top level, in order, and refused anywhere else", () => {
    const parsed = parseQuery("tag:edge sort:-cpu sort:name,-last_seen");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sorts.map((s) => [s.field, s.desc])).toEqual([["cpu", true], ["name", false], ["last_seen", true]]);
    expect(shape(parsed.tree)).toEqual("tag:edge");
    for (const nested of ["(sort:cpu)", "a OR sort:cpu", "sort:cpu OR a", "-sort:cpu", "OR(a, sort:cpu)"]) {
      const result = parseQuery(nested);
      expect(result.ok ? "ok" : result.error.code, nested).toBe("sortNested");
    }
  });

  it("withoutSorts takes the sort terms out and keeps the rest as typed", () => {
    expect(withoutSorts("tag:edge sort:-cpu cpu>80 sort:name,-id")).toBe("tag:edge cpu>80");
    expect(withoutSorts("sort:cpu")).toBe("");
    expect(withoutSorts('name:"a  b" sort:cpu')).toBe('name:"a  b"');
    expect(withoutSorts("sort:cpu tag:edge")).toBe("tag:edge");
    expect(withoutSorts("cpu> sort:cpu")).toBe("cpu>");
  });

  it("errors carry the code and the offending span", () => {
    const cases: [string, string, number, number][] = [
      ["(a b", "unclosedParen", 0, 1],
      ["a b)", "unexpectedParen", 3, 4],
      ['name:"edge', "unclosedQuote", 5, 10],
      ["a OR", "danglingOperator", 2, 4],
      ["OR a", "danglingOperator", 0, 2],
      ["a | | b", "danglingOperator", 2, 3],
      ["a AND", "danglingOperator", 2, 5],
      ["a -", "nothingToNegate", 2, 3],
      ["()", "emptyGroup", 0, 2],
      ["NOT(a, b)", "notArity", 0, 9],
      ["AND()", "callArity", 0, 5],
      ["status:offline,", "emptyValue", 14, 15],
    ];
    for (const [query, code, start, end] of cases) {
      const parsed = parseQuery(query);
      expect(parsed.ok, query).toBe(false);
      if (parsed.ok) continue;
      expect([parsed.error.code, parsed.error.start, parsed.error.end], query).toEqual([code, start, end]);
    }
  });

  it("every old call form parses as it did", () => {
    expect(tree("AND(exec, root, NOT(sing-box))")).toEqual(["and", "exec", "root", ["not", "sing-box"]]);
    expect(tree("OR(linux, darwin, amd64, arm64)")).toEqual(["or", "linux", "darwin", "amd64", "arm64"]);
    expect(tree("AND(cd)")).toEqual("cd");
    expect(tree("and(a,b)")).toEqual(["and", "a", "b"]);
    expect(tree("Or(a , b)")).toEqual(["or", "a", "b"]);
    expect(tree("NOT (x)")).toEqual(["not", "x"]);
    expect(tree("AND (a, b)")).toEqual(["and", "a", "b"]);
    expect(tree("OR(a,,b,)")).toEqual(["or", "a", "b"]);
    expect(tree("AND(agent:exec,tag:cd)")).toEqual(["and", "agent:exec", "tag:cd"]);
    expect(tree("OR(tag:a,b)")).toEqual(["or", "tag:a", "b"]);
    expect(tree("OR(AND(a, b), NOT(c))")).toEqual(["or", ["and", "a", "b"], ["not", "c"]]);
    for (const bad of ["NOT(a, b)", "NOT()", "AND()", "OR()", "AND(a", "AND(a))"]) expect(parseQuery(bad).ok, bad).toBe(false);
  });

  it("outside a call a comma separates terms, so pasted text never fails", () => {
    expect(tree("a, b")).toEqual(["and", "a", "b"]);
    expect(tree("cd,VDS")).toEqual(["and", "cd", "VDS"]);
    expect(tree("(hk, sg) OR x")).toEqual(["or", ["and", "hk", "sg"], "x"]);
    expect(tree(", a ,")).toEqual("a");
    expect(tree("tag:a,b c")).toEqual(["and", "tag:a,b", "c"]);
    expect(tree("OR(a, b), c")).toEqual(["and", ["or", "a", "b"], "c"]);
    expect(run("edge, cd")).toEqual(["n-hk"]);
  });
});

/* ------------------------------------------------------------------ */
/* The plugin node fields                                              */
/* ------------------------------------------------------------------ */

describe("node fields over plugin facts", () => {
  it("string and list fields: contains, exact, wildcard and aliases", () => {
    expect(run("name:hetz")).toEqual(["n-fsn"]);
    expect(run("name:=studio-mac")).toEqual(["n-mac"]);
    expect(run("name:=studio")).toEqual([]);
    expect(run("name:*-fsn")).toEqual(["n-fsn"]);
    expect(run("name:[cd]*").sort()).toEqual(["n-fsn", "n-hk"]);
    expect(run("tag:edge").sort()).toEqual(["n-dmit", "n-hk"]);
    expect(run("tag:relay")).toEqual(["n-hk"]);
    expect(run("ip:2001:db8")).toEqual(["n-hk"]);
    expect(run("ip:10.0.*")).toEqual(["n-mac"]);
    expect(run("os:macos")).toEqual(["n-mac"]);
    expect(run("os:amd64").sort()).toEqual(["n-dmit", "n-hk"]);
    expect(run("group:asia")).toEqual(["n-hk"]);
    expect(run("provider:hetzner")).toEqual(["n-fsn"]);
    expect(run("provider:AS64500")).toEqual(["n-hk"]);
    expect(run("region:kowloon")).toEqual(["n-hk"]);
    expect(run("arch:arm64").sort()).toEqual(["n-fsn", "n-mac"]);
  });

  it("status is the server's word, and rebuilt when a plugin has only the facts", () => {
    expect(run("status:offline")).toEqual(["n-dmit"]);
    expect(run("status:never")).toEqual(["n-new"]);
    expect(run("status:offline,never").sort()).toEqual(["n-dmit", "n-new"]);
    const error = errorOf("status:ofline");
    expect([error.code, error.start, error.end]).toEqual(["unknownValue", 7, 13]);
    expect(String(error.params?.values)).toMatch(/never_reported/);

    expect(nodeStatusOf({ id: "a", online: true })).toBe("online");
    expect(nodeStatusOf({ id: "a", online: true, disabled: true })).toBe("disabled");
    expect(nodeStatusOf({ id: "a", online: false, last_seen: ago(60) })).toBe("offline");
    expect(nodeStatusOf({ id: "a", online: false, last_seen: "0001-01-01T00:00:00Z" })).toBe("never_reported");
    expect(nodeStatusOf({ id: "a", online: false, last_seen: "" })).toBe("never_reported");
    // As the console: with no last_seen at all nobody said it never reported.
    expect(nodeStatusOf({ id: "a", online: false })).toBe("offline");
    expect(nodeStatusOf({ id: "a", status: "degraded", online: true })).toBe("degraded");
    expect(nodeStatusOf({ id: "a", status: "weird", online: true })).toBe("online");
  });

  it("flags and bool fields", () => {
    expect(run("is:offline")).toEqual(["n-dmit"]);
    expect(run("is:never")).toEqual(["n-new"]);
    expect(run("-is:online").sort()).toEqual(["n-dmit", "n-new"]);
    expect(run("is:reporting").sort()).toEqual(["n-fsn", "n-hk", "n-mac"]);
    expect(run("online:no").sort()).toEqual(["n-dmit", "n-new"]);
    expect(errorOf("is:onlin").code).toBe("unknownFlag");
    expect(errorOf("is:onlin").params?.suggestion).toBe("online");
    expect(errorOf("online:maybe").code).toBe("badBool");
  });

  it("last_seen reads ages and dates, and the zero time is no time", () => {
    expect(run("last_seen>1d")).toEqual(["n-dmit"]);
    expect(run("last_seen<1m").sort()).toEqual(["n-fsn", "n-hk", "n-mac"]);
    expect(run("last_seen<2026-10-05")).toEqual(["n-dmit"]);
    expect(run("seen>=2026-10-08T11:00Z").sort()).toEqual(["n-fsn", "n-hk", "n-mac"]);
    expect(run("-last_seen<1h").sort()).toEqual(["n-dmit", "n-new"]);
    expect(run("sort:-last_seen").at(-1)).toBe("n-new");
    expect(errorOf("last_seen:3d").code).toBe("needsCompare");
    expect(errorOf("last_seen>yesterday").code).toBe("badTime");
  });

  it("versions compare by segment", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBe(1);
    expect(compareVersions("v0.3.9", "0.3.9")).toBe(0);
    expect(compareVersions("0.3.10-alpha.2", "0.3.10")).toBe(-1);
    expect(run("agent<0.3.10").sort()).toEqual(["n-dmit", "n-fsn", "n-mac"]);
    expect(run("agent>=0.3.10")).toEqual(["n-hk"]);
    expect(run("agent:0.3.1")).toEqual(["n-hk", "n-mac"]);
    expect(errorOf("agent>latest").code).toBe("badVersion");
  });

  it("the console's agent capabilities and live metrics are not fields here", () => {
    for (const key of ["cap", "drift", "cpu", "mem", "disk", "load", "rx", "tx", "uptime"]) {
      expect(errorOf(`${key}:x`).code, key).toBe("unknownField");
    }
    expect(errorOf("is:drift").code).toBe("unknownFlag");
  });

  it("unknown fields are errors with a suggestion; IPv6 stays text", () => {
    const error = errorOf("tag:edge stauts:offline");
    expect([error.code, error.start, error.end, error.params?.suggestion]).toEqual(["unknownField", 9, 15, "status"]);
    expect(run("fe80::1")).toEqual([]);
    expect(run("2001:db8::10")).toEqual(["n-hk"]);
    expect(errorOf("sort:nmae").params?.suggestion).toBe("name");
    expect(errorOf("sort:online").code).toBe("unknownSort");
  });

  it("only keeps the fields a page can answer, in the console's order", () => {
    const fields = nodeQueryFields<PluginNodeFacts>((n) => n, { only: ["status", "name", "last_seen", "online"] });
    expect(fields.map((f) => f.key)).toEqual(["name", "status", "online", "last_seen"]);
    const narrow: QuerySchema<PluginNodeFacts> = { fields, text: (n) => [n.name] };
    const compiled = compileQuery("tag:edge", narrow);
    expect(compiled.ok ? "ok" : compiled.error.code).toBe("unknownField");
  });

  it("rows about nodes reach them through nodeOf, and identity names a row whose node left", () => {
    interface Binding {
      nodeId: string;
      label?: string;
      port: number;
    }
    const byId = new Map(FLEET.map((n) => [n.id, n]));
    const rows: Binding[] = [
      { nodeId: "n-hk", port: 22 },
      { nodeId: "n-fsn", port: 58394 },
      { nodeId: "gone", label: "old-box", port: 22 },
    ];
    const bindings: QuerySchema<Binding> = {
      fields: [
        { key: "port", type: "number", get: (r) => r.port },
        ...nodeQueryFields<Binding>((r) => byId.get(r.nodeId), { identity: (r) => ({ id: r.nodeId, name: r.label }) }),
      ],
      text: (r) => [byId.get(r.nodeId)?.name ?? r.label],
    };
    const find = (query: string) => {
      const compiled = compileQuery(query, bindings);
      if (!compiled.ok) throw new Error(`${query}: ${compiled.error.code}`);
      return applyQuery(rows, compiled.query, NOW).map((r) => r.nodeId);
    };
    expect(find("port:22")).toEqual(["n-hk", "gone"]);
    expect(find("name:old")).toEqual(["gone"]);
    expect(find("tag:edge")).toEqual(["n-hk"]);
    expect(find("-tag:edge")).toEqual(["n-fsn", "gone"]);
    expect(find("sort:-name")).toEqual(["gone", "n-fsn", "n-hk"]);
    expect(find("sort:status").at(-1)).toBe("gone");
  });
});

/* ------------------------------------------------------------------ */
/* Text, relevance and sort                                            */
/* ------------------------------------------------------------------ */

describe("text, relevance and sort", () => {
  it("a bare word is the fuzzy search the Nodes page has", () => {
    expect(run("gmhk")).toEqual(["n-hk"]);
    expect(run("hetzner")).toEqual(["n-fsn"]);
    expect(run("mac")).toEqual(["n-mac"]);
    expect(run("gomami")).toEqual(["n-hk"]);
    expect(run("203.0.113")).toEqual(["n-hk"]);
    expect(run('"gomami-hkg"')).toEqual(["n-hk"]);
    expect(run('"gmhk"')).toEqual([]);
  });

  it("a negated bare word is a substring, not a subsequence", () => {
    expect(run("-fsn").sort()).toEqual(["n-dmit", "n-hk", "n-mac", "n-new"]);
    expect(run("-dmt")).toContain("n-dmit");
  });

  it("relevance floats exact and prefix matches without a sort", () => {
    const rows = [node({ id: "a", name: "xx-edge-yy" }), node({ id: "b", name: "edge" }), node({ id: "c", name: "edgerunner" })];
    expect(run("edge", rows)).toEqual(["b", "c", "a"]);
  });

  it("sort: orders by type, repeats break ties, and missing values go last", () => {
    expect(run("sort:-agent")).toEqual(["n-hk", "n-mac", "n-fsn", "n-dmit", "n-new"]);
    expect(run("sort:status").slice(0, 2)).toEqual(["n-new", "n-dmit"]);
    expect(run("tag:edge sort:name")).toEqual(["n-hk", "n-dmit"]);
    expect(run("sort:arch,name -is:never")).toEqual(["n-hk", "n-dmit", "n-fsn", "n-mac"]);
    expect(run("sort:arch sort:-name -is:never")).toEqual(["n-dmit", "n-hk", "n-mac", "n-fsn"]);
  });

  it("an empty query keeps every row in the page's order", () => {
    const compiled = compileQuery("   ", schema) as { ok: true; query: CompiledQuery<PluginNodeFacts> };
    expect(compiled.ok && compiled.query.empty).toBe(true);
    expect(applyQuery(FLEET, compiled.query, NOW)).toEqual(FLEET);
  });

  it("the value parsers", () => {
    expect(parseNumber("80%", "percent")).toBe(80);
    expect(parseNumber("1.5GB", "bytes")).toBe(1.5e9);
    expect(parseNumber("10MBps", "rate")).toBe(10e6);
    expect(parseNumber("10%", "plain")).toBeUndefined();
    expect(parseDuration("1w2d")).toBe(9 * 86400);
    expect(parseDuration("2 hours")).toBeUndefined();
    expect(parseTime("2026-10-01")).toBe(new Date(2026, 9, 1).getTime());
    expect(parseTime("2026-10-01T12:00+08:00")).toBe(Date.UTC(2026, 9, 1, 4));
    expect(parseTime("2026-02-30")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Completion and the field descriptions                               */
/* ------------------------------------------------------------------ */

describe("completion", () => {
  const fields = describeFields(schema, FLEET);
  const labels = (input: string, caret = input.length) => completeQuery(input, caret, fields).items.map((item) => item.label);

  it("offers field names, is:, sort: and values", () => {
    expect(labels("sta").slice(0, 1)).toEqual(["status"]);
    expect(labels("seen")).toContain("last_seen");
    expect(completeQuery("last", 4, fields).items[0]!.insert).toBe("last_seen>");
    expect(completeQuery("st", 2, fields).items.find((i) => i.label === "status")!.insert).toBe("status:");
    expect(labels("is:off")).toEqual(["is:offline"]);
    expect(completeQuery("offl", 4, fields).items[0]).toEqual({ label: "is:offline", insert: "is:offline ", kind: "flag", hint: "Offline", type: "bool" });
    expect(labels("sort:-ag")).toEqual(["sort:-agent", "sort:-tag"]);
    expect(labels("tag:ed")).toEqual(["edge"]);
    expect(labels("tag:e")).toEqual(["edge", "core", "home", "relay"]);
    expect(labels("status:offline,nev")).toEqual(["never_reported"]);
    expect(completeQuery("tag:edge status:offline,ne", 26, fields).start).toBe(24);
    expect(labels("group:")).toEqual(["Asia relays"]);
    expect(completeQuery("group:", 6, fields).items[0]!.insert).toBe('"Asia relays" ');
    expect(labels("last_seen>")).toEqual([]);
    expect(labels("")).toEqual([]);
    expect(labels('name:"a')).toEqual([]);
    const mid = completeQuery("tag:edge -is:of sort:name", 15, fields);
    expect([mid.items[0]!.label, mid.start, mid.end]).toEqual(["is:offline", 13, 15]);
  });

  it("describes the fields with hints in words", () => {
    const status = fields.find((f) => f.key === "status")!;
    expect(status.values).toEqual(["never_reported", "offline", "degraded", "disabled", "online"]);
    expect(status.hint).toMatch(/online, degraded/);
    expect(fields.find((f) => f.key === "name")!.values).toContain("studio-mac");
  });

  it("a page field shadows a shared field of the same name, and the menu offers it once", () => {
    interface Row {
      node: PluginNodeFacts;
      status: "enforced" | "drift";
    }
    const rows: Row[] = [
      { node: FLEET[0]!, status: "drift" },
      { node: FLEET[3]!, status: "enforced" },
    ];
    const s: QuerySchema<Row> = {
      fields: [{ key: "status", type: "enum", values: ["drift", "enforced"], get: (r) => r.status }, ...nodeQueryFields<Row>((r) => r.node)],
      text: (r) => [r.node.name],
    };
    const compiled = compileQuery("status:drift", s);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(applyQuery(rows, compiled.query).map((r) => r.node.id)).toEqual(["n-hk"]);
    expect(compileQuery("is:offline", s).ok).toBe(true);
    expect(describeFields(s, rows).filter((f) => f.key === "status")).toHaveLength(1);
  });

  it("a schema of plain records works the same way", () => {
    interface Row {
      host: string;
      port: number[];
      up: boolean;
    }
    const rows: Row[] = [
      { host: "a", port: [22, 58394], up: true },
      { host: "b", port: [22], up: false },
      { host: "c", port: [], up: true },
    ];
    const s: QuerySchema<Row> = {
      fields: [
        { key: "host", type: "string", get: (r) => r.host },
        { key: "port", type: "number", get: (r) => r.port },
        { key: "up", type: "bool", flag: true, get: (r) => r.up },
      ],
      text: (r) => [r.host],
    };
    const ids = (q: string) => {
      const c = compileQuery(q, s);
      if (!c.ok) throw new Error(q);
      return applyQuery(rows, c.query).map((r) => r.host);
    };
    expect(ids("port:22")).toEqual(["a", "b"]);
    expect(ids("port>1024")).toEqual(["a"]);
    expect(ids("-port:22")).toEqual(["c"]);
    expect(ids("is:up sort:-port")).toEqual(["a", "c"]);
  });
});

/* ------------------------------------------------------------------ */
/* The English copy                                                    */
/* ------------------------------------------------------------------ */

describe("messages", () => {
  const sentence = (query: string) => {
    const compiled = compileQuery(query, schema);
    return compiled.ok ? "" : queryErrorMessage(compiled.error);
  };

  it("says each error in the console's words, with the suggestion when there is one", () => {
    expect(sentence("stauts:offline")).toBe("There is no field called stauts. Did you mean status?");
    expect(sentence("zzzz:1")).toBe("There is no field called zzzz. To search for the text, put it in quotes.");
    expect(sentence("status:ofline")).toBe("status has no value ofline. It takes never_reported, offline, degraded, disabled, online.");
    expect(sentence("is:onlin")).toBe("is:onlin is not a flag on this page. Did you mean is:online?");
    expect(sentence("(a")).toBe("This parenthesis is never closed.");
    expect(sentence("a OR")).toBe("OR needs a term on each side.");
    expect(sentence("last_seen:1d")).toBe("last_seen needs a comparison, such as last_seen>10m.");
    expect(sentence("name>3")).toBe("name does not compare with > or <. Use name:value.");
    expect(queryErrorMessage({ code: "badNumber", start: 0, end: 1, params: { field: "users", unit: "plain" } })).toBe("users takes a number.");
    expect(queryErrorMessage({ code: "badNumber", start: 0, end: 1, params: { field: "used", unit: "percent" } })).toBe("used takes a percent, such as 80 or 80%.");
  });

  it("draws the syntax examples from the page's own fields", () => {
    const help = querySyntaxHelp(describeFields(schema, FLEET));
    const byKey = Object.fromEntries(help.rows.map((row) => [row.key, row.query]));
    expect(byKey.contains).toBe("tag:edge");
    expect(byKey.exact).toBe("name:=hk-1");
    expect(byKey.not).toBe("-tag:lab    NOT edge");
    expect(byKey.anyOf).toBe("status:never_reported,offline");
    expect(byKey.age).toBe("last_seen>10m");
    expect(byKey.flag).toBe("is:online");
    expect(byKey.compare).toBeUndefined();
    expect(byKey.sort).toBe("sort:-last_seen sort:name");
    expect(help.missing).toMatch(/-last_seen<1h is last_seen>=1h/);

    const usage = querySyntaxHelp(
      describeFields<{ user: string; traffic: number; quota: number }>(
        {
          fields: [
            { key: "user", type: "string", get: (r) => r.user },
            { key: "traffic", type: "number", unit: "bytes", get: (r) => r.traffic },
            { key: "quota", type: "number", unit: "percent", get: (r) => r.quota },
          ],
          text: (r) => [r.user],
        },
        [],
      ),
    );
    const usageRows = Object.fromEntries(usage.rows.map((row) => [row.key, row.query]));
    expect(usageRows.contains).toBe("user:edge");
    expect(usageRows.compare).toBe("traffic>10MiB quota>=90%");
    expect(usageRows.flag).toBeUndefined();
    expect(usageRows.age).toBeUndefined();
    expect(usage.missing).toMatch(/-traffic<10 is traffic>=10/);
  });
});
