import type { AppCommand } from "../commands.js";
import type {
  WhistleExecutionOrigin,
  WhistleJsonValue,
} from "@fungi.computer/whistle";
import type {
  AppContext,
  AppIdentity,
  AppLifecycle,
  FocusState,
} from "../lifecycle.js";
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
} from "../ui.js";
import type {
  APP_NAVIGATION_CONTRACT_VERSION,
  AppNavigationActivation,
  AppNavigationState,
} from "../window.js";
import type { AppErrorData } from "./app-error.js";
import type { RpcResult } from "./result.js";
import type { WhistleFailure } from "@fungi.computer/whistle";

/** The iframe handshake version both App and host must speak. */
export const APP_PROTOCOL_VERSION = 2 as const;
/** Message type the App iframe posts to announce it is ready to connect. */
export const APP_READY_TYPE = "fungi.app.ready" as const;
/** Message type the host posts to hand the App its RPC MessagePort. */
export const APP_CONNECT_TYPE = "fungi.app.connect" as const;

export type AppClientRpc = {
  disconnect(error?: AppErrorData): Promise<RpcResult<void>>;
  requestClose(): Promise<RpcResult<boolean>>;
  /** Ask the App to go back one step in its own history; `true` when it did. */
  requestBack(): Promise<RpcResult<boolean>>;
  /** The person used a crumb or header command; `true` when the App acted. */
  activateNavigation(
    activation: AppNavigationActivation,
  ): Promise<RpcResult<boolean>>;
  /** The person used one of the App's status items; `true` when it acted. */
  activateStatus(action: AppStatusAction): Promise<RpcResult<boolean>>;
  updateContext(context: VersionedFact<AppContext>): Promise<RpcResult<void>>;
  reconfigure(value: AppHostReconfigurationWire): Promise<RpcResult<void>>;
  updateLifecycle(
    lifecycle: VersionedFact<AppLifecycle>,
  ): Promise<RpcResult<void>>;
  updateReservedChords(
    chords: VersionedFact<readonly ReservedChord[]>,
  ): Promise<RpcResult<void>>;
  updateTheme(theme: VersionedFact<string>): Promise<RpcResult<void>>;
};

/** The host's handshake message that hands the App its RPC MessagePort. */
export type AppConnectMessage = {
  readonly epoch: string;
  readonly protocolVersion: typeof APP_PROTOCOL_VERSION;
  readonly type: typeof APP_CONNECT_TYPE;
};

export type AppHostRpc = {
  requestComputerChoice(): Promise<RpcResult<void>>;
  requestBrowserAction(
    input: AppBrowserAction,
  ): Promise<RpcResult<AppBrowserActionOutcome>>;
  connect(request: ConnectRequestWire): Promise<RpcResult<HostBootstrapWire>>;
  invokeReservedChord(id: string, repeat: boolean): Promise<RpcResult<void>>;
  openNavigation(input: FileNavigationInput): Promise<RpcResult<void>>;
  openTeamBilling(): Promise<RpcResult<void>>;
  openDesktopSettings(): Promise<RpcResult<void>>;
  requestAppPermissions(
    input: AppPermissionRequest,
  ): Promise<RpcResult<AppPermissionOutcome>>;
  registerCommand(
    command: AppCommand,
    handler: CommandHandlerRpc,
  ): Promise<RpcResult<RegisteredCommandWire>>;
  reportFocus(focus: FocusState): Promise<RpcResult<void>>;
  reportNavigation(state: NavigationStateWire): Promise<RpcResult<void>>;
  reportStatus(items: readonly AppStatusItem[]): Promise<RpcResult<void>>;
  reportAgentSessionSelection(
    selection: AgentSessionSelection | null,
  ): Promise<RpcResult<void>>;
  showToast(input: ToastInput): Promise<RpcResult<void>>;
  unregisterCommand(commandId: string): Promise<RpcResult<void>>;
};

/** The versioned navigation contract an App reports to its host. */
export type NavigationStateWire = Readonly<{
  contractVersion: typeof APP_NAVIGATION_CONTRACT_VERSION;
}> &
  AppNavigationState;

/** The App iframe's handshake message announcing it is ready to connect. */
export type AppReadyMessage = {
  readonly protocolVersion: typeof APP_PROTOCOL_VERSION;
  readonly type: typeof APP_READY_TYPE;
};

/** The handle is deliberately opaque: capability owners define its methods. */
export type CapabilityGrantWire = {
  readonly handle: object;
  readonly id: string;
  readonly version: number;
};

export type CommandHandlerRpc = {
  cancel(requestId: string): Promise<RpcResult<void>>;
  invoke(
    invocation: CommandInvocationWire,
  ): Promise<RpcResult<CommandInvocationResultWire>>;
};

/** Data-only command outcome crossing the App boundary. */
export type CommandInvocationResultWire =
  | Readonly<{
      readonly status: "handled";
      readonly result?: WhistleJsonValue;
    }>
  | Readonly<{
      readonly status: "failed";
      readonly error: WhistleFailure;
    }>;

export type CommandInvocationWire = {
  readonly arguments?: WhistleJsonValue;
  readonly commandId: string;
  readonly origin: WhistleExecutionOrigin;
  readonly requestId: string;
};

export type ConnectRequestWire = {
  readonly epoch: string;
  readonly protocolVersion: typeof APP_PROTOCOL_VERSION;
};

export type HostBootstrapWire = {
  readonly capabilities: readonly CapabilityGrantWire[];
  readonly context: VersionedFact<AppContext>;
  readonly identity: AppIdentity;
  readonly lifecycle: VersionedFact<AppLifecycle>;
  readonly reservedChords: VersionedFact<readonly ReservedChord[]>;
  readonly theme: VersionedFact<string>;
};

export type AppHostReconfigurationWire = {
  readonly capabilities: readonly CapabilityGrantWire[];
  readonly context: VersionedFact<AppContext>;
};

export type RegisteredCommandWire = {
  readonly commandId: string;
};

export type ReservedChord = {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly id: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
};

export type VersionedFact<T> = {
  readonly value: T;
  readonly version: number;
};
