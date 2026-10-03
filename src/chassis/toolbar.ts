import { defineComponent, h, inject, nextTick, onMounted, provide, ref, watch, type Component, type InjectionKey, type PropType } from "vue";

import { PcCount, type CountTone } from "./chips.js";
import { iconLoader } from "./icons.js";

export type ButtonVariant = "primary" | "secondary" | "danger";
/** `lens` filters one collection inside a toolbar; `layer` is the page's own row of layers. */
export type LensVariant = "lens" | "layer";

/**
 * The toolbar (design 4.5): ordered slots, tabs then search then note, a
 * spacer, then the secondary actions and the one primary action. A page that
 * needs a persistent filter puts a compact select in the `note` slot; there is
 * no chip row.
 */
export const PcToolbar = defineComponent({
  name: "PcToolbar",
  props: { label: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h("section", { class: "pc-toolbar", "aria-label": props.label }, [
        ...(slots.tabs?.() ?? []),
        ...(slots.search?.() ?? []),
        slots.note ? h("span", { class: "pc-toolbar-note" }, slots.note()) : undefined,
        h("span", { class: "pc-toolbar-spacer" }),
        slots.secondary ? h("div", { class: "pc-toolbar-secondary" }, slots.secondary()) : undefined,
        ...(slots.primary?.() ?? []),
      ]);
  },
});

interface LensContext {
  selected(): string;
  select(value: string): void;
  variant(): LensVariant;
  /** A tab's count went from unread to read, which widens it. */
  countArrived(): void;
}
const LENS_KEY: InjectionKey<LensContext> = Symbol("pc-lens");

/** A tab row as revealSelectedTab needs it; duck-typed so a test can fake the boxes. */
export interface TabRow {
  scrollLeft: number;
  getBoundingClientRect(): { left: number; right: number };
  querySelector(selector: string): { getBoundingClientRect(): { left: number; right: number } } | null;
}

/** Room left beside the tab, so its edge does not sit on the row's. */
const REVEAL_EDGE = 4;

/**
 * Scroll a layer row so its selected tab is inside it. Only the row's own
 * scrollLeft moves: scrollIntoView would also scroll the page and, in a
 * frame, the console around it. The same rule as vpn-core's and Sub-Store's
 * layerTabs.ts, which carried it until this variant existed.
 */
export function revealSelectedTab(row: TabRow | null | undefined): void {
  const tab = row?.querySelector('[aria-selected="true"]');
  if (!row || !tab) return;
  const box = row.getBoundingClientRect();
  const at = tab.getBoundingClientRect();
  if (at.left < box.left + REVEAL_EDGE) row.scrollLeft -= box.left + REVEAL_EDGE - at.left;
  else if (at.right > box.right - REVEAL_EDGE) row.scrollLeft += at.right - (box.right - REVEAL_EDGE);
}

/**
 * The lens tablist. ArrowLeft and ArrowRight move and select, Home and End
 * go to the first and last tab; only the selected tab is in the Tab order.
 * Panels are `pc-panel-<value>`.
 *
 * `variant="layer"` is the page's row of layers (design 23, section 3.4; the
 * wave 1 design review): a row of its own above the layer's toolbar, placed
 * directly in PcWorkspace rather than in a PcToolbar slot. From 620px it is
 * an underline row with a hairline across the frame; below 620px it is a
 * segmented control that keeps one line and scrolls sideways when the tabs
 * are wider than the frame. Tabs carry no icons. The row scrolls its selected
 * tab into view on mount, when the selection changes, and once more when a
 * count arrives (the counts land after an address has already chosen a later
 * layer, and widen every tab), and at no other time, so a re-render for
 * anything else does not snap back a row the operator is swiping through.
 */
export const PcLensTabs = defineComponent({
  name: "PcLensTabs",
  props: {
    modelValue: { type: String, required: true },
    label: { type: String, required: true },
    variant: { type: String as PropType<LensVariant>, default: "lens" },
  },
  emits: { "update:modelValue": (_value: string) => true },
  setup(props, { slots, emit }) {
    const list = ref<HTMLElement | null>(null);
    const reveal = (): void => {
      if (props.variant === "layer") revealSelectedTab(list.value);
    };
    let revealQueued = false;
    const queueReveal = (): void => {
      if (revealQueued) return;
      revealQueued = true;
      void nextTick(() => {
        revealQueued = false;
        reveal();
      });
    };
    provide(LENS_KEY, {
      selected: () => props.modelValue,
      select: (value) => emit("update:modelValue", value),
      variant: () => props.variant,
      countArrived: queueReveal,
    });
    onMounted(reveal);
    watch(() => props.modelValue, reveal, { flush: "post" });
    function onKeydown(event: KeyboardEvent): void {
      const key = event.key;
      if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
      const row = event.currentTarget as HTMLElement;
      const tabs = Array.from(row.querySelectorAll<HTMLElement>("[role='tab']"));
      const current = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role='tab']");
      const index = current ? tabs.indexOf(current) : -1;
      if (!tabs.length || index === -1) return;
      event.preventDefault();
      const at = key === "Home" ? 0 : key === "End" ? tabs.length - 1 : (index + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      const next = tabs[at]!;
      const value = next.dataset.value;
      if (value !== undefined) emit("update:modelValue", value);
      next.focus();
    }
    return () =>
      h(
        "div",
        {
          ref: list,
          class: "pc-lens-tabs",
          "data-variant": props.variant === "layer" ? "layer" : undefined,
          role: "tablist",
          "aria-label": props.label,
          onKeydown,
        },
        slots.default?.(),
      );
  },
});

export const PcLensTab = defineComponent({
  name: "PcLensTab",
  props: {
    value: { type: String, required: true },
    label: { type: String, default: "" },
    /** Absent (null) until the list has been read; never "0" as a placeholder. */
    count: { type: [Number, String] as PropType<number | string | null>, default: null },
    countTone: { type: String as PropType<CountTone | undefined>, default: undefined },
    icon: { type: Object as PropType<Component>, default: undefined },
  },
  setup(props, { slots }) {
    const lens = inject(LENS_KEY, null);
    watch(
      () => props.count !== null && props.count !== undefined,
      (read, wasRead) => {
        if (read && !wasRead) lens?.countArrived();
      },
      { flush: "post" },
    );
    return () => {
      const selected = lens ? lens.selected() === props.value : false;
      // A layer row names its layers in words only (design 23, 3.4).
      const layer = lens?.variant() === "layer";
      return h(
        "button",
        {
          class: "pc-lens-tab",
          type: "button",
          role: "tab",
          id: `pc-tab-${props.value}`,
          "aria-selected": selected ? "true" : "false",
          "aria-controls": `pc-panel-${props.value}`,
          tabindex: selected ? 0 : -1,
          "data-value": props.value,
          onClick: () => lens?.select(props.value),
        },
        [
          layer ? undefined : slots.icon ? slots.icon() : props.icon ? h(props.icon, { size: 14, "aria-hidden": "true" }) : undefined,
          slots.default ? slots.default() : props.label,
          props.count !== null && props.count !== undefined ? h(PcCount, { value: props.count, tone: props.countTone }) : undefined,
        ],
      );
    };
  },
});

export const PcSearchField = defineComponent({
  name: "PcSearchField",
  props: {
    modelValue: { type: String, default: "" },
    placeholder: { type: String, default: "Search" },
    label: { type: String, default: "Search" },
  },
  emits: { "update:modelValue": (_value: string) => true },
  setup(props, { emit }) {
    return () =>
      h("div", { class: "pc-search" }, [
        h("input", {
          type: "search",
          value: props.modelValue,
          placeholder: props.placeholder,
          "aria-label": props.label,
          autocomplete: "off",
          spellcheck: "false",
          onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
        }),
      ]);
  },
});

export const PcButton = defineComponent({
  name: "PcButton",
  props: {
    variant: { type: String as PropType<ButtonVariant>, default: "secondary" },
    compact: { type: Boolean, default: false },
    /** A secondary button that names a destructive verb: danger ink and border. */
    destructive: { type: Boolean, default: false },
    /** Replaces the icon with a spinner and disables the button. */
    busy: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    type: { type: String as PropType<"button" | "submit">, default: "button" },
    title: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "button",
        {
          class: "pc-button",
          type: props.type,
          disabled: props.disabled || props.busy,
          title: props.title,
          "data-variant": props.variant,
          "data-compact": props.compact ? "true" : undefined,
          "data-destructive": props.destructive ? "true" : undefined,
        },
        [props.busy ? iconLoader(props.compact ? 13 : 15) : slots.icon?.(), ...(slots.default?.() ?? [])],
      );
  },
});

export const PcIconButton = defineComponent({
  name: "PcIconButton",
  props: {
    /** The accessible name and the tooltip. */
    label: { type: String, required: true },
    bordered: { type: Boolean, default: false },
    destructive: { type: Boolean, default: false },
    size: { type: String as PropType<"30" | "32" | "22">, default: "30" },
    disabled: { type: Boolean, default: false },
    pressed: { type: Boolean as PropType<boolean | undefined>, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "button",
        {
          class: "pc-icon-button",
          type: "button",
          "aria-label": props.label,
          title: props.label,
          disabled: props.disabled,
          "aria-pressed": props.pressed === undefined ? undefined : props.pressed ? "true" : "false",
          "data-bordered": props.bordered ? "true" : undefined,
          "data-destructive": props.destructive ? "true" : undefined,
          "data-size": props.size === "30" ? undefined : props.size,
        },
        slots.default?.(),
      );
  },
});
