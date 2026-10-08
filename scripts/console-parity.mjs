// Hold the console's list query core and this package's port of it to one
// behaviour. CI checks out lattice-dashboard and runs:
//
//   node --experimental-strip-types scripts/console-parity.mjs <console checkout>
//
// 1. The shared vectors (src/query/vectors.json) run against the console's
//    own src/lib/query modules, through the console's `@/` alias hook.
// 2. The console's copies of the runner and the vectors must be byte-identical
//    to these. Until the console carries them, the step says so and passes.
//
// Exit 1 on any failure, with one line per disagreement.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bridgeQuery = resolve(here, "../src/query");
const consoleRoot = resolve(process.argv[2] ?? "../lattice-dashboard");
const consoleQuery = join(consoleRoot, "src/lib/query");

if (!existsSync(join(consoleQuery, "engine.ts"))) {
  console.error(`console-parity: no query core at ${consoleQuery}`);
  process.exit(1);
}

let failed = false;

for (const name of ["vectors.ts", "vectors.json"]) {
  const theirs = join(consoleQuery, name);
  if (!existsSync(theirs)) {
    console.log(`::notice::lattice-dashboard has no src/lib/query/${name} yet; only the behaviour is compared.`);
    continue;
  }
  if (readFileSync(theirs, "utf8") !== readFileSync(join(bridgeQuery, name), "utf8")) {
    console.error(`console-parity: src/lib/query/${name} differs from this package's src/query/${name}. Change both copies together.`);
    failed = true;
  }
}

// The console imports through `@/`; its own test hook resolves that to src/.
await import(pathToFileURL(join(consoleRoot, "src/testing/resolveAlias.mjs")).href);
const load = (name) => import(pathToFileURL(join(consoleQuery, `${name}.ts`)).href);
const [syntax, engine, complete, values] = await Promise.all(["syntax", "engine", "complete", "values"].map(load));
const { runQueryVectors } = await import(pathToFileURL(join(bridgeQuery, "vectors.ts")).href);
const vectors = JSON.parse(readFileSync(join(bridgeQuery, "vectors.json"), "utf8"));

const failures = runQueryVectors({ ...syntax, ...engine, ...complete, ...values }, vectors);
for (const line of failures) console.error(`console-parity: ${line}`);
if (failures.length) failed = true;

const count = vectors.parse.length + vectors.withoutSorts.length + vectors.run.length + vectors.complete.length;
console.log(failed ? "console-parity: the console and the bridge disagree" : `console-parity: the console's core passes all ${count} query vectors and the value checks`);
process.exit(failed ? 1 : 0);
