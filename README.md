# lattice-plugin-bridge

`@latticenet/plugin-bridge` is the client half of the Lattice plugin-UI protocol. A
plugin UI runs inside a sandboxed iframe in the operator console and cannot reach the
control plane directly. Everything it needs, host identity, theme, and RPC into the
plugin's own backend, arrives over `postMessage` through this package.

It replaces the four divergent per-plugin `bridge.ts` copies. The protocol is unchanged
from those copies: this package extracts them, it does not redesign the wire format.

## Where it fits

The console mounts the plugin frame and puts a one-time nonce and its own origin in the
frame URL fragment. The plugin constructs a `BridgeClient`, which posts
`lattice.plugin.ready` until the host answers with `lattice.host.init`. From then on the
plugin calls host-declared services and the host answers or refuses.

Messages the plugin sends: `lattice.plugin.ready`, `lattice.plugin.call`,
`lattice.plugin.cancel`, `lattice.plugin.resize`.
Messages the host sends: `lattice.host.init`, `lattice.host.result`, `lattice.host.error`,
`lattice.host.theme`, `lattice.host.dispose`.

## Invariants

These are the reasons the package exists in one place instead of four. The package tests
cover each of them, and a consumer cannot weaken them through options.

- The frame URL fragment must carry `lattice_nonce` (16 to 128 characters) and a
  `host_origin` that parses as an exact absolute http or https origin. If either is
  missing or malformed the constructor throws `BridgeHandshakeError`. It does not fall
  back to `*`.
- Every inbound message must match the nonce, match the pinned origin exactly, and have
  `event.source === window.parent`. Anything else is dropped.
- Every outbound message is posted with the pinned `host_origin` as `targetOrigin`.
- `lattice.host.init` must declare version `"1"`, the consumer's own plugin id, and one
  of the routes that build answers for. A mismatch fails the handshake.
- Host design tokens are filtered to a fixed allowlist before they are applied.
  The allowlist is token contract v2: colours, status semantics as both a fill
  and an ink step (`--warning` is a fill; `--warning-text` is what a status
  label is written in, because the light-scheme fill reads 2.5:1 as text), the
  four radius steps, both row heights, the seven spacing steps, the mono stack
  and two type sizes, two shadows, two durations and one curve, under the
  console's own names. It is exported as `HOST_TOKEN_NAMES`. A plugin declares the same
  names on its own `:root` as fallbacks, for its dev harness and for a host
  older than this version; the host's values are written inline and win.

## API

`BridgeClient` takes the plugin's `window`, its signed-manifest `expectedPluginId`, and
the `expectedRoutes` from its manifest `ui.views`. Defaults: ready handshake retries every
500 ms up to 16 attempts, per-call timeout 15000 ms.

`client.call(service, method, payload, timeoutMs?)` returns `{ promise, cancel }`.
Cancelling posts `lattice.plugin.cancel` and rejects with `BridgeCancelledError`, so a
plugin can drop a slow call without leaking the pending entry.

`canCall(init, service, method)` reports whether the host declared that service and method
in `init.interfaces`. Use it to disable an action the host will refuse rather than letting
the operator press it and read an error.

`client.theme` and `client.subscribeTheme(listener)` track host theme reports.
`client.resize(height)` asks the host to resize the frame. `client.dispose(reason)` tears
the client down.

Errors are typed: `BridgeError` is the base, with `BridgeRemoteError` (the host refused or
the backend failed, carries an optional `code`), `BridgeCancelledError`,
`BridgeTimeoutError`, `BridgeDisposedError`, and `BridgeHandshakeError`.

## Build and test

```
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc -p tsconfig.build.json, emits dist/
```

## Consumers

Pinned at `0.1.0-alpha.1` by the netguard, sub-store, and wireguard plugin UIs. vpn-core
still carries its own `ui/src/bridge.ts` copy and has not been migrated.

## Branching

Work lands on `integration` via task branches. `main` is the stable baseline and currently
carries only this README, so read `integration` for the source.
