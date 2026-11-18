import * as z from "zod";

/** The owners that report a run in this shape. */
export const runObservationSourceSchema = z.enum({
  /** A process on a Computer, observed through Shed. */
  shedProcess: "shed.process",
  /** An App build job, observed through Oyster. */
  oysterBuild: "oyster.build",
});

/**
 * Where a run stands. `completed` means the owner saw it finish without an
 * error; it is never verification, so `verified` is reserved for an owner that
 * has checked the result. `unknown` means the owner cannot say.
 */
export const runObservationStateSchema = z.enum({
  /** The owner has the request but nothing is executing yet. */
  requested: "requested",
  /** The owner accepted the request and is starting it. */
  admitted: "admitted",
  /** It is executing. */
  running: "running",
  /** It finished and a person must review the result. */
  needs_review: "needs_review",
  /** It finished without an error; nobody has verified the result. */
  completed: "completed",
  /** The result was checked and accepted. */
  verified: "verified",
  /** It ended with an error, or was ended by the platform. */
  failed: "failed",
  /** The caller stopped it. */
  cancelled: "cancelled",
  /** The owner cannot say what became of it. */
  unknown: "unknown",
});

/**
 * A position in an owner's log file. `cursor` is a byte offset the owner
 * issued: pass it back unchanged to read on. `size` is the bytes the owner has
 * confirmed present, so it is at least `cursor` and exact when `eof` is true.
 * `eof` means the observation read to the end of the log as it stands; a
 * running run may write more.
 */
export const runObservationLogSchema = z
  .strictObject({
    cursor: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    eof: z.boolean(),
  })
  .check(
    z.refine(
      ({ cursor, size, eof }) => size >= cursor && (!eof || size === cursor),
      "A log's size is at least its cursor, and the cursor reaches the size at eof",
    ),
  );

/** One thing a run produced, such as its log. */
export const runObservationOutputSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  ref: z.string().min(1).max(4096),
});

/**
 * What a run costs, in the owner's unit. Owners that do not meter a run report
 * `null`; a cost is never estimated.
 */
export const runObservationCostSchema = z.strictObject({
  amount: z.number().nonnegative(),
  unit: z.string().min(1).max(32),
});

/**
 * One run as its owner reports it. The owner maps its own records into this
 * shape and keeps no copy: reading it again by `id` is how a caller recovers
 * after a lost connection.
 */
export const runObservationSchema = z.strictObject({
  source: runObservationSourceSchema,
  /** The owner's id for the run. */
  id: z.string().min(1).max(256),
  /** The run this one replaced or was started from. */
  parentId: z.string().min(1).max(256).optional(),
  /** The source revision the run worked from. */
  sourceRevision: z.string().min(1).max(256).optional(),
  state: runObservationStateSchema,
  /** A short snake_case code that says why, such as `computer_slept`. */
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(64)
    .optional(),
  /** Milliseconds since the epoch: the earliest time the owner recorded. */
  requestedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  /** Null when no log can be read for this observation. */
  log: runObservationLogSchema.nullable(),
  outputs: z.array(runObservationOutputSchema).max(16),
  cost: runObservationCostSchema.nullable(),
});

/** A value of {@link runObservationSchema}. */
export type RunObservation = z.output<typeof runObservationSchema>;
