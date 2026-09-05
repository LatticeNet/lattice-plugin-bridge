import { h, type VNode } from "vue";

/**
 * The handful of glyphs the chassis draws itself: the chevron on a toggle,
 * the close mark, the spinner, the sort mark. Page and row icons come from the
 * consumer through slots or `icon` props, so the chassis does not depend on an
 * icon package. Paths are Lucide's, at its 24-unit grid and 2-unit stroke.
 */
function glyph(size: number, paths: VNode[], extra: Record<string, unknown> = {}): VNode {
  return h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
      ...extra,
    },
    paths,
  );
}

export function iconChevronRight(size = 14, extra: Record<string, unknown> = {}): VNode {
  return glyph(size, [h("path", { d: "m9 18 6-6-6-6" })], extra);
}

export function iconX(size = 15): VNode {
  return glyph(size, [h("path", { d: "M18 6 6 18" }), h("path", { d: "m6 6 12 12" })]);
}

export function iconLoader(size = 15): VNode {
  return glyph(size, [h("path", { d: "M21 12a9 9 0 1 1-6.219-8.56" })], { class: "pc-spin" });
}

export function iconAlert(size = 17): VNode {
  return glyph(size, [
    h("circle", { cx: 12, cy: 12, r: 10 }),
    h("line", { x1: 12, x2: 12, y1: 8, y2: 12 }),
    h("line", { x1: 12, x2: 12.01, y1: 16, y2: 16 }),
  ]);
}

export function iconInfo(size = 17): VNode {
  return glyph(size, [
    h("circle", { cx: 12, cy: 12, r: 10 }),
    h("path", { d: "M12 16v-4" }),
    h("path", { d: "M12 8h.01" }),
  ]);
}

export function iconCheck(size = 17): VNode {
  return glyph(size, [
    h("path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }),
    h("path", { d: "m9 12 2 2 4-4" }),
  ]);
}

export function iconInbox(size = 26): VNode {
  return glyph(size, [
    h("polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }),
    h("path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }),
  ]);
}
