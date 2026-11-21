import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as z from "zod";
import { setupNeedSchema } from "./internal/setup-need.js";
import {
  appBackendRefusalSchema,
  appFailureReasons,
  type AppFailureReason,
  type AppFailureWhere,
} from "./backend-refusal.js";
import {
  mediaProviderDetailMax,
  mediaProviderDiagnosticSchema,
  mediaProviderDiagnosticZodSchema,
  mediaProviderErrorCategorySchema,
} from "./internal/media-diagnostic.js";

export { mediaProviderDetailMax };

/** Why a provider call failed, in the closed set Prints can explain. */
export type MediaProviderReason =
  | "credits_exhausted"
  | "content_refused"
  | "invalid_input"
  | "rate_limited"
  | "provider_unavailable"
  | "remote_binding_disabled"
  | "timeout"
  | "spending_limit";

/** Declaration-safe projection of the canonical Media diagnostic grammar. */
export type MediaProviderDiagnostic =
  | Readonly<{
      /** Allowlisted Workers AI category; never a provider message. */
      category:
        | "InferenceUpstreamError"
        | "AiInternalError"
        | "TypeError"
        | "AbortError"
        | "TimeoutError"
        | "Error";
      /** Four- or five-digit provider prefix, or null when absent. */
      code: number | null;
      /** Host-classified failure class, independent of public error prose. */
      reason?: MediaProviderReason;
      /** The provider's short, host-sanitized sentence; never keys or JSON. */
      detail?: string;
    }>
  | Readonly<{
      /** A completed video result could not be downloaded. */
      category: "result_download";
      /** Native Response status, including zero. */
      status: number;
    }>
  | Readonly<{
      /** The host's own media service failed, such as a celld Hub's edge port. */
      category: "media_service";
      /** The service's closed failure, never its message. */
      failure: MediaServiceFailure;
    }>;

/** Why the host's own media service failed, in the closed set Prints can explain. */
export type MediaServiceFailure =
  | "invalid_request"
  | "unauthorized"
  | "unavailable"
  | "rate_limited"
  | "too_large"
  | "unreachable"
  | "invalid_response";

/** Decode only safe provider facts, rejecting unmodeled private fields. */
export function decodeMediaProviderDiagnostic(
  input: unknown,
): MediaProviderDiagnostic {
  // Bidirectional projection check, erased from the Promise declaration graph.
  return Schema.decodeUnknownSync(mediaProviderDiagnosticSchema, {
    onExcessProperty: "error",
  })(input) satisfies [MediaProviderDiagnostic] extends [
    typeof mediaProviderDiagnosticSchema.Type,
  ]
    ? MediaProviderDiagnostic
    : never;
}

/**
 * Documentable wire projection of the canonical diagnostic grammar.
 * Its owner supplies the native Zod dialect so output declarations remain
 * documentable without transforms, coercions or an unchecked type assertion.
 */
export const mediaProviderDiagnosticWireSchema: z.ZodType<MediaProviderDiagnostic> =
  mediaProviderDiagnosticZodSchema;

/** Decode an ordinary Error name without retaining arbitrary upstream text. */
export function decodeMediaProviderErrorCategory(
  input: string | undefined,
): Exclude<
  MediaProviderDiagnostic["category"],
  "result_download" | "media_service"
> {
  return (
    Option.getOrUndefined(
      Schema.decodeUnknownOption(mediaProviderErrorCategorySchema)(input),
    ) ?? "Error"
  );
}

/** The closed set of reasons an AppError can state; every SDK and
 * host-reported failure is tagged with exactly one of these codes. */
export const appErrorCodes = [
  "APP_CONFIGURATION_FAILED",
  "CANCELLED",
  "CAPABILITY_DENIED",
  "CAPABILITY_REVOKED",
  "COMMAND_NOT_DECLARED",
  "CONFLICT",
  "DAILY_LIMIT_REACHED",
  "DELIVERY_PENDING",
  "DESKTOP_OBSERVATION_LIMIT_REACHED",
  "DISCONNECTED",
  "FILE_TOO_LARGE",
  "HOST_FAILURE",
  "HOST_UNSUPPORTED",
  "IDENTITY",
  "INSUFFICIENT_CREDIT",
  "INVALID_ARGUMENT",
  /** A provider tried and failed. Never use it for a missing provider, account
   * or binding: that is `SETUP_REQUIRED`, which names what to set up. */
  "MEDIA_PROVIDER_FAILURE",
  "MEDIA_PROVIDER_FAILURE_UNCHARGED",
  "PROTOCOL",
  "SAFETY_FILTER_REFUSED",
  "SELECTION_CHANGED",
  /** Something the App needs is not set up; carries `need` for the copy. */
  "SETUP_REQUIRED",
  "TIMEOUT",
] as const;
/** One closed App error code from `appErrorCodes`. */
export type AppErrorCode = (typeof appErrorCodes)[number];

/** One pending-delivery refusal shared by admission and the shell. */
export type AppDeliveryPending = Readonly<{
  code: Extract<AppErrorCode, "DELIVERY_PENDING">;
}>;

const describedAppErrorSchema = Schema.Struct({
  name: Schema.Literal("AppError"),
  code: Schema.Literals(appErrorCodes),
  retryable: Schema.Boolean,
  need: Schema.optional(Schema.String),
  // Decoded leniently below: a newer host's reason must not fail the description.
  reason: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  where: Schema.optional(Schema.Unknown),
});

const appFailureReasonSchema = Schema.Literals(appFailureReasons);
const failureWhereSchema = Schema.Struct({
  binding: Schema.String,
  method: Schema.String,
  path: Schema.String,
});

/** Required construction options for an AppError. */
export type AppErrorOptions = {
  readonly cause?: unknown;
  readonly code: AppErrorCode;
  /** Every error states retry truth explicitly; absence is not a verdict. */
  readonly retryable: boolean;
  /** What a `SETUP_REQUIRED` failure needs, in plain words such as "a model". */
  readonly need?: string;
  /** The host's stated cause; `describeAppError` words it in place of the code's copy. */
  readonly reason?: AppFailureReason;
  /** Names this failure in the host's logs, shown with causes that are our bug. */
  readonly ref?: string;
  /** For `binding_reply_invalid`: which connection, method and field. */
  readonly where?: AppFailureWhere;
};

/** The SDK's one typed failure. Carries a closed `code` naming the failure
 * kind and an explicit `retryable` verdict, instead of leaving callers to
 * guess either from the message or exception shape. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  /** Set only on `SETUP_REQUIRED`: the missing thing, for the copy. */
  readonly need: string | undefined;
  /** The host's stated cause, when it supplied one. */
  readonly reason: AppFailureReason | undefined;
  /** The log reference for this failure, when the host supplied one. */
  readonly ref: string | undefined;
  /** Which connection's reply was unreadable, when the host said. */
  readonly where: AppFailureWhere | undefined;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.need = options.need;
    this.reason = options.reason;
    this.ref = options.ref;
    this.where = options.where;
  }
}

/** Trusted presentation copy; overrides never change recovery or retry policy. */
export type ErrorCopy = Readonly<{
  title: string;
  message: string;
}>;

/** Recovery hints are for the caller's UI, never an instruction to retry automatically. */
export type ErrorDescription = ErrorCopy &
  Readonly<{
    retryable: boolean;
    action?: "grant" | "retry" | "reconnect" | "billing" | "setup";
  }>;

type CopyEntry = ErrorCopy & Pick<ErrorDescription, "action">;

/** An out-of-contract `need` is ignored rather than failing the whole description. */
function setupNeed(value: string | undefined): string | undefined {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(setupNeedSchema)(value),
  );
}

function setupMessage(need: string | undefined): string {
  return `This needs ${need ?? "setup"} first.`;
}

// User-facing wording approved by Levi; keep it in one reviewable table.
const errorCopy = {
  APP_CONFIGURATION_FAILED: {
    title: "Couldn't load the App",
    message:
      "The App's configuration could not be loaded. Try opening it again.",
  },
  CANCELLED: {
    title: "Request cancelled",
    message:
      "It stopped before it finished. Start it again if you still want it.",
  },
  CAPABILITY_DENIED: {
    title: "Access needed",
    message: "This App needs permission to do that.",
    action: "grant",
  },
  CAPABILITY_REVOKED: {
    title: "Access changed",
    message: "This App no longer has permission to do that.",
    action: "grant",
  },
  COMMAND_NOT_DECLARED: {
    title: "Action unavailable",
    message: "This App doesn't include that action. It may need an update.",
  },
  CONFLICT: {
    title: "File changed",
    message: "This file changed elsewhere. Review it before saving again.",
  },
  DAILY_LIMIT_REACHED: {
    title: "Daily limit reached",
    message:
      "Today's spending limit for this Oyster is used up. It resets at 00:00 UTC.",
  },
  DELIVERY_PENDING: {
    title: "App delivery pending",
    message: "The App hasn't finished getting ready. Try opening it again.",
  },
  DESKTOP_OBSERVATION_LIMIT_REACHED: {
    title: "Desktop observation limit reached",
    message:
      "This desktop already has 24 active observations. Close one before adding another.",
  },
  DISCONNECTED: {
    title: "Connection lost",
    message: "Reopen the App to connect again.",
    action: "reconnect",
  },
  HOST_FAILURE: {
    title: "Couldn't complete the request",
    message:
      "The host stopped answering. Reopen the App or reload the workspace.",
  },
  HOST_UNSUPPORTED: {
    title: "Not available here",
    message: "This host doesn't offer that.",
  },
  FILE_TOO_LARGE: {
    title: "File too large",
    message: "Choose a file within the supported size limit.",
  },
  IDENTITY: {
    title: "Couldn't connect",
    message: "Reopen the App to connect again.",
    action: "reconnect",
  },
  INSUFFICIENT_CREDIT: {
    title: "Out of credit",
    message:
      "Your Team doesn't have enough credit for this. Add credit to continue.",
    action: "billing",
  },
  INVALID_ARGUMENT: {
    title: "Request not accepted",
    message: "Some of the details weren't usable. Check them and try again.",
  },
  MEDIA_PROVIDER_FAILURE: {
    title: "Generation failed",
    message:
      "The model couldn't complete this generation. Change the prompt or model and send again.",
  },
  MEDIA_PROVIDER_FAILURE_UNCHARGED: {
    title: "Generation failed",
    message:
      "The model couldn't complete this generation. You weren't charged. Change the prompt or model and send again.",
  },
  PROTOCOL: {
    title: "Couldn't read the response",
    message:
      "The host sent something this App doesn't understand. Reload the workspace; if it keeps happening, the App may need an update.",
  },
  SAFETY_FILTER_REFUSED: {
    title: "Generation refused",
    message:
      "The model refused this generation. Change the prompt or reference image and send again.",
  },
  SELECTION_CHANGED: {
    title: "Selection changed",
    message:
      "The selection changed during this request. Reopen the App to continue.",
    action: "reconnect",
  },
  SETUP_REQUIRED: {
    title: "Setup needed",
    message: setupMessage(undefined),
    action: "setup",
  },
  TIMEOUT: {
    title: "Still waiting",
    message: "The request didn't respond in time. Its outcome isn't known yet.",
  },
  UNKNOWN: {
    title: "Something went wrong",
    message: "The App couldn't complete this request.",
  },
} satisfies Readonly<Record<AppErrorCode | "UNKNOWN", CopyEntry>>;

/** " (ref abc)" for causes that are ours, so a report maps to a log line. */
function refSuffix(ref: string | undefined): string {
  return ref === undefined || ref === "" ? "" : ` (ref ${ref})`;
}

// What the host said went wrong, in plain words. Each entry names the cause;
// none carries exception text. Reviewed in this table with `errorCopy`.
const reasonCopy = {
  exec_isolation_required: () => ({
    title: "App can't run here",
    message: "This App needs a runtime this host doesn't have.",
  }),
  execution_not_admitted: () => ({
    title: "App not allowed to run",
    message:
      "This App isn't allowed to run right now. A Team owner can check its access.",
  }),
  artifact_unavailable: () => ({
    title: "App files missing",
    message: "This App's files couldn't be loaded. Update or reinstall it.",
  }),
  disabled: () => ({
    title: "App turned off",
    message: "This App is turned off.",
  }),
  timed_out: () => ({
    title: "Still waiting",
    message:
      "The App took too long to answer. Its result isn't known; check before you retry.",
  }),
  permission_changed: () => ({
    title: "Access changed",
    message:
      "This App's access changed while it was working. Review its permissions.",
    action: "grant",
  }),
  binding_reply_invalid: (ref, where) => ({
    title: "Internal error",
    message:
      where === undefined
        ? `One of the App's connections returned an answer we couldn't read. That's our bug${refSuffix(ref)}.`
        : `The App's ${where.binding.toLowerCase()} connection answered ${where.method} with something we couldn't read${where.path === "" ? "" : ` (${where.path})`}. That's our bug${refSuffix(ref)}.`,
  }),
  cancelled: () => ({
    title: "Request cancelled",
    message:
      "This request was cancelled before it finished. Start it again if you still want it.",
  }),
  request_too_large: () => ({
    title: "Request too large",
    message:
      "This request is too large for the App to accept. Try something smaller.",
  }),
  not_offered: () => ({
    title: "App can't do that",
    message: "This App doesn't offer that.",
  }),
  backend_error: (ref) => ({
    title: "The App failed",
    message: `The App's own code failed on this request${refSuffix(ref)}.`,
  }),
  internal: (ref) => ({
    title: "Internal error",
    message: `An internal error stopped the App from running this request${refSuffix(ref)}.`,
  }),
} satisfies Readonly<
  Record<
    AppFailureReason,
    (ref: string | undefined, where: AppFailureWhere | undefined) => CopyEntry
  >
>;

/**
 * Describe an SDK-decoded failure without exposing exception or request data.
 * The error owner retains retry truth. Grant and reconnect hints describe
 * prerequisites, so they can accompany a non-retryable operation.
 */
export function describeAppError(
  cause: unknown,
  overrides?: Partial<Record<AppErrorCode, ErrorCopy>>,
): ErrorDescription {
  // The picked shell and host can be separate bundles of this same SDK.
  const decoded = Schema.decodeUnknownOption(describedAppErrorSchema)(cause);
  if (Option.isNone(decoded)) return { ...errorCopy.UNKNOWN, retryable: false };
  const error = decoded.value;
  const entry: CopyEntry = errorCopy[error.code];
  const reason = Option.getOrUndefined(
    Schema.decodeUnknownOption(appFailureReasonSchema)(error.reason),
  );
  if (reason !== undefined) {
    const where = Option.getOrUndefined(
      Schema.decodeUnknownOption(failureWhereSchema)(error.where),
    );
    const stated: CopyEntry = reasonCopy[reason](error.ref, where);
    const statedAction =
      stated.action ?? (error.retryable ? "retry" : undefined);
    const description = {
      title: stated.title,
      message: stated.message,
      retryable: error.retryable,
    };
    return statedAction
      ? { ...description, action: statedAction }
      : description;
  }
  const copy =
    overrides?.[error.code] ??
    (error.code === "SETUP_REQUIRED"
      ? { title: entry.title, message: setupMessage(setupNeed(error.need)) }
      : entry);
  const action = entry.action ?? (error.retryable ? "retry" : undefined);
  const description = {
    title: copy.title,
    message: copy.message,
    retryable: error.retryable,
  };
  if (action) return { ...description, action };
  return description;
}

const failureTextMax = 200;

/** A request that never reached its server (a dropped connection or DNS failure). */
export class NetworkRequestError extends Error {
  constructor(options?: ErrorOptions) {
    super("The network request failed. Check your connection.", options);
    this.name = "NetworkRequestError";
  }
}

/**
 * One phrase naming why a failed call failed, for a toast, without a final
 * period so a caller can punctuate once. An App error states its cause through
 * {@link describeAppError}; a {@link NetworkRequestError} says the connection
 * failed; any other thrown Error states its own message (our own code wrote
 * it), capped; anything else says no reason was given. Never the generic
 * "something went wrong".
 */
export function failureCause(cause: unknown): string {
  const decoded = Schema.decodeUnknownOption(describedAppErrorSchema)(cause);
  const stated = Option.isSome(decoded)
    ? describeAppError(cause).message
    : cause instanceof z.ZodError
      ? "The response was not in the expected shape"
      : cause instanceof Error
        ? cause.message.trim()
        : "";
  const phrase = stated.replace(/\.+$/u, "");
  if (phrase.length === 0) return "No reason was given";
  return phrase.length > failureTextMax
    ? `${phrase.slice(0, failureTextMax)}…`
    : phrase;
}

/** What failed, then why, as one sentence: "The conversation could not be started: <cause>." */
export function failureMessage(what: string, cause: unknown): string {
  return `${what}: ${failureCause(cause)}.`;
}

/**
 * {@link failureMessage} for an App whose host may put private text in an
 * untyped error. A typed App error states its cause; anything else says only
 * that the host returned an error it did not describe.
 */
export function typedFailureMessage(what: string, cause: unknown): string {
  return Option.isSome(
    Schema.decodeUnknownOption(describedAppErrorSchema)(cause),
  )
    ? failureMessage(what, cause)
    : `${what}: the host returned an error it did not describe.`;
}

/** The closed code each stated reason travels under; the reason words the copy. */
const reasonCode = {
  exec_isolation_required: "HOST_FAILURE",
  execution_not_admitted: "HOST_FAILURE",
  artifact_unavailable: "HOST_FAILURE",
  disabled: "HOST_FAILURE",
  timed_out: "TIMEOUT",
  permission_changed: "CAPABILITY_REVOKED",
  binding_reply_invalid: "HOST_FAILURE",
  backend_error: "HOST_FAILURE",
  cancelled: "CANCELLED",
  request_too_large: "HOST_FAILURE",
  not_offered: "HOST_FAILURE",
  internal: "HOST_FAILURE",
} as const satisfies Readonly<Record<AppFailureReason, AppErrorCode>>;

/**
 * The failure a non-ok App backend response states. A host body naming a closed
 * reason (and its log ref) becomes an `AppError` carrying both, so
 * `describeAppError` words the real cause; a body that names none still says
 * which status the backend answered. The one place a response turns into an
 * App failure: callers do not word it themselves.
 */
export async function readAppFailure(response: Response): Promise<AppError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // A body that is not JSON states no reason.
    if (!(cause instanceof SyntaxError)) throw cause;
  }
  const retryable = response.status >= 500;
  const stated = appBackendRefusalSchema.safeParse(body);
  if (!stated.success)
    return new AppError(
      `The App backend answered HTTP ${String(response.status)}`,
      {
        code: "HOST_FAILURE",
        retryable,
      },
    );
  const { reason, ref, where } = stated.data;
  const options: AppErrorOptions = {
    code: reasonCode[reason],
    // A timeout's outcome is unknown, so never invite a blind retry.
    retryable: reason === "timed_out" ? false : retryable,
    reason,
  };
  const detailed: AppErrorOptions =
    ref === undefined ? options : { ...options, ref };
  return new AppError(
    `The App backend failed: ${reason}`,
    where === undefined ? detailed : { ...detailed, where },
  );
}
