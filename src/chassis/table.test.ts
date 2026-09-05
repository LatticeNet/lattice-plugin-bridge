// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PcActionsCell, PcGroupRow, PcNameCell, PcRow, PcRowToggle, PcTable, PcTd, PcTh } from "./table";
import { PcLensTab, PcLensTabs } from "./toolbar";
import { useMediaQuery } from "./queryState";
import { useExpandSet } from "./expandSet";

/** A three-group fleet table wired to useExpandSet, the way a consumer builds it. */
const Fleet = defineComponent({
  props: { stacked: { type: Boolean, default: undefined } },
  setup(props) {
    const groups = useExpandSet();
    const nodes = [
      { id: "node_a", name: "Aaitr-ATT-VDS", lines: ["vless-exit-1"] },
      { id: "node_b", name: "DMIT-eb-wee", lines: ["vless-relay-1", "vless-exit-2"] },
      { id: "node_c", name: "LegendVPS-SG-EVO", lines: ["ss-exit-1"] },
    ];
    return () =>
      h(
        PcTable,
        { stacked: props.stacked, label: "Fleet" },
        {
          head: () => [h(PcTh, { name: true }, () => "Node / line"), h(PcTh, () => "Role"), h(PcTh, { actions: true }, () => "Actions")],
          default: () =>
            nodes.map((node) =>
              h("tbody", { key: node.id, "data-open": groups.isOpen(node.id) ? "true" : "false" }, [
                h(PcGroupRow, { expanded: groups.isOpen(node.id) }, () => [
                  h(PcNameCell, { name: node.name, id: node.id, expanded: groups.isOpen(node.id), controls: `${node.id}-first`, onToggle: () => groups.toggle(node.id) }),
                  h(PcTd, { colspan: 1, stack: "summary" }, () => `${node.lines.length} lines`),
                  h(PcActionsCell, () => "Evidence"),
                ]),
                ...(groups.isOpen(node.id)
                  ? node.lines.map((line, index) =>
                      h(PcRow, { key: line, id: index === 0 ? `${node.id}-first` : undefined }, () => [
                        h(PcNameCell, { name: line, id: `${line}-hash`, level: 1 }),
                        h(PcTd, { label: "Role" }, () => "exit"),
                        h(PcActionsCell, () => "Details"),
                      ]),
                    )
                  : []),
              ]),
            ),
        },
      );
  },
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("group rows: expand and collapse", () => {
  it("prints children only while the group is open, and one toggle never touches another", async () => {
    const wrapper = mount(Fleet, { attachTo: document.body });
    expect(wrapper.findAll(".pc-row")).toHaveLength(0);
    const toggles = wrapper.findAll("[data-pc-toggle]");
    expect(toggles).toHaveLength(3);
    expect(toggles[0]!.attributes("aria-expanded")).toBe("false");
    expect(toggles[0]!.attributes("aria-controls")).toBe("node_a-first");
    expect(toggles[0]!.element.tagName).toBe("BUTTON");
    expect(toggles[0]!.attributes("type")).toBe("button");

    await toggles[1]!.trigger("click");
    expect(wrapper.findAll(".pc-row")).toHaveLength(2);
    expect(wrapper.find("#node_b-first").exists()).toBe(true);
    expect(wrapper.findAll("[data-pc-toggle]")[1]!.attributes("aria-expanded")).toBe("true");
    expect(wrapper.findAll("[data-pc-toggle]")[0]!.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findAll(".pc-group-row")[1]!.attributes("data-open")).toBe("true");

    await wrapper.findAll("[data-pc-toggle]")[1]!.trigger("click");
    expect(wrapper.findAll(".pc-row")).toHaveLength(0);
    wrapper.unmount();
  });

  it("indents child name cells by level and keeps the muted mono id under the name", () => {
    const wrapper = mount(Fleet);
    wrapper.findAll("[data-pc-toggle]")[0]!.trigger("click");
    return nextTick().then(() => {
      const child = wrapper.find(".pc-row .pc-name");
      expect(child.attributes("data-level")).toBe("1");
      expect(child.find("strong").text()).toBe("vless-exit-1");
      expect(child.find("small").text()).toBe("vless-exit-1-hash");
      expect(child.find("small").attributes("title")).toBe("vless-exit-1-hash");
      expect(wrapper.find(".pc-group-row .pc-name").attributes("data-level")).toBeUndefined();
    });
  });
});

describe("keyboard", () => {
  it("ArrowRight opens and ArrowLeft closes the focused toggle; the other direction is inert", async () => {
    const expanded = ref(false);
    const wrapper = mount(PcRowToggle, { props: { expanded: false, name: "DMIT-1", onToggle: () => (expanded.value = !expanded.value) } });
    await wrapper.trigger("keydown", { key: "ArrowLeft" });
    expect(expanded.value).toBe(false);
    await wrapper.trigger("keydown", { key: "ArrowRight" });
    expect(expanded.value).toBe(true);
    await wrapper.setProps({ expanded: true });
    await wrapper.trigger("keydown", { key: "ArrowRight" });
    expect(expanded.value).toBe(true);
    await wrapper.trigger("keydown", { key: "ArrowLeft" });
    expect(expanded.value).toBe(false);
  });

  it("ArrowDown and ArrowUp move focus between toggles without wrapping or toggling", async () => {
    const wrapper = mount(Fleet, { attachTo: document.body });
    const toggles = wrapper.findAll("[data-pc-toggle]");
    (toggles[0]!.element as HTMLElement).focus();
    await toggles[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(toggles[1]!.element);
    await toggles[1]!.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(toggles[2]!.element);
    await toggles[2]!.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(toggles[2]!.element);
    await toggles[2]!.trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(toggles[1]!.element);
    expect(wrapper.findAll(".pc-row")).toHaveLength(0);
    wrapper.unmount();
  });

  it("the lens tablist answers ArrowLeft and ArrowRight, wraps, and keeps only the selected tab in the Tab order", async () => {
    const lens = ref("fleet");
    const Tabs = defineComponent({
      setup() {
        return () =>
          h(PcLensTabs, { modelValue: lens.value, label: "Lines lens", "onUpdate:modelValue": (value: string) => (lens.value = value) }, () => [
            h(PcLensTab, { value: "fleet", label: "Fleet" }),
            h(PcLensTab, { value: "topology", label: "Topology" }),
            h(PcLensTab, { value: "attention", label: "Attention", count: 2, countTone: "warning" }),
          ]);
      },
    });
    const wrapper = mount(Tabs, { attachTo: document.body });
    const tabs = wrapper.findAll("[role='tab']");
    expect(tabs.map((tab) => tab.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(tabs[2]!.find(".pc-count").text()).toBe("2");
    expect(tabs[2]!.find(".pc-count").attributes("data-tone")).toBe("warning");
    expect(tabs[0]!.attributes("aria-controls")).toBe("pc-panel-fleet");

    await tabs[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(lens.value).toBe("topology");
    expect(document.activeElement).toBe(tabs[1]!.element);
    await tabs[1]!.trigger("keydown", { key: "ArrowLeft" });
    await tabs[0]!.trigger("keydown", { key: "ArrowLeft" });
    expect(lens.value).toBe("attention");
    await nextTick();
    expect(wrapper.findAll("[role='tab']").map((tab) => tab.attributes("aria-selected"))).toEqual(["false", "false", "true"]);
    wrapper.unmount();
  });
});

describe("stacked form under 480px", () => {
  it("forced stacked: the header is read only, cells carry their line and label, a row without a toggle gets one that folds its detail", async () => {
    const wrapper = mount(Fleet, { props: { stacked: true }, attachTo: document.body });
    const table = wrapper.find("table");
    expect(table.attributes("data-stacked")).toBe("true");
    expect(wrapper.find(".pc-group-row .pc-name").attributes("data-stack")).toBe("name");
    expect(wrapper.find(".pc-group-row td[data-stack='summary']").exists()).toBe(true);
    expect(wrapper.find(".pc-group-row td[data-stack='actions']").exists()).toBe(true);

    await wrapper.findAll("[data-pc-toggle]")[0]!.trigger("click");
    const row = wrapper.find(".pc-row");
    expect(row.attributes("data-open")).toBeUndefined();
    const detail = row.find("td[data-stack='detail']");
    expect(detail.attributes("data-label")).toBe("Role");
    const stackToggle = row.find("[data-pc-toggle]");
    expect(stackToggle.exists()).toBe(true);
    await stackToggle.trigger("click");
    expect(wrapper.find(".pc-row").attributes("data-open")).toBe("true");
    wrapper.unmount();
  });

  it("not stacked: a plain row has no toggle of its own", async () => {
    const wrapper = mount(Fleet, { props: { stacked: false } });
    await wrapper.findAll("[data-pc-toggle]")[0]!.trigger("click");
    expect(wrapper.find("table").attributes("data-stacked")).toBeUndefined();
    expect(wrapper.find(".pc-row [data-pc-toggle]").exists()).toBe(false);
  });

  it("follows the frame width through matchMedia when not forced", async () => {
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    let matches = false;
    const matchMedia = vi.fn((query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    const wrapper = mount(Fleet, { attachTo: document.body });
    await nextTick();
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 480px)");
    expect(wrapper.find("table").attributes("data-stacked")).toBeUndefined();
    matches = true;
    for (const listener of listeners) listener({ matches: true });
    await nextTick();
    expect(wrapper.find("table").attributes("data-stacked")).toBe("true");
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it("useMediaQuery is undefined until the client evaluates it", () => {
    const Probe = defineComponent({
      setup() {
        const narrow = useMediaQuery("(max-width: 480px)", undefined);
        return () => h("i", String(narrow.value));
      },
    });
    expect(mount(Probe).text()).toBe("undefined");
  });
});

describe("scroll wrap: the header pins to the document unless the table is wider than the frame", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chassis.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  function rule(selector: string): string {
    const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(match, `a rule for ${selector}`).toBeTruthy();
    return match![1];
  }

  it("does not make the wrap a scroll container at rest, so a sticky th has the document to pin to", () => {
    // `overflow-x: auto` computes overflow-y to auto as well, which turns the
    // wrap into the nearest scrollport: the header then sticks to a box that
    // never scrolls vertically and rides off with the rows.
    expect(rule(".pc-table-wrap")).toMatch(/overflow-x:\s*clip/);
    expect(rule(".pc-table-wrap")).not.toMatch(/overflow-x:\s*auto/);
    expect(rule('.pc-table-wrap[data-overflow="x"]')).toMatch(/overflow-x:\s*auto/);
  });

  it("marks the wrap as sideways-scrolling only while the table is wider than it", async () => {
    let callback: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    class FakeResizeObserver {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe(target: Element): void { observed.push(target); }
      unobserve(): void {}
      disconnect(): void { observed.length = 0; }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      const wrapper = mount(Fleet, { attachTo: document.body });
      const wrap = wrapper.find(".pc-table-wrap").element as HTMLElement;
      const table = wrapper.find(".pc-table").element as HTMLElement;
      expect(observed).toContain(wrap);
      expect(observed).toContain(table);

      let wrapWidth = 1440;
      let tableWidth = 1000;
      vi.spyOn(wrap, "getBoundingClientRect").mockImplementation(() => ({ width: wrapWidth }) as DOMRect);
      vi.spyOn(table, "getBoundingClientRect").mockImplementation(() => ({ width: tableWidth }) as DOMRect);

      callback!([], {} as ResizeObserver);
      await nextTick();
      expect(wrap.getAttribute("data-overflow")).toBeNull();

      wrapWidth = 375;
      callback!([], {} as ResizeObserver);
      await nextTick();
      expect(wrap.getAttribute("data-overflow")).toBe("x");

      wrapWidth = 1440;
      callback!([], {} as ResizeObserver);
      await nextTick();
      expect(wrap.getAttribute("data-overflow")).toBeNull();

      wrapper.unmount();
      expect(observed).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to a sideways scroller where ResizeObserver is missing, so nothing is clipped", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    try {
      const wrapper = mount(Fleet, { attachTo: document.body });
      await nextTick();
      expect(wrapper.find(".pc-table-wrap").attributes("data-overflow")).toBe("x");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
