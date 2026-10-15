import * as Schema from "effect/Schema";
import {
  appStorageScopes,
  appStorageKeyNameSchema,
} from "@fungi.computer/puffball/app";
export { appStorageKeyNameSchema };
/**
 * Storage error codes the host and client agree on: invalid input, an
 * undeclared key, a scope this App never declared, a member-only action
 * tried without a member, a value or quota that is too large, a write
 * conflict, or a transient host failure.
 */
export const appStorageErrorCodes = [
  "invalid",
  "undeclared_key",
  "scope_not_declared",
  "owner_required",
  "too_large",
  "quota_exceeded",
  "conflict",
  "unavailable",
] as const;
/** Validates that a value is one of the known storage error codes. */
export const appStorageErrorCodeSchema = Schema.Literals(appStorageErrorCodes);
/**
 * Thrown by the storage client when a read, write, reset, or watch is
 * rejected by the host; `code` identifies why.
 */
export class AppStorageError extends Error {
  constructor(
    readonly code: typeof appStorageErrorCodeSchema.Type,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
const revision = Schema.Int.check(Schema.isGreaterThan(0));
const layer = Schema.Struct({ value: Schema.Json, revision });
/**
 * Validates the resolved shape of a storage key: its merged value, which
 * layer it came from, the raw team and member layers it was merged from,
 * and whether this App may write to the team layer.
 */
export const resolvedAppStorageSchema = Schema.Struct({
  value: Schema.Json,
  source: Schema.Literals(["member", "team", "none"]),
  team: Schema.NullOr(layer),
  member: Schema.NullOr(layer),
  canWriteTeam: Schema.Boolean,
});
/**
 * The resolved value for a storage key, as returned by `read`: the merged
 * value, which layer it came from, the raw team/member layers, and whether
 * this App may write to the team layer.
 */
export type ResolvedAppStorage = typeof resolvedAppStorageSchema.Type;
const mutation = {
  key: appStorageKeyNameSchema,
  scope: Schema.Literals(appStorageScopes),
  basedOn: Schema.NullOr(revision),
};
/**
 * Validates a write request: the key, scope, value to store, and the
 * revision it's conditioned on (`null` to write unconditionally).
 */
export const appStorageWriteSchema = Schema.Struct({
  ...mutation,
  value: Schema.Json,
});
/**
 * Validates a reset request: the key, scope, and the revision it's
 * conditioned on (`null` to reset unconditionally).
 */
export const appStorageResetSchema = Schema.Struct(mutation);
/** A validated write request for one storage key. */
export type AppStorageWrite = typeof appStorageWriteSchema.Type;
/** A validated reset request for one storage key. */
export type AppStorageReset = typeof appStorageResetSchema.Type;

/** Validates a bare revision number returned after a write or reset. */
export const appStorageRevisionSchema = Schema.Struct({ revision });
/**
 * Validates a change-event payload pushed when a storage key's value
 * changes, naming the App, key, scope, and resulting revision.
 */
export const appStorageEventSchema = Schema.Struct({
  appId: Schema.String,
  key: appStorageKeyNameSchema,
  scope: Schema.Literals(appStorageScopes),
  revision,
});
/**
 * A change-event payload identifying which App, key, scope, and
 * resulting revision changed.
 */
export type AppStorageEvent = typeof appStorageEventSchema.Type;
/**
 * The wire-level outcome of a storage operation: either an accepted
 * value or a rejection carrying an {@link AppStorageError} code.
 */
export type AppStorageResult<A> =
  | Readonly<{ kind: "accepted"; value: A }>
  | Readonly<{ kind: "rejected"; code: AppStorageError["code"] }>;
/**
 * Validates the wire result of a read: either an accepted resolved
 * value or a rejection code.
 */
export const appStorageReadResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    value: resolvedAppStorageSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    code: appStorageErrorCodeSchema,
  }),
]);
/**
 * Validates the wire result of a write or reset: either an accepted
 * revision or a rejection code.
 */
export const appStorageMutationResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    value: appStorageRevisionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    code: appStorageErrorCodeSchema,
  }),
]);

const brokerRefusal = Schema.Struct({ error: Schema.String });
/** The read result at a host broker, retaining its existing admission/failure reply. */
export const appStorageBrokerReadResultSchema = Schema.Union([
  appStorageReadResultSchema,
  brokerRefusal,
]);
/** The shared write/reset result at a host broker, including its existing failure reply. */
export const appStorageBrokerMutationResultSchema = Schema.Union([
  appStorageMutationResultSchema,
  brokerRefusal,
]);
