import * as z from "zod";

/** Public metadata for one host-admitted Workflow Git pass; parsing never grants authority. */
export const workflowGitPassResultSchema = z.strictObject({
  passId: z.string().min(1),
  remote: z.url({ protocol: /^https$/, abort: true }).refine((value) => {
    const remote = new URL(value);
    return remote.username === "" && remote.password === "";
  }, "Workflow Git remotes must not contain credentials"),
  expiresAt: z.number().int().positive(),
  /**
   * Present when the host admits this pass by `Authorization: Bearer` on the
   * remote. It is never part of the remote; a command receives it only as
   * command-local Git config, never written to a repository config.
   */
  bearer: z.string().min(1).exactOptional(),
});
/** The complete remote stays opaque; the host owns admission, renewal and revocation. */
export type WorkflowGitPassResult = z.output<
  typeof workflowGitPassResultSchema
>;

/** Existing attachment budget operation kinds shared by Computer and Media. */
export const connectorOperationBudgetKindSchema = z.enum([
  "exec",
  "write",
  "media",
]);

/** Existing owner budget refusal; it remains a domain result, not a wire envelope. */
export const connectorOperationBudgetRefusalSchema = z.strictObject({
  error: z.literal("attachment_budget_exceeded"),
  kind: connectorOperationBudgetKindSchema,
  retryAfterMs: z.number(),
});

/** Computer admission refusals returned before native dispatch. */
export const appComputerAdmissionRefusalSchema = z.union([
  z.strictObject({
    error: z.enum([
      "revoked",
      "not_granted",
      "grantor_lost_authority",
      "unavailable",
    ]),
  }),
  connectorOperationBudgetRefusalSchema,
]);

/** Existing Computer broker argument refusals. */
export const appComputerInputRefusalSchema = z.strictObject({
  error: z.enum(["too_large", "invalid_path", "invalid"]),
});

/** Existing Computer dispatch status/decoding refusals. */
export const appComputerDispatchRefusalSchema = z.strictObject({
  error: z.enum(["not_granted", "too_large", "conflict", "unavailable"]),
});

/** An execution wait can time out while its durable request remains identifiable. */
export const appComputerExecTimeoutSchema = z.strictObject({
  error: z.literal("timeout"),
  requestId: z.string(),
});

/** The Workflow Git-pass owner has exactly these existing domain refusals. */
export const workflowGitPassRefusalSchema = z.strictObject({
  error: z.enum(["revoked", "not_granted", "unavailable"]),
});
