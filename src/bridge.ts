/**
 * @latticenet/plugin-bridge — the one Lattice plugin-UI bridge client.
 *
 * Extracted (TASK-0004) from the four divergent per-plugin `bridge.ts` copies.
 * Reference behavior is the sub-store / vpn-core transport, the strongest of
 * the copies; the typed error taxonomy comes from the template copy. Protocol
 * semantics are unchanged — this package extracts, it does not redesign.
 *
 * Invariants (covered by package tests; a consumer must not be able to weaken
 * them):
 *  - the frame URL fragment must carry `lattice_nonce` (16–128 chars) and a
 *    `host_origin` that parses as an exact absolute http(s) origin — absence
 *    fails closed in the constructor;
 *  - inbound messages must match the nonce, the pinned origin exactly, and
 *    `event.source === window.parent`;
 *  - `lattice.host.init` must declare version "1", the consumer's plugin id,
 *    and one of its registered routes;
 *  - theme application filters host tokens to a fixed allowlist.
 */

export interface CallableInterface {
  service: string;
  methods: string[];
}

/** Theme state as last reported by the host (init or lattice.host.theme).
 *  colorScheme is the wire value verbatim ("light" | "dark" | "system" by
 *  convention); designTokens are the unfiltered host tokens. */
export interface HostTheme {
  colorScheme?: string;
  designTokens?: Record<string, unknown>;
}

export interface HostInit {
  version: string;
  pluginId: string;
  pluginVersion: string;
  pluginRoute: string;
  locale: string;
  colorScheme: string;
  designTokens: Record<string, string>;
  interfaces: CallableInterface[];
}

export interface BridgeClientOptions {
  /** The plugin's own window (its document lives in the sandboxed frame). */
  window: Window;
  /** Signed-manifest id, e.g. "latticenet.sub-store". */
  expectedPluginId: string;
  /** Manifest ui.views routes this build answers for. */
  expectedRoutes: readonly string[];
  /** Call-id prefix; defaults to "plugin". */
  idPrefix?: string;
  /** Ready-handshake retry cadence; defaults to 500 ms × 16 attempts. */
  readyRetryMs?: number;
  readyAttemptLimit?: number;
  /** Per-call default timeout; defaults to 15_000 ms. */
  defaultCallTimeoutMs?: number;
}

// ── typed errors (taxonomy from the template copy) ──────────────────────────

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The host answered a call with `lattice.host.error`. Carries the wire's
 *  error code (e.g. "denied") when the host supplied one. */
export class BridgeRemoteError extends BridgeError {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}
/** A call was cancelled via the handle's cancel(). */
export class BridgeCancelledError extends BridgeError {}
/** A call exceeded its timeout; a cancel was posted to the host. */
export class BridgeTimeoutError extends BridgeError {}
/** The host disposed the frame (or the client was disposed locally). */
export class BridgeDisposedError extends BridgeError {}
/** The frame URL fragment failed nonce/host_origin validation (fail-closed). */
export class BridgeHandshakeError extends BridgeError {}

// ── wire types ──────────────────────────────────────────────────────────────

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PluginMessage =
  | { type: "lattice.plugin.ready"; nonce: string }
  | { type: "lattice.plugin.call"; nonce: string; id: string; service: string; method: string; payload: unknown }
  | { type: "lattice.plugin.cancel"; nonce: string; id: string }
  | { type: "lattice.plugin.resize"; nonce: string; height: number };

/**
 * Token contract v2: the custom properties a Lattice host may write onto the
 * plugin document.
 *
 * The first version of this list was eleven colours, and every plugin
 * therefore re-derived its own radius scale, spacing scale, type sizes, status
 * colours, shadows and motion. Four plugins ended up with four namespaces and
 * three radius systems, none of them the console's. This list is the whole
 * chassis instead, under the host's own names, so a plugin declares the same
 * names on its `:root` as fallbacks (for its dev harness and for an older
 * host) and the host's inline values win wherever a host sends them.
 *
 * Widening the list widens nothing else. The filter is by name; values are
 * written with `style.setProperty`, which cannot execute or fetch anything,
 * and a name outside this set is dropped whatever it carries.
 */
export const HOST_TOKEN_NAMES: ReadonlySet<string> = new Set([
  // Surfaces, ink and state colour.
  "--background", "--foreground", "--card", "--card-foreground", "--muted",
  "--muted-foreground", "--accent", "--accent-foreground", "--border",
  "--primary", "--primary-foreground", "--destructive",
  "--destructive-foreground", "--ring",
  // Status semantics: the colours that carry meaning in a control plane.
  "--success", "--success-foreground", "--warning", "--warning-foreground",
  "--info", "--info-foreground",
  // Corner radius: four steps plus the shadcn alias.
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius",
  // Row rhythm, one per density.
  "--row-h", "--row-h-compact",
  // Spacing scale.
  "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6",
  "--space-7",
  // Type: the mono stack and the two sizes that do not inherit.
  "--font-mono", "--text-body", "--text-mono",
  // Elevation, for the surfaces that genuinely float.
  "--shadow-overlay", "--shadow-raised",
  // Motion: two durations and one curve.
  "--duration-fast", "--duration-base", "--ease-out",
]);

export class BridgeClient {
  readonly nonce: string;
  readonly init: Promise<HostInit>;

  private readonly win: Window;
  // hostOrigin pins both inbound and outbound messages; absence fails closed.
  private readonly hostOrigin: string;
  private readonly expectedPluginId: string;
  private readonly expectedRoutes: readonly string[];
  private readonly idPrefix: string;
  private readonly readyRetryMs: number;
  private readonly readyAttemptLimit: number;
  private readonly defaultCallTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private initResolve!: (value: HostInit) => void;
  private initReject!: (reason: Error) => void;
  private themeValue: HostTheme | null = null;
  private readonly themeListeners = new Set<(theme: HostTheme) => void>();
  private sequence = 0;
  private disposed = false;
  private readyAttempts = 0;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BridgeClientOptions) {
    this.win = options.window;
    this.expectedPluginId = options.expectedPluginId;
    this.expectedRoutes = options.expectedRoutes;
    this.idPrefix = options.idPrefix ?? "plugin";
    this.readyRetryMs = options.readyRetryMs ?? 500;
    this.readyAttemptLimit = options.readyAttemptLimit ?? 16;
    this.defaultCallTimeoutMs = options.defaultCallTimeoutMs ?? 15_000;
    const channel = readChannel(this.win.location.hash);
    this.nonce = channel.nonce;
    this.hostOrigin = channel.hostOrigin;
    this.init = new Promise<HostInit>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.init.catch(() => {});
    this.onMessage = this.onMessage.bind(this);
    this.win.addEventListener("message", this.onMessage);
    this.postReady();
  }

  call<T>(service: string, method: string, payload: unknown, timeoutMs?: number): { promise: Promise<T>; cancel: () => void } {
    if (this.disposed) throw new BridgeDisposedError("plugin bridge is disposed");
    const id = `${this.idPrefix}-${++this.sequence}`;
    let cancel = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.post({ type: "lattice.plugin.cancel", nonce: this.nonce, id });
        reject(new BridgeTimeoutError("Request timed out"));
      }, timeoutMs ?? this.defaultCallTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        this.post({ type: "lattice.plugin.cancel", nonce: this.nonce, id });
        pending.reject(new BridgeCancelledError("Request cancelled"));
      };
      this.post({ type: "lattice.plugin.call", nonce: this.nonce, id, service, method, payload });
    });
    promise.catch(() => {});
    return { promise, cancel };
  }

  /** Theme last reported by the host, or null before init. */
  get theme(): HostTheme | null {
    return this.themeValue;
  }

  /** Subscribe to host theme reports (init + lattice.host.theme). Returns the unsubscribe. */
  subscribeTheme(listener: (theme: HostTheme) => void): () => void {
    this.themeListeners.add(listener);
    return () => {
      this.themeListeners.delete(listener);
    };
  }

  resize(height: number): void {
    if (!this.disposed && Number.isFinite(height)) {
      this.post({ type: "lattice.plugin.resize", nonce: this.nonce, height: Math.ceil(height) });
    }
  }

  dispose(reason?: string): void {
    this.failBridge(new BridgeDisposedError(reason ?? "Plugin host disconnected"));
  }

  private onMessage(event: MessageEvent): void {
    if (this.disposed || event.source !== this.win.parent || !isRecord(event.data) || event.data.nonce !== this.nonce) return;
    if (event.origin !== this.hostOrigin) return;
    const message = event.data;
    switch (message.type) {
      case "lattice.host.init": {
        const init = this.parseInit(message);
        if (!init) return;
        this.clearReadyTimer();
        this.setTheme({ colorScheme: init.colorScheme, designTokens: init.designTokens });
        this.initResolve(init);
        return;
      }
      case "lattice.host.theme":
        if (typeof message.colorScheme === "string" && isStringRecord(message.designTokens)) {
          this.setTheme({ colorScheme: message.colorScheme, designTokens: message.designTokens });
        }
        return;
      case "lattice.host.result":
        this.finish(message.id, undefined, message.result);
        return;
      case "lattice.host.error":
        if (typeof message.id === "string") {
          this.finish(message.id, new BridgeRemoteError(
            typeof message.message === "string" ? message.message : "Plugin call failed",
            typeof message.code === "string" ? message.code : undefined,
          ));
        } else {
          this.failBridge(new BridgeRemoteError(
            typeof message.message === "string" ? message.message : "Plugin host rejected initialization",
            typeof message.code === "string" ? message.code : undefined,
          ));
        }
        return;
      case "lattice.host.dispose":
        this.dispose();
    }
  }

  private finish(value: unknown, error?: Error, result?: unknown): void {
    if (typeof value !== "string") return;
    const pending = this.pending.get(value);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private post(message: PluginMessage): void {
    this.win.parent.postMessage(message, this.hostOrigin);
  }

  private postReady(): void {
    if (this.disposed || this.readyAttempts >= this.readyAttemptLimit) return;
    this.readyAttempts += 1;
    this.post({ type: "lattice.plugin.ready", nonce: this.nonce });
    if (this.readyAttempts < this.readyAttemptLimit) {
      this.readyTimer = setTimeout(() => this.postReady(), this.readyRetryMs);
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private setTheme(theme: { colorScheme: string; designTokens: Record<string, string> }): void {
    this.themeValue = theme;
    applyTheme(theme.colorScheme, theme.designTokens);
    for (const listener of this.themeListeners) listener(theme);
  }

  private failBridge(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReadyTimer();
    this.win.removeEventListener("message", this.onMessage);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.initReject(error);
  }

  private parseInit(message: Record<string, unknown>): HostInit | undefined {
    if (typeof message.version !== "string" || typeof message.pluginId !== "string" ||
        typeof message.pluginVersion !== "string" || typeof message.pluginRoute !== "string" ||
        typeof message.locale !== "string" || typeof message.colorScheme !== "string" ||
        !isStringRecord(message.designTokens) || !Array.isArray(message.interfaces) ||
        message.version !== "1" || message.pluginId !== this.expectedPluginId ||
        !this.expectedRoutes.includes(message.pluginRoute)) return undefined;
    const interfaces: CallableInterface[] = [];
    for (const value of message.interfaces) {
      if (!isRecord(value) || typeof value.service !== "string" || !Array.isArray(value.methods) ||
          !value.methods.every((method) => typeof method === "string")) return undefined;
      interfaces.push({ service: value.service, methods: value.methods as string[] });
    }
    return {
      version: message.version,
      pluginId: message.pluginId,
      pluginVersion: message.pluginVersion,
      pluginRoute: message.pluginRoute,
      locale: message.locale,
      colorScheme: message.colorScheme,
      designTokens: message.designTokens,
      interfaces,
    };
  }
}

export function canCall(init: HostInit | undefined, service: string, method: string): boolean {
  return init?.interfaces.some((contract) => contract.service === service && contract.methods.includes(method)) === true;
}

function readChannel(hash: string): { nonce: string; hostOrigin: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const nonce = params.get("lattice_nonce");
  if (!nonce || nonce.length < 16 || nonce.length > 128) throw new BridgeHandshakeError("Missing plugin channel nonce");
  const hostOrigin = params.get("host_origin")?.trim();
  if (!hostOrigin) throw new BridgeHandshakeError("Missing plugin host origin");
  // Must be an exact absolute http(s) origin — anything else is a host bug
  // or a tampered frame URL, and neither is a reason to silently downgrade.
  let parsed: URL;
  try {
    parsed = new URL(hostOrigin);
  } catch {
    throw new BridgeHandshakeError("Invalid plugin host origin");
  }
  if (parsed.origin !== hostOrigin || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new BridgeHandshakeError("Invalid plugin host origin");
  }
  return { nonce, hostOrigin };
}

function applyTheme(colorScheme: string, tokens: Record<string, string>): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.colorScheme = colorScheme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = colorScheme === "dark" ? "dark" : "light";
  for (const [name, value] of Object.entries(tokens)) {
    if (HOST_TOKEN_NAMES.has(name)) document.documentElement.style.setProperty(name, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
