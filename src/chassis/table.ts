import { computed, defineComponent, h, inject, provide, ref, type ComputedRef, type InjectionKey, type PropType, type Ref } from "vue";

import { PcStateDot, type StateTone } from "./chips.js";
import { iconChevronRight } from "./icons.js";
import { useMediaQuery } from "./queryState.js";
import { PcButton } from "./toolbar.js";

export type SortState = "none" | "ascending" | "descending";
/** Which line of the stacked (480px) row a cell belongs to. */
export type StackRole = "name" | "summary" | "state" | "actions" | "detail";
export type RowLevel = 0 | 1 | 2;

export interface NameStatus {
  tone: StateTone;
  label: string;
  title?: string;
}

const STACKED_KEY: InjectionKey<ComputedRef<boolean>> = Symbol("pc-stacked");
interface RowContext {
  /** The stacked form's own "show the folded cells" state. */
  stackOpen: Ref<boolean>;
}
const ROW_KEY: InjectionKey<RowContext> = Symbol("pc-row");

/** The bordered card (design 4.6) and any bordered block. */
export const PcPanel = defineComponent({
  name: "PcPanel",
  props: {
    label: { type: String, default: undefined },
    role: { type: String, default: undefined },
    id: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () => h("section", { class: "pc-panel", id: props.id, role: props.role, "aria-label": props.label }, slots.default?.());
  },
});

export const PcPanelHeader = defineComponent({
  name: "PcPanelHeader",
  props: {
    title: { type: String, required: true },
    description: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () =>
      h("header", { class: "pc-panel-header" }, [
        h("div", [h("h2", props.title), props.description ? h("p", props.description) : undefined]),
        slots.default ? h("div", { class: "pc-panel-header-end" }, slots.default()) : undefined,
      ]);
  },
});

/** Padded body for a panel that holds a form rather than a table. */
export const PcPanelBody = defineComponent({
  name: "PcPanelBody",
  setup(_, { slots }) {
    return () => h("div", { class: "pc-panel-body" }, slots.default?.());
  },
});

/**
 * The table inside the card. `head` renders inside `<thead><tr>`; the default
 * slot renders inside `<table>`, so a consumer writes one `<tbody>` per group
 * (Lines) or one for the whole list. ArrowDown and ArrowUp move focus between
 * row toggles; the toggle itself answers Enter, Space, ArrowRight and
 * ArrowLeft. `stacked` forces the 480px form; left undefined it follows the
 * frame width.
 */
export const PcTable = defineComponent({
  name: "PcTable",
  props: {
    minWidth: { type: Number, default: 720 },
    stacked: { type: Boolean as PropType<boolean | undefined>, default: undefined },
    density: { type: String as PropType<"comfortable" | "compact">, default: "comfortable" },
    label: { type: String, default: undefined },
    stackBelow: { type: Number, default: 480 },
  },
  setup(props, { slots }) {
    const narrow = useMediaQuery(`(max-width: ${props.stackBelow}px)`);
    const stacked = computed(() => props.stacked ?? narrow.value ?? false);
    provide(STACKED_KEY, stacked);

    function onKeydown(event: KeyboardEvent): void {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      const current = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-pc-toggle]");
      if (!current) return;
      const table = event.currentTarget as HTMLElement;
      const toggles = Array.from(table.querySelectorAll<HTMLElement>("[data-pc-toggle]"));
      const index = toggles.indexOf(current);
      const next = toggles[index + step];
      if (!next) return;
      event.preventDefault();
      next.focus();
    }

    return () =>
      h("div", { class: "pc-table-wrap" }, [
        h(
          "table",
          {
            class: "pc-table",
            style: { "--pc-table-min": `${props.minWidth}px` },
            "data-stacked": stacked.value ? "true" : undefined,
            "data-density": props.density === "compact" ? "compact" : undefined,
            "aria-label": props.label,
            onKeydown,
          },
          [slots.head ? h("thead", [h("tr", slots.head())]) : undefined, ...(slots.default?.() ?? [])],
        ),
      ]);
  },
});

export const PcTh = defineComponent({
  name: "PcTh",
  props: {
    numeric: { type: Boolean, default: false },
    name: { type: Boolean, default: false },
    actions: { type: Boolean, default: false },
    select: { type: Boolean, default: false },
    sortable: { type: Boolean, default: false },
    sort: { type: String as PropType<SortState>, default: "none" },
    width: { type: String, default: undefined },
  },
  emits: { sort: () => true },
  setup(props, { slots, emit }) {
    return () =>
      h(
        "th",
        {
          scope: "col",
          class: { "pc-numeric": props.numeric, "pc-name": props.name, "pc-actions": props.actions, "pc-select": props.select },
          style: props.width ? { width: props.width, minWidth: props.width } : undefined,
          "aria-sort": props.sortable && props.sort !== "none" ? props.sort : undefined,
        },
        props.sortable
          ? [
              h("button", { class: "pc-sort", type: "button", onClick: () => emit("sort") }, [
                ...(slots.default?.() ?? []),
                h("span", { class: "pc-sort-mark", "aria-hidden": "true" }, props.sort === "ascending" ? "▲" : props.sort === "descending" ? "▼" : "▴▾"),
              ]),
            ]
          : slots.default?.(),
      );
  },
});

export const PcTd = defineComponent({
  name: "PcTd",
  props: {
    numeric: { type: Boolean, default: false },
    mono: { type: Boolean, default: false },
    colspan: { type: Number, default: undefined },
    title: { type: String, default: undefined },
    /** The column header, printed as the label in the stacked form. */
    label: { type: String, default: undefined },
    stack: { type: String as PropType<StackRole>, default: "detail" },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "td",
        {
          class: { "pc-numeric": props.numeric, "pc-mono": props.mono },
          colspan: props.colspan,
          title: props.title,
          "data-stack": props.stack,
          "data-label": props.label,
        },
        // One wrapper around the content, so the stacked form can lay the
        // column label and the value out as two grid tracks.
        [h("span", { class: "pc-td-body" }, slots.default?.())],
      );
  },
});

/** The chevron toggle: a real button, so Enter and Space toggle it. ArrowRight opens, ArrowLeft closes. */
export const PcRowToggle = defineComponent({
  name: "PcRowToggle",
  props: {
    expanded: { type: Boolean, required: true },
    /** The id of the first child row. */
    controls: { type: String, default: undefined },
    name: { type: String, default: "" },
    title: { type: String, default: undefined },
  },
  emits: { toggle: () => true },
  setup(props, { slots, emit }) {
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === "ArrowRight" && !props.expanded) {
        event.preventDefault();
        emit("toggle");
      } else if (event.key === "ArrowLeft" && props.expanded) {
        event.preventDefault();
        emit("toggle");
      }
    }
    return () =>
      h(
        "button",
        {
          class: "pc-toggle",
          type: "button",
          "aria-expanded": props.expanded ? "true" : "false",
          "aria-controls": props.controls,
          "data-pc-toggle": "",
          onClick: () => emit("toggle"),
          onKeydown,
        },
        [iconChevronRight(14, { class: "pc-chevron" }), h("strong", { title: props.title ?? props.name }, slots.default ? slots.default() : props.name)],
      );
  },
});

/**
 * The name cell: bold name over a muted mono id, an optional status dot at the
 * name baseline, chips after the name, and the narrow status line that shows
 * under 720px. Bind `expanded` to make it a toggle. In the stacked form a row
 * without its own toggle gets one that folds the row's detail cells.
 */
export const PcNameCell = defineComponent({
  name: "PcNameCell",
  props: {
    name: { type: String, required: true },
    id: { type: String, default: "" },
    /** Replaces the id line, e.g. "ports 24443 to 24454" on a bank row. */
    sub: { type: String, default: "" },
    title: { type: String, default: undefined },
    level: { type: Number as PropType<RowLevel>, default: 0 },
    expanded: { type: Boolean as PropType<boolean | undefined>, default: undefined },
    controls: { type: String, default: undefined },
    status: { type: Object as PropType<NameStatus | undefined>, default: undefined },
  },
  emits: { toggle: () => true },
  setup(props, { slots, emit }) {
    const stacked = inject(STACKED_KEY, computed(() => false));
    const row = inject(ROW_KEY, null);
    return () => {
      const ownToggle = props.expanded !== undefined;
      const stackToggle = !ownToggle && stacked.value && row !== null;
      const subText = props.sub || props.id;
      return h("td", { class: "pc-name", "data-level": props.level || undefined, "data-stack": "name" }, [
        h("div", { class: "pc-name-line" }, [
          ownToggle
            ? h(PcRowToggle, { expanded: props.expanded === true, controls: props.controls, name: props.name, title: props.title, onToggle: () => emit("toggle") })
            : stackToggle
              ? h(PcRowToggle, { expanded: row!.stackOpen.value, name: props.name, title: props.title, onToggle: () => (row!.stackOpen.value = !row!.stackOpen.value) })
              : h("strong", { title: props.title ?? props.name }, props.name),
          props.status ? h(PcStateDot, { tone: props.status.tone, label: props.status.label, title: props.status.title }) : undefined,
          slots.after ? h("span", { class: "pc-name-after" }, slots.after()) : undefined,
        ]),
        subText ? h("small", { title: subText }, subText) : undefined,
        slots.status ? h("span", { class: "pc-narrow-status" }, slots.status()) : undefined,
      ]);
    };
  },
});

const rowProps = {
  id: { type: String, default: undefined },
  selected: { type: Boolean, default: false },
};

/** A group row owns the rows beneath it; every cell reads as a shelf. */
export const PcGroupRow = defineComponent({
  name: "PcGroupRow",
  props: { ...rowProps, expanded: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => h("tr", { class: "pc-group-row", id: props.id, "data-open": props.expanded ? "true" : "false", "data-selected": props.selected ? "true" : undefined }, slots.default?.());
  },
});

/** A bank: a nested group inside a group (Lines), the ceiling of nesting. */
export const PcBankRow = defineComponent({
  name: "PcBankRow",
  props: { ...rowProps, expanded: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => h("tr", { class: "pc-bank-row", id: props.id, "data-open": props.expanded ? "true" : "false", "data-selected": props.selected ? "true" : undefined }, slots.default?.());
  },
});

/** A record row. `open` marks a row whose detail is open in place beneath it. */
export const PcRow = defineComponent({
  name: "PcRow",
  props: { ...rowProps, open: { type: Boolean, default: false } },
  setup(props, { slots }) {
    const stackOpen = ref(false);
    provide(ROW_KEY, { stackOpen });
    return () =>
      h(
        "tr",
        {
          class: "pc-row",
          id: props.id,
          "data-open": props.open || stackOpen.value ? "true" : undefined,
          "data-selected": props.selected ? "true" : undefined,
        },
        slots.default?.(),
      );
  },
});

/** The in-place detail under a row: one cell across every column. */
export const PcDetailRow = defineComponent({
  name: "PcDetailRow",
  props: { colspan: { type: Number, required: true }, id: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () => h("tr", { class: "pc-detail-row", id: props.id }, [h("td", { colspan: props.colspan, "data-stack": "summary" }, slots.default?.())]);
  },
});

export const PcRowActions = defineComponent({
  name: "PcRowActions",
  setup(_, { slots }) {
    return () => h("div", { class: "pc-row-actions" }, slots.default?.());
  },
});

/** The actions column, sticky at the right edge above 720px. */
export const PcActionsCell = defineComponent({
  name: "PcActionsCell",
  setup(_, { slots }) {
    return () => h("td", { class: "pc-actions", "data-stack": "actions" }, [h("div", { class: "pc-row-actions" }, slots.default?.())]);
  },
});

/** The optional leading selection column. `header` renders the th with indeterminate support. */
export const PcSelectCell = defineComponent({
  name: "PcSelectCell",
  props: {
    checked: { type: Boolean, default: false },
    indeterminate: { type: Boolean, default: false },
    label: { type: String, required: true },
    header: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
  },
  emits: { change: (_checked: boolean) => true },
  setup(props, { emit }) {
    return () =>
      h(props.header ? "th" : "td", { class: "pc-select", scope: props.header ? "col" : undefined, "data-stack": "actions" }, [
        h("input", {
          type: "checkbox",
          checked: props.checked,
          indeterminate: props.indeterminate,
          disabled: props.disabled,
          "aria-label": props.label,
          onChange: (event: Event) => emit("change", (event.target as HTMLInputElement).checked),
        }),
      ]);
  },
});

/** The card footer: "Nodes 1 to 25 of 33", Previous, Page 1 of 2, Next. */
export const PcPagination = defineComponent({
  name: "PcPagination",
  props: {
    page: { type: Number, required: true },
    pages: { type: Number, required: true },
    from: { type: Number, required: true },
    to: { type: Number, required: true },
    total: { type: Number, required: true },
    noun: { type: String, default: "Rows" },
    note: { type: String, default: "" },
    label: { type: String, default: "Pagination" },
  },
  emits: { "update:page": (_page: number) => true },
  setup(props, { emit }) {
    return () =>
      h("footer", { class: "pc-pagination", "aria-label": props.label }, [
        h("span", `${props.noun} ${props.from} to ${props.to} of ${props.total}${props.note ? `, ${props.note}` : ""}`),
        h(PcButton, { compact: true, disabled: props.page <= 1, onClick: () => emit("update:page", props.page - 1) }, () => "Previous"),
        h("span", `Page ${props.page} of ${props.pages}`),
        h(PcButton, { compact: true, disabled: props.page >= props.pages, onClick: () => emit("update:page", props.page + 1) }, () => "Next"),
      ]);
  },
});
