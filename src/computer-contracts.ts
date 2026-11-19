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

/**
 * The host could not tell why the Computer did not answer. `ref` names the
 * host log line that holds the cause, so a report maps to it. A bare
 * `{ error: "unavailable" }` stays valid in each refusal schema below.
 */
export const appComputerUnavailableSchema = z.lazy(() =>
  z.strictObject({
    error: z.literal("unavailable"),
    ref: z.string().min(1).max(128),
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
    appComputerUnavailableSchema,
    connectorOperationBudgetRefusalSchema,
  ]),
);

/** Existing Computer broker argument refusals. */
export const appComputerInputRefusalSchema = z.lazy(() =>
  z.strictObject({
    error: z.enum(["too_large", "invalid_path", "invalid"]),
  }),
);

/**
 * Why the Computer refused or could not run a dispatched request: its own
 * status answers (`not_granted`, `too_large`, `conflict`), a full host
 * (`capacity`), a Team without Computer credit (`unfunded`), an admission
 * check that could not run (`admission_unavailable`), no machine to run on
 * (`backend_unavailable`), or an unknown cause (`unavailable`, with its log
 * ref). The host does not send the named causes or the ref yet: released
 * Apps reject them, so it answers `{ error: "unavailable" }` until a
 * server-written release opt-in exists (see {@link appComputerNamedRefusalSchema}).
 */
export const appComputerDispatchRefusalSchema = z.lazy(() =>
  z.union([
    z.strictObject({
      error: z.enum([
        "not_granted",
        "too_large",
        "conflict",
        "capacity",
        "unfunded",
        "admission_unavailable",
        "backend_unavailable",
        "unavailable",
      ]),
    }),
    appComputerUnavailableSchema,
  ]),
);

/**
 * The named refusals the host does not send yet: released Apps decode only
 * the plain shapes, so the host answers each of these `{ error: "unavailable" }`
 * and keeps the real cause in its audit line. Not sent yet.
 */
export const appComputerNamedRefusalSchema = z.lazy(() =>
  z.union([
    z.strictObject({
      error: z.enum([
        "capacity",
        "unfunded",
        "admission_unavailable",
        "backend_unavailable",
      ]),
    }),
    appComputerUnavailableSchema,
  ]),
);

/** An execution wait can time out while its durable request remains identifiable. */
export const appComputerExecTimeoutSchema = z.lazy(() =>
  z.strictObject({
    error: z.literal("timeout"),
    requestId: z.string(),
  }),
);

/** Every code a Computer refusal can carry, including per-operation `not_found`. */
export const appComputerRefusalCodeSchema = z.enum([
  "revoked",
  "not_granted",
  "grantor_lost_authority",
  "attachment_budget_exceeded",
  "too_large",
  "invalid_path",
  "invalid",
  "not_found",
  "conflict",
  "timeout",
  "capacity",
  "unfunded",
  "admission_unavailable",
  "backend_unavailable",
  "unavailable",
]);
export type AppComputerRefusalCode = z.output<
  typeof appComputerRefusalCodeSchema
>;

/**
 * A Computer refusal that is a code alone, or `unavailable` with its log
 * ref: what an App method passes on when the Computer declined. Budget and
 * timeout refusals keep their own schemas above.
 */
export type AppComputerPlainRefusal = z.output<
  typeof appComputerPlainRefusalSchema
>;
export const appComputerPlainRefusalSchema = z.lazy(() =>
  z.union([
    z.strictObject({
      error: appComputerRefusalCodeSchema.exclude([
        "attachment_budget_exceeded",
        "timeout",
      ]),
    }),
    appComputerUnavailableSchema,
  ]),
);

/** " (ref abc)" for an unknown cause, so a report maps to its log line. */
function refSuffix(ref: string | undefined): string {
  return ref === undefined || ref === "" ? "" : ` (ref ${ref})`;
}

// What the Computer said, in plain words. Each sentence names the cause and
// none shows a raw code. Reviewed in this one table.
const computerRefusalCopy = {
  revoked: () => "This App's access to the Computer was removed.",
  not_granted: () => "This App doesn't have access to this Computer.",
  grantor_lost_authority: () =>
    "The person who gave this App Computer access no longer has it.",
  attachment_budget_exceeded: () =>
    "This App has used its Computer allowance for now. Try again later.",
  too_large: () =>
    "That's too large for the Computer to take. Try something smaller.",
  invalid_path: () => "That path isn't allowed on this Computer.",
  invalid: () => "The Computer couldn't accept that request as written.",
  not_found: () => "That file or folder isn't on the Computer.",
  conflict: () =>
    "It changed on the Computer while this was running. Reload it and try again.",
  timeout: () =>
    "The Computer didn't finish in time. It may still be running the command.",
  capacity: () =>
    "The Computer's host is full right now. Try again in a minute.",
  unfunded: () =>
    "This Team is out of Computer credit. Add credit to keep using it.",
  admission_unavailable: () =>
    "We couldn't check this Computer's access just now. Try again shortly.",
  backend_unavailable: () =>
    "The machine behind this Computer isn't available right now. Try again shortly.",
  unavailable: (ref) =>
    `The Computer didn't answer, and we don't know why yet${refSuffix(ref)}.`,
} satisfies Readonly<
  Record<AppComputerRefusalCode, (ref: string | undefined) => string>
>;

/**
 * The plain sentence for a Computer refusal code, for any runtime (an App
 * backend's result rows, or a UI through `describeComputerRefusal`). Pass the
 * `ref` an `unavailable` refusal carries so the sentence names its log line.
 */
export function computerRefusalMessage(
  code: AppComputerRefusalCode,
  ref?: string,
): string {
  return computerRefusalCopy[code](ref);
}
