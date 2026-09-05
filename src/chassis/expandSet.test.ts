import { describe, expect, it } from "vitest";

import { useExpandSet } from "./expandSet";

describe("useExpandSet", () => {
  it("starts closed and toggles one key without touching another", () => {
    const set = useExpandSet();
    expect(set.isOpen("a")).toBe(false);
    set.toggle("a");
    set.open("b");
    expect(set.isOpen("a")).toBe(true);
    expect(set.isOpen("b")).toBe(true);
    set.toggle("a");
    expect(set.isOpen("a")).toBe(false);
    expect(set.isOpen("b")).toBe(true);
    set.close("b");
    expect([...set.keys.value]).toEqual([]);
  });

  it("seeds from the document query through replace", () => {
    const set = useExpandSet(["node_1"]);
    expect(set.isOpen("node_1")).toBe(true);
    set.replace(["node_2", "node_3"]);
    expect(set.isOpen("node_1")).toBe(false);
    expect([...set.own.value]).toEqual(["node_2", "node_3"]);
  });

  it("a search opens every match and clearing it restores the operator's own set", () => {
    const set = useExpandSet(["mine"]);
    set.override(["hit-1", "hit-2"]);
    expect(set.overridden.value).toBe(true);
    expect(set.isOpen("hit-1")).toBe(true);
    expect(set.isOpen("mine")).toBe(false);
    // Closing a search-opened group edits the override, not the own set.
    set.toggle("hit-1");
    expect(set.isOpen("hit-1")).toBe(false);
    set.override(null);
    expect(set.overridden.value).toBe(false);
    expect(set.isOpen("mine")).toBe(true);
    expect(set.isOpen("hit-2")).toBe(false);
  });

  it("clear drops both the own set and the override", () => {
    const set = useExpandSet(["a"]);
    set.override(["b"]);
    set.clear();
    expect(set.isOpen("a")).toBe(false);
    expect(set.isOpen("b")).toBe(false);
    expect(set.overridden.value).toBe(false);
  });
});
