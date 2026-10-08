// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mount } from "@vue/test-utils";
import { defineComponent, effectScope, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nodeQuerySchema, type PluginNodeFacts } from "../query/index";
import { ERROR_DELAY_MS, SETTLE_MS, URL_WRITE_MS, useDocumentQueryText, useListQuery, useQueryText } from "./listQuery";
import { PcQueryBar } from "./queryBar";

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const NODES: PluginNodeFacts[] = [
  { id: "n-hk", name: "[cd]-gomami-hkg", status: "online", tags: ["edge", "cd"], last_seen: ago(5) },
  { id: "n-fsn", name: "[cd]-hetzner-fsn", status: "online", tags: ["core"], last_seen: ago(5) },
  { id: "n-dmit", name: "DMIT-4", status: "offline", tags: ["edge"], last_seen: ago(6 * 86400) },
  { id: "n-sg", name: "[cd]-LegendVPS-SG-EVO", status: "degraded", tags: ["edge"], last_seen: ago(40) },
  { id: "n-new", name: "fresh-box", status: "never_reported" },
];

const schema = nodeQuerySchema();

/** A page: the rows, the query over them, and the bar bound to the text. */
function mountPage(initial = "", examples = [{ query: "tag:edge is:offline", note: "Edge nodes that stopped reporting" }]) {
  const Page = defineComponent({
    setup() {
      const text = ref(initial);
      const rows = ref(NODES);
      const query = useListQuery(rows, schema, text);
      return () =>
        h("div", { class: "pc-workspace" }, [
          h(PcQueryBar, {
            modelValue: text.value,
            "onUpdate:modelValue": (value: string) => (text.value = value),
            query,
            count: { shown: query.rows.value.length, total: rows.value.length },
            label: "Search nodes",
            placeholder: "tag:edge status:offline sort:name",
            storageKey: "test.nodes",
            examples,
          }),
          h("ul", { class: "rows" }, query.rows.value.map((node) => h("li", { key: node.id }, node.id))),
        ]);
    },
  });
  return mount(Page, { attachTo: document.body });
}

const shownIds = (wrapper: ReturnType<typeof mountPage>) => wrapper.findAll(".rows li").map((li) => li.text());

async function type(wrapper: ReturnType<typeof mountPage>, value: string) {
  const input = wrapper.get("input");
  (input.element as HTMLInputElement).value = value;
  (input.element as HTMLInputElement).setSelectionRange(value.length, value.length);
  await input.trigger("input");
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useListQuery", () => {
  it("keeps the last valid query that stood while the text does not read, and shows the error after a pause", async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const text = ref("tag:edge");
    const query = scope.run(() => useListQuery(ref(NODES), schema, text))!;
    expect(query.rows.value.map((n) => n.id)).toEqual(["n-hk", "n-dmit", "n-sg"]);
    vi.advanceTimersByTime(SETTLE_MS);

    text.value = "stauts:offline tag:edge";
    await nextTick();
    expect(query.error.value?.code).toBe("unknownField");
    expect(query.stale.value).toBe(true);
    expect(query.rows.value.map((n) => n.id)).toEqual(["n-hk", "n-dmit", "n-sg"]);
    expect(query.shownError.value).toBeNull();
    vi.advanceTimersByTime(ERROR_DELAY_MS);
    expect(query.shownError.value?.code).toBe("unknownField");
    expect(query.invalid.value).toBe(true);

    text.value = "status:offline tag:edge";
    await nextTick();
    expect(query.shownError.value).toBeNull();
    expect(query.rows.value.map((n) => n.id)).toEqual(["n-dmit"]);
    scope.stop();
  });

  it("holds an error at the end of the text, a term still being typed, until reveal", async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const text = ref("tag:edge");
    const query = scope.run(() => useListQuery(ref(NODES), schema, text))!;
    vi.advanceTimersByTime(SETTLE_MS);
    for (const typing of ["tag:edge status:", "tag:edge OR", "tag:edge -", 'tag:edge name:"DMIT']) {
      text.value = typing;
      await nextTick();
      vi.advanceTimersByTime(ERROR_DELAY_MS * 3);
      expect(query.error.value, typing).not.toBeNull();
      expect(query.shownError.value, typing).toBeNull();
      expect(query.rows.value.map((n) => n.id), typing).toEqual(["n-hk", "n-dmit", "n-sg"]);
    }
    query.reveal();
    expect(query.shownError.value?.code).toBe("unclosedQuote");
    text.value = "tag:edge stauts:offline";
    await nextTick();
    expect(query.shownError.value?.code).toBe("unknownField");
    scope.stop();
  });

  it("says to dim only the rows a stale query left, never its no-match state (staleRows)", async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const text = ref("tag:edge");
    const query = scope.run(() => useListQuery(ref(NODES), schema, text))!;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(query.staleRows.value).toBe(false);

    text.value = "tag:edge stauts:offline";
    await nextTick();
    vi.advanceTimersByTime(ERROR_DELAY_MS);
    expect(query.invalid.value).toBe(true);
    expect(query.rows.value).toHaveLength(3);
    expect(query.staleRows.value).toBe(true);

    // The last valid query keeps nothing: the panel holds the no-match
    // state, and its Clear the query must stay live.
    text.value = "zzz-no-such-node";
    await nextTick();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(query.rows.value).toHaveLength(0);
    text.value = "zzz-no-such-node stauts:offline";
    await nextTick();
    vi.advanceTimersByTime(ERROR_DELAY_MS);
    expect(query.invalid.value).toBe(true);
    expect(query.rows.value).toHaveLength(0);
    expect(query.staleRows.value).toBe(false);
    scope.stop();
  });

  it("dims nothing over a list with no rows at all", () => {
    const scope = effectScope();
    const query = scope.run(() => useListQuery(ref<PluginNodeFacts[]>([]), schema, ref("stauts:offline")))!;
    expect(query.invalid.value).toBe(true);
    expect(query.staleRows.value).toBe(false);
    scope.stop();
  });

  it("shows an error that arrives with the page at once, and runs every row", () => {
    const scope = effectScope();
    const query = scope.run(() => useListQuery(ref(NODES), schema, ref("stauts:offline")))!;
    expect(query.shownError.value?.code).toBe("unknownField");
    expect(query.rows.value).toHaveLength(NODES.length);
    expect(query.active.value.empty).toBe(true);
    scope.stop();
  });
});

describe("useQueryText and useDocumentQueryText", () => {
  it("writes the store once the typing pauses, and takes a change that arrives from it", async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const stored = ref("tag:edge");
    const text = scope.run(() => useQueryText(stored))!;
    text.value = "tag:edge is:off";
    await nextTick();
    text.value = "tag:edge is:offline";
    await nextTick();
    expect(stored.value).toBe("tag:edge");
    vi.advanceTimersByTime(URL_WRITE_MS);
    expect(stored.value).toBe("tag:edge is:offline");
    stored.value = "status:degraded";
    await nextTick();
    expect(text.value).toBe("status:degraded");
    scope.stop();
  });

  it("reads ?q= from the frame's document and writes it back without the fragment changing", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const win = {
      location: { search: "?lens=fleet&q=tag%3Aedge", hash: "#lattice_nonce=abc", pathname: "/ui/" },
      history: { replaceState: (_d: unknown, _u: string, url?: string) => writes.push(url ?? "") },
    };
    const { useDocumentQueryState } = await import("./queryState");
    const scope = effectScope();
    const text = scope.run(() => useDocumentQueryText("q", { state: useDocumentQueryState(win) }))!;
    expect(text.value).toBe("tag:edge");
    text.value = "tag:edge sort:name";
    await nextTick();
    vi.advanceTimersByTime(URL_WRITE_MS);
    await nextTick();
    expect(writes.at(-1)).toBe("/ui/?lens=fleet&q=tag%3Aedge+sort%3Aname#lattice_nonce=abc");
    scope.stop();
  });

  it("keeps the text when the frame refuses replaceState", async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const state = { read: () => [], write: () => { throw new DOMException("refused", "SecurityError"); } };
    const text = scope.run(() => useDocumentQueryText("q", { state }))!;
    text.value = "is:offline";
    await nextTick();
    expect(() => vi.advanceTimersByTime(URL_WRITE_MS)).not.toThrow();
    await nextTick();
    expect(text.value).toBe("is:offline");
    scope.stop();
  });
});

describe("PcQueryBar", () => {
  it("is a labelled combobox with the count inside its end", async () => {
    const wrapper = mountPage("tag:edge");
    const input = wrapper.get("input");
    expect(input.attributes("role")).toBe("combobox");
    expect(input.attributes("aria-label")).toBe("Search nodes");
    expect(input.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".pc-query-count").text()).toBe("3/5");
    expect(wrapper.get(".pc-sr-only").text()).toBe("3 of 5");
    expect(shownIds(wrapper)).toEqual(["n-hk", "n-dmit", "n-sg"]);
    wrapper.unmount();
  });

  it("offers fields as the operator types, marks nothing until ArrowDown, and inserts with Enter", async () => {
    const wrapper = mountPage();
    await type(wrapper, "sta");
    const input = wrapper.get("input");
    expect(input.attributes("aria-expanded")).toBe("true");
    const options = wrapper.findAll("[role='option']");
    expect(options[0]!.text()).toContain("status");
    expect(options.every((option) => option.attributes("aria-selected") === "false")).toBe(true);

    await input.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.findAll("[role='option']")[0]!.attributes("aria-selected")).toBe("true");
    expect(input.attributes("aria-activedescendant")).toBe(wrapper.findAll("[role='option']")[0]!.attributes("id"));

    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe("status:");
    // A field name opens straight onto its values.
    const values = wrapper.findAll("[role='option']").map((option) => option.find(".pc-query-option-label").text());
    expect(values).toEqual(["never_reported", "offline", "degraded", "disabled", "online"]);
    wrapper.unmount();
  });

  it("Escape closes the menu, then leaves the field, and never reaches the page", async () => {
    const wrapper = mountPage();
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    await type(wrapper, "is:");
    const input = wrapper.get("input");
    (input.element as HTMLInputElement).focus();
    expect(input.attributes("aria-expanded")).toBe("true");
    await input.trigger("keydown", { key: "Escape" });
    expect(input.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(input.element);
    await input.trigger("keydown", { key: "Escape" });
    expect(document.activeElement).not.toBe(input.element);
    expect(pageEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", pageEscape);
    wrapper.unmount();
  });

  it("Tab moves on unless an item is marked; keys during composition belong to the input method", async () => {
    const wrapper = mountPage();
    await type(wrapper, "sta");
    const input = wrapper.get("input");
    await input.trigger("keydown", { key: "Tab" });
    expect(input.attributes("aria-expanded")).toBe("false");
    expect((input.element as HTMLInputElement).value).toBe("sta");
    await type(wrapper, "sta");
    await input.trigger("keydown", { key: "ArrowDown", isComposing: true });
    expect(wrapper.findAll("[role='option']").every((option) => option.attributes("aria-selected") === "false")).toBe(true);
    wrapper.unmount();
  });

  it("shows the error with its column and the offending characters, and puts the suggestion in place", async () => {
    const wrapper = mountPage("tag:edge stauts:offline");
    expect(wrapper.get(".pc-query").attributes("data-invalid")).toBe("true");
    expect(wrapper.get("input").attributes("aria-invalid")).toBe("true");
    expect(wrapper.get(".pc-query-error").text()).toContain("There is no field called stauts. Did you mean status?");
    expect(wrapper.get(".pc-query-column").text()).toBe("(at character 10)");
    expect(wrapper.get(".pc-query-snippet mark").text()).toBe("stauts");
    expect(wrapper.get(".pc-query-stale").text()).toBe("The list shows every row until the query reads.");
    expect(wrapper.find(".pc-query-count").exists()).toBe(false);
    await wrapper.get(".pc-query-suggestion").trigger("click");
    await nextTick();
    await nextTick();
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("tag:edge status:offline");
    expect(shownIds(wrapper)).toEqual(["n-dmit"]);
    expect(wrapper.find(".pc-query-error").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps recent queries per page and offers them on ArrowDown in an empty field", async () => {
    const wrapper = mountPage();
    await type(wrapper, "tag:edge sort:name");
    const input = wrapper.get("input");
    await input.trigger("keydown", { key: "Enter" });
    expect(JSON.parse(localStorage.getItem("lattice.query.recent.test.nodes")!)).toEqual(["tag:edge sort:name"]);
    await wrapper.get("button[aria-label='Clear the query']").trigger("click");
    await nextTick();
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.get(".pc-query-menu-heading").text()).toBe("Recent");
    expect(wrapper.get("[role='listbox']").attributes("aria-label")).toBe("Recent queries");
    const option = wrapper.get("[role='option']");
    expect(option.attributes("aria-selected")).toBe("true");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe("tag:edge sort:name");
    wrapper.unmount();
  });

  it("works when the sandbox refuses storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const wrapper = mountPage();
    await type(wrapper, "is:offline");
    const input = wrapper.get("input");
    await input.trigger("keydown", { key: "Enter" });
    await wrapper.get("button[aria-label='Clear the query']").trigger("click");
    await nextTick();
    await input.trigger("keydown", { key: "ArrowDown" });
    // Remembered for the visit, though storage refused it.
    expect(wrapper.get("[role='option']").text()).toContain("is:offline");
    wrapper.unmount();
  });

  it("opens the help card with the page's examples, syntax drawn from its fields, and its fields; Escape returns focus", async () => {
    const wrapper = mountPage();
    const button = wrapper.get("button[aria-label='Query syntax']");
    await button.trigger("click");
    await nextTick();
    const card = wrapper.get("[role='dialog']");
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(button.attributes("aria-controls")).toBe(card.attributes("id"));
    expect(document.activeElement).toBe(card.element);
    expect(card.text()).toContain("Edge nodes that stopped reporting");
    const syntax = card.findAll("[data-kind='syntax'] dt").map((dt) => dt.text());
    expect(syntax).toContain("last_seen>10m");
    expect(syntax).toContain("is:online");
    expect(syntax.some((row) => row.startsWith("cpu"))).toBe(false);
    expect(card.findAll("[data-kind='fields'] dt").map((dt) => dt.text())).toContain("tag, tags, role");
    expect(card.text()).toContain("is:online is:offline is:degraded is:disabled is:never is:reporting");

    await card.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    expect(document.activeElement).toBe(button.element);

    await button.trigger("click");
    await nextTick();
    await wrapper.get(".pc-query-example").trigger("click");
    await nextTick();
    await nextTick();
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("tag:edge is:offline");
    expect(shownIds(wrapper)).toEqual(["n-dmit"]);
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("closes the help card when the frame loses focus to the console around it", async () => {
    const wrapper = mountPage();
    await wrapper.get("button[aria-label='Query syntax']").trigger("click");
    await nextTick();
    window.dispatchEvent(new Event("blur"));
    await nextTick();
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("closes the help card on a press outside it", async () => {
    const wrapper = mountPage();
    await wrapper.get("button[aria-label='Query syntax']").trigger("click");
    await nextTick();
    expect(wrapper.find("[role='dialog']").exists()).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("Escape on the help button closes the card it opened", async () => {
    const wrapper = mountPage();
    const button = wrapper.get("button[aria-label='Query syntax']");
    await button.trigger("click");
    await nextTick();
    (button.element as HTMLElement).focus();
    await button.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the status live region in the tree and changes only its text", async () => {
    const wrapper = mountPage("tag:edge");
    const status = wrapper.get(".pc-query-status");
    expect(status.attributes("aria-live")).toBe("polite");
    expect(status.text()).toBe("");
    await type(wrapper, "tag:edge stauts:x");
    await wrapper.get("input").trigger("keydown", { key: "Enter" });
    expect(wrapper.get(".pc-query-status").element).toBe(status.element);
    expect(status.text()).toContain("There is no field called stauts");
    expect(wrapper.get(".pc-sr-only").text()).toBe("");
    wrapper.unmount();
  });
});

describe("chassis.css", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chassis.css"), "utf8");
  it("styles every part the bar renders", () => {
    for (const part of ["pc-query", "pc-query-input", "pc-query-menu", "pc-query-option", "pc-query-help", "pc-query-error", "pc-query-snippet", "pc-query-count"]) {
      expect(css, part).toContain(`.${part} `);
    }
  });
});
