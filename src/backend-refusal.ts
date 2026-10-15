import * as z from "zod";

/** Closed host refusal vocabulary. Private backend messages never reach callers. */
export const appBackendRefusalSchema = z.strictObject({
  error: z.literal("App execution unavailable"),
  reason: z.enum([
    "exec_isolation_required",
    "execution_not_admitted",
    "artifact_unavailable",
  ]),
});
