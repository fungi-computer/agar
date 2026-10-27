import * as Schema from "effect/Schema";
import * as z from "zod";
import {
  ApprovalViewSchema,
  ApprovalRefusalSchema,
  AutoApproveInputSchema,
  type Approvals,
} from "@fungi.computer/approvals";
import { defineCapability, type CapabilityContract } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
} from "./internal/rpc-contract.js";

export type { Approvals } from "@fungi.computer/approvals";

const refusal = ApprovalRefusalSchema;
const page = Schema.Struct({
  items: Schema.Array(ApprovalViewSchema),
  nextCursor: Schema.NullOr(Schema.String),
});
const answer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("answered"), view: ApprovalViewSchema }),
  refusal,
]);
const policy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("updated"),
    rule: AutoApproveInputSchema,
  }),
  refusal,
]);

// Match the existing storage/Agent capability adapters: the maintained RPC
// helpers bind native stub receivers, decode data and release result envelopes.
const data = <A>(schema: Schema.Codec<A, unknown>) =>
  rpcDataSchema(
    z
      .unknown()
      .transform((value) =>
        Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
      ),
  );

/** Member-bound approval view. Authentication and current rights belong to the host. */
export const approvals: CapabilityContract<Approvals> = defineCapability(
  "approvals",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      list: rpcMethod(data(page)),
      get: rpcMethod(data(Schema.NullOr(ApprovalViewSchema))),
      answer: rpcMethod(data(answer)),
      setAutoApprove: rpcMethod(data(policy)),
    }),
  ),
);
