import { defineComponent, h, onMounted, ref, watch, type PropType, type Ref } from "vue";

import { iconX } from "./icons.js";
import { trapDialogTab, useOverlayRegistration } from "./overlayStack.js";
import { PcButton } from "./toolbar.js";

export type ModalSize = "small" | "default" | "large";
export type PanelSize = "record" | "output";

interface DialogOptions {
  kind: "modal" | "panel";
  className: string;
}

/**
 * Shared dialog behaviour: register with the overlay stack while open, move
 * focus to the dialog on open and back to the opener on close, keep Tab
 * inside, close on the scrim. Escape is not handled here: the screen's one
 * document handler (useOverlayEscape) closes the top of the stack.
 */
function useDialog(props: { open: boolean; returnFocusTo: HTMLElement | null }, emitClose: () => void) {
  const dialog = ref<HTMLElement | null>(null);
  useOverlayRegistration(() => props.open, emitClose);
  // Post-flush, so the dialog element exists when it is focused; mounted,
  // for a dialog that is rendered open in the first place.
  onMounted(() => {
    if (props.open) dialog.value?.focus();
  });
  watch(
    () => props.open,
    (open, was) => {
      if (open) dialog.value?.focus();
      else if (was) props.returnFocusTo?.focus();
    },
    { flush: "post" },
  );
  const onKeydown = (event: KeyboardEvent): void => {
    if (dialog.value) trapDialogTab(event, dialog.value);
  };
  return { dialog, onKeydown };
}

function dialogProps() {
  return {
    open: { type: Boolean, required: true as const },
    title: { type: String, required: true as const },
    description: { type: String, default: "" },
    closeLabel: { type: String, default: "Close" },
    /** Focused again when the dialog closes. */
    returnFocusTo: { type: Object as PropType<HTMLElement | null>, default: null },
  };
}

function renderDialog(
  options: DialogOptions,
  props: { open: boolean; title: string; description: string; closeLabel: string; size?: string },
  slots: Record<string, undefined | ((...args: unknown[]) => unknown)>,
  emitClose: () => void,
  dialog: Ref<HTMLElement | null>,
  onKeydown: (event: KeyboardEvent) => void,
  titleId: string,
) {
  if (!props.open) return null;
  const tag = options.kind === "panel" ? "aside" : "div";
  return h(
    "div",
    {
      class: "pc-overlay",
      "data-kind": options.kind,
      role: "presentation",
      onClick: (event: MouseEvent) => {
        if (event.target === event.currentTarget) emitClose();
      },
    },
    [
      h(
        tag,
        {
          ref: dialog,
          class: options.className,
          "data-size": props.size,
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": titleId,
          tabindex: -1,
          onKeydown,
        },
        [
          h("header", [
            h("div", [h("h2", { id: titleId }, props.title), props.description || slots.description ? h("p", slots.description ? (slots.description() as never) : props.description) : undefined]),
            h("button", { class: "pc-icon-button", type: "button", "aria-label": props.closeLabel, title: props.closeLabel, onClick: emitClose }, [iconX(16)]),
          ]),
          h("div", { class: "pc-modal-body" }, slots.default?.() as never),
          slots.footer ? h("footer", slots.footer() as never) : undefined,
        ],
      ),
    ],
  );
}

let dialogSequence = 0;

/** Fixed and centred on the frame's viewport (design 4.10). */
export const PcModal = defineComponent({
  name: "PcModal",
  props: { ...dialogProps(), size: { type: String as PropType<ModalSize>, default: "default" } },
  emits: { close: () => true },
  setup(props, { slots, emit }) {
    const emitClose = (): void => emit("close");
    const { dialog, onKeydown } = useDialog(props, emitClose);
    const titleId = `pc-dialog-${++dialogSequence}`;
    return () => renderDialog({ kind: "modal", className: "pc-modal" }, { ...props, size: props.size === "default" ? undefined : props.size }, slots, emitClose, dialog, onKeydown, titleId);
  },
});

/** Docked right: 440px for a record form, 960px for an output document. */
export const PcSidePanel = defineComponent({
  name: "PcSidePanel",
  props: { ...dialogProps(), size: { type: String as PropType<PanelSize>, default: "record" } },
  emits: { close: () => true },
  setup(props, { slots, emit }) {
    const emitClose = (): void => emit("close");
    const { dialog, onKeydown } = useDialog(props, emitClose);
    const titleId = `pc-dialog-${++dialogSequence}`;
    return () => renderDialog({ kind: "panel", className: "pc-side-panel" }, { ...props, size: props.size }, slots, emitClose, dialog, onKeydown, titleId);
  },
});

/** A question: a small modal with one confirming verb and Cancel. */
export const PcConfirmDialog = defineComponent({
  name: "PcConfirmDialog",
  props: {
    open: { type: Boolean, required: true },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    confirmLabel: { type: String, default: "Confirm" },
    cancelLabel: { type: String, default: "Cancel" },
    destructive: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    returnFocusTo: { type: Object as PropType<HTMLElement | null>, default: null },
  },
  emits: { confirm: () => true, cancel: () => true },
  setup(props, { slots, emit }) {
    return () =>
      h(
        PcModal,
        { open: props.open, title: props.title, size: "small", returnFocusTo: props.returnFocusTo, onClose: () => emit("cancel") },
        {
          default: () => (slots.default ? slots.default() : props.message ? h("p", props.message) : undefined),
          footer: () => [
            h(PcButton, { disabled: props.busy, onClick: () => emit("cancel") }, () => props.cancelLabel),
            h(PcButton, { variant: props.destructive ? "danger" : "primary", busy: props.busy, onClick: () => emit("confirm") }, () => props.confirmLabel),
          ],
        },
      );
  },
});

/** Floats over the foot of the table card and names the count it will act on. */
export const PcBatchBar = defineComponent({
  name: "PcBatchBar",
  props: {
    count: { type: Number, required: true },
    noun: { type: String, default: "selected" },
    clearLabel: { type: String, default: "Clear" },
    label: { type: String, default: "Selection actions" },
  },
  emits: { clear: () => true },
  setup(props, { slots, emit }) {
    return () =>
      props.count > 0
        ? h(
            "div",
            {
              class: "pc-batch-bar",
              role: "toolbar",
              "aria-label": props.label,
              onKeydown: (event: KeyboardEvent) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  emit("clear");
                }
              },
            },
            [
              h("span", { class: "pc-batch-bar-count" }, `${props.count} ${props.noun}`),
              h("div", { class: "pc-batch-bar-actions" }, slots.default?.()),
              h(PcButton, { compact: true, onClick: () => emit("clear") }, () => props.clearLabel),
            ],
          )
        : null;
  },
});
