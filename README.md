# lattice-plugin-bridge

One versioned bridge client for Lattice plugin UIs, replacing the per-plugin `bridge.ts`
copies. It carries the iframe handshake, nonce validation, `host_origin` pinning (inbound
check + outbound `targetOrigin`), the call transport with cancel/timeout, and the typed
error taxonomy.

Status: scaffold. The extraction lands via Olympus TASK-0004; the protocol invariants are
registered in the coordination repo's contract before the first release.

- Package: `@latticenet/plugin-bridge`
- Branching: work lands on `integration` via task branches; `main` is the stable baseline.
