/**
 * @latticenet/plugin-bridge/query: the console's list query, one search,
 * filter and sort syntax, for plugin pages. Framework-free: nothing here
 * imports Vue, so a page may run it in a worker, a test or another framework.
 * The Vue field that types it is `PcQueryBar` in the chassis.
 *
 * Read a query against a page's typed fields with `compileQuery`, run it with
 * `applyQuery`, describe the fields for a menu with `describeFields`, and
 * complete at the caret with `completeQuery`. `nodeQueryFields` is the shared
 * node field set a node list puts beside its own.
 */
export { parseQuery, withoutSorts } from "./syntax.js";
export type {
  CompareOp,
  ParseResult,
  QueryError,
  QueryErrorCode,
  QueryNode,
  QueryValue,
  SortKey,
  SortNode,
  TermNode,
  TextNode,
} from "./syntax.js";

export { applyQuery, compileQuery, describeFields, querySorter } from "./engine.js";
export type { CompiledQuery, CompileResult, FieldType, QueryField, QueryFieldInfo, QuerySchema, QuerySort } from "./engine.js";

export { completeQuery, quoteQueryValue } from "./complete.js";
export type { Completion, CompletionKind, CompletionResult } from "./complete.js";

export { TOKEN_ALIASES, compareVersions, parseDuration, parseNumber, parseTime } from "./values.js";
export type { NumberUnit } from "./values.js";

export {
  NODE_ATTENTION_ORDER,
  NODE_FIELD_HINTS,
  NODE_STATUSES,
  nodeIsReporting,
  nodeQueryFields,
  nodeQuerySchema,
  nodeQueryText,
  nodeStatusOf,
} from "./nodeFields.js";
export type { NodeFieldKey, NodeFieldOptions, NodeSchemaOptions, NodeStatus, PluginNodeFacts } from "./nodeFields.js";

export { FIELD_TYPE_LABELS, QUERY_COPY, queryErrorMessage, querySyntaxHelp } from "./messages.js";
export type { SyntaxHelp, SyntaxRow } from "./messages.js";
