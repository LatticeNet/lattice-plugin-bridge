import { computed, shallowRef, type ComputedRef } from "vue";

/**
 * The open set for one level of a grouped table (design 4.8).
 *
 * A Set of keys per level: toggling one key never touches another. A search
 * opens every matching group because the operator asked for children, not for
 * groups, and clearing the search restores the operator's own set: while an
 * override is in place, the operator's own set is kept untouched and toggles
 * edit the override, so closing a search-opened group does not close it again
 * after the search is cleared.
 */
export interface ExpandSet {
  /** Whether the key is open under the current view (override or own). */
  isOpen(key: string): boolean;
  toggle(key: string): void;
  open(key: string): void;
  close(key: string): void;
  /** Replace the operator's own set. Used to seed from the document query. */
  replace(keys: Iterable<string>): void;
  /** Close everything in the operator's own set and drop any override. */
  clear(): void;
  /** Open exactly these keys for as long as the override stands (a search). */
  override(keys: Iterable<string> | null): void;
  /** The keys open under the current view. */
  readonly keys: ComputedRef<ReadonlySet<string>>;
  /** The operator's own set, ignoring any override. */
  readonly own: ComputedRef<ReadonlySet<string>>;
  readonly overridden: ComputedRef<boolean>;
}

export function useExpandSet(initial: Iterable<string> = []): ExpandSet {
  const own = shallowRef<Set<string>>(new Set(initial));
  const forced = shallowRef<Set<string> | null>(null);

  function current(): Set<string> {
    return forced.value ?? own.value;
  }
  function commit(next: Set<string>): void {
    if (forced.value) forced.value = next;
    else own.value = next;
  }

  return {
    isOpen: (key) => current().has(key),
    toggle(key) {
      const next = new Set(current());
      if (next.has(key)) next.delete(key);
      else next.add(key);
      commit(next);
    },
    open(key) {
      if (current().has(key)) return;
      const next = new Set(current());
      next.add(key);
      commit(next);
    },
    close(key) {
      if (!current().has(key)) return;
      const next = new Set(current());
      next.delete(key);
      commit(next);
    },
    replace(keys) {
      own.value = new Set(keys);
    },
    clear() {
      own.value = new Set();
      forced.value = null;
    },
    override(keys) {
      forced.value = keys === null ? null : new Set(keys);
    },
    keys: computed(() => forced.value ?? own.value),
    own: computed(() => own.value),
    overridden: computed(() => forced.value !== null),
  };
}
