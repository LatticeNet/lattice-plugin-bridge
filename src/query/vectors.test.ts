import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as complete from "./complete";
import * as engine from "./engine";
import * as syntax from "./syntax";
import * as values from "./values";
import { runQueryVectors, type QueryCore, type QueryVectors } from "./vectors";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8")) as QueryVectors;

describe("shared list query vectors", () => {
  it("hold this port to the console's behaviour", () => {
    // The core's generic signatures are wider than the runner's plain-data schema; the vectors check behaviour, not types.
    const core = { ...syntax, ...engine, ...complete, ...values } as unknown as QueryCore;
    expect(runQueryVectors(core, vectors)).toEqual([]);
  });

  it("cover every part of the grammar and every field type", () => {
    expect(vectors.parse.length).toBeGreaterThan(50);
    expect(vectors.run.length).toBeGreaterThan(80);
    const types = new Set(vectors.schema.fields.map((field) => field.type));
    expect([...types].sort()).toEqual(["bool", "duration", "enum", "list", "number", "string", "time", "version"]);
  });

  it("report a core that disagrees, line by line", () => {
    const core = { ...syntax, ...engine, ...complete, ...values, withoutSorts: (input: string) => input } as unknown as QueryCore;
    const failures = runQueryVectors(core, vectors);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatch(/^withoutSorts /);
  });
});

describe("the query core", () => {
  it("imports nothing but itself, so a page may use it without Vue", () => {
    let seen = 0;
    for (const name of readdirSync(here).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const source = readFileSync(join(here, name), "utf8");
      const specifiers = [...source.matchAll(/^(?:import|export)[^;]*?from\s+"([^"]+)"/gms)].map((match) => match[1]);
      seen += specifiers.length;
      expect(specifiers.filter((specifier) => !specifier!.startsWith("./")), name).toEqual([]);
    }
    expect(seen).toBeGreaterThan(10);
  });
});
