// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { describe, expect, it } from "vitest";

import { PcLensTab, PcLensTabs } from "./toolbar";

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

  it("keeps every tab in the one tablist so ArrowLeft and ArrowRight still reach the wrapped row", async () => {
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
