import { defineComponent, h, type Component, type PropType } from "vue";

import { iconAlert, iconInbox } from "./icons.js";

export type EmptyKind = "empty" | "no-match" | "permission" | "error" | "handshake";

/**
 * First-load skeleton (design 4.9): the stat strip's tiles as bars, or eight
 * rows on a four-track grid, each reserving `--row-h` so the page does not
 * resize when data lands.
 */
export const PcSkeleton = defineComponent({
  name: "PcSkeleton",
  props: {
    variant: { type: String as PropType<"strip" | "rows">, default: "rows" },
    count: { type: Number, default: undefined },
    label: { type: String, default: "Loading" },
  },
  setup(props) {
    return () => {
      if (props.variant === "strip") {
        const tiles = props.count ?? 4;
        return h(
          "div",
          { class: "pc-skeleton-strip", role: "status", "aria-label": props.label, style: { "--stat-count": String(tiles) } },
          Array.from({ length: tiles }, (_, index) =>
            h("div", { key: index, "aria-hidden": "true" }, [h("span", { class: "pc-skeleton-bar", "data-size": "short" }), h("span", { class: "pc-skeleton-bar", "data-size": "tall" })]),
          ),
        );
      }
      const rows = props.count ?? 8;
      return h(
        "div",
        { class: "pc-skeleton-rows", role: "status", "aria-label": props.label },
        Array.from({ length: rows }, (_, index) =>
          h("div", { key: index, "aria-hidden": "true" }, [
            h("span", { class: "pc-skeleton-bar" }),
            h("span", { class: "pc-skeleton-bar", "data-size": "short" }),
            h("span", { class: "pc-skeleton-bar", "data-size": "short" }),
            h("span", { class: "pc-skeleton-bar", "data-size": "short" }),
          ]),
        ),
      );
    };
  },
});

/**
 * The empty block inside a card: a 26px icon, a bold sentence naming the
 * state, a paragraph or list in the default slot, actions centred below.
 * One component for empty, no match, permission wall, error and the missing
 * handshake.
 */
export const PcEmptyState = defineComponent({
  name: "PcEmptyState",
  props: {
    title: { type: String, required: true },
    kind: { type: String as PropType<EmptyKind>, default: "empty" },
    icon: { type: Object as PropType<Component>, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "div",
        {
          class: "pc-empty",
          "data-kind": props.kind,
          role: props.kind === "error" || props.kind === "handshake" ? "alert" : "status",
        },
        [
          slots.icon ? slots.icon() : props.icon ? h(props.icon, { size: 26, "aria-hidden": "true" }) : props.kind === "error" || props.kind === "handshake" ? iconAlert(26) : iconInbox(26),
          h("strong", props.title),
          ...(slots.default?.() ?? []),
          slots.actions ? h("div", { class: "pc-empty-actions" }, slots.actions()) : undefined,
        ],
      );
  },
});
