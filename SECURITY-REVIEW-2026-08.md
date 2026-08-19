# Security review, 2026-08: plugin UI layer and host/plugin message bridge

Reviewer lane: uisec. Subject: this package, the four plugin UIs
(`vpn-core`, `sub-store`, `netguard`, `wireguard`), and the host side in
`lattice-dashboard/src/views/platform/`.

Trees reviewed, all `origin/integration`, in per-repo worktrees at
`<repo>/.wt-x/uisec`:

| repo | commit |
| --- | --- |
| lattice-dashboard | `2a78899` |
| lattice-plugin-bridge | `75f85bf` |
| lattice-plugin-vpn-core | `1430ddc` |
| lattice-plugin-sub-store | `537f679` |
| lattice-plugin-netguard | `d1a6edf` |
| lattice-plugin-wireguard | `16d7afd` |

Verdict: all five in-scope repos opened and reviewed, all five clean. One
finding was raised and confirmed (UISEC-1, medium, fixed on another lane), one
was raised and withdrawn after review (UISEC-2).

## 1. What was actually opened

Per repo, a sink census across every file, then a full read of the modules that
sit on the trust boundary. Claims about what ships were checked against the
signed bundle committed at `<repo>/.release-bundle.tar.gz`, not against sources.

**lattice-plugin-bridge.** Seven files. `src/bridge.ts` read line by line.

**vpn-core/ui.** 28 files censused. Read in full: `ui/src/bridge.ts` (this repo
still carries its own bridge copy rather than consuming the package).

**sub-store/ui.** 69 files censused. Read in full: `ui/src/navigate.ts`. Not
read line by line: the individual screen and component files.

**netguard/ui.** 26 files censused. Read in full: `ui/src/netguardModel.ts`.

**wireguard/ui.** 19 files censused. Read in full: `ui/src/wireguardModel.ts`.

**lattice-dashboard/src/views/platform/.** Read in full: `PluginFrameHost.vue`,
`pluginBridgeModel.ts`, `pluginFrameModel.ts`, `pluginNavigationModel.ts`,
`PluginView.vue`, `composables/usePluginContributions.ts`. Read in the relevant
ranges: `PluginsView.vue`, `StaticView.vue`, `AgentUpdatesView.vue`,
`lib/api/client.ts`, `views/operations/TerminalView.vue`,
`views/auth/LoginView.vue`.

Also read as context, not as review scope: the two CSP headers in
`lattice-server` (`internal/server/server.go:7340`,
`internal/server/server_plugin_assets.go:127-137`) and `validPluginID`
(`internal/plugin/plugin.go:437-461`), because three exploitability calls
depended on them.

The first pass censused only `<plugin>/ui/src` and so missed the dev harnesses.
The second pass widened to every file and found them. They are covered below.

## 2. What was concluded

### Does allow-same-origin ever appear next to allow-scripts?

No, nowhere in either tree. The dashboard has exactly one iframe
(`PluginFrameHost.vue:312-323`, `sandbox="allow-scripts"` with
`referrerpolicy="no-referrer"`), and `pluginIsolation.test.ts:60` already pins
the absence. No plugin creates an iframe in shipped code; the only `sandbox`
string in any shipped bundle is Vue's own attribute table
(`t==="sandbox"&&e.tagName==="IFRAME"`).

vpn-core and wireguard each carry a dev harness (`ui/dev/host.ts`) that builds an
iframe with no sandbox attribute at all, and writes `location.search` values into
`innerHTML`. It does not ship, verified against the artifacts rather than
inferred from the Vite config: all four signed bundles contain `ui/index.html`
plus hashed assets and nothing else, zero hits for `dev.html` or `dev/`. Worth
knowing only so that nobody promotes the harness into a product surface.

### Does any plugin-controlled string reach the host DOM?

No path found, through `v-html`, `innerHTML`, or a constructed URL.

The dashboard `src` contains zero occurrences of `v-html`, `innerHTML`,
`outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function`.
Plugin-contributed views (table, detail, kv, markdown) render through Vue text
interpolation, with render hints, field kinds, view kinds, sections, routes and
icons allowlisted in `usePluginContributions.ts:30-89` and unknown values inert
rather than throwing.

The `:style` and `setProperty` sink class was swept separately, since a CSS value
is a sink too: none at all in the platform views, and every style binding in the
four plugin UIs carries a locally computed number, never a remote string.

The only URL the host builds from plugin data is the frame src, and
`resolvePluginFrameURL` (`pluginBridgeModel.ts:70-98`) rejects a non-hex-64
digest, an off-origin URL, a path outside
`/api/plugins/assets/<id>/<digest>/ui/`, and any query, fragment, username or
password. Traversal in that prefix is unreachable because `new URL` normalizes
first, and the plugin id cannot traverse either, because server-side
`validPluginID` restricts it to `[a-z0-9.-]` with no repeated dots.

In the shipped bundles the only `innerHTML` occurrences are seven Vue runtime-dom
internals, byte-identical across all four plugins, unreachable without a `v-html`
in application code.

### Is there a target=_blank without rel=noopener?

No. The four plugin UIs contain no anchors and no `window.open` at all, in source
or in the shipped bundles. In the platform views the only external anchors are
`AgentUpdatesView.vue:496-497` and `:540-541`, both `rel="noreferrer"`, which
implies noopener. Every `window.open` in the dashboard passes `noopener`
explicitly (`NodesView.vue:866`, `TerminalView.vue:440,444`,
`InventoryView.vue:818`), and the xterm link handler (`XtermSession.vue:171`)
gates on `^https?://` before opening anything.

### Does the host hand the frame more than it needs?

No. `lattice.host.init` carries locale, colour scheme, the eleven allowlisted
design tokens, the plugin's own id, version and route, and the plugin's own
interface contract. No session token, no CSRF token, no fleet data. The session
is an HttpOnly cookie; the CSRF token never leaves a module variable in
`lib/api/client.ts`; localStorage holds only theme and layout preferences; and
the frame's opaque origin puts all of it out of reach regardless. Zero storage
access in any shipped plugin bundle. Fleet data reaches a plugin only through a
method it declared and the server authorized.

One qualification, for completeness rather than as a finding: beyond the
enumerated init fields, gateway errors forward the server's message text and
request id verbatim (`pluginBridgeModel.ts:280`), inside the plugin's own call.

### This package specifically

Inbound messages are checked on all three of `event.source === win.parent`,
`event.origin === hostOrigin`, and nonce (`src/bridge.ts:206-207`). Outbound
posts go to the pinned origin, never a wildcard (`:255`). `readChannel`
(`:321-339`) throws on a missing nonce, a nonce outside 16-128 characters, a
missing or unparseable `host_origin`, one whose parsed `origin` differs from the
input string, or a non-http(s) scheme, and the constructor does not catch, so a
tampered frame URL fails closed instead of downgrading to a wildcard target.
`lattice.host.init` is rejected unless it declares version "1", the consumer's
own plugin id, and one of its registered routes. Theme tokens are filtered
against a fixed eleven-name allowlist before `setProperty`.

vpn-core's local copy was diffed against this package on every one of those
checks and is equivalent. It is the one place a bridge change has to land twice.

## 3. Findings

**UISEC-1 (medium). Confirmed, fixed on the operator-surface lane.** The host's
only gate on a plugin-supplied `lattice:navigate` route was "is this an internal
dashboard path", while `/terminal` acts on its own query string at mount
(`TerminalView.vue:159-163`, `:274-281`, `:361-366`). One postMessage from a
sandboxed frame therefore opened a terminal session against a node of the
plugin's choosing, under the operator's identity and scopes, with no
confirmation. This contradicted the invariant stated at
`pluginNavigationModel.ts:10-13` and `PluginFrameHost.vue:220-222`. Found
independently by two lanes; fixed at the boundary, where a frame may request any
internal page but cannot hand it an argument unless the path declares which
arguments it accepts.

**UISEC-2. Withdrawn.** Raised as defence in depth: the host posts to the frame
with targetOrigin `"*"` (`PluginFrameHost.vue:179`) and drops `event.origin`
before the bridge session sees it (`:236`, `pluginBridgeModel.ts:141-144`).
Correctly rejected in review. The frame is opaque-origin, so `event.origin` is
`"null"` both before and after an in-frame navigation, and pinning it would have
bounded nothing. The source pin plus rotate-on-load is the defence that holds.

One ordering detail from that work is worth recording, because a future bridge
capability might lean on it. The comment at `PluginFrameHost.vue:248-250` says
teardown happens "before the new document can reach the host". Measured in a
two-origin harness with the real CSP shape, that is not the ordering: scripts in
a replacing document run before the iframe's `load` event, so messages crossed in
both directions before teardown, and the window widened at will by hanging a slow
subresource on the replacing page. Same-origin only, opaque, no egress, no
privilege the plugin did not already hold, so there is nothing to fix today.
Teardown-on-load bounds the exposure; it is not a barrier.

Cross-origin escape from the frame is genuinely blocked, also measured:
`csp-violation directive=frame-src blocked=<other origin>`, from the console's
`default-src 'self'` acting as the frame-src fallback, which Chrome enforces
against a navigation the child initiates itself.

## 4. Not security, but worth someone's time

`sub-store/ui/src/overlayAnchor.ts:4-10` still documents the superseded model,
"an iframe the host sizes to its content". Given the effort spent making the host
side a real viewport, that docstring is how the next person gets it wrong.

Each plugin ships `ui/scripts/scan-build.mjs`, which walks the whole dist and
rejects inline scripts, inline styles, and any absolute http(s) URL outside a
three-entry allowlist. It holds on the shipped artifacts: all four bundles carry
zero external URLs, and their `index.html` files contain only a module script tag
and a stylesheet link. It would not catch a dynamically assembled URL;
`connect-src 'none'` is the actual enforcement.

Dependencies: the dashboard's `npm audit` is clean. All four plugin UIs carry the
same two advisories through Vite's dev tree only (nanoid high,
GHSA-2v37-7h3g-55p8; postcss moderate, GHSA-fxqj-rqcc-2cmp). Build-time, absent
from the signed bundles, fixed by a routine bump. Not urgent.

## 5. What remains unexamined

The plugin Go sidecars, which belong to another lane, and the server beyond the
three constants named in section 1. In particular the authorization on
`POST /api/plugins/call` was not reviewed; the host-side gate
(`methodDeclared`, `pluginBridgeModel.ts:288-293`) was, and it restricts a frame
to the service and method names in its own declared contract.

No plugin UI was read line by line in full. Each was censused in full and read in
full at its boundary modules. The residual risk that carries is a logic flaw
inside a screen component that a sink census does not name, in code that already
cannot reach the host DOM, cannot construct a URL, and has no network egress.

The dashboard's own built output was not inspected, only its sources; the four
plugin bundles were inspected as shipped.

## 6. Scheduling: the copy-docs hold can be released

The hold is not needed for this lane and can be released now. Evidence rather
than assurance:

Across the four plugin repos, `feat/copy-docs` touches exactly one boundary
module, `vpn-core/ui/src/bridge.ts`. Its diff against `origin/integration`
changes error message strings only. Every condition, every `throw` site, and the
control flow of `readChannel`, `onMessage` and `post` are byte-identical, so
every security property asserted in section 2 survives it unchanged. sub-store,
netguard and wireguard touch no boundary module at all, and this package's
copy-docs branch changes only `README.md`.

Line numbers cited in this note are pinned to the commits in the table above, so
a later reader can diff forward rather than re-deriving.

## 7. Branch state

`audit/uisec` in `lattice-dashboard` holds one failing test for UISEC-1
(`eede7e9`) and the removal of the withdrawn UISEC-2 assertion (`d189f36`). It is
not for merging: UISEC-1 is already fixed at the boundary, so the test passes
there and is a duplicate. Drop the branch with this review.
