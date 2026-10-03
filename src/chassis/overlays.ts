import { computed, defineComponent, h, onMounted, ref, watch, type PropType, type Ref } from "vue";

import { iconX } from "./icons.js";
import { trapDialogTab, useOverlayRegistration } from "./overlayStack.js";
import { useMediaQuery } from "./queryState.js";
import { PcButton } from "./toolbar.js";

export type ModalSize = "small" | "default" | "large";
export type PanelSize = "record" | "output";

interface DialogOptions {
  kind: "modal" | "panel";
  className: string;
  /** False for a side panel beside the collection: no scrim, no aria-modal, rows stay live. */
  modal: boolean;
}

/**
 * Shared dialog behaviour: register with the overlay stack while open, move
 * focus to the dialog on open and back to the opener on close, keep Tab
 * inside, close on the scrim. Escape is not handled here: the screen's one
 * document handler (useOverlayEscape) closes the top of the stack.
 *
 * `modal` is false for a side panel beside the collection (PcSidePanel from
 * 768px). Then Tab is not kept inside, and on close focus goes back to the
 * opener only when it was in the panel: the panel's removal leaves it on
 * <body>. An operator who has moved on to the rows keeps the focus they put
 * there, so closing the panel from the page does not pull them back to the
 * row that first opened it. Escape from a text field or an open menu on the
 * page, or one a page control already used, leaves it open
 * (escapeBelongsToPage).
 */
function useDialog(props: { open: boolean; returnFocusTo: HTMLElement | null }, emitClose: () => void, modal: () => boolean = () => true) {
  const dialog = ref<HTMLElement | null>(null);
  useOverlayRegistration(() => props.open, emitClose, () => (modal() ? null : dialog.value));
  // The element that held focus when the dialog opened. Focus goes back there
  // on close unless the consumer names another target with returnFocusTo, so
  // a keyboard user lands on the button they pressed, not on <body>.
  let opener: HTMLElement | null = null;
  const open = (): void => {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
    dialog.value?.focus();
  };
  const close = (): void => {
    const target = props.returnFocusTo ?? opener;
    opener = null;
    if (!modal()) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) return;
    }
    if (target?.isConnected) target.focus();
  };
  // Post-flush, so the dialog element exists when it is focused; mounted,
  // for a dialog that is rendered open in the first place.
  onMounted(() => {
    if (props.open) open();
  });
  watch(
    () => props.open,
    (isOpen, was) => {
      if (isOpen) open();
      else if (was) close();
    },
    { flush: "post" },
  );
  const onKeydown = (event: KeyboardEvent): void => {
    if (dialog.value && modal()) trapDialogTab(event, dialog.value);
  };
  return { dialog, onKeydown };
}

function dialogProps() {
  return {
    open: { type: Boolean, required: true as const },
    title: { type: String, required: true as const },
    description: { type: String, default: "" },
    closeLabel: { type: String, default: "Close" },
    /** Focused again when the dialog closes; left null, focus returns to the element that had it when the dialog opened. */
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
      "data-modal": options.modal ? undefined : "false",
      role: "presentation",
      // Beside the collection there is no scrim to click: the wrapper lets
      // pointer events through to the rows (chassis.css), and a click on a
      // row opens that row in the panel's place rather than closing it.
      onClick: options.modal
        ? (event: MouseEvent) => {
            if (event.target === event.currentTarget) emitClose();
          }
        : undefined,
    },
    [
      h(
        tag,
        {
          ref: dialog,
          class: options.className,
          "data-size": props.size,
          // A landmark, not a dialog, while the page around it stays live:
          // aria-modal would tell a screen reader the rows are inert when
          // they are not. The title still names it.
          role: options.modal ? "dialog" : "complementary",
          "aria-modal": options.modal ? "true" : undefined,
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
    return () => renderDialog({ kind: "modal", className: "pc-modal", modal: true }, { ...props, size: props.size === "default" ? undefined : props.size }, slots, emitClose, dialog, onKeydown, titleId);
  },
});

/**
 * The frame width from which a record panel (440px) sits beside the
 * collection. Beside the rows, a panel always leaves them 320px (chassis.css
 * caps it at the frame less 320px), and 440 + 320 fits from 768px.
 */
export const SIDE_PANEL_BESIDE_QUERY = "(min-width: 768px)";

/**
 * The frame width from which an output panel (960px) sits beside the
 * collection: 960 + 320. Narrower, an output document is a modal sheet, so it
 * keeps its reading width instead of squeezing beside rows it would cover.
 */
export const SIDE_PANEL_OUTPUT_BESIDE_QUERY = "(min-width: 1280px)";

/**
 * Docked right: 440px for a record form, 960px for an output document.
 *
 * From 768px a record panel, and from 1280px an output panel, sits beside the
 * collection and is not modal (design 23, section 3.5, the console's
 * ObjectSheet rule): no scrim, the page keeps scrolling, the rows stay live
 * so a click on another row swaps the record, and the panel is a labelled
 * complementary landmark that Tab walks into and out of. Beside the rows it
 * is never wider than the frame less 320px, whatever width a plugin gives
 * it. Below its threshold it is a modal, full-height sheet with a scrim, Tab
 * kept inside. In both, Escape (useOverlayEscape) and the close button close
 * it, and focus returns to the opener; beside the collection, Escape typed in a
 * page field (the rows' search) or pressed in an open row menu stays there.
 * The frame is measured in the first render, so a panel restored from the
 * address opens in its final form. Without matchMedia (a server render, a
 * test) it is modal.
 */
export const PcSidePanel = defineComponent({
  name: "PcSidePanel",
  props: { ...dialogProps(), size: { type: String as PropType<PanelSize>, default: "record" } },
  emits: { close: () => true },
  setup(props, { slots, emit }) {
    const emitClose = (): void => emit("close");
    const besideRecord = useMediaQuery(SIDE_PANEL_BESIDE_QUERY);
    const besideOutput = useMediaQuery(SIDE_PANEL_OUTPUT_BESIDE_QUERY);
    const modal = computed(() => (props.size === "output" ? besideOutput : besideRecord).value !== true);
    const { dialog, onKeydown } = useDialog(props, emitClose, () => modal.value);
    const titleId = `pc-dialog-${++dialogSequence}`;
    return () => renderDialog({ kind: "panel", className: "pc-side-panel", modal: modal.value }, { ...props, size: props.size }, slots, emitClose, dialog, onKeydown, titleId);
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
