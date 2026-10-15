import * as z from "zod";
import type { WhistleJsonValue } from "@fungi.computer/whistle";

/**
 * The closed vocabulary an App method may refuse with. Each code names one
 * caller-visible outcome; the host owns how it is presented (see
 * {@link appMethodRefusalStatus}).
 */
export const appMethodRefusalCodes = [
  "invalid",
  "forbidden",
  "not_found",
  "conflict",
  "unavailable",
] as const;
/** One of {@link appMethodRefusalCodes}. */
export type AppMethodRefusalCode = (typeof appMethodRefusalCodes)[number];

/** HTTP status for each refusal code, shared by every host and App route. */
export const appMethodRefusalStatus = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
} as const satisfies Record<AppMethodRefusalCode, number>;

/** Bound on the App-authored refusal message that reaches callers. */
export const maxAppMethodRefusalMessage = 500;

/**
 * An App method's declared domain refusal. A handler throws it to decline a
 * call; the generated method boundary returns it as a typed
 * {@link AppMethodReply} instead of an execution failure. Its message is
 * caller-facing App copy, so it must not carry private data.
 */
export class AppMethodRefusal extends Error {
  readonly code: AppMethodRefusalCode;

  constructor(code: AppMethodRefusalCode, message: string) {
    super(message);
    this.name = "AppMethodRefusal";
    this.code = code;
  }
}

/** A refused call as it crosses the generated method boundary. */
export const appMethodRefusedReplySchema = z.strictObject({
  kind: z.literal("refused"),
  code: z.enum(appMethodRefusalCodes),
  message: z.string().min(1).max(maxAppMethodRefusalMessage),
});
/** A decoded {@link appMethodRefusedReplySchema} value. */
export type AppMethodRefusedReply = z.output<
  typeof appMethodRefusedReplySchema
>;

/** Every generated App method RPC answers with exactly one of these. */
export const appMethodReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ok"), value: z.json() }),
  appMethodRefusedReplySchema,
]);
/** A decoded {@link appMethodReplySchema} value; the result is read-only JSON. */
export type AppMethodReply =
  Readonly<{ kind: "ok"; value: WhistleJsonValue }> | AppMethodRefusedReply;
