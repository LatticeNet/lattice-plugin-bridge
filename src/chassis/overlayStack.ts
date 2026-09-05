import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch, type Ref } from "vue";

/**
 * Who owns Escape, and what "an overlay is open" means (design 4.10).
 *
 * Ported from Sub-Store's overlayStack. An overlay registers a close function
 * while it is open, one document handler closes the top of the stack, and
 * "is an overlay open" is the depth rather than a list a screen has to
 * remember to extend. Deliberately not reactive: the callers are a keydown
 * handler and a state snapshot, both of which read it at the moment of the
 * event; an overlay whose render depends on the stack it is in is a loop.
 */
type CloseFn = () => void;

interface Entry {
  id: number;
  close: CloseFn;
}

const stack: Entry[] = [];
let sequence = 0;

/** Claim the top of the stack until the returned function is called. */
export function registerOverlay(close: CloseFn): () => void {
  const entry: Entry = { id: ++sequence, close };
  stack.push(entry);
  return () => {
    const at = stack.findIndex((item) => item.id === entry.id);
    if (at !== -1) stack.splice(at, 1);
  };
}

export function overlayDepth(): number {
  return stack.length;
}

/**
 * Close the topmost overlay, if there is one. The entry is not popped here:
 * the overlay's own state change unmounts it and runs its dispose, so there is
 * one path for "this is closed" whether the operator pressed Escape, clicked
 * the scrim, or the screen closed it in code.
 */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

/** Tests only: a module-level stack outlives a component tree that threw. */
export function resetOverlayStack(): void {
  stack.length = 0;
}

/** The three stack operations as one handle, for a screen that wants them. */
export function useOverlayStack(): {
  register: typeof registerOverlay;
  closeTop: typeof closeTopOverlay;
  depth: typeof overlayDepth;
} {
  return { register: registerOverlay, closeTop: closeTopOverlay, depth: overlayDepth };
}

/** Keep an overlay's place in the stack for exactly as long as it is open. */
export function useOverlayRegistration(open: Ref<boolean> | (() => boolean), close: () => void): void {
  let dispose: (() => void) | undefined;
  const release = (): void => {
    dispose?.();
    dispose = undefined;
  };
  watch(
    typeof open === "function" ? open : () => open.value,
    (isOpen) => {
      if (isOpen && !dispose) dispose = registerOverlay(close);
      else if (!isOpen) release();
    },
    { immediate: true },
  );
  onBeforeUnmount(release);
}

/**
 * Escape closes the topmost overlay and nothing else. Bound to the
 * activate/deactivate pair as well as mount, because a shell that keeps
 * screens alive across tab switches would otherwise leave a hidden screen
 * listening.
 */
export function useOverlayEscape(target: () => Document | undefined = () => (typeof document === "undefined" ? undefined : document)): void {
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (closeTopOverlay()) event.stopPropagation();
  }
  const bind = (): void => target()?.addEventListener("keydown", onKeydown);
  const release = (): void => target()?.removeEventListener("keydown", onKeydown);
  onMounted(bind);
  onActivated(bind);
  onDeactivated(release);
  onBeforeUnmount(release);
}

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keep Tab inside an aria-modal overlay without a focus-trap package. */
export function trapDialogTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (!focusable.length) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const target = event.target;
  const inside = target ? root.contains(target as Node) : false;
  if (event.shiftKey && (!inside || target === first || target === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || target === last || target === root)) {
    event.preventDefault();
    first.focus();
  }
}
