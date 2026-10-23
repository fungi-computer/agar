import * as z from "zod";

/** Existing attachment budget operation kinds shared by Computer and Media. */
export const connectorOperationBudgetKindSchema = z.enum([
  "exec",
  "write",
  "media",
]);

/** Existing owner budget refusal; it remains a domain result, not a wire envelope. */
export const connectorOperationBudgetRefusalSchema = z.lazy(() =>
  z.strictObject({
    error: z.literal("attachment_budget_exceeded"),
    kind: connectorOperationBudgetKindSchema,
    retryAfterMs: z.number(),
  }),
);

/** Computer admission refusals returned before native dispatch. */
export const appComputerAdmissionRefusalSchema = z.lazy(() =>
  z.union([
    z.strictObject({
      error: z.enum([
        "revoked",
        "not_granted",
        "grantor_lost_authority",
        "unavailable",
      ]),
    }),
    connectorOperationBudgetRefusalSchema,
  ]),
);

/** Existing Computer broker argument refusals. */
export const appComputerInputRefusalSchema = z.lazy(() =>
  z.strictObject({
    error: z.enum(["too_large", "invalid_path", "invalid"]),
  }),
);

/** Existing Computer dispatch status/decoding refusals. */
export const appComputerDispatchRefusalSchema = z.lazy(() =>
  z.strictObject({
    error: z.enum(["not_granted", "too_large", "conflict", "unavailable"]),
  }),
);

/** An execution wait can time out while its durable request remains identifiable. */
export const appComputerExecTimeoutSchema = z.lazy(() =>
  z.strictObject({
    error: z.literal("timeout"),
    requestId: z.string(),
  }),
);
