import { describe, expect, it, vi } from "vitest";

import {
  BridgeCancelledError,
  BridgeClient,
  BridgeDisposedError,
  BridgeHandshakeError,
  BridgeRemoteError,
  BridgeTimeoutError,
  canCall,
  validPageState,
  type HostInit,
} from "./bridge";

const NONCE = "0123456789abcdef0123456789abcdef";
const PLUGIN_ID = "latticenet.example";
const ROUTES = ["main", "settings"] as const;

function harness(hash?: string) {
  const posted: { message: unknown; target: unknown }[] = [];
  let listener: ((event: MessageEvent) => void) | undefined;
  const parent = { postMessage: (message: unknown, target: unknown) => posted.push({ message, target }) };
  const win = {
    parent,
    location: { hash: hash ?? `#lattice_nonce=${NONCE}&host_origin=https%3A%2F%2Fdash.example` },
    addEventListener: (_name: string, next: (event: MessageEvent) => void) => { listener = next; },
    removeEventListener: vi.fn(),
  } as unknown as Window;
  const dispatch = (data: unknown, origin = "https://dash.example", source: unknown = parent) =>
    listener?.({ data, source, origin } as unknown as MessageEvent);
  const make = () =>
    new BridgeClient({ window: win, expectedPluginId: PLUGIN_ID, expectedRoutes: ROUTES, idPrefix: "example" });
  return { win, parent, posted, dispatch, make };
}

function initFor(nonce: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "lattice.host.init",
    nonce,
    version: "1",
    pluginId: PLUGIN_ID,
    pluginVersion: "0.1.0",
    pluginRoute: "main",
    locale: "en",
    colorScheme: "dark",
    designTokens: {},
    interfaces: [{ service: "svc", methods: ["read"] }],
    ...overrides,
  };
}

describe("channel validation (fail closed)", () => {
  it("rejects a missing or out-of-bounds nonce", () => {
    const short = harness("#lattice_nonce=abc&host_origin=https%3A%2F%2Fdash.example");
    expect(() => short.make()).toThrow(BridgeHandshakeError);
    const missing = harness("#host_origin=https%3A%2F%2Fdash.example");
    expect(() => missing.make()).toThrow("Missing plugin channel nonce");
    const long = harness(`#lattice_nonce=${"x".repeat(129)}&host_origin=https%3A%2F%2Fdash.example`);
    expect(() => long.make()).toThrow(BridgeHandshakeError);
  });

  it("rejects a missing, malformed, or non-exact host_origin", () => {
    expect(() => harness(`#lattice_nonce=${NONCE}`).make()).toThrow("Missing plugin host origin");
    expect(() => harness(`#lattice_nonce=${NONCE}&host_origin=javascript%3Aalert(1)`).make()).toThrow("Invalid plugin host origin");
    // Trailing path makes it not an exact origin.
    expect(() => harness(`#lattice_nonce=${NONCE}&host_origin=https%3A%2F%2Fdash.example%2Fevil`).make()).toThrow(BridgeHandshakeError);
  });
});

describe("handshake and init validation", () => {
  it("posts ready with retries until init, and pins the outbound target origin", async () => {
    vi.useFakeTimers();
    const { posted, dispatch, make } = harness();
    const client = make();
    expect(posted[0]).toEqual({ message: { type: "lattice.plugin.ready", nonce: client.nonce }, target: "https://dash.example" });
    await vi.advanceTimersByTimeAsync(500);
    expect(posted.filter((entry) => (entry.message as { type?: string }).type === "lattice.plugin.ready")).toHaveLength(2);
    dispatch(initFor(client.nonce));
    await client.init;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posted.filter((entry) => (entry.message as { type?: string }).type === "lattice.plugin.ready")).toHaveLength(2);
    client.dispose();
    vi.useRealTimers();
  });

  it("accepts init only with matching nonce, origin, source, plugin id, and route", async () => {
    const { parent, dispatch, make } = harness();
    const client = make();
    let settled = false;
    void client.init.then(() => { settled = true; }, () => { settled = true });
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(settled).toBe(false);
    };
    dispatch(initFor(client.nonce), "https://dash.example", {});
    await settle();
    dispatch({ ...initFor(client.nonce), nonce: "wrong" });
    await settle();
    dispatch(initFor(client.nonce), "https://evil.example");
    await settle();
    dispatch(initFor(client.nonce, { pluginId: "other.plugin" }));
    await settle();
    dispatch(initFor(client.nonce, { pluginRoute: "unknown-route" }));
    await settle();
    // A route from the registered set other than the first also passes.
    dispatch(initFor(client.nonce, { pluginRoute: "settings" }), "https://dash.example", parent);
    await expect(client.init).resolves.toMatchObject({ pluginRoute: "settings" });
    client.dispose();
  });

  it("rejects malformed interface entries", async () => {
    const { dispatch, make } = harness();
    const client = make();
    let settled = false;
    void client.init.then(() => { settled = true; }, () => { settled = true });
    dispatch(initFor(client.nonce, { interfaces: [{ service: "svc", methods: "read" }] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    client.dispose();
  });
});

describe("calls", () => {
  it("resolves structured results and exposes canCall against the manifest list", async () => {
    const { posted, dispatch, make } = harness();
    const client = make();
    dispatch(initFor(client.nonce));
    const init = await client.init;
    expect(canCall(init, "svc", "read")).toBe(true);
    expect(canCall(init, "svc", "write")).toBe(false);
    expect(canCall(undefined as unknown as HostInit, "svc", "read")).toBe(false);

    const request = client.call<{ ok: boolean }>("svc", "read", { q: 1 });
    const call = posted.at(-1)?.message as { id: string; service: string; method: string; nonce: string };
    expect(call).toMatchObject({ id: "example-1", service: "svc", method: "read", nonce: client.nonce });
    dispatch({ type: "lattice.host.result", nonce: call.nonce, id: call.id, result: { ok: true } });
    await expect(request.promise).resolves.toEqual({ ok: true });
    client.dispose();
  });

  it("maps host errors, cancel, timeout, and disposal to typed errors exactly once", async () => {
    vi.useFakeTimers();
    const { posted, dispatch, make } = harness();
    const client = make();

    const failed = client.call("svc", "read", null);
    const failedCall = posted.at(-1)?.message as { id: string };
    dispatch({ type: "lattice.host.error", nonce: client.nonce, id: failedCall.id, code: "denied", message: "Forbidden" });
    await expect(failed.promise).rejects.toBeInstanceOf(BridgeRemoteError);
    await expect(failed.promise).rejects.toThrow("Forbidden");
    const remoteError = await failed.promise.catch((cause: unknown) => cause);
    expect((remoteError as BridgeRemoteError).code).toBe("denied");

    const cancelled = client.call("svc", "read", null);
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toBeInstanceOf(BridgeCancelledError);
    expect((posted.at(-1)?.message as { type?: string }).type).toBe("lattice.plugin.cancel");

    const timedOut = client.call("svc", "read", null, 5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(timedOut.promise).rejects.toBeInstanceOf(BridgeTimeoutError);

    const disposed = client.call("svc", "read", null);
    client.dispose();
    await expect(disposed.promise).rejects.toBeInstanceOf(BridgeDisposedError);
    expect(() => client.call("svc", "read", {})).toThrow(BridgeDisposedError);
    vi.useRealTimers();
  });

  it("fails every pending call and the init promise when the host rejects initialization", async () => {
    vi.useFakeTimers();
    const { posted, dispatch, make } = harness();
    const client = make();
    const request = client.call("svc", "read", null);
    dispatch({ type: "lattice.host.error", nonce: client.nonce, message: "Initialization denied" });
    await expect(client.init).rejects.toThrow("Initialization denied");
    await expect(request.promise).rejects.toThrow("Initialization denied");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posted.filter((entry) => (entry.message as { type?: string }).type === "lattice.plugin.ready")).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("theme application", () => {
  it("applies only allowlisted tokens", async () => {    const properties = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const fakeDocument = {
      documentElement: {
        style: {
          colorScheme: "",
          setProperty: (name: string, value: string) => { properties.set(name, value); },
          getPropertyValue: (name: string) => properties.get(name) ?? "",
        },
        dataset,
      },
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const { dispatch, make } = harness();
      const client = make();
      dispatch(
        initFor(client.nonce, {
          colorScheme: "dark",
          designTokens: { "--primary": "#fff", "--evil": "url(x)", "color": "red" },
        }),
      );
      await client.init;
      expect(properties.get("--primary")).toBe("#fff");
      expect(properties.has("--evil")).toBe(false);
      expect(properties.has("color")).toBe(false);
      expect(dataset.theme).toBe("dark");
      expect(fakeDocument.documentElement.style.colorScheme).toBe("dark");
      client.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries the whole chassis, not just the palette", async () => {
    // Every group the four plugins were re-deriving locally. One assertion per
    // group, because the groups are what a plugin lays out with: a build that
    // gets the colours and drops the radius scale is the bug this contract
    // exists to close, and it is invisible on screen wherever the plugin's own
    // fallback happens to agree with the console.
    const properties = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const fakeDocument = {
      documentElement: {
        style: {
          colorScheme: "",
          setProperty: (name: string, value: string) => { properties.set(name, value); },
          getPropertyValue: (name: string) => properties.get(name) ?? "",
        },
        dataset,
      },
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const { dispatch, make } = harness();
      const client = make();
      const contract: Record<string, string> = {
        "--accent": "oklch(0.285 0.02 235)",
        "--accent-foreground": "oklch(0.97 0.004 240)",
        "--destructive-foreground": "oklch(0.16 0.02 15)",
        "--success": "oklch(0.706 0.15 156)",
        "--success-foreground": "oklch(0.16 0.02 156)",
        "--warning": "oklch(0.8 0.16 80)",
        "--warning-foreground": "oklch(0.2 0.04 75)",
        "--info": "oklch(0.7 0.12 210)",
        "--info-foreground": "oklch(0.16 0.02 210)",
        "--success-text": "oklch(0.706 0.15 156)",
        "--warning-text": "oklch(0.8 0.16 80)",
        "--info-text": "oklch(0.7 0.12 210)",
        "--radius-sm": "3px",
        "--radius-md": "4px",
        "--radius-lg": "6px",
        "--radius-xl": "8px",
        "--radius": "4px",
        "--row-h": "40px",
        "--row-h-compact": "32px",
        "--space-1": "4px",
        "--space-2": "8px",
        "--space-3": "12px",
        "--space-4": "16px",
        "--space-5": "24px",
        "--space-6": "32px",
        "--space-7": "48px",
        "--font-mono": "ui-monospace, monospace",
        "--text-body": "14px",
        "--text-mono": "12px",
        "--shadow-overlay": "0 0 0 1px oklch(1 0 0 / 8%)",
        "--shadow-raised": "0 1px 2px oklch(0 0 0 / 40%)",
        "--duration-fast": "100ms",
        "--duration-base": "200ms",
        "--ease-out": "cubic-bezier(0.19, 1, 0.22, 1)",
      };
      dispatch(initFor(client.nonce, { colorScheme: "dark", designTokens: contract }));
      await client.init;
      for (const [name, value] of Object.entries(contract)) {
        expect(properties.get(name), `${name} was dropped by the allowlist`).toBe(value);
      }
      expect(properties.size).toBe(Object.keys(contract).length);
      client.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("theme state and subscription", () => {
  it("exposes theme after init, notifies subscribers on host theme updates, and honors unsubscribe", async () => {
    const { dispatch, make } = harness();
    const client = make();
    expect(client.theme).toBeNull();
    const seen: string[] = [];
    const unsubscribe = client.subscribeTheme((theme) => seen.push(String(theme.colorScheme)));
    dispatch(initFor(client.nonce, { colorScheme: "dark" }));
    await client.init;
    expect(client.theme?.colorScheme).toBe("dark");
    expect(seen).toEqual(["dark"]);
    dispatch({ type: "lattice.host.theme", nonce: client.nonce, colorScheme: "light", designTokens: {} });
    expect(seen).toEqual(["dark", "light"]);
    unsubscribe();
    dispatch({ type: "lattice.host.theme", nonce: client.nonce, colorScheme: "dark", designTokens: {} });
    expect(seen).toEqual(["dark", "light"]);
    client.dispose();
  });

  it("carries a custom dispose reason and keeps the default message otherwise", async () => {
    const { make } = harness();
    const client = make();
    const pending = client.call("svc", "read", null);
    client.dispose("ui unmounted");
    await expect(pending.promise).rejects.toThrow("ui unmounted");

    const second = make();
    const pendingSecond = second.call("svc", "read", null);
    second.dispose();
    await expect(pendingSecond.promise).rejects.toThrow("The console disconnected this plugin.");
  });
});

describe("error sentences", () => {
  it("says what the operator can do, not only what broke", async () => {
    // These messages reach the page through safeErrorMessage and the boot
    // notices. "Request timed out" left the operator guessing whether the
    // change happened; the sentence says it may have, and what to check.
    vi.useFakeTimers();
    const { posted, dispatch, make } = harness();
    const client = make();
    const timedOut = client.call("svc", "read", null, 5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(timedOut.promise).rejects.toThrow("It may still be running there, so re-check the state before retrying.");
    const cancelled = client.call("svc", "read", null);
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toThrow("so its outcome is unknown");
    const refused = client.call("svc", "read", null);
    dispatch({ type: "lattice.host.error", nonce: client.nonce, id: (posted.at(-1)?.message as { id: string }).id });
    await expect(refused.promise).rejects.toThrow("The console refused this request and gave no reason.");
    client.dispose();
    expect(() => client.call("svc", "read", null)).toThrow("nothing was sent");
    vi.useRealTimers();

    expect(() => harness("#host_origin=https%3A%2F%2Fdash.example").make()).toThrow("open the plugin from the console rather than directly");
  });
});

describe("page state", () => {
  it("passes the address state through init, and leaves it out when the host sent none", async () => {
    const withState = harness();
    const client = withState.make();
    withState.dispatch(initFor(client.nonce, { pageState: { view: "nodes", open: "node_a" } }));
    await expect(client.init).resolves.toMatchObject({ pageState: { view: "nodes", open: "node_a" } });

    const empty = harness();
    const emptyClient = empty.make();
    empty.dispatch(initFor(emptyClient.nonce, { pageState: {} }));
    expect((await emptyClient.init).pageState).toEqual({});

    // A console from before the contract: no field, so the page keeps its own.
    const old = harness();
    const oldClient = old.make();
    old.dispatch(initFor(oldClient.nonce));
    expect("pageState" in (await oldClient.init)).toBe(false);
  });

  it("sets aside a state that breaks the rules, and drops a reserved key on its own", async () => {
    const cases: [unknown, unknown][] = [
      [{ view: "nodes", Bad: "x" }, undefined],
      [{ view: "x".repeat(257) }, undefined],
      [{ view: 3 }, undefined],
      [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])), undefined],
      [["view"], undefined],
      // The host never sends these; if one arrives it costs only itself.
      [{ view: "nodes", code: "123456", token: "t" }, { view: "nodes" }],
    ];
    for (const [sent, expected] of cases) {
      const { dispatch, make } = harness();
      const client = make();
      dispatch(initFor(client.nonce, { pageState: sent }));
      // A bad state is a host fault, not a reason to fail the start.
      const init = await client.init;
      expect(init.pageState).toEqual(expected);
    }
  });

  it("sends the full state after init only, inside the rules, to the pinned origin", async () => {
    const { posted, dispatch, make } = harness();
    const client = make();
    const states = () => posted.filter((entry) => (entry.message as { type?: string }).type === "lattice.plugin.state");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Before init the page has not seen the address it would overwrite.
    expect(client.sendState({ view: "groups" })).toBe(false);
    expect(states()).toHaveLength(0);

    dispatch(initFor(client.nonce));
    await client.init;
    expect(client.sendState({ view: "groups", q: "port:22/tcp" })).toBe(true);
    expect(states()).toEqual([
      { message: { type: "lattice.plugin.state", nonce: client.nonce, state: { view: "groups", q: "port:22/tcp" } }, target: "https://dash.example" },
    ]);

    // Whole or nothing, as the host applies it. The page hears about it:
    // false every time, and one console warning for the first refusal only.
    expect(warn).not.toHaveBeenCalled();
    expect(client.sendState({ view: "groups", redirect: "/evil" })).toBe(false);
    expect(client.sendState({ view: "groups", q: "x".repeat(257) })).toBe(false);
    expect(states()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("at most 256 characters");

    client.dispose();
    expect(client.sendState({ view: "zones" })).toBe(false);
    expect(states()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("validPageState is the contract's rules, whole or nothing", () => {
    expect(validPageState({ view: "nodes", show: "attention" })).toEqual({ view: "nodes", show: "attention" });
    expect(validPageState({})).toEqual({});
    expect(validPageState({ "1view": "x" })).toBeUndefined();
    expect(validPageState({ mfa: "1" })).toBeUndefined();
    expect(validPageState(null)).toBeUndefined();
    expect(validPageState("view=nodes")).toBeUndefined();
  });
});
