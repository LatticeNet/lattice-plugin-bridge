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

## Chassis

`@latticenet/plugin-bridge/chassis` is the shared page skeleton for plugin frames: Vue 3
components on the token contract above, with one stylesheet,
`@latticenet/plugin-bridge/chassis.css`. It exists because the four plugin pages drifted
apart in the parts that are not colour: radius, row height, how a group row folds its
records, how tabs carry counts, what a chip means. The reference is the vpn-core Lines
page; the design that maps every part onto it is `docs/design-plugin-chassis.md` in the
`lattice` repo. `vue` is an optional peer dependency; a consumer that uses only the bridge
client installs nothing new.

Import the stylesheet once, then build the page in the reading order the design fixes:

```vue
<script setup lang="ts">
import "@latticenet/plugin-bridge/chassis.css";
import { PcWorkspace, PcPageHeader, PcProofLine, PcStatStrip, PcStatCard, PcToolbar, PcLensTabs, PcLensTab,
  PcSearchField, PcButton, PcPanel, PcPanelHeader, PcTable, PcTh, PcTd, PcGroupRow, PcRow, PcNameCell,
  PcStateDot, PcStatePill, PcActionsCell, PcCount, useExpandSet, useOverlayEscape } from "@latticenet/plugin-bridge/chassis";
const groups = useExpandSet();
useOverlayEscape();
</script>

<template>
  <PcWorkspace>
    <PcPageHeader title="Lines" badge="VPN Core plugin" description="Managed and discovered proxy endpoints across the fleet." :icon="Radar">
      <template #actions><PcButton :busy="refreshing" @click="refresh">Refresh</PcButton></template>
      <template #proof><PcProofLine :segments="['observed at 23:21:14', '25 nodes report', 'liveness: 138 running']" :refreshing="refreshing" /></template>
    </PcPageHeader>
    <PcStatStrip :count="5" label="Line summary"><PcStatCard label="Lines" :value="138" note="none reporting a config error" /></PcStatStrip>
    <PcToolbar>
      <template #tabs><PcLensTabs v-model="lens" label="Lines lens"><PcLensTab value="fleet" label="Fleet" /><PcLensTab value="attention" label="Attention" :count="2" count-tone="warning" /></PcLensTabs></template>
      <template #search><PcSearchField v-model="search" placeholder="Search node, line, endpoint" /></template>
      <template #primary><PcButton variant="primary" @click="rollout">Roll out managed lines</PcButton></template>
    </PcToolbar>
    <PcPanel id="pc-panel-fleet" role="tabpanel">
      <PcPanelHeader title="Fleet" description="Every node that reports an inbound, with its lines folded underneath."><PcCount value="25 nodes · 138 lines" /></PcPanelHeader>
      <PcTable :min-width="1080" label="Fleet">
        <template #head><PcTh name>Node / line</PcTh><PcTh>Role</PcTh><PcTh>Service</PcTh><PcTh actions>Actions</PcTh></template>
        <tbody v-for="node in nodes" :key="node.id">
          <PcGroupRow :expanded="groups.isOpen(node.id)">
            <PcNameCell :name="node.name" :id="node.id" :expanded="groups.isOpen(node.id)" :controls="'node-' + node.id" @toggle="groups.toggle(node.id)" />
            <PcTd :colspan="1" stack="summary">{{ node.lines.length }} lines</PcTd>
            <PcTd label="Service" stack="state"><PcStatePill tone="healthy" label="running" title="checked 23:21:14" /></PcTd>
            <PcActionsCell><PcButton compact>Evidence</PcButton></PcActionsCell>
          </PcGroupRow>
          <template v-if="groups.isOpen(node.id)">
            <PcRow v-for="(line, i) in node.lines" :key="line.hash" :id="i === 0 ? 'node-' + node.id : undefined">
              <PcNameCell :name="line.name" :id="line.hash" :level="1" />
              <PcTd label="Role" stack="state"><PcStatePill tone="neutral" :label="line.role" /></PcTd>
              <PcTd label="Service" stack="state"><PcStatePill tone="healthy" label="running" /></PcTd>
              <PcActionsCell><PcButton compact>Details</PcButton></PcActionsCell>
            </PcRow>
          </template>
        </tbody>
      </PcTable>
    </PcPanel>
  </PcWorkspace>
</template>
```

What the parts do, in one line each:

- `PcWorkspace` is the page frame (`batch` keeps room for a batch bar). `PcPageHeader` takes `title`, `badge`, `description`, an `icon` component or `#icon` slot, `#actions` for the page-level Refresh, and `#proof` for the proof line, which then sits inside the header above its hairline. `PcProofLine` prints `segments` joined by a middle dot, plus "refreshing".
- `PcNotice` has a `tone` (danger, success, warning, info), a `title`, `dismissible`, an `#actions` slot for "Try again". `PcStatStrip` takes `count` and `label`; `PcStatCard` takes `label`, `value`, `note`, and a `tone` that colours the value only.
- `PcToolbar` renders its slots in order: `tabs`, `search`, `note`, spacer, `secondary`, `primary`. `PcLensTabs` is a `v-model` tablist that answers ArrowLeft and ArrowRight; `PcLensTab` takes `value`, `label`, `count` (absent until read, never "0"), `countTone`, `icon`. `PcSearchField` is a `v-model` search input. `PcButton` takes `variant` (primary, secondary, danger), `compact`, `destructive`, `busy`, `disabled`, with an `#icon` slot; `PcIconButton` takes `label`, `bordered`, `destructive`, `size`.
- `PcPanel` is the bordered card; `PcPanelHeader` takes `title`, `description`, and the count badge in its default slot; `PcPanelBody` pads a form. `PcTable` takes `minWidth`, `density`, `label`, and `stacked` (leave it undefined and the table follows the frame width below `stackBelow`, 480px); its `#head` slot renders inside `<thead><tr>` and its default slot inside `<table>`, so the consumer writes one `<tbody>` per group. `PcTh` takes `name`, `numeric`, `actions`, `select`, `sortable` and `sort`, emitting `sort`. `PcTd` takes `numeric`, `mono`, `colspan`, `title`, a `label` (the column header, printed in the stacked form) and `stack` (name, summary, state, actions, detail: which line of the stacked row it belongs to).
- `PcGroupRow`, `PcBankRow` (`expanded`, `id`, `selected`) and `PcRow` (`open`, `id`, `selected`) are the three row levels; `PcDetailRow` (`colspan`) is the in-place detail under a row. `PcNameCell` takes `name`, `id` (the muted mono line), `sub` (replaces it), `level` (0, 1, 2 for the indent), `status` (a dot at the name baseline), and becomes a toggle when `expanded` is bound (`controls`, emits `toggle`); its `#after` slot holds chips after the name and `#status` the narrow status line shown under 720px. `PcRowToggle` is the chevron button on its own: Enter and Space toggle it, ArrowRight opens, ArrowLeft closes, and inside a `PcTable` ArrowDown and ArrowUp move between toggles. `PcActionsCell` is the sticky right column; `PcRowActions` groups a text button and an icon button. `PcSelectCell` (`checked`, `indeterminate`, `label`, `header`, emits `change`) is the optional leading selection column. `PcPagination` takes `page`, `pages`, `from`, `to`, `total`, `noun`, `note` and emits `update:page`.
- Chips: `PcStateDot` and `PcStatePill` (`tone`: healthy, warning, error, info, neutral; `label`; `title` carrying the evidence), `PcKindChip` (`label`, `tone` info for a managed or derived kind), `PcTagChip` (`label`), `PcTagList` (`tags`, `max`, folds the rest into "+N"), `PcCount` (`value`, `tone`).
- `PcSkeleton` (`variant` strip or rows, `count`, `label`) and `PcEmptyState` (`title`, `kind`: empty, no-match, permission, error, handshake; `icon`; `#actions`).
- `PcModal` (`open`, `title`, `description`, `size` small, default, large, `returnFocusTo`, emits `close`; `#footer`; on close, focus goes back to `returnFocusTo` or, left unset, to the element that had focus when the dialog opened), `PcSidePanel` (the same with `size` record or output), `PcConfirmDialog` (`open`, `title`, `message`, `confirmLabel`, `cancelLabel`, `destructive`, `busy`, emits `confirm` and `cancel`), `PcBatchBar` (`count`, emits `clear`).
- Behaviour: `useExpandSet()` is the open set for one level of grouping (`isOpen`, `toggle`, `open`, `close`, `replace`, `clear`, and `override(keys)` for a search that opens every match without losing the operator's own set). `useOverlayEscape()` binds one document handler that closes the top of the overlay stack; `useOverlayRegistration`, `registerOverlay`, `closeTopOverlay`, `overlayDepth` and `trapDialogTab` are the pieces under it. `useDocumentQueryState()` reads and writes `?expand=`, `?bank=`, `?lens=` without touching the handshake fragment. `useMediaQuery(query)` is the ref behind the stacked form.

`dev/harness.html` renders the Lines page on the chassis with realistic content. After
`npm run build`, serve the package root and open `dev/harness.html?expand=dmit-1`; the
`dev/frame.html?w=375&h=812` wrapper shows it inside a 375px frame.

## Build and test

```
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc -p tsconfig.build.json plus the chassis stylesheet, emits dist/
```

## Consumers

Pinned at `0.1.0-alpha.1` by the netguard, sub-store, and wireguard plugin UIs. vpn-core
still carries its own `ui/src/bridge.ts` copy and has not been migrated.

## Branching

Work lands on `integration` via task branches. `main` is the stable baseline and currently
carries only this README, so read `integration` for the source.
