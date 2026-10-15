import * as z from "zod";
import { parseJsonValue } from "@fungi.computer/whistle/wire";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { defineCapability } from "./capabilities.js";
import {
  rpcHandleSchema,
  rpcVoid,
  rpcMethod,
  rpcDataSchema,
} from "./internal/rpc-contract.js";
import * as Schema from "effect/Schema";
import type {
  CapabilityContract,
  CapabilityDirectory,
} from "./capabilities.js";

/** A recipient App decides how to present this request; opening never sends it. */
export const appIntentSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("compose"),
    text: Schema.String.pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(2_000)),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    params: Schema.Array(
      Schema.Struct({
        key: Schema.String.pipe(
          Schema.check(Schema.isMinLength(1)),
          Schema.check(Schema.isMaxLength(64)),
        ),
        value: Schema.String.pipe(Schema.check(Schema.isMaxLength(1_024))),
      }),
    ).pipe(Schema.check(Schema.isMaxLength(16))),
  }),
]);
export type AppIntent = Schema.Schema.Type<typeof appIntentSchema>;
/** The navigate form of an App intent, whose params a role contract defines. */
export type AppNavigateIntent = Extract<AppIntent, { kind: "navigate" }>;

export const appOpenInputSchema = Schema.Union(
  [
    Schema.Struct({
      role: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(80)),
      ),
      intent: appIntentSchema,
    }),
    Schema.Struct({
      appId: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(128)),
      ),
      intent: appIntentSchema,
    }),
  ],
  { mode: "oneOf" },
);
export type AppOpenInput = Schema.Schema.Type<typeof appOpenInputSchema>;

/** The App the Team chose for a role, as the host's role routing resolves it; a null name is an unnamed App. */
export const appRoleChoiceSchema = z
  .strictObject({ displayName: z.string().min(1).max(80).nullable() })
  .nullable();
export type AppRoleChoice = z.output<typeof appRoleChoiceSchema>;

/**
 * Open the Team's chosen App for a role with a bounded presentation intent.
 * `role` answers which App that open would reach (null when none fills it),
 * so a caller can name or hide its entry without hard-coding another App.
 */
export const appsOpen: CapabilityContract<{
  open(input: AppOpenInput): Promise<void>;
  role(role: string): Promise<AppRoleChoice>;
}> = defineCapability(
  "apps.open",
  1,
  rpcHandleSchema({
    open: rpcVoid,
    role: rpcMethod(rpcDataSchema(appRoleChoiceSchema)),
  }),
);

export const openApp = (directory: CapabilityDirectory, input: AppOpenInput) =>
  directory.require(appsOpen).open(input);

/** Call a declared method of another App as the signed-in member. Caller grants never travel. */
export const appsCall: CapabilityContract<{
  /** The input is JSON text, as with app.methods; the result is decoded owned JSON. */
  call(appId: string, method: string, input: string): Promise<WhistleJsonValue>;
}> = defineCapability(
  "apps.call",
  1,
  rpcHandleSchema({
    call: rpcMethod(
      rpcDataSchema(z.unknown().transform((value) => parseJsonValue(value))),
    ),
  }),
);
