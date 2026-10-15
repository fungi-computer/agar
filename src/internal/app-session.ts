import * as Schema from "effect/Schema";
/**
 * WHY: one session owns stores, callbacks, transport, and terminal teardown;
 * versioned host facts are applied only at this seam (2026-08-27).
 */
import {
  newMessagePortRpcSession,
  RpcStub,
  RpcTarget,
} from "@fungi.computer/capnweb";

import type { AppContext, AppLifecycle } from "../lifecycle.js";
import type { AppRoot } from "../root.js";
import type {
  AppStatusAction,
  AppStatusActionHandler,
  AppStatusItem,
  HostUi,
} from "../ui.js";
import { statusActionAllowed } from "../status.js";
import type {
  AppBackHandler,
  AppNavigationState,
  AppWindow,
  BeforeAppClose,
} from "../window.js";
import type { AppErrorData } from "./app-error.js";

import { AppError } from "../errors.js";
import { reportCatchFailure } from "../failure.js";
import {
  createLocalBindingState,
  createReservedChordState,
  installBrowserBridge,
} from "./browser-bridge.js";
import { installBackInputs, macHistoryKeys } from "./back-inputs.js";
import {
  createCapabilityDirectory,
  disposeRpcValue,
  type CapabilityDirectoryController,
} from "./capabilities.js";
import { createAppCommands } from "./commands.js";
import {
  APP_PROTOCOL_VERSION,
  type AppClientRpc,
  type AppHostRpc,
  type HostBootstrapWire,
  type CapabilityGrantWire,
  type ReservedChord,
  type VersionedFact,
} from "./protocol.js";
import { callRpc, rpcFailure, rpcSuccess, unwrapRpcResult } from "./result.js";
import {
  parseBrowserAction,
  parseBrowserActionOutcomeResult,
  parseBootstrapResult,
  parseHostReconfiguration,
  parseContext,
  parseErrorData,
  parseFact,
  parseAgentSessionSelection,
  parseIdentity,
  parseLifecycle,
  parseNavigation,
  parseStatusAction,
  parseStatusItems,
  parseNavigationStateInput,
  parsePermissionOutcomeResult,
  parsePermissionRequest,
  parseReservedChords,
  parseTheme,
  parseToast,
  parseVoidResult,
} from "./schemas.js";

const rpcStubSchema = Schema.declare<RpcStub<object>>(
  (value): value is RpcStub<object> => value instanceof RpcStub,
);
import { createReadonlyStore } from "./store.js";

type ClientState = {
  capabilities?: CapabilityDirectoryController;
  beforeClose?: BeforeAppClose;
  back?: AppBackHandler;
  statusAction?: AppStatusActionHandler;
  /** What the App last declared for its status bar; actions must match it. */
  statusItems: readonly AppStatusItem[];
  /** What the App last published; browser back inputs follow it. */
  canGoBack: boolean;
  readonly bindings: ReturnType<typeof createLocalBindingState>;
  readonly chords: ReturnType<typeof createReservedChordState>;
  readonly context: ReturnType<typeof createReadonlyStore<AppContext>>;
  disconnect?: (error?: AppErrorData) => void;
  readonly lifecycle: ReturnType<typeof createReadonlyStore<AppLifecycle>>;
  readonly theme: ReturnType<typeof createReadonlyStore<string>>;
  readonly versions: {
    chords: number;
    context: number;
    lifecycle: number;
    theme: number;
  };
};

class AppClientTarget extends RpcTarget implements AppClientRpc {
  #disposed = false;
  readonly #state: ClientState;

  constructor(state: ClientState) {
    super();
    this.#state = state;
  }

  disconnect(error?: AppErrorData) {
    try {
      if (this.#disposed) throw disconnected();
      const cause = error === undefined ? undefined : parseErrorData(error);
      // The RPC result is the graceful-disconnect acknowledgement. Closing the
      // port on a later turn lets Cap'n Web send that acknowledgement first.
      setTimeout(
        () => this.#state.disconnect?.(cause ?? gracefulDisconnect()),
        0,
      );
      return Promise.resolve(rpcSuccess(undefined));
    } catch (cause) {
      return Promise.resolve(rpcFailure<undefined>(cause));
    }
  }

  async requestClose() {
    try {
      if (this.#disposed) throw disconnected();
      return rpcSuccess(await (this.#state.beforeClose?.() ?? true));
    } catch (cause) {
      return rpcFailure<boolean>(cause);
    }
  }

  async requestBack() {
    try {
      if (this.#disposed) throw disconnected();
      return rpcSuccess(await (this.#state.back?.() ?? false));
    } catch (cause) {
      return rpcFailure<boolean>(cause);
    }
  }

  async activateStatus(value: AppStatusAction) {
    try {
      if (this.#disposed) throw disconnected();
      const action = parseStatusAction(value);
      // A shell's stale copy can still send an item the App has since
      // dropped or disabled; only what it declares now reaches the App.
      if (!statusActionAllowed(this.#state.statusItems, action))
        return rpcSuccess(false);
      return rpcSuccess(await (this.#state.statusAction?.(action) ?? false));
    } catch (cause) {
      return rpcFailure<boolean>(cause);
    }
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
  }

  async updateContext(value: VersionedFact<AppContext>) {
    if (this.#disposed) return rpcFailure<undefined>(disconnected());
    return this.#update(value, "context", parseContext, (next) => {
      this.#state.context.update(next);
    });
  }

  reconfigure(value: Parameters<AppClientRpc["reconfigure"]>[0]) {
    let retained: CapabilityGrantWire[] = [];
    try {
      if (this.#disposed) throw disconnected();
      const next = parseHostReconfiguration(value);
      if (next.context.version <= this.#state.versions.context) {
        return Promise.resolve(rpcSuccess(undefined));
      }
      // RPC argument handles are disposed when this call returns. The directory
      // owns duplicates until the next replacement or App disposal.
      for (const grant of next.capabilities)
        retained.push({
          ...grant,
          handle: Schema.decodeUnknownSync(rpcStubSchema)(grant.handle).dup(),
        });
      if (!this.#state.capabilities) throw disconnected();
      this.#state.capabilities.replace(retained);
      retained = [];
      this.#state.versions.context = next.context.version;
      this.#state.context.update(next.context.value);
      return Promise.resolve(rpcSuccess(undefined));
    } catch (cause) {
      for (const grant of retained) disposeRpcValue(grant.handle);
      return Promise.resolve(rpcFailure<undefined>(cause));
    }
  }

  updateLifecycle(value: VersionedFact<AppLifecycle>) {
    try {
      if (this.#disposed) throw disconnected();
      const fact = parseFact(parseLifecycle)(value);
      if (fact.version <= this.#state.versions.lifecycle)
        return Promise.resolve(rpcSuccess(undefined));
      const current = this.#state.lifecycle.get();
      if (!isHostLifecycleTransition(current, fact.value)) {
        throw new AppError("The host sent an invalid lifecycle transition", {
          code: "PROTOCOL",
          retryable: false,
        });
      }
      this.#state.versions.lifecycle = fact.version;
      this.#state.lifecycle.update(fact.value);
      return Promise.resolve(rpcSuccess(undefined));
    } catch (cause) {
      return Promise.resolve(rpcFailure<undefined>(cause));
    }
  }

  async updateReservedChords(value: VersionedFact<readonly ReservedChord[]>) {
    if (this.#disposed) return rpcFailure<undefined>(disconnected());
    return this.#update(value, "chords", parseReservedChords, (next) => {
      this.#state.chords.update(next);
    });
  }

  async updateTheme(value: VersionedFact<string>) {
    if (this.#disposed) return rpcFailure<undefined>(disconnected());
    return this.#update(value, "theme", parseTheme, (next) => {
      this.#state.theme.update(next);
    });
  }

  #update<T>(
    value: VersionedFact<T>,
    key: "chords" | "context" | "theme",
    parse: ReturnType<typeof Schema.decodeUnknownSync<Schema.Decoder<T>>>,
    apply: (next: T) => void,
  ) {
    try {
      const fact = parseFact(parse)(value);
      if (fact.version > this.#state.versions[key]) {
        this.#state.versions[key] = fact.version;
        apply(fact.value);
      }
      return Promise.resolve(rpcSuccess(undefined));
    } catch (cause) {
      return Promise.resolve(rpcFailure<undefined>(cause));
    }
  }
}

export async function connectAppPort(options: {
  readonly epoch: string;
  readonly isActive: () => boolean;
  readonly onDisposed: () => void;
  readonly port: MessagePort;
  readonly window: Window;
}): Promise<AppRoot> {
  const state = createClientState();
  const target = new AppClientTarget(state);
  const remote = newMessagePortRpcSession<AppHostRpc>(options.port, target);
  let bootstrapOwner:
    Awaited<ReturnType<RpcStub<AppHostRpc>["connect"]>> | undefined;
  const brokenPromise = createBrokenPromise(remote);
  try {
    performance.mark("fungi.app-open.agar-rpc-connect-start");
    const result = await Promise.race([
      remote.connect({
        epoch: options.epoch,
        protocolVersion: APP_PROTOCOL_VERSION,
      }),
      brokenPromise,
    ]);
    performance.mark("fungi.app-open.agar-rpc-connect-ready");
    bootstrapOwner = result;
    const bootstrap = unwrapRpcResult(parseBootstrapResult(result));
    if (!options.isActive()) throw cancelled();
    const root = createRoot({
      bootstrap,
      bootstrapOwner,
      options,
      remote,
      state,
      target,
    });
    performance.mark("fungi.app-open.agar-root-created");
    bootstrapOwner = undefined;
    return root;
  } catch (cause) {
    return rejectConnection(cause, options, target, remote, bootstrapOwner);
  }
}

function applyBootstrapFacts(
  state: ClientState,
  facts: ReturnType<typeof parseBootstrapFacts>,
): void {
  state.context.update(facts.context.value);
  state.theme.update(facts.theme.value);
  state.lifecycle.update(facts.lifecycle.value);
  state.chords.update(facts.chords.value);
  state.versions.context = facts.context.version;
  state.versions.theme = facts.theme.version;
  state.versions.lifecycle = facts.lifecycle.version;
  state.versions.chords = facts.chords.version;
}

function cancelled(): AppError {
  return new AppError("App connection was cancelled", {
    code: "CANCELLED",
    retryable: false,
  });
}

function createBrokenPromise(remote: RpcStub<AppHostRpc>): Promise<never> {
  let broken: ((error: AppError) => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    broken = reject;
  });
  promise.catch((cause: unknown) => {
    reportCatchFailure("app-session.rpc-disconnect", cause);
  });
  remote.onRpcBroken(() =>
    broken?.(
      new AppError("The app host disconnected", {
        code: "DISCONNECTED",
        retryable: true,
      }),
    ),
  );
  return promise;
}

function createClientState(): ClientState {
  return {
    statusItems: [],
    bindings: createLocalBindingState(),
    chords: createReservedChordState([]),
    context: createReadonlyStore({
      computerId: null,
      focus: { editing: false, surface: null },
      openRequest: null,
      visibility: "hidden",
    }),
    lifecycle: createReadonlyStore("connecting"),
    theme: createReadonlyStore("default"),
    canGoBack: false,
    versions: { chords: -1, context: -1, lifecycle: -1, theme: -1 },
  };
}

function createRoot(options: {
  readonly bootstrap: HostBootstrapWire;
  readonly bootstrapOwner: Awaited<ReturnType<RpcStub<AppHostRpc>["connect"]>>;
  readonly options: {
    readonly onDisposed: () => void;
    readonly port: MessagePort;
    readonly window: Window;
  };
  readonly remote: RpcStub<AppHostRpc>;
  readonly state: ClientState;
  readonly target: AppClientTarget;
}): AppRoot {
  const identity = parseIdentity(options.bootstrap.identity);
  const facts = parseBootstrapFacts(options.bootstrap);
  applyBootstrapFacts(options.state, facts);
  const capabilities = createCapabilityDirectory(
    options.bootstrap.capabilities,
  );
  options.state.capabilities = capabilities;
  return createRootRuntime(options, identity, capabilities);
}

function createRootBridge(
  options: Parameters<typeof createRoot>[0],
  identity: ReturnType<typeof parseIdentity>,
  dispose: (error: AppErrorData) => void,
): () => void {
  return installBrowserBridge({
    bindings: options.state.bindings,
    chords: options.state.chords,
    identity,
    onBroken: (cause) => {
      dispose({
        code: "DISCONNECTED",
        message:
          cause instanceof AppError
            ? cause.message
            : "The app host rejected a browser bridge operation",
        retryable: true,
      });
    },
    remote: options.remote,
    window: options.options.window,
  });
}

function createRootRuntime(
  options: Parameters<typeof createRoot>[0],
  identity: ReturnType<typeof parseIdentity>,
  capabilities: ReturnType<typeof createCapabilityDirectory>,
): AppRoot {
  let disposed = false;
  const dispose = (error?: AppErrorData): void => {
    if (disposed) return;
    disposed = true;
    exhaustCleanup(
      [
        () => {
          if (error) options.state.lifecycle.update("disconnected");
        },
        () => {
          options.state.lifecycle.update("disposing");
        },
        removeBrowserBridge,
        removeBackInputs,
        () => {
          commands.dispose();
        },
        () => {
          options.state.beforeClose = undefined;
          options.state.back = undefined;
          options.state.statusAction = undefined;
        },
        () => {
          capabilities.disconnect();
        },
        () => {
          options.target[Symbol.dispose]();
        },
        () => {
          disposeRpcValue(options.bootstrapOwner);
        },
        () => {
          disposeRpcValue(options.remote);
        },
        () => {
          options.options.port.close();
        },
        () => {
          options.state.lifecycle.update("disposed");
        },
        options.options.onDisposed,
      ],
      "app connection disposal",
    );
  };
  const assertConnected = (): void => {
    if (disposed)
      throw new AppError("The app connection is disposed", {
        code: "DISCONNECTED",
        retryable: true,
      });
  };
  const commands = createAppCommands(
    options.remote,
    assertConnected,
    () => {
      dispose({
        code: "DISCONNECTED",
        message: "The app host rejected a terminal command operation",
        retryable: true,
      });
    },
    options.state.bindings,
  );
  const ui = createRootUi(options.remote, assertConnected, options.state);
  const appWindow = createAppWindow(
    options.state,
    options.remote,
    assertConnected,
  );
  const removeBrowserBridge = createRootBridge(options, identity, dispose);
  const removeBackInputs = installBackInputs({
    window: options.options.window,
    mac: macHistoryKeys(),
    canGoBack: () =>
      options.state.canGoBack && options.state.back !== undefined,
    back: () => {
      const back = options.state.back;
      if (!back) return;
      void Promise.resolve()
        .then(back)
        .catch((cause: unknown) => {
          reportCatchFailure("app-window.back-input", cause);
        });
    },
  });
  options.state.disconnect = dispose;
  options.remote.onRpcBroken(() => {
    disposeRemoteSession(dispose);
  });
  return exposeRoot({
    capabilities: capabilities.directory,
    commands: commands.commands,
    context: options.state.context,
    dispose,
    identity,
    lifecycle: options.state.lifecycle,
    theme: options.state.theme,
    ui,
    window: appWindow,
  });
}

function createAppWindow(
  state: ClientState,
  remote: RpcStub<AppHostRpc>,
  assertConnected: () => void,
): AppWindow {
  const navigation = Object.freeze({
    async publish(input: AppNavigationState) {
      assertConnected();
      const wire = parseNavigationStateInput(input);
      state.canGoBack = wire.canGoBack;
      await callRpc(remote.reportNavigation(wire), parseVoidResult);
    },
    onBack(handler: AppBackHandler) {
      assertConnected();
      if (state.back !== undefined)
        throw new AppError("The App already owns Back requests", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      state.back = handler;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (state.back === handler) state.back = undefined;
      };
    },
  });
  return Object.freeze({
    navigation,
    onBeforeClose(handler: BeforeAppClose) {
      assertConnected();
      if (state.beforeClose !== undefined)
        throw new AppError("The App already owns a close consultation", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      state.beforeClose = handler;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (state.beforeClose === handler) state.beforeClose = undefined;
      };
    },
  });
}

function createRootUi(
  remote: RpcStub<AppHostRpc>,
  assertConnected: () => void,
  state: ClientState,
): HostUi {
  return Object.freeze({
    async requestComputerChoice() {
      assertConnected();
      await callRpc(remote.requestComputerChoice(), parseVoidResult);
    },
    async requestBrowserAction(
      input: Parameters<HostUi["requestBrowserAction"]>[0],
    ) {
      assertConnected();
      const parsed = parseBrowserAction(input);
      if (parsed.kind === "refused") return parsed;
      return await callRpc(
        remote.requestBrowserAction(parsed),
        parseBrowserActionOutcomeResult,
      );
    },
    onStatusAction(handler: AppStatusActionHandler) {
      assertConnected();
      if (state.statusAction !== undefined)
        throw new AppError("The App already owns its status actions", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      state.statusAction = handler;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (state.statusAction === handler) state.statusAction = undefined;
      };
    },
    async requestAppPermissions(
      input: Parameters<HostUi["requestAppPermissions"]>[0],
    ) {
      assertConnected();
      return await callRpc(
        remote.requestAppPermissions(parsePermissionRequest(input)),
        parsePermissionOutcomeResult,
      );
    },
    async openDesktopSettings() {
      assertConnected();
      await callRpc(remote.openDesktopSettings(), parseVoidResult);
    },
    async openTeamBilling() {
      assertConnected();
      await callRpc(remote.openTeamBilling(), parseVoidResult);
    },
    async openNavigation(input: Parameters<HostUi["openNavigation"]>[0]) {
      assertConnected();
      await callRpc(
        remote.openNavigation(parseNavigation(input)),
        parseVoidResult,
      );
    },
    async reportStatus(items: Parameters<HostUi["reportStatus"]>[0]) {
      assertConnected();
      const parsed = parseStatusItems(items);
      // Actions are checked against this as soon as the App declares it.
      state.statusItems = parsed;
      await callRpc(remote.reportStatus(parsed), parseVoidResult);
    },
    async reportAgentSessionSelection(
      selection: Parameters<HostUi["reportAgentSessionSelection"]>[0],
    ) {
      assertConnected();
      await callRpc(
        remote.reportAgentSessionSelection(
          parseAgentSessionSelection(selection),
        ),
        parseVoidResult,
      );
    },
    async showToast(input: Parameters<HostUi["showToast"]>[0]) {
      assertConnected();
      await callRpc(remote.showToast(parseToast(input)), parseVoidResult);
    },
  });
}

function disconnected(): AppError {
  return new AppError("The app connection is disposed", {
    code: "DISCONNECTED",
    retryable: true,
  });
}

function disposeRemoteSession(dispose: (error: AppErrorData) => void): void {
  dispose({
    code: "DISCONNECTED",
    message: "The app host disconnected",
    retryable: true,
  });
}

function exhaustCleanup(
  cleanups: readonly (() => void)[],
  label: string,
): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (cause) {
      console.warn(`${label} cleanup failed`, cause);
    }
  }
}

function exposeRoot(value: AppRoot): AppRoot {
  return Object.freeze(value);
}

function gracefulDisconnect(): AppErrorData {
  return {
    code: "DISCONNECTED",
    message: "The app host disconnected",
    retryable: false,
  };
}

function isHostLifecycleTransition(
  current: AppLifecycle,
  next: AppLifecycle,
): boolean {
  return (
    current === next ||
    (current === "connected" && next === "suspended") ||
    (current === "suspended" && next === "connected")
  );
}

function parseBootstrapFacts(bootstrap: HostBootstrapWire) {
  const context = parseFact(parseContext)(bootstrap.context);
  const theme = parseFact(parseTheme)(bootstrap.theme);
  const lifecycle = parseFact(parseLifecycle)(bootstrap.lifecycle);
  const chords = parseFact(parseReservedChords)(bootstrap.reservedChords);
  if (lifecycle.value !== "connected" && lifecycle.value !== "suspended")
    throw new AppError("The bootstrap lifecycle is invalid", {
      code: "PROTOCOL",
      retryable: false,
    });
  return { chords, context, lifecycle, theme };
}

function rejectConnection(
  cause: unknown,
  options: { readonly onDisposed: () => void; readonly port: MessagePort },
  target: AppClientTarget,
  remote: RpcStub<AppHostRpc>,
  bootstrapOwner:
    Awaited<ReturnType<RpcStub<AppHostRpc>["connect"]>> | undefined,
): never {
  exhaustCleanup(
    [
      () => {
        target[Symbol.dispose]();
      },
      () => {
        if (bootstrapOwner) disposeRpcValue(bootstrapOwner);
      },
      () => {
        disposeRpcValue(remote);
      },
      () => {
        options.port.close();
      },
      options.onDisposed,
    ],
    "app connection rejection",
  );
  throw cause instanceof AppError
    ? cause
    : new AppError("Unable to establish the app RPC session", {
        cause,
        code: "PROTOCOL",
        retryable: false,
      });
}
