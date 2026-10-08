/**
 * A list page's query (../query) as reactive state, for PcQueryBar. Ported
 * from lattice-dashboard src/composables/useListQuery.ts, timings included,
 * so a half-typed query behaves the same in a plugin frame as on Nodes.
 *
 * An invalid query keeps the last valid one running, so a half-typed `cpu>`
 * or a typo never empties the list under the operator; `stale` says the rows
 * on screen answer an earlier query, and the bar says so beside the error.
 * "The last valid one" is the last that stood still for SETTLE_MS: typing
 * `status:offline` passes through `status:off`, and falling back to a
 * fragment would show a list for a query nobody meant. A query that was
 * invalid from the start (a pasted link) runs as the empty query: every row.
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";

import {
  applyQuery,
  compileQuery,
  describeFields,
  type CompiledQuery,
  type QueryError,
  type QueryFieldInfo,
  type QuerySchema,
} from "../query/index.js";
import type { DocumentQueryState } from "./queryState.js";
import { useDocumentQueryState } from "./queryState.js";

/** How long a valid query must stand before an invalid one falls back to it. */
export const SETTLE_MS = 400;
/**
 * How long an error waits after the last keystroke before it is shown:
 * `status:` is an error for the moment between the colon and the value, and
 * flashing it there reads as a complaint about typing. Enter and leaving the
 * field show it at once (`reveal`).
 */
export const ERROR_DELAY_MS = 600;
/** How long the address waits after the last keystroke before it records the query. */
export const URL_WRITE_MS = 300;

const OPEN_TERM: ReadonlySet<string> = new Set(["emptyValue", "danglingOperator", "nothingToNegate", "unclosedQuote"]);

/** The error is a term the operator is still typing at the end of the text. */
function openAtEnd(error: QueryError, text: string): boolean {
  return OPEN_TERM.has(error.code) && error.end >= text.trimEnd().length;
}

/** What PcQueryBar reads from a page's query, whatever the page's rows are. */
export interface ListQueryState {
  fields: Readonly<Ref<QueryFieldInfo[]>>;
  error: Readonly<Ref<QueryError | null>>;
  shownError: Readonly<Ref<QueryError | null>>;
  reveal: () => void;
  stale: Readonly<Ref<boolean>>;
  /** The query that ran: its text, and whether it asks for anything. */
  active: Readonly<Ref<{ empty: boolean; source: string }>>;
}

export interface ListQuery<T> extends ListQueryState {
  /** The rows the query keeps, ordered by its sort (or relevance). */
  rows: Readonly<Ref<T[]>>;
  /** The problem with the text, or null. */
  error: Readonly<Ref<QueryError | null>>;
  /** The error once the typing has paused on it (or `reveal` was called); what the bar shows. */
  shownError: Readonly<Ref<QueryError | null>>;
  /** Show the current error now: Enter, or the field losing focus. */
  reveal: () => void;
  /**
   * The rows on screen answer an earlier query and the operator has been told
   * so: a page dims its list while this holds, so nobody selects or acts on
   * rows for a query they can no longer see.
   */
  invalid: Readonly<Ref<boolean>>;
  /**
   * `invalid`, while the query keeps rows: what a page dims and makes inert.
   * When the last valid query kept none, the panel holds the no-match state,
   * whose Clear the query must stay live, so a page binds this rather than
   * `invalid` to a panel that holds both. A page that narrows `rows` further
   * before drawing them tests its own drawn rows instead.
   */
  staleRows: Readonly<Ref<boolean>>;
  /** The rows answer an earlier, valid query because the text is not one. */
  stale: Readonly<Ref<boolean>>;
  /** The query that ran. */
  active: Readonly<Ref<CompiledQuery<T>>>;
  /** The query narrows or orders the list. */
  filtering: Readonly<Ref<boolean>>;
  /** The query carries `sort:`, which replaces the page's own order. */
  sorted: Readonly<Ref<boolean>>;
  /** Field descriptions with values read from the rows, for the bar. */
  fields: Readonly<Ref<QueryFieldInfo[]>>;
}

export interface ListQueryOptions {
  /**
   * What ages (`last_seen>10m`) are measured against, as epoch ms. Leave it
   * out and they are measured when the rows or the text change, so a poll
   * moves them, not the clock.
   */
  now?: Readonly<Ref<number>>;
}

/** The query over a page's rows. Build `schema` once per page. */
export function useListQuery<T>(
  source: Readonly<Ref<readonly T[]>>,
  schema: QuerySchema<T>,
  text: Readonly<Ref<string>>,
  options: ListQueryOptions = {},
): ListQuery<T> {
  const now = options.now;
  const compiled = computed(() => compileQuery(text.value, schema));
  const empty = compileQuery<T>("", schema) as { ok: true; query: CompiledQuery<T> };
  const settled = shallowRef<CompiledQuery<T>>(compiled.value.ok ? compiled.value.query : empty.query);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(compiled, (result) => {
    clearTimeout(timer);
    if (!result.ok) return;
    timer = setTimeout(() => {
      settled.value = result.query;
    }, SETTLE_MS);
  });
  onScopeDispose(() => clearTimeout(timer));

  const active = computed(() => (compiled.value.ok ? compiled.value.query : settled.value));
  const error = computed(() => (compiled.value.ok ? null : compiled.value.error));
  const rows = computed(() => applyQuery(source.value, active.value, now?.value ?? Date.now()));

  // A query that arrives invalid (a pasted link) is shown at once.
  const shownError = shallowRef<QueryError | null>(error.value);
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  watch(error, (next) => {
    clearTimeout(errorTimer);
    if (!next) shownError.value = null;
    else if (shownError.value) shownError.value = next;
    // A term still open at the end of the text (`tag:` while its values are
    // offered, `a OR`) is being typed, not wrong: it waits for Enter or for
    // the field to lose focus (`reveal`) instead of a pause, so picking a
    // field from the menu never flashes the error and dims the rows.
    else if (!openAtEnd(next, text.value)) errorTimer = setTimeout(() => (shownError.value = error.value), ERROR_DELAY_MS);
  });
  onScopeDispose(() => clearTimeout(errorTimer));
  const reveal = () => {
    clearTimeout(errorTimer);
    shownError.value = error.value;
  };

  return {
    rows,
    error,
    shownError,
    reveal,
    invalid: computed(() => !!shownError.value),
    staleRows: computed(() => !!shownError.value && rows.value.length > 0),
    stale: computed(() => !compiled.value.ok),
    active,
    filtering: computed(() => !active.value.empty),
    sorted: computed(() => active.value.sorts.length > 0),
    fields: computed(() => describeFields(schema, source.value)),
  };
}

/**
 * The text the field edits, kept apart from where it is stored. The list
 * follows every keystroke; the store is written once the typing pauses,
 * because rewriting an address on each key is what browsers throttle, and
 * Back should not step through a query one letter at a time. A change that
 * arrives from the store (a link, a restored page state) replaces the text.
 */
export function useQueryText(stored: Ref<string>, delay = URL_WRITE_MS): Ref<string> {
  const text = ref(stored.value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** What this field last wrote; the store echoing it back is not news. */
  let written = stored.value.trim();
  watch(text, (value) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      written = value.trim();
      stored.value = value;
    }, delay);
  });
  watch(
    () => stored.value,
    (value) => {
      const incoming = value.trim();
      if (incoming === written || incoming === text.value.trim()) return;
      clearTimeout(timer);
      written = incoming;
      text.value = value;
    },
  );
  // A pause cut short by leaving the page is dropped: writing now would put
  // this page's query on whatever replaced it.
  onScopeDispose(() => clearTimeout(timer));
  return text;
}

/**
 * `?q=` in the frame's own document, through useDocumentQueryState: read once,
 * written once the typing pauses. For a page whose state the console keeps
 * (`HostInit.pageState`), put the text in that state instead and bind it to
 * the bar; the page's state sender already paces the writes.
 */
export function useDocumentQueryText(key = "q", options: { state?: DocumentQueryState; delay?: number } = {}): Ref<string> {
  const state = options.state ?? useDocumentQueryState();
  const stored = ref(state.read(key)[0] ?? "");
  watch(stored, (value) => {
    try {
      state.write(key, value.trim() ? [value] : []);
    } catch {
      // An opaque-origin frame may refuse replaceState; the text stays in memory.
    }
  });
  return useQueryText(stored, options.delay);
}
