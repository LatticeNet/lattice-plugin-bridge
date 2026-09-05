import { defineComponent, h, type Component, type PropType } from "vue";

import { iconAlert, iconCheck, iconInfo, iconX } from "./icons.js";

export type NoticeTone = "danger" | "success" | "warning" | "info";
export type StatTone = "warning" | "error" | "neutral";

/** The page frame (design 4.1). `batch` keeps a batch bar's worth of room under the last row. */
export const PcWorkspace = defineComponent({
  name: "PcWorkspace",
  props: { batch: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => h("main", { class: "pc-workspace", "data-batch": props.batch ? "true" : undefined }, slots.default?.());
  },
});

/**
 * The page header (design 4.2): icon mark, title, plugin badge, one-line
 * description, the right slot that holds the page-level Refresh, and the
 * `proof` slot for the PcProofLine, which sits inside the header's bottom
 * padding so the hairline is drawn under it.
 */
export const PcPageHeader = defineComponent({
  name: "PcPageHeader",
  props: {
    title: { type: String, required: true },
    /** "VPN Core plugin", "Sub-Store plugin": the badge beside the title. */
    badge: { type: String, default: "" },
    description: { type: String, default: "" },
    icon: { type: Object as PropType<Component>, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h("header", { class: "pc-page-header", "data-proof": slots.proof ? "true" : undefined }, [
        h("div", { class: "pc-title-mark" }, slots.icon ? slots.icon() : props.icon ? h(props.icon, { size: 19, "aria-hidden": "true" }) : undefined),
        h("div", { class: "pc-title-copy" }, [
          h("div", { class: "pc-title-line" }, [
            h("h1", props.title),
            props.badge ? h("span", { class: "pc-plugin-badge" }, props.badge) : undefined,
          ]),
          props.description || slots.description ? h("p", slots.description ? slots.description() : props.description) : undefined,
        ]),
        slots.actions ? h("div", { class: "pc-header-actions" }, slots.actions()) : undefined,
        slots.proof ? h("div", { class: "pc-page-proof" }, slots.proof()) : undefined,
      ]);
  },
});

/** The mono proof line under the header: "observed at 23:21:14 · 25 nodes report · ...". */
export const PcProofLine = defineComponent({
  name: "PcProofLine",
  props: {
    segments: { type: Array as PropType<readonly string[]>, default: () => [] },
    refreshing: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return () =>
      h("p", { class: "pc-proof-line", "aria-live": "polite" }, [
        ...props.segments.map((segment, index) => h("span", index === 0 ? segment : `· ${segment}`)),
        ...(slots.default?.() ?? []),
        props.refreshing ? h("span", "· refreshing") : undefined,
      ]);
  },
});

/** One notice, four tones (design 4.3). Retry goes in the `actions` slot. */
export const PcNotice = defineComponent({
  name: "PcNotice",
  props: {
    tone: { type: String as PropType<NoticeTone>, default: "danger" },
    title: { type: String, default: "" },
    dismissible: { type: Boolean, default: false },
    dismissLabel: { type: String, default: "Dismiss" },
    iconSize: { type: Number, default: 17 },
  },
  emits: { dismiss: () => true },
  setup(props, { slots, emit }) {
    const defaultIcon = (): ReturnType<typeof iconAlert> => {
      if (props.tone === "success") return iconCheck(props.iconSize);
      if (props.tone === "info") return iconInfo(props.iconSize);
      return iconAlert(props.iconSize);
    };
    return () =>
      h(
        "div",
        {
          class: "pc-notice",
          "data-tone": props.tone,
          role: props.tone === "danger" ? "alert" : "status",
          "aria-live": props.tone === "danger" ? undefined : "polite",
        },
        [
          slots.icon ? slots.icon() : defaultIcon(),
          h("div", { class: "pc-notice-body" }, [props.title ? h("strong", props.title) : undefined, ...(slots.default?.() ?? [])]),
          slots.actions || props.dismissible
            ? h("div", { class: "pc-notice-actions" }, [
                ...(slots.actions?.() ?? []),
                props.dismissible
                  ? h(
                      "button",
                      {
                        class: "pc-icon-button",
                        type: "button",
                        "aria-label": props.dismissLabel,
                        title: props.dismissLabel,
                        onClick: () => emit("dismiss"),
                      },
                      [iconX(15)],
                    )
                  : undefined,
              ])
            : undefined,
        ],
      );
  },
});

/** One bordered card holding four or five tiles (design 4.4). */
export const PcStatStrip = defineComponent({
  name: "PcStatStrip",
  props: {
    count: { type: Number, default: 4 },
    label: { type: String, default: "Summary" },
  },
  setup(props, { slots }) {
    return () => h("section", { class: "pc-stat-strip", "aria-label": props.label, style: { "--stat-count": String(props.count) } }, slots.default?.());
  },
});

export const PcStatCard = defineComponent({
  name: "PcStatCard",
  props: {
    label: { type: String, required: true },
    value: { type: [String, Number], default: "" },
    note: { type: String, default: "" },
    /** Colours the value only: warning, error, or neutral. */
    tone: { type: String as PropType<StatTone | undefined>, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h("div", { class: "pc-stat", "data-tone": props.tone }, [
        h("span", { class: "pc-stat-label" }, props.label),
        h("strong", { class: "pc-stat-value" }, slots.default ? slots.default() : String(props.value)),
        props.note || slots.note ? h("small", { class: "pc-stat-note" }, slots.note ? slots.note() : props.note) : undefined,
      ]);
  },
});
