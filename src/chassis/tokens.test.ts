import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HOST_TOKEN_NAMES } from "../bridge";

/**
 * The colour rule of the chassis sheet: the only literal colours are the
 * fallbacks for the published names (and the two scrims) on :root; every
 * other rule reads a token. A plugin that ships a colour of its own is the
 * drift the chassis exists to end, so the sheet is parsed and checked here.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chassis.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Block {
  selector: string;
  declarations: { property: string; value: string }[];
}

/** Flatten nested at-rules; a block inside @media keeps its own selector. */
function blocks(source: string): Block[] {
  const out: Block[] = [];
  let index = 0;
  function readBlock(selectorText: string): void {
    const selector = selectorText.trim();
    const isAtRule = selector.startsWith("@");
    const declarations: Block["declarations"] = [];
    let buffer = "";
    while (index < source.length) {
      const char = source[index++]!;
      if (char === "{") {
        readBlock(buffer);
        buffer = "";
      } else if (char === "}") {
        if (!isAtRule) {
          for (const piece of buffer.split(";")) {
            const at = piece.indexOf(":");
            if (at === -1) continue;
            declarations.push({ property: piece.slice(0, at).trim(), value: piece.slice(at + 1).trim() });
          }
        }
        if (!isAtRule) out.push({ selector, declarations });
        return;
      } else buffer += char;
    }
  }
  let buffer = "";
  while (index < source.length) {
    const char = source[index++]!;
    if (char === "{") {
      readBlock(buffer);
      buffer = "";
    } else buffer += char;
  }
  return out;
}

const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(|\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|silver|navy|teal)\b/i;
const FALLBACK_SELECTORS = new Set([":root", ':root[data-theme="dark"]']);
const SCRIMS = new Set(["--pc-scrim", "--pc-scrim-strong"]);
const COLOUR_PROPERTIES = /^(color|background|background-color|background-image|border|border-color|border-top|border-right|border-bottom|border-left|border-bottom-color|box-shadow|outline|fill|stroke|accent-color)$/;

describe("chassis.css colour rule", () => {
  const parsed = blocks(css);

  it("parses into rule blocks", () => {
    expect(parsed.length).toBeGreaterThan(50);
    expect(parsed.some((block) => block.selector === ".pc-group-row > td")).toBe(true);
  });

  it("declares a fallback for every published token name and nothing beyond that plus the scrims", () => {
    const light = parsed.find((block) => block.selector === ":root")!;
    const declared = new Set(light.declarations.map((declaration) => declaration.property));
    for (const name of HOST_TOKEN_NAMES) expect(declared, `fallback for ${name}`).toContain(name);
    for (const block of parsed.filter((candidate) => FALLBACK_SELECTORS.has(candidate.selector))) {
      for (const { property, value } of block.declarations) {
        if (!LITERAL_COLOUR.test(value)) continue;
        expect(HOST_TOKEN_NAMES.has(property) || SCRIMS.has(property), `${block.selector} ${property} carries a literal colour`).toBe(true);
      }
    }
  });

  it("builds every --pc- derivation from tokens, not literals", () => {
    for (const block of parsed.filter((candidate) => FALLBACK_SELECTORS.has(candidate.selector))) {
      for (const { property, value } of block.declarations) {
        if (!property.startsWith("--pc-") || SCRIMS.has(property)) continue;
        expect(LITERAL_COLOUR.test(value), `${property}: ${value}`).toBe(false);
      }
    }
  });

  it("paints every component rule from a token", () => {
    const offenders: string[] = [];
    for (const block of parsed) {
      if (FALLBACK_SELECTORS.has(block.selector)) continue;
      for (const { property, value } of block.declarations) {
        if (LITERAL_COLOUR.test(value)) offenders.push(`${block.selector} { ${property}: ${value} }`);
        if (COLOUR_PROPERTIES.test(property) && !/var\(--|currentColor|transparent|inherit|none|^0$/.test(value)) {
          offenders.push(`${block.selector} { ${property}: ${value} } (no token)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads only published names or --pc- derivations declared in the sheet", () => {
    const declaredPc = new Set(
      parsed
        .filter((block) => FALLBACK_SELECTORS.has(block.selector) || block.selector === ":root")
        .flatMap((block) => block.declarations.map((declaration) => declaration.property))
        .filter((property) => property.startsWith("--pc-")),
    );
    const allowedLocal = new Set(["--stat-count", "--pc-table-min"]);
    const unknown = new Set<string>();
    for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = match[1]!;
      if (HOST_TOKEN_NAMES.has(name) || declaredPc.has(name) || allowedLocal.has(name)) continue;
      unknown.add(name);
    }
    expect([...unknown]).toEqual([]);
  });
});
