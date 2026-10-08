/**
 * The node fields a plugin's node lists share (engine.ts), named and read as
 * the console's Nodes page names and reads them, so `tag:edge is:offline
 * sort:name` means the same inside a plugin frame as on Nodes.
 *
 * A plugin does not hold the console's node record. Its backend answers with
 * its own view (WireGuard's `node_id`, NetGuard's `node_name`), so a page
 * maps each row to `PluginNodeFacts`, the subset of the control plane's node
 * JSON this field set reads, under the same names. Every fact is optional
 * except the id; a field whose fact a row lacks matches no positive term and
 * sorts last, and `only` keeps the menu to the fields a page can answer.
 *
 * Ported from lattice-dashboard src/lib/query/nodeFields.ts and the status
 * derivation in src/lib/nodeStatus.ts. Left out: `cap` and `drift`, which
 * read the agent's runtime switches, and the live metrics (cpu, mem, disk,
 * load, rx, tx, uptime). The plugin contract carries neither; a page that
 * has a figure of its own declares it as its own field.
 */
import type { QueryField, QuerySchema } from "./engine.js";

/** The control plane's node status words (lattice-server node_status.go). */
export type NodeStatus = "online" | "degraded" | "offline" | "never_reported" | "disabled";

/** Every status, the good state first, then by the work each wants. */
export const NODE_STATUSES: readonly NodeStatus[] = ["online", "degraded", "offline", "never_reported", "disabled"];

/** Worst first, the order an operator triages in; `sort:status` uses it. */
export const NODE_ATTENTION_ORDER: Readonly<Record<NodeStatus, number>> = {
  never_reported: 0,
  offline: 1,
  degraded: 2,
  disabled: 3,
  online: 9,
};

type Fact<T> = T | null | undefined;

/** What a plugin knows about one node, under the control plane's JSON names. */
export interface PluginNodeFacts {
  id: string;
  name?: Fact<string>;
  /** The server's derived status. When absent it is rebuilt from `disabled`, `online` and `last_seen`. */
  status?: Fact<string>;
  online?: Fact<boolean>;
  disabled?: Fact<boolean>;
  /** The last report, as an ISO time or epoch ms. The Go zero time means never. */
  last_seen?: Fact<string | number>;
  role?: Fact<string>;
  tags?: Fact<readonly string[]>;
  group_ids?: Fact<readonly string[]>;
  public_ip?: Fact<string>;
  public_ipv6?: Fact<string>;
  internal_ip?: Fact<string>;
  internal_ipv6?: Fact<string>;
  agent_version?: Fact<string>;
  host_facts?: Fact<{
    hostname?: Fact<string>;
    os?: Fact<string>;
    platform?: Fact<string>;
    platform_version?: Fact<string>;
    arch?: Fact<string>;
  }>;
  geo?: Fact<{
    country?: Fact<string>;
    region?: Fact<string>;
    city?: Fact<string>;
    provider?: Fact<string>;
    as_org?: Fact<string>;
    asn?: Fact<number>;
  }>;
}

/** A contact time before this is the Go zero time the API sends for a node that never reported. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);

function isZeroTime(value: Fact<string | number>): boolean {
  if (value === undefined || value === null || value === "") return true;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) || ms < EARLIEST_PLAUSIBLE_MS;
}

function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === "string" && (NODE_STATUSES as readonly string[]).includes(value);
}

/**
 * The node's status. The server's word wins whenever it is present; without
 * it the same precedence is rebuilt from what the plugin has, as the console
 * rebuilds it: a node not online is offline, unless it carries a last_seen
 * that is the zero time (or empty), which says it never reported. A row with
 * no last_seen at all is offline, because nobody said it never reported.
 */
export function nodeStatusOf(node: PluginNodeFacts): NodeStatus {
  if (isNodeStatus(node.status)) return node.status;
  if (node.disabled) return "disabled";
  if (node.online) return "online";
  if (node.last_seen !== undefined && node.last_seen !== null && isZeroTime(node.last_seen)) return "never_reported";
  return "offline";
}

/** The agent is in contact right now: online or degraded. */
export function nodeIsReporting(node: PluginNodeFacts): boolean {
  const status = nodeStatusOf(node);
  return status === "online" || status === "degraded";
}

/** Statuses in the order the attention sort puts them: never reported first, online last. */
const STATUS_ORDER = [...NODE_STATUSES].sort((a, b) => NODE_ATTENTION_ORDER[a] - NODE_ATTENTION_ORDER[b]);

function present<T>(values: readonly (T | undefined | null | "")[]): T[] {
  return values.filter((value): value is T => value !== undefined && value !== null && value !== "");
}

/** The words a bare search looks at: name, id, role, addresses, host facts and tags. */
export function nodeQueryText(node: PluginNodeFacts | undefined): string[] {
  if (!node) return [];
  return present([
    node.name,
    node.id,
    node.role,
    node.public_ip,
    node.public_ipv6,
    node.internal_ip,
    node.internal_ipv6,
    node.host_facts?.hostname,
    node.host_facts?.arch,
    node.host_facts?.os,
    node.host_facts?.platform,
    ...(node.tags ?? []),
  ]);
}

/** Every shared node field, by its canonical key. */
export type NodeFieldKey =
  | "name"
  | "id"
  | "ip"
  | "tag"
  | "group"
  | "provider"
  | "country"
  | "region"
  | "os"
  | "arch"
  | "agent"
  | "status"
  | "online"
  | "offline"
  | "degraded"
  | "disabled"
  | "never"
  | "reporting"
  | "last_seen";

/** What each shared field holds, the console's help text for it. */
export const NODE_FIELD_HINTS: Readonly<Record<NodeFieldKey, string>> = {
  name: "Node name",
  id: "Node id",
  ip: "Public and internal addresses, IPv4 and IPv6",
  tag: "Tags and role",
  group: "Group names",
  provider: "Provider, AS name or AS number",
  country: "Country code",
  region: "Country, region or city",
  os: "OS, platform or arch",
  arch: "CPU architecture",
  agent: "Agent version",
  status: "online, degraded, offline, never_reported, disabled",
  online: "Online",
  offline: "Offline",
  degraded: "Degraded",
  disabled: "Disabled",
  never: "Never reported",
  reporting: "Reporting now: online or degraded",
  last_seen: "Last report, as an age or a date",
};

export interface NodeFieldOptions<R> {
  /** Group names by id, for group:. Read when the query runs, so it may follow a list that loads later. */
  groupName?: (id: string) => string | undefined;
  /** The row's id and name when the row has no node (a binding whose node left the fleet). */
  identity?: (row: R) => { id: string; name?: string } | undefined;
  /**
   * Keep only these fields, in the console's order. A page lists the facts it
   * has, so the menu and the help never offer a field that matches nothing.
   */
  only?: readonly NodeFieldKey[];
}

/**
 * The shared node fields over any row that leads to a node. A row with no
 * node matches no node term and sorts last on every node field, except name
 * and id when `identity` is given. A page lists its own fields before these,
 * and its field wins a name both claim (its own `status`, say).
 */
export function nodeQueryFields<R>(nodeOf: (row: R) => PluginNodeFacts | undefined, options: NodeFieldOptions<R> = {}): QueryField<R>[] {
  const read =
    <V>(get: (node: PluginNodeFacts) => V) =>
    (row: R): V | undefined => {
      const node = nodeOf(row);
      return node ? get(node) : undefined;
    };
  const values =
    (get: (node: PluginNodeFacts) => readonly Fact<string>[]) =>
    (rows: readonly R[]): string[] =>
      rows.flatMap((row) => {
        const node = nodeOf(row);
        return node ? present(get(node)) : [];
      });
  const identity = (row: R): { id: string; name: string } | undefined => {
    const node = nodeOf(row);
    if (node) return { id: node.id, name: node.name || node.id };
    const known = options.identity?.(row);
    return known ? { id: known.id, name: known.name || known.id } : undefined;
  };
  const groups = (node: PluginNodeFacts) => (node.group_ids ?? []).map((id) => options.groupName?.(id) ?? id);
  const status = (want: NodeStatus) => read((node) => nodeStatusOf(node) === want);
  const hint = (key: NodeFieldKey) => NODE_FIELD_HINTS[key];

  const fields: (QueryField<R> & { key: NodeFieldKey })[] = [
    {
      key: "name",
      type: "string",
      hint: hint("name"),
      get: (row) => identity(row)?.name,
      suggest: (rows) => present(rows.map((row) => identity(row)?.name)),
      sort: (row) => {
        const id = identity(row);
        return id ? `${id.name.toLowerCase()}\u0000${id.id}` : undefined;
      },
    },
    { key: "id", type: "string", hint: hint("id"), get: (row) => identity(row)?.id },
    {
      key: "ip",
      aliases: ["address", "addr"],
      type: "list",
      hint: hint("ip"),
      get: read((node) => present([node.public_ip, node.public_ipv6, node.internal_ip, node.internal_ipv6])),
      sort: read((node) => node.public_ip || node.public_ipv6 || node.internal_ip || node.internal_ipv6 || undefined),
    },
    {
      key: "tag",
      aliases: ["tags", "role"],
      type: "list",
      hint: hint("tag"),
      get: read((node) => present([node.role, ...(node.tags ?? [])])),
      suggest: values((node) => [node.role, ...(node.tags ?? [])]),
    },
    {
      key: "group",
      aliases: ["groups"],
      type: "list",
      hint: hint("group"),
      get: read(groups),
      suggest: values(groups),
    },
    {
      key: "provider",
      aliases: ["isp", "asn"],
      type: "list",
      hint: hint("provider"),
      get: read((node) => present([node.geo?.provider, node.geo?.as_org, node.geo?.asn ? `AS${node.geo.asn}` : undefined])),
      suggest: values((node) => [node.geo?.provider, node.geo?.as_org]),
    },
    {
      key: "country",
      aliases: ["cc"],
      type: "string",
      hint: hint("country"),
      get: read((node) => node.geo?.country),
      suggest: values((node) => [node.geo?.country]),
    },
    {
      key: "region",
      aliases: ["city", "geo"],
      type: "list",
      hint: hint("region"),
      get: read((node) => present([node.geo?.country, node.geo?.region, node.geo?.city])),
      suggest: values((node) => [node.geo?.region, node.geo?.city]),
    },
    {
      // os, platform, its version and the arch, as the console's os: reads them, so os:amd64 works the same.
      key: "os",
      aliases: ["platform"],
      type: "list",
      hint: hint("os"),
      get: read((node) => present([node.host_facts?.os, node.host_facts?.platform, node.host_facts?.platform_version, node.host_facts?.arch])),
      suggest: values((node) => [node.host_facts?.os, node.host_facts?.platform]),
      sort: read((node) => node.host_facts?.os),
    },
    {
      key: "arch",
      type: "string",
      hint: hint("arch"),
      get: read((node) => node.host_facts?.arch),
      suggest: values((node) => [node.host_facts?.arch]),
    },
    {
      key: "agent",
      aliases: ["version"],
      type: "version",
      hint: hint("agent"),
      get: read((node) => node.agent_version),
      suggest: values((node) => [node.agent_version]),
    },
    {
      key: "status",
      type: "enum",
      hint: hint("status"),
      values: STATUS_ORDER,
      valueAliases: { never: "never_reported", unreported: "never_reported", "never-reported": "never_reported" },
      get: read(nodeStatusOf),
    },
    { key: "online", type: "bool", flag: true, hint: hint("online"), get: status("online"), sort: false },
    { key: "offline", type: "bool", flag: true, hint: hint("offline"), get: status("offline"), sort: false },
    { key: "degraded", type: "bool", flag: true, hint: hint("degraded"), get: status("degraded"), sort: false },
    { key: "disabled", type: "bool", flag: true, hint: hint("disabled"), get: status("disabled"), sort: false },
    {
      key: "never",
      aliases: ["never_reported", "unreported"],
      type: "bool",
      flag: true,
      hint: hint("never"),
      get: status("never_reported"),
      sort: false,
    },
    { key: "reporting", type: "bool", flag: true, hint: hint("reporting"), get: read(nodeIsReporting), sort: false },
    {
      key: "last_seen",
      aliases: ["seen", "lastseen"],
      type: "time",
      hint: hint("last_seen"),
      // The zero time a never-reported node carries is no time at all.
      get: read((node) => (isZeroTime(node.last_seen) ? undefined : node.last_seen)),
    },
  ];
  if (!options.only) return fields;
  const keep = new Set<string>(options.only);
  return fields.filter((field) => keep.has(field.key));
}

export type NodeSchemaOptions = NodeFieldOptions<PluginNodeFacts>;

/** The schema for a list whose rows are node facts. Build it once per page. */
export function nodeQuerySchema(options: NodeSchemaOptions = {}): QuerySchema<PluginNodeFacts> {
  return {
    fields: nodeQueryFields<PluginNodeFacts>((node) => node, options),
    text: nodeQueryText,
  };
}
