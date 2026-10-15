import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
/**
 * WHY: the host adapter is the sole authority for iframe identity, epochs,
 * and Cap'n Web resource lifetime; apps never authorize themselves (2026-08-27).
 */
import {
  newMessagePortRpcSession,
  RpcStub,
  type RpcStub as RpcStubType,
  RpcTarget,
} from "@fungi.computer/capnweb";

import type { AppCommand } from "./commands.js";
import type {
  WhistleExecutionOrigin,
  WhistleJsonValue,
} from "@fungi.computer/whistle";
import { WhistleActionError } from "@fungi.computer/whistle";
import type { AppContext, AppIdentity, FocusState } from "./lifecycle.js";
import type { AppNavigationState } from "./window.js";
import type {
  AppBrowserAction,
  AppBrowserActionOutcome,
  AgentSessionSelection,
  AppPermissionOutcome,
  AppPermissionRequest,
  AppStatusAction,
  AppStatusItem,
  FileNavigationInput,
  ToastInput,
} from "./ui.js";

import { AppError } from "./errors.js";
import { reportCatchFailure } from "./failure.js";
import { disposeRpcValue } from "./internal/capabilities.js";
import { disconnectHost } from "./internal/disconnect-host.js";
import {
  APP_CONNECT_TYPE,
  APP_PROTOCOL_VERSION,
  APP_READY_TYPE,
  type AppConnectMessage,
  type AppClientRpc,
  type AppHostRpc,
  type AppHostReconfigurationWire,
  type CommandHandlerRpc,
  type CommandInvocationWire,
  type ConnectRequestWire,
  type HostBootstrapWire,
  type NavigationStateWire,
  type RegisteredCommandWire,
  type VersionedFact,
} from "./internal/protocol.js";
import {
  callRpc,
  rpcFailure,
  rpcSuccess,
  type RpcResult,
} from "./internal/result.js";
import {
  parseBrowserAction,
  parseChordInvocation,
  parseCommandResultRpc,
  parseBackDecisionResult,
  parseCloseDecisionResult,
  parseCommand,
  parseCommandId,
  parseConnectRequest,
  parseContextFact,
  parseFocus,
  parseAgentSessionSelection,
  parseLocalHostBootstrap,
  parseHostLifecycleFact,
  parseNavigation,
  parseNavigationState,
  parseStatusAction,
  parseStatusItems,
  parsePermissionRequest,
  parseReady,
  parseReservedChordsFact,
  parseThemeFact,
  parseToast,
  parseVoidResult,
} from "./internal/schemas.js";
import {
  createTerminalGate,
  type TerminalGate,
} from "./internal/terminal-gate.js";

export type AppHost = {
  disconnect(error?: AppError): Promise<void>;
  dispose(): void;
  requestClose(): Promise<boolean>;
  /** Ask the App to go back one step in its own history; `true` when it did. */
  requestBack(): Promise<boolean>;
  /** Deliver the person's use of a status item; `true` when the App acted. */
  activateStatus(action: AppStatusAction): Promise<boolean>;
  updateContext(fact: AppHostFact<AppContext>): Promise<void>;
  reconfigure(value: AppHostReconfiguration): Promise<void>;
  updateLifecycle(fact: AppHostFact<"connected" | "suspended">): Promise<void>;
  updateReservedChords(
    fact: AppHostFact<readonly AppHostReservedChord[]>,
  ): Promise<void>;
  updateTheme(fact: AppHostFact<string>): Promise<void>;
};

export type AppHostReconfiguration = {
  readonly capabilities: AppHostLaunch["capabilities"];
  readonly context: AppHostFact<AppContext>;
};

export type AppHostFact<T> = {
  readonly value: T;
  readonly version: number;
};

export type AppHostHandlers = {
  /** Open the embedding host's picker, without accepting an App-selected Computer. */
  readonly requestComputerChoice?: () => Promise<void>;
  readonly requestBrowserAction?: (
    input: AppBrowserAction,
  ) => Promise<AppBrowserActionOutcome>;
  readonly invokeReservedChord: (input: {
    readonly id: string;
    readonly repeat: boolean;
  }) => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
  readonly openNavigation: (input: FileNavigationInput) => Promise<void>;
  readonly openTeamBilling?: () => Promise<void>;
  readonly openDesktopSettings?: () => Promise<void>;
  readonly requestAppPermissions?: (
    input: AppPermissionRequest,
  ) => Promise<AppPermissionOutcome>;
  readonly registerCommands: (input: {
    readonly commands: readonly AppCommand[];
    readonly invoke: (
      commandId: string,
      input: {
        readonly arguments?: WhistleJsonValue;
        readonly origin: WhistleExecutionOrigin;
        readonly signal?: AbortSignal;
      },
    ) => Promise<WhistleJsonValue | undefined>;
  }) => Promise<AppCommandContribution>;
  readonly reportFocus: (input: FocusState) => Promise<void>;
  /** The App's latest navigation state; hosts without window chrome omit it. */
  readonly reportNavigation?: (input: AppNavigationState) => Promise<void>;
  /** The App's latest status readouts; hosts without a status bar omit it. */
  readonly reportStatus?: (items: readonly AppStatusItem[]) => Promise<void>;
  readonly reportAgentSessionSelection: (
    input: AgentSessionSelection | null,
  ) => Promise<void>;
  readonly showToast: (input: ToastInput) => Promise<void>;
};

/** One host-owned Whistle contribution for all commands in an App mount. */
export type AppCommandContribution = {
  readonly update: (commands: readonly AppCommand[]) => void;
  readonly dispose: () => void;
};

export type AppHostLaunch = {
  readonly capabilities: readonly {
    /** A live Cap'n Web handle; it remains opaque to the adapter. */
    readonly handle: object;
    readonly id: string;
    readonly version: number;
  }[];
  readonly context: AppHostFact<AppContext>;
  readonly identity: AppIdentity;
  readonly lifecycle: AppHostFact<"connected" | "suspended">;
  readonly reservedChords: AppHostFact<readonly AppHostReservedChord[]>;
  readonly theme: AppHostFact<string>;
};

export type AppHostReservedChord = {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly id: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
};

export type ConnectAppHostOptions = {
  readonly appWindow: {
    postMessage(
      message: AppConnectMessage,
      targetOrigin: string,
      transfer: Transferable[],
    ): void;
  };
  /** Serialized document origin; "null" requires a host-owned opaque sandbox. */
  readonly expectedAppOrigin: string;
  readonly handlers: AppHostHandlers;
  readonly hostWindow: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly launch: AppHostLaunch;
  readonly signal?: AbortSignal;
};

/** Only the addressed postMessage door is needed to mount an App. */
type AppWindowPort = {
  postMessage(
    message: AppConnectMessage,
    targetOrigin: string,
    transfer: Transferable[],
  ): void;
};

/** One pending or live mount belongs to each iframe WindowProxy. */
const liveMounts = new WeakMap<AppWindowPort, PendingHostMount>();

type RetainedCommand = {
  readonly callback: RetainedCommandHandler;
  readonly requests: Set<string>;
  readonly command: AppCommand;
};

type RetainedCommandHandler = RpcStubType<CommandHandlerRpc>;
const retainedCommandHandlerSchema = Schema.declare<RetainedCommandHandler>(
  (value): value is RetainedCommandHandler => value instanceof RpcStub,
);

type PendingRegistration = Readonly<{
  readonly commandId: string;
  readonly command: RetainedCommand;
}>;

class MountedHost extends RpcTarget implements AppHostRpc {
  readonly #commands = new Map<string, RetainedCommand>();
  readonly #pendingCommands = new Map<string, RetainedCommand>();
  readonly #pendingUnregistrations = new Set<string>();
  #contribution: AppCommandContribution | undefined;
  #sync: Promise<void> = Promise.resolve();
  #connected = false;
  #disposed = false;
  readonly #handlers: AppHostHandlers;
  readonly #launch: HostBootstrapWire;
  #onConnected: (() => void) | undefined;
  #onFatal: (() => void) | undefined;

  constructor(
    launch: AppHostLaunch,
    handlers: AppHostHandlers,
    readonly epoch: string,
  ) {
    super();
    this.#launch = parseLocalHostBootstrap(launch);
    this.#handlers = handlers;
  }

  connect(value: ConnectRequestWire) {
    try {
      this.#assertLive();
      const request = parseConnectRequest(value);
      if (this.#connected || request.epoch !== this.epoch)
        throw identityError();
      this.#connected = true;
      this.#onConnected?.();
      return Promise.resolve(rpcSuccess(this.#launch));
    } catch (cause) {
      return Promise.resolve(rpcFailure<HostBootstrapWire>(cause));
    }
  }

  async invokeReservedChord(id: string, repeat: boolean) {
    return this.#call(() =>
      this.#handlers.invokeReservedChord(parseChordInvocation({ id, repeat })),
    );
  }

  isConnected(): boolean {
    return this.#connected;
  }

  onConnected(callback: () => void): void {
    this.#onConnected = callback;
  }

  onFatal(callback: () => void): void {
    this.#onFatal = callback;
  }

  async requestComputerChoice() {
    return this.#call(() => {
      if (this.#handlers.requestComputerChoice === undefined)
        throw new AppError("Computer choice is unavailable in this host", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      return this.#handlers.requestComputerChoice();
    });
  }

  async requestBrowserAction(value: AppBrowserAction) {
    return this.#answer<AppBrowserActionOutcome>(async () => {
      const parsed = parseBrowserAction(value);
      if (parsed.kind === "refused") return parsed;
      return (
        this.#handlers.requestBrowserAction?.(parsed) ?? {
          kind: "refused",
          reason: "unavailable",
        }
      );
    });
  }

  async openNavigation(value: FileNavigationInput) {
    return this.#call(() =>
      this.#handlers.openNavigation(parseNavigation(value)),
    );
  }

  async openTeamBilling() {
    return this.#call(() => {
      if (this.#handlers.openTeamBilling === undefined)
        throw new AppError("Billing is unavailable in this host", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      return this.#handlers.openTeamBilling();
    });
  }

  async openDesktopSettings() {
    return this.#call(() => {
      if (this.#handlers.openDesktopSettings === undefined)
        throw new AppError("Desktop settings are unavailable in this host", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      return this.#handlers.openDesktopSettings();
    });
  }

  async requestAppPermissions(value: AppPermissionRequest) {
    return this.#answer(() => {
      if (this.#handlers.requestAppPermissions === undefined)
        throw new AppError("App permissions are unavailable in this host", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      return this.#handlers.requestAppPermissions(
        parsePermissionRequest(value),
      );
    });
  }

  async registerCommand(value: AppCommand, handler: CommandHandlerRpc) {
    let registration: PendingRegistration | undefined;
    try {
      registration = this.#admitCommand(value, handler);
      await this.#registerPendingCommand(registration);
      return rpcSuccess<RegisteredCommandWire>(
        Object.freeze({ commandId: registration.commandId }),
      );
    } catch (cause) {
      if (registration) this.#discardPending(registration);
      return rpcFailure<RegisteredCommandWire>(cause);
    }
  }

  async reportFocus(value: FocusState) {
    return this.#call(() => this.#handlers.reportFocus(parseFocus(value)));
  }

  async reportStatus(value: readonly AppStatusItem[]) {
    return this.#call(() => {
      const items = parseStatusItems(value);
      return this.#handlers.reportStatus?.(items) ?? Promise.resolve();
    });
  }

  async reportNavigation(value: NavigationStateWire) {
    return this.#call(() => {
      const state = parseNavigationState(value);
      return this.#handlers.reportNavigation?.(state) ?? Promise.resolve();
    });
  }

  async reportAgentSessionSelection(value: AgentSessionSelection | null) {
    return this.#call(() =>
      this.#handlers.reportAgentSessionSelection(
        parseAgentSessionSelection(value),
      ),
    );
  }

  async showToast(value: ToastInput) {
    return this.#call(() => this.#handlers.showToast(parseToast(value)));
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const command of this.#commands.values()) {
      try {
        this.#release(command);
      } catch (cause) {
        console.warn("App host command cleanup failed", cause);
      }
    }
    this.#commands.clear();
    for (const command of this.#pendingCommands.values()) {
      try {
        this.#release(command);
      } catch (cause) {
        console.warn("App host pending command cleanup failed", cause);
      }
    }
    this.#pendingCommands.clear();
    this.#pendingUnregistrations.clear();
    this.#releaseContribution();
  }

  unregisterCommand(value: string) {
    try {
      this.#assertConnected();
      const commandId = parseCommandId(value);
      const command = this.#commands.get(commandId);
      if (!command)
        throw new AppError("Unknown command", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      if (this.#pendingUnregistrations.has(commandId))
        throw new AppError("Command is already unregistering", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      this.#pendingUnregistrations.add(commandId);
      return this.#syncUnregistration(commandId, command)
        .then(() => {
          this.#pendingUnregistrations.delete(commandId);
          if (this.#commands.get(commandId) === command) {
            this.#commands.delete(commandId);
            this.#release(command);
          }
          return rpcSuccess(undefined);
        })
        .catch((cause: unknown) => {
          this.#pendingUnregistrations.delete(commandId);
          return rpcFailure<undefined>(cause);
        });
    } catch (cause) {
      return Promise.resolve(rpcFailure<undefined>(cause));
    }
  }

  #assertConnected(): void {
    this.#assertLive();
    if (!this.#connected) throw disconnected();
  }

  #assertLive(): void {
    if (this.#disposed) throw disconnected();
  }

  #admitCommand(
    value: AppCommand,
    handler: CommandHandlerRpc,
  ): PendingRegistration {
    this.#assertConnected();
    const command = parseCommand(value);
    const commandId = `${this.#launch.identity.appId}/${command.id}`;
    if (
      this.#commands.size + this.#pendingCommands.size >= 128 ||
      this.#commands.has(commandId) ||
      this.#pendingCommands.has(commandId)
    )
      throw new AppError("Command already registered", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    const retainedCommand: RetainedCommand = {
      callback: duplicateHandler(handler),
      requests: new Set(),
      command,
    };
    this.#pendingCommands.set(commandId, retainedCommand);
    return { commandId, command: retainedCommand };
  }

  #discardPending(registration: PendingRegistration): void {
    const { commandId, command } = registration;
    if (this.#pendingCommands.get(commandId) !== command) return;
    this.#pendingCommands.delete(commandId);
    this.#release(command);
  }

  async #call(operation: () => Promise<void>) {
    return this.#answer(async () => {
      await operation();
      return undefined;
    });
  }

  async #answer<T>(operation: () => Promise<T>) {
    try {
      this.#assertConnected();
      return rpcSuccess(await operation());
    } catch (cause) {
      return rpcFailure<T>(cause);
    }
  }

  #registerPendingCommand(registration: PendingRegistration): Promise<void> {
    return this.#enqueueSync(async () => {
      const { commandId, command } = registration;
      this.#assertConnected();
      if (this.#pendingCommands.get(commandId) !== command)
        throw disconnected();
      const next = new Map(this.#commands);
      next.set(commandId, command);
      try {
        await this.#applyCommands(next);
      } catch (cause) {
        this.#discardPending(registration);
        throw cause;
      }
      if (this.#disposed || this.#pendingCommands.get(commandId) !== command)
        throw disconnected();
      this.#pendingCommands.delete(commandId);
      this.#commands.set(commandId, command);
    });
  }

  #syncUnregistration(
    commandId: string,
    command: RetainedCommand,
  ): Promise<void> {
    return this.#enqueueSync(async () => {
      this.#assertConnected();
      if (this.#commands.get(commandId) !== command) throw disconnected();
      const next = new Map(this.#commands);
      next.delete(commandId);
      try {
        await this.#applyCommands(next, next);
      } catch (cause) {
        if (this.#commands.get(commandId) === command) {
          this.#commands.delete(commandId);
          this.#release(command);
        }
        throw cause;
      }
    });
  }

  #enqueueSync(operation: () => Promise<void>): Promise<void> {
    const queued = this.#sync.then(operation);
    this.#sync = queued.catch((cause: unknown) => {
      reportCatchFailure("host.command-sync", cause);
    });
    return queued;
  }

  async #applyCommands(
    next: Map<string, RetainedCommand>,
    recovery = this.#commands,
  ): Promise<void> {
    const commands = [...next.values()].map((retained) => retained.command);
    if (this.#contribution === undefined) {
      if (commands.length === 0) return;
      await this.#registerContribution(commands);
      return;
    }
    const contribution = this.#contribution;
    try {
      contribution.update(commands);
      if (this.#disposed || this.#contribution !== contribution)
        throw disconnected();
    } catch (cause) {
      this.#releaseContribution();
      try {
        await this.#registerContribution(
          [...recovery.values()].map((retained) => retained.command),
        );
      } catch (recoveryCause) {
        this.#abandonCommands();
        this.#onFatal?.();
        throw recoveryCause;
      }
      throw cause;
    }
  }

  async #registerContribution(commands: readonly AppCommand[]): Promise<void> {
    if (commands.length === 0) return;
    const contribution = await this.#handlers.registerCommands({
      commands,
      invoke: (id, input) => {
        const commandId = `${this.#launch.identity.appId}/${id}`;
        const command = this.#commands.get(commandId);
        if (command === undefined) throw disconnected();
        return this.#invoke(command.callback, commandId, input);
      },
    });
    if (!Predicate.isObject(contribution))
      throw new AppError("Host command registration returned no lease", {
        code: "HOST_FAILURE",
        retryable: false,
      });
    if (
      !Predicate.isFunction(contribution.update) ||
      !Predicate.isFunction(contribution.dispose)
    ) {
      throw new AppError(
        "Host command registration returned an invalid lease",
        {
          code: "HOST_FAILURE",
          retryable: false,
        },
      );
    }
    if (this.#disposed || !this.#connected) {
      contribution.dispose();
      throw disconnected();
    }
    this.#contribution = contribution;
  }

  #abandonCommands(): void {
    for (const command of this.#commands.values()) this.#release(command);
    this.#commands.clear();
    for (const command of this.#pendingCommands.values())
      this.#release(command);
    this.#pendingCommands.clear();
    this.#pendingUnregistrations.clear();
  }

  #cancel(callback: RetainedCommandHandler, requestId: string): void {
    try {
      void callRpc(callback.cancel(requestId), parseVoidResult).catch(
        (cause: unknown) => {
          console.warn("App host command cancellation failed", cause);
          this.#onFatal?.();
        },
      );
    } catch (cause) {
      console.warn("App host command cancellation failed", cause);
      this.#onFatal?.();
    }
  }

  async #invoke(
    callback: RetainedCommandHandler,
    commandId: string,
    input: {
      readonly arguments?: WhistleJsonValue;
      readonly origin: WhistleExecutionOrigin;
      readonly signal?: AbortSignal;
    },
  ): Promise<WhistleJsonValue | undefined> {
    this.#assertConnected();
    const command = this.#commands.get(commandId);
    if (command?.callback !== callback) throw disconnected();
    if (command.requests.size >= 64) {
      throw new AppError("Too many command requests", {
        code: "HOST_FAILURE",
        retryable: true,
      });
    }
    if (input.signal?.aborted) throw cancelled();
    const requestId = newRequestId();
    command.requests.add(requestId);
    const cancel = (): void => {
      this.#cancel(callback, requestId);
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const invocation: CommandInvocationWire = {
        commandId,
        origin: input.origin,
        requestId,
      };
      if (input.arguments !== undefined)
        Object.assign(invocation, { arguments: input.arguments });
      const outcome = await callRpc(
        callback.invoke(invocation),
        parseCommandResultRpc,
      );
      if (outcome.status === "failed")
        throw new WhistleActionError(
          outcome.error.code,
          outcome.error.message,
          outcome.error.details,
        );
      return outcome.result;
    } finally {
      input.signal?.removeEventListener("abort", cancel);
      command.requests.delete(requestId);
    }
  }

  #release(command: RetainedCommand): void {
    for (const requestId of command.requests)
      this.#cancel(command.callback, requestId);
    command.requests.clear();
    disposeRpcValue(command.callback);
  }

  #releaseContribution(): void {
    const contribution = this.#contribution;
    this.#contribution = undefined;
    if (contribution === undefined) return;
    try {
      contribution.dispose();
    } catch (cause) {
      console.warn("App host command contribution cleanup failed", cause);
    }
  }
}

class PendingHostMount {
  #gate: TerminalGate;
  #host: AppHost | undefined;
  #reject: ((error: AppError) => void) | undefined;
  #resolve: ((host: AppHost) => void) | undefined;

  constructor(
    readonly options: ConnectAppHostOptions,
    readonly origin: string,
  ) {
    this.#gate = createTerminalGate({
      dispose: () => {
        this.#disposeHost();
      },
      onDisconnect: options.handlers.onDisconnect,
      reject: (error) => this.#reject?.(error),
      release: () => {
        this.#releaseMount();
      },
    });
  }

  start(): Promise<AppHost> {
    return new Promise<AppHost>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      this.options.hostWindow.addEventListener("message", this.#onMessage);
      this.options.signal?.addEventListener("abort", this.#onAbort, {
        once: true,
      });
    });
  }

  #disposeHost(): void {
    try {
      this.#host?.dispose();
    } finally {
      this.#releaseMount();
    }
  }

  #fail(error: AppError): void {
    this.#stopWaiting();
    // Publication is a one-way door. A failure after it must use the
    // terminal path so disposal and notification remain exactly-once.
    if (this.#gate.isPublished()) this.#gate.unexpected();
    else this.#gate.failBeforePublication(error);
  }

  #onAbort = (): void => {
    this.#fail(cancelled());
  };

  #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isReadyMessage(event.data)) return;
    performance.mark("fungi.app-open.host-ready-received");
    if (event.source !== this.options.appWindow) return;
    if (event.origin !== this.origin) {
      this.#fail(identityError());
      return;
    }
    if (event.ports.length !== 0) {
      this.#fail(protocolError("The app ready message transferred a port"));
      return;
    }
    try {
      parseReady(event.data);
      this.#stopReady();
      performance.mark("fungi.app-open.host-connect-sent");
      const session = this.#openSession();
      this.#postConnect(session.target.epoch, session.transfer);
      this.#probe(session.client);
    } catch (cause) {
      this.#fail(toProtocolError(cause));
    }
  };

  #openSession() {
    const channel = new MessageChannel();
    const target = new MountedHost(
      this.options.launch,
      this.options.handlers,
      newEpoch(),
    );
    const client = newMessagePortRpcSession<AppClientRpc>(
      channel.port1,
      target,
    );
    this.#host = createHost({
      client,
      onBroken: () => {
        this.#gate.unexpected();
      },
      onDisposed: () => {
        this.#gate.release();
        this.#releaseMount();
      },
      onGracefulDisconnect: () => this.#gate.graceful(),
      port: channel.port1,
      target,
    });
    target.onConnected(() => {
      this.#publish();
    });
    return { client, port: channel.port1, target, transfer: channel.port2 };
  }

  #postConnect(epoch: string, transfer: MessagePort): void {
    this.options.appWindow.postMessage(
      {
        epoch,
        protocolVersion: APP_PROTOCOL_VERSION,
        type: APP_CONNECT_TYPE,
      },
      // Opaque sandbox origins cannot be named as a postMessage target. The
      // ready door above still binds this transfer to the exact iframe Window.
      this.origin === "null" ? "*" : this.origin,
      [transfer],
    );
  }

  #probe(client: RpcStubType<AppClientRpc>): void {
    void callRpc(
      client.updateContext(this.options.launch.context),
      parseVoidResult,
    ).catch((cause: unknown) => {
      if (this.#gate.isPublished()) this.#gate.unexpected();
      else this.#fail(cause instanceof AppError ? cause : disconnected());
    });
  }

  #publish(): void {
    if (!this.#host || !this.#gate.publish()) return;
    performance.mark("fungi.app-open.host-connected");
    this.#stopWaiting();
    this.#resolve?.(this.#host);
  }

  #releaseMount(): void {
    if (liveMounts.get(this.options.appWindow) === this)
      liveMounts.delete(this.options.appWindow);
  }

  #stopReady(): void {
    this.options.hostWindow.removeEventListener("message", this.#onMessage);
  }

  #stopWaiting(): void {
    this.#stopReady();
    this.options.signal?.removeEventListener("abort", this.#onAbort);
  }
}

/** The host-only adapter owns iframe authentication and the hidden Cap'n Web epoch. */
export function connectAppHost(
  options: ConnectAppHostOptions,
): Promise<AppHost> {
  const origin = expectedOrigin(options.expectedAppOrigin);
  if (!origin) return Promise.reject(invalidOrigin());
  if (options.signal?.aborted) return Promise.reject(cancelled());
  if (liveMounts.has(options.appWindow))
    return Promise.reject(alreadyMounted());
  const mount = new PendingHostMount(options, origin);
  liveMounts.set(options.appWindow, mount);
  return mount.start();
}

function alreadyMounted(): AppError {
  return new AppError("An app host is already live for this iframe", {
    code: "IDENTITY",
    retryable: false,
  });
}

function cancelled(): AppError {
  return new AppError("App host connection was cancelled", {
    code: "CANCELLED",
    retryable: false,
  });
}

function createFactUpdater(
  assertLive: () => void,
): <T>(
  send: (fact: VersionedFact<T>) => Promise<RpcResult<void>>,
  fact: AppHostFact<T>,
  parse: ReturnType<
    typeof Schema.decodeUnknownSync<Schema.Decoder<VersionedFact<T>>>
  >,
) => Promise<void> {
  return async <T>(
    send: (fact: VersionedFact<T>) => Promise<RpcResult<void>>,
    fact: AppHostFact<T>,
    parse: ReturnType<
      typeof Schema.decodeUnknownSync<Schema.Decoder<VersionedFact<T>>>
    >,
  ): Promise<void> => {
    assertLive();
    await callRpc(send(parse(fact)), parseVoidResult);
  };
}

function createHost(options: {
  readonly client: RpcStubType<AppClientRpc>;
  readonly onBroken: () => void;
  readonly onDisposed: () => void;
  readonly onGracefulDisconnect: () => Promise<void>;
  readonly port: MessagePort;
  readonly target: MountedHost;
}): AppHost {
  let disposed = false;
  const assertLive = (): void => {
    if (disposed) throw disconnected();
  };
  const dispose = createHostDisposer(
    options,
    () => disposed,
    (value) => {
      disposed = value;
    },
  );
  const onBroken = (): void => {
    try {
      options.onBroken();
    } finally {
      dispose();
    }
  };
  options.target.onFatal(onBroken);
  options.client.onRpcBroken(onBroken);
  const update = createFactUpdater(assertLive);
  return Object.freeze({
    disconnect: (error?: AppError) =>
      disconnectHost(error, assertLive, options, dispose),
    dispose,
    requestClose: async () => {
      assertLive();
      return await callRpc(
        options.client.requestClose(),
        parseCloseDecisionResult,
      );
    },
    requestBack: async () => {
      assertLive();
      return await callRpc(
        options.client.requestBack(),
        parseBackDecisionResult,
      );
    },
    activateStatus: async (action: AppStatusAction) => {
      assertLive();
      return await callRpc(
        options.client.activateStatus(parseStatusAction(action)),
        parseBackDecisionResult,
      );
    },
    updateContext: (fact: AppHostFact<AppContext>) =>
      update(
        (fact) => options.client.updateContext(fact),
        fact,
        parseContextFact,
      ),
    reconfigure: async (value: AppHostReconfiguration) => {
      assertLive();
      const context = parseContextFact(value.context);
      const capabilities: AppHostReconfigurationWire = {
        capabilities: value.capabilities,
        context,
      };
      await callRpc(options.client.reconfigure(capabilities), parseVoidResult);
    },
    updateLifecycle: (fact: AppHostFact<"connected" | "suspended">) =>
      update(
        (fact) => options.client.updateLifecycle(fact),
        fact,
        parseHostLifecycleFact,
      ),
    updateReservedChords: (
      fact: AppHostFact<readonly AppHostReservedChord[]>,
    ) =>
      update(
        (fact) => options.client.updateReservedChords(fact),
        fact,
        parseReservedChordsFact,
      ),
    updateTheme: (fact: AppHostFact<string>) =>
      update((fact) => options.client.updateTheme(fact), fact, parseThemeFact),
  });
}

function createHostDisposer(
  options: {
    readonly client: RpcStubType<AppClientRpc>;
    readonly onDisposed: () => void;
    readonly port: MessagePort;
    readonly target: MountedHost;
  },
  isDisposed: () => boolean,
  setDisposed: (value: boolean) => void,
): () => void {
  return (): void => {
    if (isDisposed()) return;
    setDisposed(true);
    // Mark the private epoch terminal before closing transport; Cap'n Web may
    // synchronously report the close as a break.
    options.onDisposed();
    try {
      options.target[Symbol.dispose]();
    } finally {
      disposeRpcValue(options.client);
      options.port.close();
    }
  };
}

function disconnected(): AppError {
  return new AppError("The app host is disconnected", {
    code: "DISCONNECTED",
    retryable: true,
  });
}

function duplicateHandler(value: CommandHandlerRpc): RetainedCommandHandler {
  if (!Schema.is(retainedCommandHandlerSchema)(value)) {
    throw new AppError("Command callback is invalid", {
      code: "PROTOCOL",
      retryable: false,
    });
  }
  return value.dup();
}

function expectedOrigin(value: string): string | undefined {
  if (value === "null") return value;
  if (!URL.canParse(value)) return undefined;
  const origin = new URL(value).origin;
  return origin === value ? origin : undefined;
}

const isReadyMessage = Schema.is(
  Schema.Struct({ type: Schema.Literal(APP_READY_TYPE) }),
);

function identityError(): AppError {
  return new AppError("The app connection identity is invalid", {
    code: "IDENTITY",
    retryable: false,
  });
}

function invalidOrigin(): AppError {
  return new AppError("expectedAppOrigin must be an origin", {
    code: "INVALID_ARGUMENT",
    retryable: false,
  });
}

function newEpoch(): string {
  return randomToken(24);
}

function newRequestId(): string {
  return randomToken(18);
}

function protocolError(message: string): AppError {
  return new AppError(message, { code: "PROTOCOL", retryable: false });
}

function randomToken(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function toProtocolError(cause: unknown): AppError {
  return cause instanceof AppError
    ? cause
    : protocolError("Unable to establish the app host");
}
