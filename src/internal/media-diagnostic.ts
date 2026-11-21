import * as Schema from "effect/Schema";
import * as z from "zod";

const categories = [
  "InferenceUpstreamError",
  "AiInternalError",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "Error",
] as const;
/** Why a provider call failed, in the closed set Prints can explain. */
const mediaProviderReasons = [
  "credits_exhausted",
  "content_refused",
  "invalid_input",
  "rate_limited",
  "provider_unavailable",
  "remote_binding_disabled",
  "timeout",
  "spending_limit",
] as const;
/** Why the host's own media service failed before or around the provider. */
const mediaServiceFailures = [
  "invalid_request",
  "unauthorized",
  "unavailable",
  "rate_limited",
  "too_large",
  "unreachable",
  "invalid_response",
] as const;
/** Longest provider sentence kept; the host decodes it before it crosses. */
export const mediaProviderDetailMax = 160;
const providerCodeBounds = { minimum: 0, maximum: 99_999 };
const responseStatusBounds = { minimum: 0, maximum: 599 };

/** Names emitted by the maintained Workers AI boundary, never arbitrary names. */
export const mediaProviderErrorCategorySchema = Schema.Literals(categories);

/** One canonical grammar for safe provider facts across Media transports. */
export const mediaProviderDiagnosticSchema = Schema.Union([
  Schema.Struct({
    category: mediaProviderErrorCategorySchema,
    code: Schema.NullOr(Schema.Int.check(Schema.isBetween(providerCodeBounds))),
    reason: Schema.optionalKey(Schema.Literals(mediaProviderReasons)),
    detail: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(mediaProviderDetailMax)),
    ),
  }),
  Schema.Struct({
    category: Schema.Literal("result_download"),
    status: Schema.Int.check(Schema.isBetween(responseStatusBounds)),
  }),
  Schema.Struct({
    category: Schema.Literal("media_service"),
    failure: Schema.Literals(mediaServiceFailures),
  }),
]);

/** Documentable Promise transport grammar; this module owns both schema dialects. */
export const mediaProviderDiagnosticZodSchema = z.union([
  z.strictObject({
    category: z.enum(categories),
    code: z
      .number()
      .int()
      .min(providerCodeBounds.minimum)
      .max(providerCodeBounds.maximum)
      .nullable(),
    reason: z.enum(mediaProviderReasons).optional(),
    detail: z.string().max(mediaProviderDetailMax).optional(),
  }),
  z.strictObject({
    category: z.literal("result_download"),
    status: z
      .number()
      .int()
      .min(responseStatusBounds.minimum)
      .max(responseStatusBounds.maximum),
  }),
  z.strictObject({
    category: z.literal("media_service"),
    failure: z.enum(mediaServiceFailures),
  }),
]);
