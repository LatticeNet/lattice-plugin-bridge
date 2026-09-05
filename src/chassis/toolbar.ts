import { defineComponent, h, inject, provide, type Component, type InjectionKey, type PropType } from "vue";

import { PcCount, type CountTone } from "./chips.js";
import { iconLoader } from "./icons.js";

export type ButtonVariant = "primary" | "secondary" | "danger";

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
}
const LENS_KEY: InjectionKey<LensContext> = Symbol("pc-lens");

/**
 * The lens tablist. ArrowLeft and ArrowRight move and select; only the
 * selected tab is in the Tab order. Panels are `pc-panel-<value>`.
 */
export const PcLensTabs = defineComponent({
  name: "PcLensTabs",
  props: {
    modelValue: { type: String, required: true },
    label: { type: String, required: true },
  },
  emits: { "update:modelValue": (_value: string) => true },
  setup(props, { slots, emit }) {
    provide(LENS_KEY, { selected: () => props.modelValue, select: (value) => emit("update:modelValue", value) });
    function onKeydown(event: KeyboardEvent): void {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const list = event.currentTarget as HTMLElement;
      const tabs = Array.from(list.querySelectorAll<HTMLElement>("[role='tab']"));
      const current = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role='tab']");
      const index = current ? tabs.indexOf(current) : -1;
      if (!tabs.length || index === -1) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length]!;
      const value = next.dataset.value;
      if (value !== undefined) emit("update:modelValue", value);
      next.focus();
    }
    return () => h("div", { class: "pc-lens-tabs", role: "tablist", "aria-label": props.label, onKeydown }, slots.default?.());
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
    return () => {
      const selected = lens ? lens.selected() === props.value : false;
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
          slots.icon ? slots.icon() : props.icon ? h(props.icon, { size: 14, "aria-hidden": "true" }) : undefined,
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
