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
 * A boolean ref that follows a media query. Used by PcTable for the 480px
 * stacked form and by PcSidePanel for the 768px beside-the-rows form.
 *
 * On the client it holds the answer from the first render, so those parts
 * draw in their final form in the first frame: a panel restored from the
 * address opens beside the rows instead of opening modal and flipping after
 * mount. `undefined` where there is no window or no matchMedia (a server
 * render, a test without it). Plugin frames are client-rendered; a page that
 * hydrates a server render would see the first client frame differ from it.
 */
export function useMediaQuery(query: string, win: (Window & typeof globalThis) | undefined = typeof window === "undefined" ? undefined : window): Ref<boolean | undefined> {
  const list: MediaQueryList | undefined = win && typeof win.matchMedia === "function" ? win.matchMedia(query) : undefined;
  const matches = ref<boolean | undefined>(list?.matches);
  const update = (event: { matches: boolean }): void => {
    matches.value = event.matches;
  };
  onMounted(() => {
    if (!list) return;
    list.addEventListener("change", update);
    // The frame may have been resized between setup and mount.
    matches.value = list.matches;
  });
  onBeforeUnmount(() => list?.removeEventListener("change", update));
  return matches;
}
