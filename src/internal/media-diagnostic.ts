import * as Schema from "effect/Schema";

/** Names emitted by the maintained Workers AI boundary, never arbitrary names. */
export const mediaProviderErrorCategorySchema = Schema.Literals([
  "InferenceUpstreamError",
  "AiInternalError",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "Error",
]);

/** One canonical grammar for safe provider facts across Media transports. */
export const mediaProviderDiagnosticSchema = Schema.Union([
  Schema.Struct({
    category: mediaProviderErrorCategorySchema,
    code: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99_999 })),
    ),
  }),
  Schema.Struct({
    category: Schema.Literal("result_download"),
    status: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 599 })),
  }),
]);
