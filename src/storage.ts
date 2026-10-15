import * as Schema from "effect/Schema";
import * as z from "zod";
import { EventSource } from "eventsource";
import { defineCapability, type CapabilityContract } from "./capabilities.js";
import {
  rpcHandleSchema,
  rpcDataSchema,
  rpcMethod,
  rpcFetchHandleSchema,
} from "./internal/rpc-contract.js";
import { createReadonlyStore } from "./internal/store.js";
import { reportCatchFailure } from "./failure.js";
import type { ReadonlyStore } from "./store.js";
import {
  AppStorageError,
  appStorageKeyNameSchema,
  appStorageWriteSchema,
  appStorageResetSchema,
  appStorageReadResultSchema,
  appStorageMutationResultSchema,
  appStorageEventSchema,
  type AppStorageResult,
  type AppStorageWrite,
  type AppStorageReset,
  type ResolvedAppStorage,
} from "./storage-wire.js";
export * from "./storage-wire.js";

/**
 * A live subscription to one storage key's resolved value: read the
 * current value, subscribe to changes, and close when done watching.
 */
export type AppStorageWatch = ReadonlyStore<ResolvedAppStorage> &
  Disposable & {
    /** Stop watching and release the underlying event subscription. */
    close(): void;
  };
/** This App's storage client, scoped to its declared member/team data. */
export type AppStorage = Readonly<{
  /** Read the resolved value for `key`, merging team and member layers. */
  read(key: string): Promise<ResolvedAppStorage>;
  /**
   * Write a value for a key and scope, optionally conditioned on
   * `basedOn` revision; resolves with the resulting revision.
   */
  write(input: AppStorageWrite): Promise<{ revision: number }>;
  /**
   * Clear a key's value for a scope, optionally conditioned on
   * `basedOn` revision; resolves with the resulting revision.
   */
  reset(input: AppStorageReset): Promise<{ revision: number }>;
  /** Resolves after the first admitted snapshot; close when the consumer leaves. */
  watch(key: string): Promise<AppStorageWatch>;
}>;
const data = <A>(schema: Schema.Codec<A, unknown>) =>
  rpcDataSchema(
    z
      .unknown()
      .transform((value) =>
        Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
      ),
  );
/**
 * A live object capability backing one key's change-event stream,
 * adapted to Fetch so it can drive an `EventSource`.
 */
export type AppStorageEventHandle = Disposable & {
  /** Forward one `EventSource` request to the host's event stream. */
  fetch(request: Request): Promise<Response>;
  /** Release the change-event stream's underlying object capability. */
  close(): Promise<void>;
};
/**
 * The raw wire contract this capability negotiates with the host,
 * before client-side input validation and error unwrapping.
 */
export type AppStorageWire = {
  /**
   * Read a key's resolved value over the wire; resolves with an
   * accepted value or a rejection code.
   */
  read(key: string): Promise<AppStorageResult<ResolvedAppStorage>>;
  /**
   * Write a key's value over the wire; resolves with the accepted
   * revision or a rejection code.
   */
  write(
    input: AppStorageWrite,
  ): Promise<AppStorageResult<{ revision: number }>>;
  /**
   * Reset a key's value over the wire; resolves with the accepted
   * revision or a rejection code.
   */
  reset(
    input: AppStorageReset,
  ): Promise<AppStorageResult<{ revision: number }>>;
  /** Open the change-event stream for a key, as a Fetch-adapted handle. */
  openEvents(key: string): Promise<AppStorageEventHandle>;
};
const rawSchema: z.ZodType<AppStorageWire> = rpcHandleSchema({
  read: rpcMethod(data(appStorageReadResultSchema)),
  write: rpcMethod(data(appStorageMutationResultSchema)),
  reset: rpcMethod(data(appStorageMutationResultSchema)),
  openEvents: rpcMethod(rpcFetchHandleSchema),
});
const unwrap = <A>(result: AppStorageResult<A>): A => {
  if (result.kind === "rejected") throw new AppStorageError(result.code);
  return result.value;
};
const parseInput = <A>(schema: Schema.Codec<A, unknown>, value: A): A => {
  const parsed = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  })(value);
  if (parsed._tag === "Failure")
    throw new AppStorageError("invalid", { cause: parsed.failure });
  return parsed.success;
};
const parseKey = (key: string) => parseInput(appStorageKeyNameSchema, key);
function client(raw: AppStorageWire): AppStorage {
  const read = async (key: string) => unwrap(await raw.read(parseKey(key)));
  return {
    read,
    write: async (input) =>
      unwrap(await raw.write(parseInput(appStorageWriteSchema, input))),
    reset: async (input) =>
      unwrap(await raw.reset(parseInput(appStorageResetSchema, input))),
    async watch(input) {
      const key = parseKey(input);
      const handle = await raw.openEvents(key);
      let closed = false;
      const isClosed = () => closed;
      let loading: Promise<void> | undefined;
      let dirty = false;
      const shouldRead = () => dirty && !isClosed();
      let store:
        ReturnType<typeof createReadonlyStore<ResolvedAppStorage>> | undefined;
      let resolveInitial: (value: AppStorageWatch) => void = () => undefined;
      let rejectInitial: (error: AppStorageError) => void = () => undefined;
      const initial = new Promise<AppStorageWatch>((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
      });
      const events = new EventSource(
        "https://app-storage.fungi.invalid/events",
        {
          fetch: async (url, init) => {
            const response = await handle.fetch(new Request(url, init));
            if (!response.ok) {
              const parsed = Schema.decodeUnknownResult(
                appStorageReadResultSchema,
              )(await response.json());
              const failure = new AppStorageError(
                parsed._tag === "Success" && parsed.success.kind === "rejected"
                  ? parsed.success.code
                  : "unavailable",
              );
              fail(failure);
              throw failure;
            }
            return response;
          },
        },
      );
      const close = () => {
        if (closed) return;
        closed = true;
        events.close();
        rejectInitial(new AppStorageError("unavailable"));
        void handle
          .close()
          .catch((cause: unknown) => {
            reportCatchFailure("storage.watch.close", cause);
          })
          .finally(() => {
            handle[Symbol.dispose]();
          });
      };
      const fail = (cause: unknown) => {
        rejectInitial(
          cause instanceof AppStorageError
            ? cause
            : new AppStorageError("unavailable", { cause }),
        );
        if (!closed && store !== undefined)
          reportCatchFailure("storage.watch", cause);
        close();
      };
      const refresh = () => {
        dirty = true;
        if (loading !== undefined || closed) return;
        loading = (async () => {
          while (shouldRead()) {
            dirty = false;
            const next = await read(key);
            if (isClosed()) return;
            if (store === undefined) {
              const first = createReadonlyStore(next);
              store = first;
              resolveInitial({
                get: () => first.get(),
                subscribe: (listener) => first.subscribe(listener),
                close,
                [Symbol.dispose]: close,
              });
            } else store.update(next);
          }
        })()
          .catch(fail)
          .finally(() => {
            loading = undefined;
            if (dirty && !closed) refresh();
          });
      };
      // The owner emits ready only after registering the subscription. Reading
      // then closes the initial-read/subscription race and every reconnect gap.
      events.addEventListener("ready", refresh);
      events.addEventListener("changed", (event) => {
        const changed = Schema.decodeUnknownResult(
          Schema.fromJsonString(appStorageEventSchema),
          { onExcessProperty: "error" },
        )(event.data);
        if (changed._tag === "Failure") fail(changed.failure);
        else if (changed.success.key !== key)
          fail(new AppStorageError("invalid"));
        else refresh();
      });
      events.onerror = (cause) => {
        if (store === undefined || events.readyState === EventSource.CLOSED)
          fail(cause);
      };
      return initial;
    },
  };
}
/** This App's own declared data. The host seals App and member identities. */
export const appStorage: CapabilityContract<AppStorage> = defineCapability(
  "app.storage",
  1,
  rawSchema.transform(client),
);
