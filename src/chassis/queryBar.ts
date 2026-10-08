import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, watch, type PropType, type VNode } from "vue";

import { completeQuery, FIELD_TYPE_LABELS, QUERY_COPY, queryErrorMessage, querySyntaxHelp, type Completion, type FieldType, type QueryFieldInfo } from "../query/index.js";
import { iconHelp, iconHistory, iconSearch, iconX } from "./icons.js";
import type { ListQueryState } from "./listQuery.js";

/**
 * One field that searches, filters and sorts a list in the frame, in the list
 * query grammar (../query). The plugin twin of the console's ListQueryBar
 * (lattice-dashboard src/components/common/ListQueryBar.vue), on the chassis
 * tokens:
 *
 *   [/] tag:edge status:offline OR status:degraded sort:name   12/34 [x] [?]
 *
 * The page owns the text (v-model, usually in its page state as `q`) and the
 * query (useListQuery); the bar owns the typing: a menu of fields, flags,
 * sort keys and values at the caret, a help card with the page's examples,
 * the syntax and the page's fields, the count inside the field's end so the
 * page never shifts, the error with the offending characters marked, and the
 * operator's recent queries for this page.
 *
 * Keys. Nothing in the menu is marked until the operator arrows into it, so
 * Enter and Tab keep their usual meaning: Enter keeps the query (and shows any
 * error at once), Tab moves on. ArrowDown opens the menu (on an empty field:
 * the recent queries) and moves through it, ArrowUp moves back, Enter or Tab
 * inserts the marked item, Escape closes the menu and, with the menu closed,
 * leaves the field. The clear button is the one way to empty it. Keys pressed
 * while an input method is composing belong to the input method.
 *
 * Recent queries live in localStorage under `lattice.query.recent.<storageKey>`.
 * A sandboxed frame may refuse storage outright; the list then lives for the
 * visit. Nothing here calls scrollIntoView, which in a frame would also scroll
 * the console around it.
 */

export interface QueryExample {
  query: string;
  /** What it finds, in words. */
  note: string;
}

interface MenuItem {
  key: string;
  label: string;
  /** Completion: replace start..end with insert. Recent: replace the whole field. */
  insert: string;
  start: number;
  end: number;
  kind: Completion["kind"] | "recent";
  hint?: string;
  type?: FieldType;
}

const RECENT_MAX = 6;
/** A query left in the field this long, with rows to show, counts as one worth keeping. */
const RECENT_SETTLE_MS = 2000;
const SNIPPET_RADIUS = 28;
/** The help card keeps this far from the frame's edges. */
const EDGE = 8;

let serial = 0;

/** Scroll a listbox so its option is inside it, moving only the listbox. */
function revealOption(list: HTMLElement | null, option: HTMLElement | null): void {
  if (!list || !option) return;
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

export const PcQueryBar = defineComponent({
  name: "PcQueryBar",
  props: {
    modelValue: { type: String, required: true },
    /** The page's query (useListQuery). */
    query: { type: Object as PropType<ListQueryState>, required: true },
    /** Rows kept and rows in the list; the count shows when given. */
    count: { type: Object as PropType<{ shown: number; total: number } | undefined>, default: undefined },
    /** Accessible name for the field. */
    label: { type: String, required: true },
    placeholder: { type: String, default: undefined },
    /** Names this page's recent queries in local storage. */
    storageKey: { type: String, required: true },
    /** Queries worth showing first in the help, for this page. */
    examples: { type: Array as PropType<readonly QueryExample[]>, default: () => [] },
  },
  emits: { "update:modelValue": (_value: string) => true },
  setup(props, { emit, expose }) {
    serial += 1;
    const uid = `pc-query-${serial}`;
    const listId = `${uid}-list`;
    const statusId = `${uid}-status`;
    const helpId = `${uid}-help`;

    const input = ref<HTMLInputElement | null>(null);
    const list = ref<HTMLElement | null>(null);
    const box = ref<HTMLElement | null>(null);
    const helpButton = ref<HTMLElement | null>(null);
    const helpCard = ref<HTMLElement | null>(null);

    const fields = computed<readonly QueryFieldInfo[]>(() => props.query.fields.value);
    const shownError = computed(() => props.query.shownError.value);

    /* ------------------------------ recent ------------------------------ */

    const recentKey = computed(() => `lattice.query.recent.${props.storageKey}`);

    function readRecent(): string[] {
      try {
        const raw = localStorage.getItem(recentKey.value);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string" && !!q.trim()).slice(0, RECENT_MAX) : [];
      } catch {
        return [];
      }
    }

    const recent = ref<string[]>(readRecent());

    function remember(query: string): void {
      const text = query.trim();
      if (!text || props.query.error.value) return;
      const next = [text, ...recent.value.filter((q) => q !== text)].slice(0, RECENT_MAX);
      recent.value = next;
      try {
        localStorage.setItem(recentKey.value, JSON.stringify(next));
      } catch {
        /* storage may be refused in a sandboxed frame; the list lives for this visit */
      }
    }

    /** When the text last changed, so leaving the field keeps only a query that stood. */
    let editedAt = 0;
    watch(
      () => props.modelValue,
      () => {
        editedAt = Date.now();
      },
    );

    /** Leaving the field keeps a query that stood for a moment and found something; half-typed words do not. */
    function rememberSettled(): void {
      if (Date.now() - editedAt < RECENT_SETTLE_MS) return;
      if (props.count && props.count.shown === 0) return;
      remember(props.modelValue);
    }

    /* ------------------------------- menu ------------------------------- */

    const open = ref(false);
    /** The marked item; -1 until the operator arrows into the menu. */
    const active = ref(-1);
    const items = ref<MenuItem[]>([]);

    function caretOf(): number {
      return input.value?.selectionStart ?? props.modelValue.length;
    }

    /** Fill the menu for the caret; on an empty field, with the recent queries when asked. */
    function refresh(withRecent = false): void {
      const text = props.modelValue;
      if (!text.trim()) {
        items.value = withRecent
          ? recent.value.map((query, i) => ({ key: `recent-${i}`, label: query, insert: query, start: 0, end: text.length, kind: "recent" as const }))
          : [];
      } else {
        const caret = caretOf();
        const result = completeQuery(text, caret, fields.value);
        const typed = text.slice(result.start, caret).toLowerCase();
        items.value = result.items
          // A value, flag or sort key already typed in full has nothing left to complete.
          .filter((item) => !(item.insert.trimEnd().toLowerCase() === typed && text.slice(caret, result.end) === ""))
          .map((item, i) => ({ key: `${item.kind}-${i}-${item.label}`, ...item, start: result.start, end: result.end }));
      }
      active.value = -1;
      open.value = items.value.length > 0;
      if (open.value) helpOpen.value = false;
    }

    function close(): void {
      open.value = false;
      active.value = -1;
    }

    async function focusAt(caret: number): Promise<void> {
      await nextTick();
      input.value?.focus();
      input.value?.setSelectionRange(caret, caret);
    }

    async function accept(item: MenuItem): Promise<void> {
      const text = props.modelValue;
      const next = item.kind === "recent" ? item.insert : text.slice(0, item.start) + item.insert + text.slice(item.end);
      const caret = item.kind === "recent" ? next.length : item.start + item.insert.length;
      emit("update:modelValue", next);
      await focusAt(caret);
      // A field name opens straight onto its values; a value or a recent query closes the menu.
      if (item.kind === "field" || (item.kind === "flag" && item.label === "is:") || (item.kind === "sort" && item.label === "sort:")) refresh();
      else close();
    }

    function onInput(event: Event): void {
      emit("update:modelValue", (event.target as HTMLInputElement).value);
      void nextTick(() => refresh());
    }

    function scrollActive(): void {
      void nextTick(() => {
        const option = active.value >= 0 ? (list.value?.querySelector<HTMLElement>(`#${uid}-opt-${active.value}`) ?? null) : null;
        revealOption(list.value, option);
      });
    }

    function move(step: number): void {
      if (!open.value) {
        refresh(true);
        if (open.value) active.value = step > 0 ? 0 : items.value.length - 1;
        scrollActive();
        return;
      }
      const n = items.value.length;
      if (!n) return;
      active.value = active.value < 0 ? (step > 0 ? 0 : n - 1) : (active.value + step + n) % n;
      scrollActive();
    }

    function onKeydown(event: KeyboardEvent): void {
      if (event.isComposing || event.keyCode === 229) return;
      const marked = open.value && active.value >= 0 ? items.value[active.value] : undefined;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          move(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          break;
        case "Enter":
          event.preventDefault();
          if (marked) {
            void accept(marked);
          } else {
            close();
            props.query.reveal();
            remember(props.modelValue);
          }
          break;
        case "Tab":
          if (marked && !event.shiftKey) {
            event.preventDefault();
            void accept(marked);
          } else {
            close();
          }
          break;
        case "Escape":
          // The field's own Escape: a side panel beside the rows stays open.
          event.preventDefault();
          event.stopPropagation();
          if (open.value) close();
          else input.value?.blur();
          break;
      }
    }

    function onClick(): void {
      // A click on an empty field offers the recent queries; elsewhere it follows the caret.
      if (!props.modelValue.trim()) refresh(true);
      else if (open.value) refresh();
    }

    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    function onBlur(): void {
      // Pointer presses on the menu keep focus (mousedown is prevented); anything else closes it.
      blurTimer = setTimeout(close, 0);
      props.query.reveal();
      rememberSettled();
    }

    function clear(): void {
      emit("update:modelValue", "");
      close();
      void nextTick(() => input.value?.focus());
    }

    // The text can change under the bar (a restored page state, a chip): the menu follows the text.
    watch(
      () => props.modelValue,
      () => {
        if (typeof document !== "undefined" && document.activeElement !== input.value) close();
      },
    );

    function hintText(item: { hint?: string; type?: FieldType; kind: MenuItem["kind"] }): string {
      if (item.kind === "recent" || item.kind === "value") return "";
      if (item.hint) return item.hint;
      if (item.kind === "flag") return QUERY_COPY.menuFlags;
      if (item.kind === "sort") return QUERY_COPY.menuSort;
      return item.type ? FIELD_TYPE_LABELS[item.type] : "";
    }

    /* ------------------------------- count ------------------------------ */

    const countShort = computed(() => (props.count && !shownError.value ? `${props.count.shown}/${props.count.total}` : ""));
    const countLong = computed(() => (props.count ? QUERY_COPY.count(props.count.shown, props.count.total) : ""));
    /** Room at the field's end for the clear and help buttons, and the count when it shows. */
    const endPadding = computed(() => {
      const buttons = `${props.modelValue ? 2 : 1} * var(--pc-query-button) + 8px`;
      return countShort.value ? `calc(${countShort.value.length + 1}ch + ${buttons})` : `calc(${buttons})`;
    });

    /* ------------------------------- error ------------------------------ */

    const errorMessage = computed(() => (shownError.value ? queryErrorMessage(shownError.value) : ""));

    /** The query around the error, the bad characters marked; long queries are cut to a window. */
    const snippet = computed(() => {
      const error = shownError.value;
      if (!error) return undefined;
      const text = props.modelValue;
      const from = Math.max(0, error.start - SNIPPET_RADIUS);
      const to = Math.min(text.length, error.end + SNIPPET_RADIUS);
      return {
        lead: from > 0 ? "..." : "",
        before: text.slice(from, error.start),
        bad: text.slice(error.start, error.end),
        after: text.slice(error.end, to),
        trail: to < text.length ? "..." : "",
        column: error.start + 1,
      };
    });

    /** The name the error suggests, ready to put in place of the bad one. */
    const suggestion = computed(() => {
      const error = shownError.value;
      const name = error?.params?.suggestion;
      if (!error || typeof name !== "string" || !name) return undefined;
      const bad = props.modelValue.slice(error.start, error.end);
      return bad.startsWith("-") ? `-${name}` : name;
    });

    async function useSuggestion(): Promise<void> {
      const error = shownError.value;
      if (!error || !suggestion.value) return;
      const text = props.modelValue;
      emit("update:modelValue", text.slice(0, error.start) + suggestion.value + text.slice(error.end));
      await focusAt(error.start + suggestion.value.length);
    }

    /** What the list on screen answers while the text does not read. */
    const staleText = computed(() => {
      if (!props.query.stale.value) return "";
      const running = props.query.active.value;
      if (running.empty) return QUERY_COPY.staleAll;
      if (props.count) return QUERY_COPY.staleFor(props.count.shown, props.count.total, running.source.trim());
      return QUERY_COPY.stale;
    });

    /* ------------------------------- help ------------------------------- */

    const helpOpen = ref(false);
    const helpStyle = ref<Record<string, string>>({});
    const help = computed(() => querySyntaxHelp(fields.value));
    const helpFields = computed(() => fields.value.filter((field) => !field.flag));
    const helpFlags = computed(() => fields.value.filter((field) => field.flag).map((field) => field.key));

    /** Keep the card inside the frame: shift it in from the start edge, and cap its height to the room below. */
    function placeHelp(): void {
      const card = helpCard.value;
      const anchor = box.value;
      if (!card || !anchor || typeof window === "undefined") return;
      const below = window.innerHeight - anchor.getBoundingClientRect().bottom - 6 - EDGE;
      const style: Record<string, string> = { maxHeight: `${Math.max(240, Math.min(544, below))}px` };
      const rect = card.getBoundingClientRect();
      if (rect.left < EDGE) style.transform = `translateX(${Math.ceil(EDGE - rect.left)}px)`;
      helpStyle.value = style;
    }

    function onDocumentPointer(event: Event): void {
      const target = event.target as Node | null;
      if (target && (helpCard.value?.contains(target) || helpButton.value?.contains(target))) return;
      helpOpen.value = false;
    }

    /** A press outside the frame (the console around it) takes focus out of the frame's window. */
    function onWindowBlur(): void {
      helpOpen.value = false;
    }

    function unbindHelp(): void {
      if (typeof document === "undefined") return;
      document.removeEventListener("pointerdown", onDocumentPointer, true);
      window.removeEventListener("blur", onWindowBlur);
    }

    watch(helpOpen, async (isOpen) => {
      if (typeof document === "undefined") return;
      if (!isOpen) {
        unbindHelp();
        return;
      }
      close();
      helpStyle.value = {};
      document.addEventListener("pointerdown", onDocumentPointer, true);
      window.addEventListener("blur", onWindowBlur);
      await nextTick();
      placeHelp();
      helpCard.value?.focus({ preventScroll: true });
    });

    function closeHelp(returnFocus: boolean): void {
      helpOpen.value = false;
      if (returnFocus) helpButton.value?.focus();
    }

    function onHelpKeydown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeHelp(true);
    }

    function onHelpFocusout(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null;
      if (!next || helpCard.value?.contains(next) || helpButton.value?.contains(next)) return;
      helpOpen.value = false;
    }

    async function pickExample(query: string): Promise<void> {
      // The query being replaced stays one keystroke away.
      remember(props.modelValue);
      emit("update:modelValue", query);
      helpOpen.value = false;
      await focusAt(query.length);
    }

    onBeforeUnmount(() => {
      clearTimeout(blurTimer);
      unbindHelp();
    });

    expose({ focus: () => input.value?.focus() });

    /* ------------------------------ render ------------------------------ */

    function renderMenu(): VNode {
      const children: VNode[] = [];
      const recentList = items.value[0]?.kind === "recent";
      // The heading is for the eye; the listbox's own name says it to a screen reader.
      if (recentList) children.push(h("li", { role: "presentation", "aria-hidden": "true", class: "pc-query-menu-heading" }, QUERY_COPY.recent));
      items.value.forEach((item, index) => {
        const hint = hintText(item);
        children.push(
          h(
            "li",
            {
              id: `${uid}-opt-${index}`,
              key: item.key,
              role: "option",
              class: "pc-query-option",
              "aria-selected": index === active.value ? "true" : "false",
              "data-kind": item.kind,
              onMousedown: (event: MouseEvent) => {
                event.preventDefault();
                void accept(item);
              },
            },
            [
              item.kind === "recent" ? h("span", { class: "pc-query-option-icon" }, [iconHistory(14)]) : undefined,
              h("span", { class: "pc-query-option-label" }, item.label),
              hint ? h("span", { class: "pc-query-option-hint" }, hint) : undefined,
            ],
          ),
        );
      });
      return h(
        "ul",
        { ref: list, id: listId, role: "listbox", "aria-label": recentList ? QUERY_COPY.recentQueries : props.label, class: "pc-query-menu", hidden: !open.value },
        children,
      );
    }

    function renderDefinitions(rows: { term: string; note: string }[], extra: Record<string, unknown> = {}): VNode {
      return h(
        "dl",
        { class: "pc-query-help-grid", ...extra },
        rows.flatMap((row) => [h("dt", row.term), h("dd", row.note)]),
      );
    }

    function renderHelp(): VNode | undefined {
      if (!helpOpen.value) return undefined;
      const examples = props.examples.length
        ? [
            h("p", { class: "pc-query-help-heading" }, QUERY_COPY.examples),
            h(
              "ul",
              { class: "pc-query-help-examples" },
              props.examples.map((example) =>
                h("li", { key: example.query }, [
                  h("button", { type: "button", class: "pc-query-example", onClick: () => void pickExample(example.query) }, example.query),
                  h("span", example.note),
                ]),
              ),
            ),
          ]
        : [];
      return h(
        "div",
        {
          ref: helpCard,
          id: helpId,
          role: "dialog",
          "aria-label": QUERY_COPY.helpTitle,
          tabindex: -1,
          class: "pc-query-help",
          style: helpStyle.value,
          onKeydown: onHelpKeydown,
          onFocusout: onHelpFocusout,
        },
        [
          h("p", { class: "pc-query-help-title" }, QUERY_COPY.helpTitle),
          ...examples,
          h("p", { class: "pc-query-help-heading" }, QUERY_COPY.syntax),
          renderDefinitions(help.value.rows.map((row) => ({ term: row.query, note: row.note })), { "data-kind": "syntax" }),
          h("p", { class: "pc-query-help-note" }, help.value.precedence),
          help.value.missing ? h("p", { class: "pc-query-help-note" }, help.value.missing) : undefined,
          h("p", { class: "pc-query-help-heading" }, QUERY_COPY.fields),
          renderDefinitions(
            helpFields.value.map((field) => ({
              term: [field.key, ...field.aliases].join(", "),
              note: hintText({ hint: field.hint, type: field.type, kind: "field" }),
            })),
            { "data-kind": "fields" },
          ),
          helpFlags.value.length
            ? h("p", { class: "pc-query-help-note" }, [h("strong", `${QUERY_COPY.flags} `), h("span", { class: "pc-query-help-flags" }, `is:${helpFlags.value.join(" is:")}`)])
            : undefined,
        ],
      );
    }

    function renderStatus(): VNode {
      const error = shownError.value;
      const snip = snippet.value;
      const children: (VNode | undefined)[] = [];
      if (error && snip) {
        children.push(
          h("p", { class: "pc-query-error" }, [
            `${errorMessage.value} `,
            h("span", { class: "pc-query-column" }, QUERY_COPY.column(snip.column)),
            suggestion.value
              ? h("button", { type: "button", class: "pc-query-suggestion", onClick: () => void useSuggestion() }, QUERY_COPY.useSuggestion(suggestion.value))
              : undefined,
          ]),
          h("p", { class: "pc-query-snippet", "aria-hidden": "true" }, [
            snip.lead,
            h("span", snip.before),
            h("mark", h("span", snip.bad || " ")),
            h("span", snip.after),
            snip.trail,
          ]),
          staleText.value ? h("p", { class: "pc-query-stale" }, staleText.value) : undefined,
        );
      }
      // Always in the tree and only its text changes: a live region that appears with its content is often not announced.
      return h("div", { id: statusId, class: "pc-query-status", "aria-live": "polite" }, children);
    }

    return () =>
      h("div", { class: "pc-query", "data-invalid": shownError.value ? "true" : undefined }, [
        h("div", { ref: box, class: "pc-query-box" }, [
          h("span", { class: "pc-query-icon" }, [iconSearch(16)]),
          h("input", {
            ref: input,
            class: "pc-query-input",
            type: "text",
            role: "combobox",
            value: props.modelValue,
            "aria-label": props.label,
            "aria-expanded": open.value ? "true" : "false",
            "aria-controls": listId,
            "aria-autocomplete": "list",
            "aria-activedescendant": open.value && active.value >= 0 ? `${uid}-opt-${active.value}` : undefined,
            "aria-invalid": shownError.value ? "true" : undefined,
            "aria-describedby": statusId,
            placeholder: props.placeholder,
            autocomplete: "off",
            autocapitalize: "off",
            spellcheck: "false",
            style: { paddingInlineEnd: endPadding.value },
            onInput,
            onKeydown,
            onClick,
            onBlur,
          }),
          h("div", { class: "pc-query-end" }, [
            countShort.value ? h("span", { class: "pc-query-count", "aria-hidden": "true" }, countShort.value) : undefined,
            props.modelValue
              ? h("button", { type: "button", class: "pc-query-button", "aria-label": QUERY_COPY.clear, title: QUERY_COPY.clear, onClick: clear }, [iconX(15)])
              : undefined,
            h(
              "button",
              {
                ref: helpButton,
                type: "button",
                class: "pc-query-button",
                "aria-label": QUERY_COPY.help,
                title: QUERY_COPY.help,
                "aria-haspopup": "dialog",
                "aria-expanded": helpOpen.value ? "true" : "false",
                "aria-controls": helpOpen.value ? helpId : undefined,
                onClick: () => {
                  if (helpOpen.value) closeHelp(false);
                  else helpOpen.value = true;
                },
                onKeydown: (event: KeyboardEvent) => {
                  if (event.key !== "Escape" || !helpOpen.value) return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeHelp(false);
                },
              },
              [iconHelp(16)],
            ),
          ]),
          renderMenu(),
          renderHelp(),
        ]),
        renderStatus(),
        // The count, said for a screen reader; out of the flow, so the page never moves when it changes.
        props.count ? h("p", { class: "pc-sr-only", "aria-live": "polite" }, shownError.value ? "" : countLong.value) : undefined,
      ]);
  },
});
