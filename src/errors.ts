import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as z from "zod";
import {
  mediaProviderDiagnosticSchema,
  mediaProviderDiagnosticZodSchema,
  mediaProviderErrorCategorySchema,
} from "./internal/media-diagnostic.js";

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
      /** Host-classified provider refusal, independent of public error prose. */
      reason?: "credits_exhausted";
    }>
  | Readonly<{
      /** A completed video result could not be downloaded. */
      category: "result_download";
      /** Native Response status, including zero. */
      status: number;
    }>;

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
): Exclude<MediaProviderDiagnostic["category"], "result_download"> {
  return (
    Option.getOrUndefined(
      Schema.decodeUnknownOption(mediaProviderErrorCategorySchema)(input),
    ) ?? "Error"
  );
}

/** The closed set of reasons an AppError can state; every SDK and
 * host-reported failure is tagged with exactly one of these codes. */
export const appErrorCodes = [
  "CANCELLED",
  "CAPABILITY_DENIED",
  "CAPABILITY_REVOKED",
  "COMMAND_NOT_DECLARED",
  "CONFLICT",
  "DELIVERY_PENDING",
  "DISCONNECTED",
  "FILE_TOO_LARGE",
  "HOST_FAILURE",
  "IDENTITY",
  "INSUFFICIENT_CREDIT",
  "INVALID_ARGUMENT",
  "MEDIA_PROVIDER_FAILURE",
  "MEDIA_PROVIDER_FAILURE_UNCHARGED",
  "PROTOCOL",
  "SAFETY_FILTER_REFUSED",
  "SELECTION_CHANGED",
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
});

/** Required construction options for an AppError. */
export type AppErrorOptions = {
  readonly cause?: unknown;
  readonly code: AppErrorCode;
  /** Every error states retry truth explicitly; absence is not a verdict. */
  readonly retryable: boolean;
};

/** The SDK's one typed failure. Carries a closed `code` naming the failure
 * kind and an explicit `retryable` verdict, instead of leaving callers to
 * guess either from the message or exception shape. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.retryable = options.retryable;
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
    action?: "grant" | "retry" | "reconnect" | "billing";
  }>;

type CopyEntry = ErrorCopy & Pick<ErrorDescription, "action">;

// User-facing wording approved by Levi; keep it in one reviewable table.
const errorCopy = {
  CANCELLED: {
    title: "Request cancelled",
    message: "This request was cancelled.",
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
    message: "This action isn't available in this App.",
  },
  CONFLICT: {
    title: "File changed",
    message: "This file changed elsewhere. Review it before saving again.",
  },
  DELIVERY_PENDING: {
    title: "App delivery pending",
    message: "The App hasn't finished getting ready. Try opening it again.",
  },
  DISCONNECTED: {
    title: "Connection lost",
    message: "Reopen the App to connect again.",
    action: "reconnect",
  },
  HOST_FAILURE: {
    title: "Couldn't complete the request",
    message: "The service couldn't complete this request.",
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
    title: "Something went wrong",
    message: "The App couldn't complete this request.",
    action: "billing",
  },
  INVALID_ARGUMENT: {
    title: "Request not accepted",
    message: "The App couldn't use the details in this request.",
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
    message: "The App received a response it couldn't use.",
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
  TIMEOUT: {
    title: "Still waiting",
    message: "The request didn't respond in time. Its outcome isn't known yet.",
  },
  UNKNOWN: {
    title: "Something went wrong",
    message: "The App couldn't complete this request.",
  },
} satisfies Readonly<Record<AppErrorCode | "UNKNOWN", CopyEntry>>;

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
  const copy = overrides?.[error.code] ?? entry;
  const action = entry.action ?? (error.retryable ? "retry" : undefined);
  const description = {
    title: copy.title,
    message: copy.message,
    retryable: error.retryable,
  };
  if (action) return { ...description, action };
  return description;
}
