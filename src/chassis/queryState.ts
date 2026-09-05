import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * The document query as page state (design 4.8): `?expand=<id>`,
 * `?bank=<key>`, `?lens=<name>`, so a link can carry the state being
 * discussed. The fragment carries the bridge handshake (`lattice_nonce`,
 * `host_origin`) and is never touched; writes go through `replaceState` so
 * they add nothing to history.
 */
export interface DocumentQueryState {
  /** Every value the key carries, in order. */
  read(key: string): string[];
  /** Replace the key's values; an empty list removes the key. */
  write(key: string, values: readonly string[]): void;
}

interface QueryWindow {
  location: { search: string; hash: string; pathname: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}

export function useDocumentQueryState(win: QueryWindow | undefined = typeof window === "undefined" ? undefined : window): DocumentQueryState {
  return {
    read(key) {
      if (!win) return [];
      return new URLSearchParams(win.location.search).getAll(key);
    },
    write(key, values) {
      if (!win) return;
      const params = new URLSearchParams(win.location.search);
      params.delete(key);
      for (const value of values) params.append(key, value);
      const search = params.toString();
      win.history.replaceState(null, "", `${win.location.pathname}${search ? `?${search}` : ""}${win.location.hash}`);
    },
  };
}

/**
 * A boolean ref that follows a media query. `undefined` until the first
 * evaluation on the client, so a server render and the first client frame
 * agree. Used by PcTable for the 480px stacked form.
 */
export function useMediaQuery(query: string, win: (Window & typeof globalThis) | undefined = typeof window === "undefined" ? undefined : window): Ref<boolean | undefined> {
  const matches = ref<boolean | undefined>(undefined);
  let list: MediaQueryList | undefined;
  const update = (event?: { matches: boolean }): void => {
    matches.value = event ? event.matches : (list?.matches ?? undefined);
  };
  onMounted(() => {
    if (!win || typeof win.matchMedia !== "function") return;
    list = win.matchMedia(query);
    list.addEventListener("change", update);
    update();
  });
  onBeforeUnmount(() => list?.removeEventListener("change", update));
  return matches;
}
