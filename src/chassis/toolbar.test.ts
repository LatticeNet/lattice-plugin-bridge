// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";

import { PcLensTab, PcLensTabs, revealSelectedTab } from "./toolbar";

/** The four-tab strip NetGuard renders, the widest one in the fleet. */
const NetGuardLens = defineComponent({
  setup() {
    const lens = ref("exposure");
    return () =>
      h(PcLensTabs, { modelValue: lens.value, label: "NetGuard lens", "onUpdate:modelValue": (value: string) => (lens.value = value) }, () => [
        h(PcLensTab, { value: "exposure", label: "Exposure" }),
        h(PcLensTab, { value: "attention", label: "Attention", count: 3, countTone: "error" }),
        h(PcLensTab, { value: "groups", label: "Groups", count: 4 }),
        h(PcLensTab, { value: "zones", label: "Zones", count: 5 }),
      ]);
  },
});

describe("the lens strip in a narrow frame", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chassis.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** The declarations of `selector` inside the `@media (max-width: 620px)` block. */
  function narrowRule(selector: string): string {
    const start = css.indexOf("@media (max-width: 620px)");
    expect(start, "the 620px block").toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}", start));
    const match = block.match(new RegExp(`\\n\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(match, `a narrow rule for ${selector}`).toBeTruthy();
    return match![1];
  }

  function baseRule(selector: string): string {
    const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(match, `a rule for ${selector}`).toBeTruthy();
    return match![1];
  }

  it("wraps the tabs to a second row below 620px instead of clipping the last one behind a scroll", () => {
    // At 375 the strip is 341px wide and NetGuard's four tabs need 378px. A
    // scroll container with no affordance hid "Zones 5" off the right edge.
    expect(narrowRule(".pc-lens-tabs")).toMatch(/flex-wrap:\s*wrap/);
    expect(narrowRule(".pc-lens-tabs")).not.toMatch(/overflow-x/);
    expect(baseRule(".pc-lens-tabs")).not.toMatch(/overflow/);
    // A tab keeps its label on one line and fills the row it lands on.
    expect(baseRule(".pc-lens-tab")).toMatch(/white-space:\s*nowrap/);
    expect(narrowRule(".pc-lens-tab")).toMatch(/flex:\s*1 1 auto/);
  });

  it("keeps all four tabs in the one tablist, so the arrow keys walk the strip whichever row a tab lands on", async () => {
    // jsdom computes no layout: this proves the tablist model over four tabs,
    // not the wrap itself. The wrapped row is measured in dev/harness-375.html.
    const wrapper = mount(NetGuardLens, { attachTo: document.body });
    try {
      const list = wrapper.find("[role='tablist']");
      const tabs = wrapper.findAll("[role='tab']");
      expect(tabs).toHaveLength(4);
      expect(tabs.every((tab) => tab.element.parentElement === list.element)).toBe(true);
      expect(tabs.map((tab) => tab.text())).toEqual(["Exposure", "Attention3", "Groups4", "Zones5"]);

      // ArrowLeft from the first tab lands on the last one, the tab that was clipped.
      (tabs[0]!.element as HTMLElement).focus();
      await tabs[0]!.trigger("keydown", { key: "ArrowLeft" });
      expect(tabs[3]!.attributes("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tabs[3]!.element);
      expect(tabs.map((tab) => tab.attributes("tabindex"))).toEqual(["-1", "-1", "-1", "0"]);

      await tabs[3]!.trigger("keydown", { key: "ArrowRight" });
      expect(tabs[0]!.attributes("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tabs[0]!.element);
    } finally {
      wrapper.unmount();
    }
  });
});

describe("the layer row (variant layer)", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chassis.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const escape = (selector: string) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function ruleIn(block: string, selector: string): string {
    const match = block.match(new RegExp(`(?:^|\\n)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`));
    expect(match, `a rule for ${selector}`).toBeTruthy();
    return match![1];
  }
  function mediaBlock(query: string): string {
    const start = css.indexOf(`@media ${query}`);
    expect(start, query).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("\n}", start));
  }

  const Icon = defineComponent({ setup: () => () => h("svg", { class: "probe-icon" }) });

  /** Sub-Store's five layers, with counts that arrive after the address chose a layer. */
  const Layers = defineComponent({
    props: { counts: { type: Array as () => (number | null)[], default: () => [null, null, null, null, null] } },
    setup(props, { expose }) {
      const view = ref("overview");
      expose({ view });
      const ids = ["overview", "subscriptions", "combinations", "files", "shares"];
      return () =>
        h(PcLensTabs, { modelValue: view.value, label: "Sub-Store layers", variant: "layer", "onUpdate:modelValue": (value: string) => (view.value = value) }, () =>
          ids.map((id, i) => h(PcLensTab, { key: id, value: id, label: id[0]!.toUpperCase() + id.slice(1), count: props.counts[i] ?? null, icon: Icon })),
        );
    },
  });

  /** Lay the row out as a 341px window onto five 120px tabs, scrolled by scrollLeft as a browser clamps it. */
  function layOut(row: HTMLElement): void {
    let scrolled = 0;
    Object.defineProperty(row, "scrollLeft", { get: () => scrolled, set: (value: number) => (scrolled = Math.max(0, Math.min(value, 600 - 341))) });
    Object.defineProperty(row, "getBoundingClientRect", { value: () => ({ left: 0, right: 341 }) });
    const tabs = Array.from(row.querySelectorAll<HTMLElement>("[role='tab']"));
    tabs.forEach((tab, i) => {
      Object.defineProperty(tab, "getBoundingClientRect", { value: () => ({ left: i * 120 - row.scrollLeft, right: (i + 1) * 120 - row.scrollLeft }) });
    });
  }

  it("marks the row, keeps the tablist model, and draws no icons", () => {
    const wrapper = mount(Layers);
    const row = wrapper.find("[role='tablist']");
    expect(row.attributes("data-variant")).toBe("layer");
    expect(wrapper.findAll("[role='tab']")).toHaveLength(5);
    expect(wrapper.find(".probe-icon").exists()).toBe(false);
    // The default variant still draws the icon it is given.
    const lens = mount(PcLensTabs, { props: { modelValue: "a", label: "Lens" }, slots: { default: () => h(PcLensTab, { value: "a", label: "A", icon: Icon }) } });
    expect(lens.find(".probe-icon").exists()).toBe(true);
    expect(lens.find("[role='tablist']").attributes("data-variant")).toBeUndefined();
  });

  it("Home and End go to the first and last layer", async () => {
    const wrapper = mount(Layers, { attachTo: document.body });
    try {
      const tabs = wrapper.findAll("[role='tab']");
      (tabs[1]!.element as HTMLElement).focus();
      await tabs[1]!.trigger("keydown", { key: "End" });
      expect(tabs[4]!.attributes("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tabs[4]!.element);
      await tabs[4]!.trigger("keydown", { key: "Home" });
      expect(tabs[0]!.attributes("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tabs[0]!.element);
    } finally {
      wrapper.unmount();
    }
  });

  it("scrolls the selected layer into the row when the selection changes, and only the row", async () => {
    const wrapper = mount(Layers, { attachTo: document.body });
    try {
      const row = wrapper.find("[role='tablist']").element as HTMLElement;
      layOut(row);
      await wrapper.findAll("[role='tab']")[4]!.trigger("click");
      await nextTick();
      // Shares spans 480 to 600 and the row shows 341px of it, so the row scrolls to its end.
      expect(row.scrollLeft).toBe(259);
      await wrapper.findAll("[role='tab']")[0]!.trigger("click");
      await nextTick();
      expect(row.scrollLeft).toBe(0);
    } finally {
      wrapper.unmount();
    }
  });

  it("reveals once more when a count arrives, and not when a count only changes", async () => {
    const wrapper = mount(Layers, { attachTo: document.body, props: { counts: [null, null, null, null, null] } });
    try {
      const row = wrapper.find("[role='tablist']").element as HTMLElement;
      layOut(row);
      (wrapper.vm as unknown as { view: string }).view = "files";
      await nextTick();
      expect(row.scrollLeft).toBe(143);
      // The operator swipes back to the start.
      row.scrollLeft = 0;
      await wrapper.setProps({ counts: [null, 12, 3, 140, 2] });
      await nextTick();
      await nextTick();
      expect(row.scrollLeft).toBe(143);
      row.scrollLeft = 0;
      await wrapper.setProps({ counts: [null, 13, 3, 141, 2] });
      await nextTick();
      await nextTick();
      expect(row.scrollLeft).toBe(0);
    } finally {
      wrapper.unmount();
    }
  });

  it("the lens variant never scrolls itself", async () => {
    const wrapper = mount(NetGuardLens, { attachTo: document.body });
    try {
      const row = wrapper.find("[role='tablist']").element as HTMLElement;
      layOut(row);
      await wrapper.findAll("[role='tab']")[3]!.trigger("click");
      await nextTick();
      expect(row.scrollLeft).toBe(0);
    } finally {
      wrapper.unmount();
    }
  });

  it("is an underline row from 620px and a one-line segmented control that scrolls below, 44px on touch", () => {
    const wide = ruleIn(css, '.pc-lens-tabs[data-variant="layer"]');
    expect(wide).toMatch(/overflow-x:\s*auto/);
    expect(wide).toMatch(/flex-wrap:\s*nowrap/);
    expect(wide).toMatch(/box-shadow:\s*inset 0 -1px 0 var\(--border\)/);
    expect(ruleIn(css, '.pc-lens-tabs[data-variant="layer"] > .pc-lens-tab[aria-selected="true"]')).toMatch(/box-shadow:\s*inset 0 -2px 0 var\(--primary\)/);
    // Above `.pc-workspace button { font: inherit }` in specificity, so the tabs keep 13px semibold.
    expect(ruleIn(css, '.pc-lens-tabs[data-variant="layer"] > .pc-lens-tab')).toMatch(/font-size:\s*var\(--pc-text-sm\);\s*font-weight:\s*600/);
    const narrow = mediaBlock("(max-width: 620px)");
    expect(ruleIn(narrow, '.pc-lens-tabs[data-variant="layer"]')).toMatch(/flex-wrap:\s*nowrap/);
    expect(ruleIn(narrow, '.pc-lens-tabs[data-variant="layer"]')).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(ruleIn(narrow, '.pc-lens-tabs[data-variant="layer"] > .pc-lens-tab[aria-selected="true"]')).toMatch(/background:\s*var\(--muted\)/);
    expect(ruleIn(mediaBlock("(pointer: coarse)"), '.pc-lens-tabs[data-variant="layer"] > .pc-lens-tab')).toMatch(/min-height:\s*44px/);
  });
});

describe("revealSelectedTab", () => {
  const row = (scrollLeft: number, tab: { left: number; right: number } | null) => ({
    scrollLeft,
    getBoundingClientRect: () => ({ left: 100, right: 400 }),
    querySelector: () => (tab ? { getBoundingClientRect: () => tab } : null),
  });

  it("moves the row by what the tab overhangs, plus 4px", () => {
    const right = row(0, { left: 380, right: 450 });
    revealSelectedTab(right);
    expect(right.scrollLeft).toBe(54);
    const left = row(200, { left: 60, right: 130 });
    revealSelectedTab(left);
    expect(left.scrollLeft).toBe(156);
  });

  it("leaves a row alone when the tab is inside it or there is no selected tab", () => {
    const inside = row(30, { left: 150, right: 250 });
    revealSelectedTab(inside);
    expect(inside.scrollLeft).toBe(30);
    const none = row(30, null);
    revealSelectedTab(none);
    expect(none.scrollLeft).toBe(30);
    revealSelectedTab(null);
  });
});
