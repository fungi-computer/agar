import { RpcStub, RpcTarget } from "@fungi.computer/capnweb";
/**
 * The protocol owns its boundary parsing. Values leave this module as copied,
 * frozen app data; live Cap'n Web references remain outside these schemas.
 */
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { flow } from "effect/Function";

import type { AppCommand, AppCommandInvocation } from "../commands.js";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import {
  parseCommandDefinition,
  parseJsonValue,
} from "@fungi.computer/whistle/wire";
import type {
  AppContext,
  AppIdentity,
  AppLifecycle,
  FocusState,
} from "../lifecycle.js";
import type {
  AppBrowserAction,
  AppBrowserActionRefusal,
  AppBrowserActionOutcome,
  AgentSessionSelection,
  AppPermissionOutcome,
  AppPermissionRequest,
  AppStatusAction,
  AppStatusItem,
  FileNavigationInput,
  ToastInput,
} from "../ui.js";
import { isUnsafeStatusCodeUnit } from "../status.js";
import {
  APP_BROWSER_SAVE_MAX_BYTES,
  APP_BROWSER_COPY_MAX_BYTES,
  APP_STATUS_ITEMS_MAX,
  APP_STATUS_OPTIONS_MAX,
  APP_STATUS_TEXT_MAX,
} from "../ui.js";
import type { AppErrorData } from "./app-error.js";
import type {
  CapabilityGrantWire,
  AppHostReconfigurationWire,
  CommandInvocationResultWire,
  HostBootstrapWire,
  NavigationStateWire,
  RegisteredCommandWire,
} from "./protocol.js";
import type { RpcResult } from "./result.js";
import {
  APP_NAVIGATION_CONTRACT_VERSION,
  APP_NAVIGATION_CRUMBS_MAX,
  APP_NAVIGATION_LABEL_MAX,
  APP_NAVIGATION_MENU_MAX,
  APP_NAVIGATION_PRIMARY_MAX,
  APP_NAVIGATION_SIBLINGS_MAX,
  APP_NAVIGATION_STATUS_MAX,
  APP_NAVIGATION_TITLE_MAX,
  type AppCrumb,
  type AppHeaderCommand,
  type AppHeaderStatus,
  type AppNavigationActivation,
  type AppNavigationState,
} from "../window.js";

import { AppError, appErrorCodes, type AppErrorCode } from "../errors.js";
import { parseFailure } from "@fungi.computer/whistle/wire";
import {
  APP_CONNECT_TYPE,
  APP_PROTOCOL_VERSION,
  APP_READY_TYPE,
  type AppConnectMessage,
  type AppReadyMessage,
  type CommandInvocationWire,
  type ConnectRequestWire,
  type ReservedChord,
  type VersionedFact,
} from "./protocol.js";

const boundedText = (maximum: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(maximum)),
  );
const boundedOptionalText = (maximum: number) =>
  Schema.optional(boundedText(maximum));
const safeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(
    Schema.makeFilter(Number.isSafeInteger, {
      message: "Expected a safe integer",
    }),
  ),
);
const safeVersion = safeInteger.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
const positiveVersion = safeInteger.pipe(Schema.check(Schema.isGreaterThan(0)));
const identitySchema = Schema.Struct({
  appId: boundedText(160),
  releaseId: boundedText(160),
  surfaceId: boundedText(160),
});
const focusSchema = Schema.Struct({
  editing: Schema.Boolean,
  surface: Schema.Union([boundedText(160), Schema.Null]),
});
const appOpenRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("compose"),
    requestId: boundedText(160),
    text: boundedText(2_000),
  }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    requestId: boundedText(160),
    params: Schema.Array(
      Schema.Struct({ key: boundedText(64), value: boundedText(4_096) }),
    ).pipe(Schema.check(Schema.isMaxLength(16))),
  }),
]);
const contextSchema = Schema.Struct({
  computerId: Schema.Union([boundedText(256), Schema.Null]),
  teamHasComputers: Schema.optional(Schema.NullOr(Schema.Boolean)),
  computerAccessGranted: Schema.optional(Schema.Boolean),
  focus: focusSchema,
  openRequest: Schema.Union([Schema.Null, appOpenRequestSchema]),
  visibility: Schema.Literals(["visible", "hidden"]),
});
type DecodedAppContext = Omit<
  Mutable<AppContext>,
  "teamHasComputers" | "computerAccessGranted"
> &
  Pick<
    Partial<Mutable<AppContext>>,
    "teamHasComputers" | "computerAccessGranted"
  >;
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
const lifecycleSchema = Schema.Literals([
  "connecting",
  "connected",
  "suspended",
  "disconnected",
  "disposing",
  "disposed",
]);
const chordSchema = Schema.Struct({
  altKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  id: boundedText(160),
  key: boundedText(64),
  metaKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
});
const commandSchema = Schema.Struct({
  action: Schema.optional(Schema.Unknown),
  availability: Schema.optional(Schema.Unknown),
  category: boundedText(160),
  description: boundedOptionalText(512),
  id: boundedText(160),
  projections: Schema.optional(Schema.Unknown),
  title: boundedText(160),
});
const commandInvocationSchema = Schema.Struct({
  arguments: Schema.optional(Schema.Unknown),
  commandId: boundedText(321),
  origin: Schema.Literals([
    "agent",
    "browser",
    "keyboard",
    "menu",
    "palette",
    "programmatic",
    "slash",
    "terminal",
  ]),
  requestId: boundedText(160),
});
const commandResultWireSchema = Schema.Union([
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    status: Schema.Literal("handled"),
  }),
  Schema.Struct({
    error: Schema.Unknown,
    status: Schema.Literal("failed"),
  }),
]);
type CommandMetadataInput = {
  category: string;
  id: string;
  title: string;
  action?: unknown;
  availability?: unknown;
  description?: string;
  projections?: unknown;
};
/** One line of plain text an App puts in host chrome. */
const statusText = (max: number) =>
  boundedText(max).pipe(
    Schema.check(
      Schema.makeFilter(
        (text: string) => {
          for (let index = 0; index < text.length; index += 1)
            if (isUnsafeStatusCodeUnit(text.charCodeAt(index))) return false;
          return true;
        },
        { message: "Expected one line of plain text" },
      ),
    ),
  );
const statusBase = {
  id: boundedText(64),
  text: statusText(APP_STATUS_TEXT_MAX),
  end: Schema.optionalKey(Schema.Boolean),
};
const statusCount = Schema.optionalKey(
  Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 9_999 })),
  ),
);
const statusItemsSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({
      ...statusBase,
      kind: Schema.Literal("text"),
      tone: Schema.optionalKey(
        Schema.Literals(["neutral", "success", "warning", "error"]),
      ),
    }),
    Schema.Struct({
      ...statusBase,
      kind: Schema.Literal("button"),
      icon: Schema.optionalKey(
        Schema.Literals(["folder", "ports", "processes", "access"]),
      ),
      count: statusCount,
      tone: Schema.optionalKey(
        Schema.Literals(["neutral", "success", "warning", "error"]),
      ),
      busy: Schema.optionalKey(Schema.Boolean),
      title: Schema.optionalKey(statusText(1_024)),
      disabled: Schema.optionalKey(Schema.Boolean),
      opens: Schema.optionalKey(Schema.Literal("dialog")),
      expanded: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      ...statusBase,
      kind: Schema.Literal("toggle"),
      pressed: Schema.Boolean,
    }),
    Schema.Struct({
      ...statusBase,
      kind: Schema.Literal("menu"),
      count: statusCount,
      title: Schema.optionalKey(statusText(1_024)),
      options: Schema.Array(
        Schema.Struct({
          id: boundedText(64),
          text: statusText(APP_STATUS_TEXT_MAX),
          checked: Schema.optionalKey(Schema.Boolean),
          disabled: Schema.optionalKey(Schema.Boolean),
        }),
      ).pipe(
        Schema.check(Schema.isMaxLength(APP_STATUS_OPTIONS_MAX)),
        // An option id names one choice; repeats would make actions ambiguous.
        Schema.check(
          Schema.makeFilter(
            (options: readonly { readonly id: string }[]) =>
              new Set(options.map((option) => option.id)).size ===
              options.length,
            { message: "Expected unique status option ids" },
          ),
        ),
      ),
    }),
  ]),
).pipe(
  Schema.check(Schema.isMaxLength(APP_STATUS_ITEMS_MAX)),
  // Ids key the host's rendering and name actions; each names one item.
  Schema.check(
    Schema.makeFilter(
      (items: readonly { readonly id: string }[]) =>
        new Set(items.map((item) => item.id)).size === items.length,
      { message: "Expected unique status item ids" },
    ),
  ),
);
const navigationSchema = Schema.Struct({
  computerId: boundedText(256),
  path: boundedText(1024),
});
const navigationTitleSchema = boundedText(APP_NAVIGATION_TITLE_MAX).pipe(
  Schema.check(
    Schema.makeFilter((title: string) => title.trim() === title, {
      message: "Expected a trimmed title",
    }),
  ),
);
const navigationIdSchema = boundedText(64);
const navigationLabelSchema = boundedText(APP_NAVIGATION_LABEL_MAX);
/** Ids name what a person used; repeats would make an activation ambiguous. */
const uniqueIds = (items: readonly { readonly id: string }[]): boolean =>
  new Set(items.map((item) => item.id)).size === items.length;
const crumbSchema = Schema.Struct({
  id: navigationIdSchema,
  label: navigationLabelSchema,
  siblings: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: navigationIdSchema, label: navigationLabelSchema }),
    ).pipe(
      Schema.check(Schema.isMaxLength(APP_NAVIGATION_SIBLINGS_MAX)),
      Schema.check(
        Schema.makeFilter(uniqueIds, {
          message: "Expected unique crumb sibling ids",
        }),
      ),
    ),
  ),
});
const headerCommandSchema = Schema.Struct({
  id: navigationIdSchema,
  label: navigationLabelSchema,
  icon: Schema.optional(Schema.Literal("play")),
  variant: Schema.optional(Schema.Literals(["primary", "outline", "ghost"])),
  tone: Schema.optional(Schema.Literal("destructive")),
  disabled: Schema.optional(Schema.Boolean),
});
const commandsSchema = (maximum: number) =>
  Schema.Array(headerCommandSchema).pipe(
    Schema.check(Schema.isMaxLength(maximum)),
    Schema.check(
      Schema.makeFilter(uniqueIds, {
        message: "Expected unique header command ids",
      }),
    ),
  );
const headerStatusSchema = Schema.Struct({
  id: navigationIdSchema,
  label: navigationLabelSchema,
  presentation: Schema.optional(Schema.Literal("bead")),
  tone: Schema.optional(
    Schema.Literals(["neutral", "info", "warning", "success", "error"]),
  ),
});
const navigationFields = {
  status: Schema.optional(
    Schema.Array(headerStatusSchema).pipe(
      Schema.check(Schema.isMaxLength(APP_NAVIGATION_STATUS_MAX)),
      Schema.check(
        Schema.makeFilter(uniqueIds, {
          message: "Expected unique header status ids",
        }),
      ),
    ),
  ),
  crumbs: Schema.optional(
    Schema.Array(crumbSchema).pipe(
      Schema.check(Schema.isMaxLength(APP_NAVIGATION_CRUMBS_MAX)),
      Schema.check(
        Schema.makeFilter(uniqueIds, { message: "Expected unique crumb ids" }),
      ),
    ),
  ),
  primary: Schema.optional(commandsSchema(APP_NAVIGATION_PRIMARY_MAX)),
  menu: Schema.optional(commandsSchema(APP_NAVIGATION_MENU_MAX)),
};
const navigationStateWireSchema = Schema.Struct({
  contractVersion: Schema.Literal(APP_NAVIGATION_CONTRACT_VERSION),
  canGoBack: Schema.Boolean,
  title: Schema.optional(navigationTitleSchema),
  ...navigationFields,
});
const navigationStateInputSchema = Schema.Struct({
  canGoBack: Schema.Boolean,
  title: Schema.optional(Schema.String),
  ...navigationFields,
});
const navigationActivationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("crumb"),
    crumbId: navigationIdSchema,
    siblingId: Schema.optional(navigationIdSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("action"),
    actionId: navigationIdSchema,
  }),
]);
const agentSessionSelectionSchema = Schema.NullOr(
  Schema.Struct({
    agentId: boundedText(256),
    sessionId: boundedText(256),
  }),
);
const permissionRequestSchema = Schema.Struct({
  agents: Schema.optional(
    Schema.Array(
      Schema.Literals([
        "agent.list",
        "agent.manage",
        "agent.read",
        "agent.send",
      ]),
    ).pipe(Schema.check(Schema.isMaxLength(4))),
  ),
  computers: Schema.optional(
    Schema.Array(
      Schema.Literals([
        "computer.list",
        "computer.readFile",
        "computer.writeFile",
        "computer.execute",
      ]),
    ).pipe(Schema.check(Schema.isMaxLength(4))),
  ),
});
const permissionOutcomeSchema = Schema.Literals([
  "granted",
  "declined",
  "customize",
]);
const toastSchema = Schema.Struct({
  message: boundedText(512),
  tone: Schema.optional(
    Schema.Literals(["info", "success", "warning", "error"]),
  ),
});
const appErrorCodeSchema = Schema.Literals(appErrorCodes);

/** Effect projection of the error owner's declaration-safe pending refusal. */
export const appDeliveryPendingSchema = Schema.Struct({
  code: appErrorCodeSchema.pick(["DELIVERY_PENDING"]),
});

const errorSchema = Schema.Struct({
  code: appErrorCodeSchema,
  message: boundedText(512),
  retryable: Schema.Boolean,
});
const readySchema = Schema.Struct({
  protocolVersion: Schema.Literal(APP_PROTOCOL_VERSION),
  type: Schema.Literal(APP_READY_TYPE),
});
const connectSchema = Schema.Struct({
  epoch: boundedText(160),
  protocolVersion: Schema.Literal(APP_PROTOCOL_VERSION),
  type: Schema.Literal(APP_CONNECT_TYPE),
});
const connectRequestSchema = Schema.Struct({
  epoch: boundedText(160),
  protocolVersion: Schema.Literal(APP_PROTOCOL_VERSION),
});
// Native Cap’n Web decorates received object envelopes with this resource owner.
// Schema owns strict key validation; the returned domain projection omits the symbol.
const rpcOwner = { [Symbol.dispose]: Schema.optional(Schema.Unknown) };
const rpcEnvelopeSchema = Schema.Union([
  Schema.Struct({
    ...rpcOwner,
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({ ...rpcOwner, error: errorSchema, ok: Schema.Literal(false) }),
]);

/** Existing protocol decoder: maintained parsing, then owned domain projection. */
function decoder<A, B>(
  schema: Schema.Codec<A>,
  project: (value: A) => B,
  code: AppErrorCode = "PROTOCOL",
) {
  return flow(
    Schema.decodeUnknownResult(schema, { onExcessProperty: "error" }),
    Result.match({
      onFailure: (cause) => {
        throw new AppError("The peer sent malformed protocol data", {
          cause,
          code,
          retryable: false,
        });
      },
      onSuccess: project,
    }),
  );
}

function frozen<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function appInvocation(
  value: CommandInvocationWire,
  signal: AbortSignal,
): Readonly<AppCommandInvocation> {
  const argumentsValue =
    value.arguments === undefined ? undefined : parseJsonValue(value.arguments);
  const invocation: AppCommandInvocation = { origin: value.origin, signal };
  if (argumentsValue !== undefined)
    Object.assign(invocation, { arguments: argumentsValue });
  return frozen(invocation);
}

export const parseCommand = decoder(
  commandSchema,
  (parsed): Readonly<AppCommand> => {
    const command: CommandMetadataInput = {
      category: parsed.category,
      id: parsed.id,
      title: parsed.title,
    };
    if (parsed.action !== undefined)
      Object.assign(command, {
        action: parsed.action,
      });
    if (parsed.availability !== undefined)
      Object.assign(command, {
        availability: parsed.availability,
      });
    if (parsed.description !== undefined)
      Object.assign(command, { description: parsed.description });
    if (parsed.projections !== undefined)
      Object.assign(command, {
        projections: parsed.projections,
      });
    return frozen(parseSemantic(() => parseCommandDefinition(command)));
  },
  "INVALID_ARGUMENT",
);
export const parseCommandId = decoder(boundedText(321), (value) => value);
export const parseCommandInvocation = decoder(
  commandInvocationSchema,
  (value): Readonly<CommandInvocationWire> => {
    const argumentsValue =
      value.arguments === undefined
        ? undefined
        : parseJsonValue(value.arguments);
    const invocation: CommandInvocationWire = {
      commandId: value.commandId,
      origin: value.origin,
      requestId: value.requestId,
    };
    if (argumentsValue !== undefined)
      Object.assign(invocation, { arguments: argumentsValue });
    return frozen(invocation);
  },
);

/** Decode an action result without carrying executable or host-private data. */
export const parseCommandResult = decoder(
  Schema.Union([Schema.Undefined, Schema.Unknown]),
  (value): WhistleJsonValue | undefined =>
    value === undefined ? undefined : parseJsonValue(value),
);
export const parseConnect = decoder(connectSchema, (value): AppConnectMessage =>
  frozen(value),
);
export const parseConnectRequest = decoder(
  connectRequestSchema,
  (value): ConnectRequestWire => frozen(value),
);
export const parseContext = decoder(
  contextSchema,
  (parsed): Readonly<AppContext> => {
    const context: DecodedAppContext = {
      computerId: parsed.computerId,
      focus: frozen({ ...parsed.focus }),
      openRequest:
        parsed.openRequest === null ? null : frozen({ ...parsed.openRequest }),
      visibility: parsed.visibility,
    };
    if (parsed.teamHasComputers !== undefined)
      context.teamHasComputers = parsed.teamHasComputers;
    if (parsed.computerAccessGranted !== undefined)
      context.computerAccessGranted = parsed.computerAccessGranted;
    return frozen(context);
  },
);
export const parseErrorData = decoder(
  errorSchema,
  (value): Readonly<AppErrorData> => frozen({ ...value }),
);
export const parseFocus = decoder(
  focusSchema,
  (value): Readonly<FocusState> => frozen({ ...value }),
  "INVALID_ARGUMENT",
);
export const parseIdentity = decoder(
  identitySchema,
  (value): Readonly<AppIdentity> => frozen({ ...value }),
);
export const parseLifecycle = decoder(
  lifecycleSchema,
  (value): AppLifecycle => value,
);
/** Both edges: one window's status items, bounded and copied. */
export const parseStatusItems = decoder(
  statusItemsSchema,
  (items): readonly AppStatusItem[] =>
    frozen(
      items.map((item) =>
        item.kind === "menu"
          ? frozen({
              ...item,
              options: frozen(item.options.map((option) => frozen(option))),
            })
          : frozen(item),
      ),
    ),
  "INVALID_ARGUMENT",
);
/** App edge: the status item the person used, as the host relays it. */
export const parseStatusAction = decoder(
  Schema.Struct({
    itemId: boundedText(64),
    optionId: Schema.optionalKey(boundedText(64)),
    anchor: Schema.optionalKey(
      Schema.Struct({
        start: Schema.Number.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
        ),
        width: Schema.Number.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
        ),
      }),
    ),
  }),
  (action): AppStatusAction =>
    frozen(
      action.anchor === undefined
        ? { ...action }
        : { ...action, anchor: frozen({ ...action.anchor }) },
    ),
  "INVALID_ARGUMENT",
);
export const parseNavigation = decoder(
  navigationSchema,
  (value): Readonly<FileNavigationInput> => frozen({ ...value }),
  "INVALID_ARGUMENT",
);
type DecodedCrumb = Schema.Schema.Type<typeof crumbSchema>;
type DecodedCommand = Schema.Schema.Type<typeof headerCommandSchema>;
type DecodedNavigation = {
  readonly canGoBack: boolean;
  readonly title?: string | undefined;
  readonly crumbs?: readonly DecodedCrumb[] | undefined;
  readonly primary?: readonly DecodedCommand[] | undefined;
  readonly menu?: readonly DecodedCommand[] | undefined;
  readonly status?: readonly DecodedStatus[] | undefined;
};
type DecodedStatus = Schema.Schema.Type<typeof headerStatusSchema>;
function statusOf(item: DecodedStatus): AppHeaderStatus {
  let copy: AppHeaderStatus = { id: item.id, label: item.label };
  if (item.presentation !== undefined)
    copy = { ...copy, presentation: item.presentation };
  if (item.tone !== undefined) copy = { ...copy, tone: item.tone };
  return frozen(copy);
}
function crumbOf(crumb: DecodedCrumb): AppCrumb {
  const copy: AppCrumb = { id: crumb.id, label: crumb.label };
  if (crumb.siblings === undefined) return frozen(copy);
  return frozen({
    ...copy,
    siblings: frozen(crumb.siblings.map((item) => frozen({ ...item }))),
  });
}
function commandOf(command: DecodedCommand): AppHeaderCommand {
  let copy: AppHeaderCommand = { id: command.id, label: command.label };
  if (command.icon !== undefined) copy = { ...copy, icon: command.icon };
  if (command.variant !== undefined)
    copy = { ...copy, variant: command.variant };
  if (command.tone !== undefined) copy = { ...copy, tone: command.tone };
  if (command.disabled !== undefined)
    copy = { ...copy, disabled: command.disabled };
  return frozen(copy);
}
/** One report's fields, each present only when the App sent it. */
function navigationOf(value: DecodedNavigation): AppNavigationState {
  let state: AppNavigationState = { canGoBack: value.canGoBack };
  if (value.title !== undefined) state = { ...state, title: value.title };
  if (value.crumbs !== undefined)
    state = { ...state, crumbs: frozen(value.crumbs.map(crumbOf)) };
  if (value.primary !== undefined)
    state = { ...state, primary: frozen(value.primary.map(commandOf)) };
  if (value.menu !== undefined)
    state = { ...state, menu: frozen(value.menu.map(commandOf)) };
  if (value.status !== undefined)
    state = { ...state, status: frozen(value.status.map(statusOf)) };
  return frozen(state);
}
/** Host edge: one App report, projected without its contract version. */
export const parseNavigationState = decoder(
  navigationStateWireSchema,
  navigationOf,
  "INVALID_ARGUMENT",
);
/** App edge: trim the title, drop an empty one, then check the wire bounds. */
export const parseNavigationStateInput = decoder(
  navigationStateInputSchema,
  (value): NavigationStateWire => {
    const trimmed = value.title?.trim();
    return parseNavigationStateWire({
      ...navigationOf({
        ...value,
        title:
          trimmed === undefined || trimmed.length === 0 ? undefined : trimmed,
      }),
      contractVersion: APP_NAVIGATION_CONTRACT_VERSION,
    });
  },
  "INVALID_ARGUMENT",
);
const parseNavigationStateWire = decoder(
  navigationStateWireSchema,
  (value): NavigationStateWire =>
    frozen({
      ...navigationOf(value),
      contractVersion: APP_NAVIGATION_CONTRACT_VERSION,
    }),
  "INVALID_ARGUMENT",
);
/** Host to App: one crumb or command the person used. */
export const parseNavigationActivation = decoder(
  navigationActivationSchema,
  (value): AppNavigationActivation => {
    if (value.kind === "action") return frozen({ ...value });
    return frozen(
      value.siblingId === undefined
        ? { kind: value.kind, crumbId: value.crumbId }
        : value,
    );
  },
  "INVALID_ARGUMENT",
);
export const parseAgentSessionSelection = decoder(
  agentSessionSelectionSchema,
  (value): AgentSessionSelection | null =>
    value === null ? null : frozen({ ...value }),
  "INVALID_ARGUMENT",
);
export const parsePermissionRequest = decoder(
  permissionRequestSchema,
  (value): AppPermissionRequest =>
    frozen({
      agents: frozen([...new Set(value.agents ?? [])]),
      computers: frozen([...new Set(value.computers ?? [])]),
    }),
  "INVALID_ARGUMENT",
);
export const parseReady = decoder(readySchema, (value): AppReadyMessage =>
  frozen(value),
);
export const parseTheme = decoder(boundedText(512), (value) => value);
export const parseToast = decoder(
  toastSchema,
  (value): Readonly<ToastInput> => frozen({ ...value }),
  "INVALID_ARGUMENT",
);
export const parseChordInvocation = decoder(
  Schema.Struct({ id: boundedText(160), repeat: Schema.Boolean }),
  (value) => frozen(value),
);
export const parseReservedChords = decoder(
  Schema.Array(chordSchema).pipe(Schema.check(Schema.isMaxLength(64))),
  (parsed): readonly Readonly<ReservedChord>[] => {
    if (new Set(parsed.map((chord) => chord.id)).size !== parsed.length) {
      throw new AppError("Reserved chords are invalid", {
        code: "PROTOCOL",
        retryable: false,
      });
    }
    return frozen(parsed.map((chord) => frozen({ ...chord })));
  },
);

/** Compose a fact decoder from the maintained decoder of its domain value. */
export function parseFact<T>(
  parseValue: ReturnType<typeof Schema.decodeUnknownSync<Schema.Decoder<T>>>,
) {
  return decoder(
    Schema.Struct({ value: Schema.Unknown, version: safeVersion }),
    (parsed): Readonly<VersionedFact<T>> =>
      frozen({ value: parseValue(parsed.value), version: parsed.version }),
  );
}
export const parseContextFact = parseFact(parseContext);
export const parseHostReconfiguration = decoder(
  Schema.Struct({
    capabilities: Schema.Array(Schema.Unknown).pipe(
      Schema.check(Schema.isMaxLength(128)),
    ),
    context: Schema.Unknown,
  }),
  (parsed): AppHostReconfigurationWire =>
    frozen({
      capabilities: frozen(
        parsed.capabilities.map((grant) => parseCapabilityGrant(grant)),
      ),
      context: parseContextFact(parsed.context),
    }),
);
const parseLifecycleFact = parseFact(parseLifecycle);
export const parseReservedChordsFact = parseFact(parseReservedChords);
export const parseThemeFact = parseFact(parseTheme);
export const parseHostLifecycleFact = flow(
  parseLifecycleFact,
  (fact): Readonly<VersionedFact<"connected" | "suspended">> => {
    if (fact.value !== "connected" && fact.value !== "suspended") {
      throw new AppError("The host lifecycle is invalid", {
        code: "PROTOCOL",
        retryable: false,
      });
    }
    return frozen({ value: fact.value, version: fact.version });
  },
);

function capabilityGrantDecoder(allowLocalTarget: boolean) {
  return decoder(
    Schema.Struct({
      handle: Schema.Unknown,
      id: boundedText(160),
      version: positiveVersion,
    }),
    (parsed): CapabilityGrantWire => {
      if (
        !(parsed.handle instanceof RpcStub) &&
        !(allowLocalTarget && parsed.handle instanceof RpcTarget)
      ) {
        throw new AppError("A capability handle is invalid", {
          code: "PROTOCOL",
          retryable: false,
        });
      }
      return frozen({
        handle: parsed.handle,
        id: parsed.id,
        version: parsed.version,
      });
    },
  );
}
export const parseCapabilityGrant = capabilityGrantDecoder(false);
const parseLocalCapabilityGrant = capabilityGrantDecoder(true);
function hostBootstrapDecoder(allowLocalTarget: boolean) {
  const parseGrant = allowLocalTarget
    ? parseLocalCapabilityGrant
    : parseCapabilityGrant;
  return decoder(
    Schema.Struct({
      capabilities: Schema.Array(Schema.Unknown).pipe(
        Schema.check(Schema.isMaxLength(128)),
      ),
      context: Schema.Unknown,
      identity: Schema.Unknown,
      lifecycle: Schema.Unknown,
      reservedChords: Schema.Unknown,
      theme: Schema.Unknown,
    }),
    (parsed): HostBootstrapWire =>
      frozen({
        capabilities: frozen(
          parsed.capabilities.map((grant) => parseGrant(grant)),
        ),
        context: parseContextFact(parsed.context),
        identity: parseIdentity(parsed.identity),
        lifecycle: parseHostLifecycleFact(parsed.lifecycle),
        reservedChords: parseReservedChordsFact(parsed.reservedChords),
        theme: parseThemeFact(parsed.theme),
      }),
  );
}
const parseHostBootstrap = hostBootstrapDecoder(false);
export const parseLocalHostBootstrap = hostBootstrapDecoder(true);
function rpcDecoder<T>(
  parseSuccess: ReturnType<typeof Schema.decodeUnknownSync<Schema.Decoder<T>>>,
) {
  return decoder(rpcEnvelopeSchema, (envelope): RpcResult<T> =>
    envelope.ok
      ? frozen({ ok: true, value: parseSuccess(envelope.value) })
      : frozen({ ok: false, error: parseErrorData(envelope.error) }),
  );
}
export const parseBootstrapResult = rpcDecoder(parseHostBootstrap);
export const parseRegisteredCommandResult = rpcDecoder(
  decoder(
    Schema.Struct({ commandId: boundedText(321) }),
    (value): RegisteredCommandWire => frozen(value),
  ),
);
export const parseCommandResultRpc = rpcDecoder(
  decoder(commandResultWireSchema, (value): CommandInvocationResultWire => {
    if (value.status === "failed")
      return frozen({
        status: "failed",
        error: parseSemantic(() => parseFailure(value.error)),
      });
    const result =
      value.result === undefined ? undefined : parseJsonValue(value.result);
    return result === undefined
      ? frozen({ status: "handled" })
      : frozen({ status: "handled", result });
  }),
);
export const parseVoidResult = rpcDecoder(
  decoder(Schema.Undefined, () => undefined),
);
export const parsePermissionOutcomeResult = rpcDecoder(
  decoder(permissionOutcomeSchema, (value): AppPermissionOutcome => value),
);
export const parseCloseDecisionResult = rpcDecoder(
  decoder(Schema.Boolean, (value) => value),
);
export const parseBackDecisionResult = rpcDecoder(
  decoder(Schema.Boolean, (value) => value),
);

function parseSemantic<T>(parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new AppError("The command metadata is invalid", {
      cause,
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
  }
}

const browserActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("saveFile"),
    name: boundedText(255).pipe(
      Schema.check(Schema.isPattern(/^[^\p{Cc}/\\]+$/u)),
    ),
    mime: boundedText(255),
    bytes: Schema.Uint8Array,
  }),
  Schema.Struct({ kind: Schema.Literal("copyText"), text: Schema.String }),
]);

/** Decode before effects, and reject oversized data before copying or sending it. */
export function parseBrowserAction(
  input: unknown,
): AppBrowserAction | AppBrowserActionRefusal {
  const parsed = Schema.decodeUnknownResult(browserActionSchema, {
    onExcessProperty: "error",
  })(input);
  if (Result.isFailure(parsed))
    return { kind: "refused", reason: "invalid-request" };
  const value = parsed.success;
  if (value.kind === "saveFile") {
    if (value.name === "." || value.name === "..")
      return { kind: "refused", reason: "invalid-request" };
    if (value.bytes.byteLength > APP_BROWSER_SAVE_MAX_BYTES)
      return { kind: "refused", reason: "too-large" };
    return { ...value, bytes: new Uint8Array(value.bytes) };
  }
  if (
    value.text.length > APP_BROWSER_COPY_MAX_BYTES ||
    new TextEncoder().encode(value.text).byteLength > APP_BROWSER_COPY_MAX_BYTES
  )
    return { kind: "refused", reason: "too-large" };
  return value;
}

export const parseBrowserActionOutcomeResult = rpcDecoder(
  decoder(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("saved") }),
      Schema.Struct({ kind: Schema.Literal("copied") }),
      Schema.Struct({
        kind: Schema.Literal("refused"),
        reason: Schema.Literals([
          "no-user-gesture",
          "too-large",
          "invalid-request",
          "unavailable",
          "denied",
          "busy",
        ]),
      }),
    ]),
    (value): AppBrowserActionOutcome => frozen(value),
  ),
);
