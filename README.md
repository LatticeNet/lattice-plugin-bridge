# lattice-plugin-bridge

One versioned bridge client for Lattice plugin UIs, replacing the per-plugin `bridge.ts`
copies. It carries the iframe handshake, nonce validation, `host_origin` pinning (inbound
check + outbound `targetOrigin`), the call transport with cancel/timeout, and the typed
error taxonomy.

Status: scaffold. The extraction lands via Olympus TASK-0004; the protocol invariants are
registered in the coordination repo's contract before the first release.

- Package: `@latticenet/plugin-bridge`
- Branching: work lands on `integration` via task branches; `main` is the stable baseline.

---
The one Lattice plugin-UI bridge client. Replaces the four divergent per-plugin
`bridge.ts` copies (template / vpn-core / sub-store / wireguard / netguard), so the
weakest copy stops setting the security bar. Protocol semantics are unchanged —
this package is an **extraction**, not a redesign (TASK-0004, design §3 F2).

## What a plugin frame is

A plugin UI ships as static assets inside the plugin's signed bundle and is served
in an opaque-origin `sandbox="allow-scripts"` iframe under
`default-src 'none'; … connect-src 'none'`. The document can make **zero** network
requests. Its only verb is `lattice.plugin.call` over `postMessage`, and the host
rejects any service/method not declared in the signed manifest.

## Usage

```ts
import { BridgeClient, canCall } from "@latticenet/plugin-bridge";

const bridge = new BridgeClient({
  window,
  expectedPluginId: "latticenet.sub-store",   // your signed manifest id
  expectedRoutes: ["sub-store"],              // your manifest ui.views routes
  idPrefix: "substore",                       // optional call-id prefix
});

const init = await bridge.init;               // resolves once, after the handshake
if (canCall(init, "latticenet.sub-store/import", "status")) {
  const { promise, cancel } = bridge.call<StatusResponse>(
    "latticenet.sub-store/import",
    "status",
    { base_url },
  );
  const status = await promise;
}
bridge.resize(document.documentElement.scrollHeight);
```

## Invariants (fail closed, tested)

- The frame URL fragment must carry `lattice_nonce` (16–128 chars) and a
  `host_origin` that parses as an **exact** absolute http(s) origin; anything
  missing, malformed, or non-exact throws `BridgeHandshakeError` in the
  constructor. No wildcard fallback, ever.
- Inbound messages must match the nonce, the pinned origin exactly, and
  `event.source === window.parent`.
- `lattice.host.init` must declare `version: "1"`, your plugin id, and one of
  your registered routes; anything else is ignored and ready-retries continue
  (500 ms × 16 by default).
- Theme application filters host design tokens to a fixed CSS-variable allowlist.

## Typed errors

`BridgeError` → `BridgeHandshakeError` (channel invalid) ·
`BridgeRemoteError` (host answered an error; carries the wire `code` when supplied) · `BridgeCancelledError` (cancel())
· `BridgeTimeoutError` (per-call timeout, default 15 s) · `BridgeDisposedError`
(host disposed the frame; also thrown by post-dispose `call()`).

## Theme

`bridge.theme` exposes the last host-reported theme (or `null` before init);
`bridge.subscribeTheme(listener)` notifies on init and every `lattice.host.theme`
update and returns the unsubscribe. `bridge.dispose(reason?)` accepts a custom
reason string.

## Migrating a plugin UI off its local copy

1. Add the dependency pinned to an exact version (see Consuming below), delete
   `ui/src/bridge.ts` and its test (the package's invariant suite replaces them).
2. Replace `new BridgeClient(window)` with the options form above; the local
   copy's hard-coded plugin id and routes become constructor arguments.
3. Replace `import ... from "./bridge"` with `@latticenet/plugin-bridge`.
4. Your UI's `test`/`typecheck`/`build`/`verify:build` must stay green.

Known, honest migration costs (hit in production migrations, no surprises):

- **Init payload typing**: the old `type`-alias init payload had an implicit
  index signature; the package's `interface HostInit` does not. A consumer ref
  typed `Record<string, unknown> | null` must retype to `HostInit | null`
  (one line; template hit this).
- **Test coverage moves**: deleting a UI's local `bridge.test.ts` can leave it
  with no test files. If so, its test entry becomes
  `vitest run --passWithNoTests` — the invariant coverage lives here, not
  duplicated per consumer.

## Consuming

Registry: **GitHub Packages** (`npm.pkg.github.com`), scope `@latticenet`.
GitHub Packages requires authentication for installs even of public packages.

Consumer `ui/.npmrc`:

```ini
@latticenet:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

- **In CI**: the npm steps need `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`,
  and the package's Actions access list must include the consuming repo
  (org-level grant, integrator's hands).
- **Local dev**: any GitHub token with `read:packages`
  (`gh auth refresh -s read:packages`).

## Releases

Prerelease lane only: `0.x-alpha.N`, published to GitHub Packages from this
repo's tag-triggered CI (`publish.yml`, ephemeral run token; tag↔version
mismatch refused; a prerelease never becomes registry `latest`). Consumers pin
exact versions. First published version: `0.1.0-alpha.1`.

The package has **zero runtime dependencies** and ships compiled ESM + types
(`dist/`, built by `npm run build` / `prepublishOnly`).

## Development

```bash
npm ci
npm test          # vitest — handshake/origin/call/theme invariants
npm run typecheck
npm run build
```

CI (`ci.yml`: install/test/typecheck/build on push and PR) is wired by the
integrator.
