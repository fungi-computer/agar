/** The closed set of reasons an AppError can state; every SDK and
 * host-reported failure is tagged with exactly one of these codes. */
export type AppErrorCode =
  | "CANCELLED"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_REVOKED"
  | "COMMAND_NOT_DECLARED"
  | "CONFLICT"
  | "DISCONNECTED"
  | "FILE_TOO_LARGE"
  | "HOST_FAILURE"
  | "IDENTITY"
  | "INSUFFICIENT_CREDIT"
  | "INVALID_ARGUMENT"
  | "PROTOCOL"
  | "SAFETY_FILTER_REFUSED"
  | "SELECTION_CHANGED"
  | "TIMEOUT";

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
  PROTOCOL: {
    title: "Couldn't read the response",
    message: "The App received a response it couldn't use.",
  },
  SAFETY_FILTER_REFUSED: {
    title: "Safety filter refused this prompt",
    message: "The model's safety filter refused this prompt — try rewording.",
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
  if (!(cause instanceof AppError))
    return { ...errorCopy.UNKNOWN, retryable: false };
  const entry: CopyEntry = errorCopy[cause.code];
  const copy = overrides?.[cause.code] ?? entry;
  const action = entry.action ?? (cause.retryable ? "retry" : undefined);
  const description = {
    title: copy.title,
    message: copy.message,
    retryable: cause.retryable,
  };
  if (action) return { ...description, action };
  return description;
}
