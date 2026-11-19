import * as z from "zod";

/**
 * The closed set of reasons a host states when an App could not run a request.
 * Each names one cause a person can act on or report; private backend messages
 * and guest-authored text never appear here.
 */
export const appFailureReasons = [
  "exec_isolation_required",
  "execution_not_admitted",
  "artifact_unavailable",
  "disabled",
  /** The Instance deadline passed; the outcome is not known. */
  "timed_out",
  /** The App's access was revoked or narrowed while it was working. */
  "permission_changed",
  /** A reply from one of the App's connections did not match its contract: our bug. */
  "binding_reply_invalid",
  /** The App's own backend failed on this request. */
  "backend_error",
  /** The request was cancelled before it finished. */
  "cancelled",
  /** The request was larger than the App accepts. */
  "request_too_large",
  /** The App does not offer what was asked for. */
  "not_offered",
  /** Anything else the host cannot classify: our bug, always with a `ref`. */
  "internal",
] as const;
/** One of {@link appFailureReasons}. */
export type AppFailureReason = (typeof appFailureReasons)[number];

/** Where a connection's reply was unreadable: host-known names and a field path, never values. */
export const appFailureWhereSchema = z.strictObject({
  binding: z.string().min(1).max(64),
  method: z.string().min(1).max(128),
  path: z.string().max(256),
});
/** A decoded {@link appFailureWhereSchema} value. */
export type AppFailureWhere = z.output<typeof appFailureWhereSchema>;

/** Closed host refusal vocabulary. Private backend messages never reach callers. */
export const appBackendRefusalSchema = z.strictObject({
  error: z.literal("App execution unavailable"),
  reason: z.enum(appFailureReasons),
  /** Names this failure in the host's logs; present for causes the host logged. */
  ref: z.string().min(1).max(64).optional(),
  /** For `binding_reply_invalid`: which connection, method and field. */
  where: appFailureWhereSchema.optional(),
});
