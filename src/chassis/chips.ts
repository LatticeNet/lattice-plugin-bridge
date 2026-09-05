import { defineComponent, h, type PropType } from "vue";

/**
 * The chip vocabulary (design 4.7): three roles and one count. Everything on
 * a page that is a small rounded label is one of these four.
 */
export type StateTone = "healthy" | "warning" | "error" | "info" | "neutral";
export type CountTone = "error" | "warning";

const stateProps = {
  tone: { type: String as PropType<StateTone>, default: "neutral" },
  label: { type: String, required: true as const },
  /** The evidence: "checked 23:21:14", the drift reason. */
  title: { type: String, default: undefined },
};

/** The quiet form: a 7px disc then the word. For a column that is mostly healthy. */
export const PcStateDot = defineComponent({
  name: "PcStateDot",
  props: stateProps,
  setup(props) {
    return () => h("span", { class: "pc-state-dot", "data-tone": props.tone, title: props.title }, props.label);
  },
});

/** The loud form: the word on its soft fill. For a service or lifecycle column. */
export const PcStatePill = defineComponent({
  name: "PcStatePill",
  props: stateProps,
  setup(props) {
    return () => h("span", { class: "pc-state-pill", "data-tone": props.tone, title: props.title }, props.label);
  },
});

/** What a record is: bank, combination, file, built in. `info` for a managed or derived kind. */
export const PcKindChip = defineComponent({
  name: "PcKindChip",
  props: {
    label: { type: String, default: "" },
    tone: { type: String as PropType<"info" | undefined>, default: undefined },
    title: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () => h("span", { class: "pc-kind", "data-tone": props.tone, title: props.title }, [...(slots.icon?.() ?? []), slots.default ? slots.default() : props.label]);
  },
});

/** An operator-applied label: a tag, an owner, a group. */
export const PcTagChip = defineComponent({
  name: "PcTagChip",
  props: {
    label: { type: String, required: true },
    title: { type: String, default: undefined },
  },
  setup(props) {
    return () => h("span", { class: "pc-tag", title: props.title }, props.label);
  },
});

/** Tags folded to `max` visible plus one "+N" carrying the rest in its title. */
export const PcTagList = defineComponent({
  name: "PcTagList",
  props: {
    tags: { type: Array as PropType<readonly string[]>, required: true },
    max: { type: Number, default: 3 },
  },
  setup(props) {
    return () => {
      const shown = props.tags.slice(0, props.max);
      const rest = props.tags.slice(props.max);
      return h("span", { class: "pc-tag-list" }, [
        ...shown.map((tag) => h(PcTagChip, { key: tag, label: tag })),
        rest.length ? h(PcTagChip, { key: "+rest", label: `+${rest.length}`, title: rest.join(", ") }) : undefined,
      ]);
    };
  },
});

/** A population: 5, 2, "25 nodes · 138 lines". */
export const PcCount = defineComponent({
  name: "PcCount",
  props: {
    value: { type: [String, Number], required: true },
    tone: { type: String as PropType<CountTone | undefined>, default: undefined },
    label: { type: String, default: undefined },
  },
  setup(props) {
    return () => h("span", { class: "pc-count", "data-tone": props.tone, "aria-label": props.label, title: props.label }, String(props.value));
  },
});
