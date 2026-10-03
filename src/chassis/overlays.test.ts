// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PcBatchBar, PcConfirmDialog, PcModal, PcSidePanel } from "./overlays";
import { closeTopOverlay, overlayDepth, resetOverlayStack, useOverlayEscape } from "./overlayStack";
import { PcNotice, PcPageHeader, PcProofLine, PcStatCard, PcStatStrip } from "./page";
import { PcEmptyState, PcSkeleton } from "./states";
import { useDocumentQueryState } from "./queryState";

beforeEach(() => resetOverlayStack());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("overlay stack", () => {
  it("a modal over a side panel: one Escape closes one thing, top first", async () => {
    const panel = ref(true);
    const modal = ref(false);
    const Screen = defineComponent({
      setup() {
        useOverlayEscape();
        return () => [
          h(PcSidePanel, { open: panel.value, title: "Preview", onClose: () => (panel.value = false) }, () => h("p", "output")),
          h(PcModal, { open: modal.value, title: "Confirm rollout", size: "small", onClose: () => (modal.value = false) }, () => h("p", "question")),
        ];
      },
    });
    const wrapper = mount(Screen, { attachTo: document.body });
    expect(overlayDepth()).toBe(1);
    modal.value = true;
    await nextTick();
    expect(overlayDepth()).toBe(2);
    expect(document.activeElement?.classList.contains("pc-modal")).toBe(true);
    expect(wrapper.find(".pc-modal").attributes("data-size")).toBe("small");
    expect(wrapper.find(".pc-modal").attributes("aria-modal")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(modal.value).toBe(false);
    expect(panel.value).toBe(true);
    expect(overlayDepth()).toBe(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(panel.value).toBe(false);
    expect(overlayDepth()).toBe(0);
    expect(closeTopOverlay()).toBe(false);
    wrapper.unmount();
  });

  it("the scrim closes on a click on itself, not on a click inside the dialog", async () => {
    const open = ref(true);
    const wrapper = mount(PcModal, { props: { open: true, title: "Plan", onClose: () => (open.value = false) }, slots: { default: () => h("p", "body") } });
    await wrapper.find(".pc-modal-body").trigger("click");
    expect(open.value).toBe(true);
    await wrapper.find(".pc-overlay").trigger("click");
    expect(open.value).toBe(false);
  });

  it("returns focus to the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const wrapper = mount(PcModal, { props: { open: true, title: "Plan", returnFocusTo: opener }, attachTo: document.body });
    await nextTick();
    expect(document.activeElement).not.toBe(opener);
    await wrapper.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
  });

  it.each([
    ["PcModal", PcModal],
    ["PcSidePanel", PcSidePanel],
    ["PcConfirmDialog", PcConfirmDialog],
  ])("%s returns focus to the element that opened it when returnFocusTo is not given", async (_, Component) => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const wrapper = mount(Component, { props: { open: false, title: "Plan" }, attachTo: document.body });
    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
    opener.remove();
  });

  it("a dialog rendered open from the start still returns focus to what held it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const wrapper = mount(PcModal, { props: { open: true, title: "Plan" }, attachTo: document.body });
    await nextTick();
    expect(document.activeElement?.classList.contains("pc-modal")).toBe(true);
    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
    opener.remove();
  });

  it("a confirm dialog emits confirm and cancel from its footer", async () => {
    const events: string[] = [];
    const wrapper = mount(PcConfirmDialog, {
      props: { open: true, title: "Delete 3 records?", message: "This cannot be undone.", destructive: true, confirmLabel: "Delete", onConfirm: () => events.push("confirm"), onCancel: () => events.push("cancel") },
    });
    const buttons = wrapper.findAll("footer .pc-button");
    expect(buttons.map((button) => button.text())).toEqual(["Cancel", "Delete"]);
    expect(buttons[1]!.attributes("data-variant")).toBe("danger");
    await buttons[1]!.trigger("click");
    await buttons[0]!.trigger("click");
    expect(events).toEqual(["confirm", "cancel"]);
  });

  it("the batch bar names its count, clears on Escape, and is absent at zero", async () => {
    const cleared = ref(0);
    const wrapper = mount(PcBatchBar, { props: { count: 3, onClear: () => cleared.value++ } });
    expect(wrapper.find(".pc-batch-bar-count").text()).toBe("3 selected");
    await wrapper.find(".pc-batch-bar").trigger("keydown", { key: "Escape" });
    expect(cleared.value).toBe(1);
    await wrapper.setProps({ count: 0 });
    expect(wrapper.find(".pc-batch-bar").exists()).toBe(false);
  });
});

/** A frame of `width` px as matchMedia answers min-width queries, resizable. */
function stubFrameWidth(width: number) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  let current = width;
  const answer = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return min ? current >= Number(min[1]) : false;
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return answer(query);
    },
    media: query,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  }));
  return {
    resize(next: number) {
      current = next;
      for (const listener of listeners) listener({ matches: answer("(min-width: 768px)") });
    },
  };
}

describe("side panel beside the collection", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A row that opens the panel, a second row, and the panel, as a plugin page builds them. */
  const Page = defineComponent({
    setup() {
      useOverlayEscape();
      const open = ref("");
      return () => [
        h("button", { id: "row-a", onClick: () => (open.value = "a") }, "Row A"),
        h("button", { id: "row-b", onClick: () => (open.value = "b") }, "Row B"),
        h(PcSidePanel, { open: open.value !== "", title: `Record ${open.value}`, onClose: () => (open.value = "") }, () => [
          h("p", `record ${open.value}`),
          h("button", { id: "edit" }, "Edit"),
        ]),
      ];
    },
  });

  it("from 768px is a labelled complementary landmark with no scrim and no aria-modal", async () => {
    stubFrameWidth(1440);
    const wrapper = mount(Page, { attachTo: document.body });
    await nextTick();
    const opener = wrapper.find("#row-a");
    (opener.element as HTMLElement).focus();
    await opener.trigger("click");
    await nextTick();
    const panel = wrapper.find(".pc-side-panel");
    expect(panel.attributes("role")).toBe("complementary");
    expect(panel.attributes("aria-modal")).toBeUndefined();
    expect(document.getElementById(panel.attributes("aria-labelledby")!)?.textContent).toBe("Record a");
    expect(wrapper.find(".pc-overlay").attributes("data-modal")).toBe("false");
    // Opening still moves focus to the panel, so a keyboard user lands in it.
    expect(document.activeElement).toBe(panel.element);
    wrapper.unmount();
  });

  it("from 768px lets Tab leave the panel and keeps the rows live", async () => {
    stubFrameWidth(1024);
    const wrapper = mount(Page, { attachTo: document.body });
    await nextTick();
    await wrapper.find("#row-a").trigger("click");
    await nextTick();
    const edit = wrapper.find("#edit");
    (edit.element as HTMLElement).focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    edit.element.dispatchEvent(tab);
    // Not wrapped back to the close button: the browser moves on to the page.
    expect(tab.defaultPrevented).toBe(false);
    // A click on the wrapper is not a scrim click; another row swaps the record.
    await wrapper.find(".pc-overlay").trigger("click");
    expect(wrapper.find(".pc-side-panel").exists()).toBe(true);
    await wrapper.find("#row-b").trigger("click");
    await nextTick();
    expect(wrapper.find(".pc-side-panel h2").text()).toBe("Record b");
    wrapper.unmount();
  });

  it("from 768px Escape closes it and returns focus to the opener when focus was in the panel", async () => {
    stubFrameWidth(1440);
    const wrapper = mount(Page, { attachTo: document.body });
    await nextTick();
    const opener = wrapper.find("#row-a").element as HTMLElement;
    opener.focus();
    await wrapper.find("#row-a").trigger("click");
    await nextTick();
    (wrapper.find("#edit").element as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(wrapper.find(".pc-side-panel").exists()).toBe(false);
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
  });

  it("from 768px leaves focus where the operator put it when they close the panel from the page", async () => {
    stubFrameWidth(1440);
    const wrapper = mount(Page, { attachTo: document.body });
    await nextTick();
    const opener = wrapper.find("#row-a").element as HTMLElement;
    opener.focus();
    await wrapper.find("#row-a").trigger("click");
    await nextTick();
    const elsewhere = wrapper.find("#row-b").element as HTMLElement;
    elsewhere.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(wrapper.find(".pc-side-panel").exists()).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
    wrapper.unmount();
  });

  it("from 768px Escape typed in a page field or an open menu stays there, and one a control used is left alone", async () => {
    stubFrameWidth(1440);
    const Rows = defineComponent({
      setup() {
        useOverlayEscape();
        const open = ref("a");
        return () => [
          h("input", { id: "search", type: "search" }),
          h("input", { id: "pick", type: "checkbox" }),
          h("div", { role: "menu" }, [h("button", { id: "item", role: "menuitem" }, "Rename")]),
          h("button", {
            id: "menu",
            onKeydown: (event: KeyboardEvent) => {
              if (event.key === "Escape") event.preventDefault();
            },
          }, "Menu"),
          h(PcSidePanel, { open: open.value !== "", title: "Record a", onClose: () => (open.value = "") }, () => h("input", { id: "field" })),
        ];
      },
    });
    const wrapper = mount(Rows, { attachTo: document.body });
    await nextTick();
    const press = async (selector: string) => {
      const target = wrapper.find(selector).element as HTMLElement;
      target.focus();
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await nextTick();
    };
    await press("#search");
    expect(wrapper.find(".pc-side-panel").exists()).toBe(true);
    await press("#menu");
    expect(wrapper.find(".pc-side-panel").exists()).toBe(true);
    await press("#item");
    expect(wrapper.find(".pc-side-panel").exists()).toBe(true);
    // A checkbox is not a text field: Escape there still steps back.
    await press("#pick");
    expect(wrapper.find(".pc-side-panel").exists()).toBe(false);
    wrapper.unmount();
  });

  it("from 768px Escape in a field inside the panel still closes it", async () => {
    stubFrameWidth(1440);
    const open = ref(true);
    const wrapper = mount(defineComponent({
      setup() {
        useOverlayEscape();
        return () => h(PcSidePanel, { open: open.value, title: "Record a", onClose: () => (open.value = false) }, () => h("input", { id: "field" }));
      },
    }), { attachTo: document.body });
    await nextTick();
    const field = wrapper.find("#field").element as HTMLElement;
    field.focus();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(open.value).toBe(false);
    wrapper.unmount();
  });

  it("below 768px the modal sheet takes Escape even from a page field", async () => {
    stubFrameWidth(375);
    const open = ref(true);
    const wrapper = mount(defineComponent({
      setup() {
        useOverlayEscape();
        return () => [
          h("input", { id: "search", type: "search" }),
          h(PcSidePanel, { open: open.value, title: "Record a", onClose: () => (open.value = false) }, () => h("p", "record")),
        ];
      },
    }), { attachTo: document.body });
    await nextTick();
    const search = wrapper.find("#search").element as HTMLElement;
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(open.value).toBe(false);
    wrapper.unmount();
  });

  it("a panel rendered open from the address is beside the rows in its first render", () => {
    stubFrameWidth(1440);
    const wrapper = mount(PcSidePanel, { props: { open: true, title: "Record a" }, attachTo: document.body });
    // No nextTick: this is the first render, before any post-mount update.
    expect(wrapper.find(".pc-side-panel").attributes("role")).toBe("complementary");
    expect(wrapper.find(".pc-overlay").attributes("data-modal")).toBe("false");
    wrapper.unmount();
  });

  it("below 768px stays a modal dialog with a scrim and keeps Tab inside", async () => {
    stubFrameWidth(375);
    const wrapper = mount(Page, { attachTo: document.body });
    await nextTick();
    await wrapper.find("#row-a").trigger("click");
    await nextTick();
    const panel = wrapper.find(".pc-side-panel");
    expect(panel.attributes("role")).toBe("dialog");
    expect(panel.attributes("aria-modal")).toBe("true");
    expect(wrapper.find(".pc-overlay").attributes("data-modal")).toBeUndefined();
    const edit = wrapper.find("#edit");
    (edit.element as HTMLElement).focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    edit.element.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await wrapper.find(".pc-overlay").trigger("click");
    expect(wrapper.find(".pc-side-panel").exists()).toBe(false);
    wrapper.unmount();
  });

  it("follows the frame across 768px while open", async () => {
    const frame = stubFrameWidth(1440);
    const wrapper = mount(Page, { attachTo: document.body });
    await nextTick();
    await wrapper.find("#row-a").trigger("click");
    await nextTick();
    expect(wrapper.find(".pc-side-panel").attributes("role")).toBe("complementary");
    frame.resize(700);
    await nextTick();
    expect(wrapper.find(".pc-side-panel").attributes("role")).toBe("dialog");
    expect(wrapper.find(".pc-side-panel").attributes("aria-modal")).toBe("true");
    wrapper.unmount();
  });

  it("the sheet drops the scrim and passes pointer events through the wrapper, not the panel", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chassis.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule('.pc-overlay[data-modal="false"]')).toMatch(/background:\s*transparent/);
    expect(rule('.pc-overlay[data-modal="false"]')).toMatch(/pointer-events:\s*none/);
    expect(rule('.pc-overlay[data-modal="false"] > .pc-side-panel')).toMatch(/pointer-events:\s*auto/);
    // After the panel rule that paints the scrim, so it wins at equal specificity.
    expect(css.indexOf('.pc-overlay[data-modal="false"]')).toBeGreaterThan(css.indexOf('.pc-overlay[data-kind="panel"]'));
  });
});

describe("page parts", () => {
  it("the header prints the icon mark, title, badge, description and the right slot", () => {
    const wrapper = mount(PcPageHeader, {
      props: { title: "Lines", badge: "VPN Core plugin", description: "Managed and discovered proxy endpoints across the fleet." },
      slots: { actions: () => h("button", "Refresh") },
    });
    expect(wrapper.find("h1").text()).toBe("Lines");
    expect(wrapper.find(".pc-plugin-badge").text()).toBe("VPN Core plugin");
    expect(wrapper.find(".pc-title-copy p").text()).toContain("Managed and discovered");
    expect(wrapper.find(".pc-header-actions button").text()).toBe("Refresh");
    expect(wrapper.find(".pc-title-mark").exists()).toBe(true);
    expect(wrapper.attributes("data-proof")).toBeUndefined();
  });

  it("the proof slot renders the proof line inside the header, above its hairline", () => {
    const wrapper = mount(PcPageHeader, {
      props: { title: "Lines" },
      slots: { proof: () => h(PcProofLine, { segments: ["observed at 23:21:14", "25 nodes report"], refreshing: true }) },
    });
    expect(wrapper.attributes("data-proof")).toBe("true");
    const proof = wrapper.find("header.pc-page-header > .pc-page-proof > .pc-proof-line");
    expect(proof.exists()).toBe(true);
    expect(proof.findAll("span").map((span) => span.text())).toEqual(["observed at 23:21:14", "· 25 nodes report", "· refreshing"]);
    expect(wrapper.element.lastElementChild?.classList.contains("pc-page-proof")).toBe(true);
  });

  it("a danger notice is an alert; the others are polite status", () => {
    expect(mount(PcNotice, { props: { tone: "danger", title: "Lines did not fully load" } }).attributes("role")).toBe("alert");
    const info = mount(PcNotice, { props: { tone: "info" } });
    expect(info.attributes("role")).toBe("status");
    expect(info.attributes("aria-live")).toBe("polite");
  });

  it("the stat strip carries its tile count and a tile's tone colours the value only", () => {
    const wrapper = mount(PcStatStrip, { props: { count: 5, label: "Line summary" }, slots: { default: () => [h(PcStatCard, { label: "Lines", value: 138, note: "none reporting a config error" }), h(PcStatCard, { label: "Lattice-managed", value: 0, tone: "warning" })] } });
    expect((wrapper.element as HTMLElement).style.getPropertyValue("--stat-count")).toBe("5");
    const tiles = wrapper.findAll(".pc-stat");
    expect(tiles[1]!.attributes("data-tone")).toBe("warning");
    expect(tiles[0]!.attributes("data-tone")).toBeUndefined();
    expect(tiles[0]!.find(".pc-stat-note").text()).toBe("none reporting a config error");
  });

  it("the skeleton reserves eight rows and the empty state names its kind", () => {
    expect(mount(PcSkeleton).findAll(".pc-skeleton-rows > div")).toHaveLength(8);
    expect(mount(PcSkeleton, { props: { variant: "strip", count: 5 } }).findAll(".pc-skeleton-strip > div")).toHaveLength(5);
    const empty = mount(PcEmptyState, { props: { title: "No line matches that search", kind: "no-match" } });
    expect(empty.attributes("role")).toBe("status");
    expect(mount(PcEmptyState, { props: { title: "Nothing could be loaded", kind: "error" } }).attributes("role")).toBe("alert");
  });
});

describe("document query state", () => {
  it("reads and writes ?expand= without touching the handshake fragment", () => {
    const win = {
      location: { search: "?lens=fleet&expand=node_a", hash: "#lattice_nonce=abc&host_origin=https%3A%2F%2Fdash.example", pathname: "/plugin" },
      history: { replaceState: (_: unknown, __: string, url?: string) => { const parsed = new URL(url!, "https://frame.example"); win.location.search = parsed.search; win.location.hash = parsed.hash; } },
    };
    const query = useDocumentQueryState(win);
    expect(query.read("expand")).toEqual(["node_a"]);
    query.write("expand", ["node_a", "node_b"]);
    expect(win.location.search).toBe("?lens=fleet&expand=node_a&expand=node_b");
    expect(win.location.hash).toBe("#lattice_nonce=abc&host_origin=https%3A%2F%2Fdash.example");
    query.write("expand", []);
    expect(win.location.search).toBe("?lens=fleet");
  });
});
