// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PcBatchBar, PcConfirmDialog, PcModal, PcSidePanel } from "./overlays";
import { closeTopOverlay, overlayDepth, resetOverlayStack, useOverlayEscape } from "./overlayStack";
import { PcNotice, PcPageHeader, PcStatCard, PcStatStrip } from "./page";
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
