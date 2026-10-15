import * as z from "zod";
import { pendingSchema } from "./pending.js";

/** Refusals emitted by the Team App build owner. */
export const teamAppBuildFailureCodeSchema = z.enum([
  "invalid",
  "denied",
  "conflict",
  "unavailable",
  "build_failed",
]);

/** Pending, completed or failed reply from the App build owner. */
export const appBuildReplySchema = z.union([
  pendingSchema,
  z.strictObject({
    releaseId: z.string().min(1).max(256),
    previewUrl: z.url(),
  }),
  z.strictObject({ error: teamAppBuildFailureCodeSchema }),
]);

/** Complete App build binding reply, including broker admission failures. */
export const appBuildBrokerResultSchema = z.union([
  appBuildReplySchema,
  z.strictObject({ error: z.string() }),
]);
