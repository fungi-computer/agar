import {
  QueryClient,
  hashKey,
  mutationOptions,
  queryOptions,
  useQueryClient,
  type MutationFunction,
  type QueryKey,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useStore } from "./react.js";
import { openAppInbox } from "./agents.js";
import type { CapabilityContract } from "./capabilities.js";
import { AppError } from "./errors.js";
import type { AppRoot } from "./root.js";
import type { Disposer } from "./store.js";
import {
  watchInbox,
  useFeedQuery,
  queryError,
  type FeedSnapshot,
} from "./internal/query-feed.js";
import type { MemberInboxItem } from "./inbox.js";

export { useFeedQuery } from "./internal/query-feed.js";
export type { FeedSnapshot, FeedWatch } from "./internal/query-feed.js";

/** The App-owned identity and grants needed by the query integration. */
export type QueryApp = Pick<AppRoot, "identity" | "context" | "capabilities">;
const scopes = new WeakMap<object, QueryApp>();

/** Cache identity belongs to an App surface and its selected Computer. */
export const queryKeys = {
  /** Build a cache key scoped to this App's surface and its currently
   * selected Computer, followed by the given key parts. */
  of(app: QueryApp | null, ...parts: QueryKey) {
    return [
      app?.identity.surfaceId ?? null,
      app?.context.get().computerId ?? null,
      ...parts,
    ] as const;
  },
};

function scopeMeta(app: QueryApp | null) {
  const meta = {};
  if (app) scopes.set(meta, app);
  return meta;
}

/** App defaults and grant lifetime binding, using the host's ordinary cache. */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const bindings = new Map<string, { app: QueryApp; release: Disposer }>();
  client.getQueryCache().subscribe((event) => {
    const query = event.query;
    if (event.type === "removed") {
      bindings.get(query.queryHash)?.release();
      bindings.delete(query.queryHash);
      return;
    }
    const app = query.meta && scopes.get(query.meta);
    const previous = bindings.get(query.queryHash);
    if (previous?.app === app) return;
    previous?.release();
    bindings.delete(query.queryHash);
    if (!app) return;
    const reset = () => {
      // The host publishes new grants before the accompanying Computer context.
      // Clear revoked data and cancel old reads only after that atomic RPC turn.
      queueMicrotask(() => {
        if (
          client.getQueryCache().get(query.queryHash) !== query ||
          bindings.get(query.queryHash)?.app !== app
        )
          return;
        void client.resetQueries({
          predicate: (candidate) => candidate === query,
        });
      });
    };
    const release = app.capabilities.subscribe(reset);
    bindings.set(query.queryHash, { app, release });
    // Reconnecting the same logical surface replaces its remote handles too.
    if (previous) reset();
  });
  return client;
}

/** Decode capabilities through their owner; Query owns cancellation and retries. */
export function capabilityQuery<H, T>(
  app: QueryApp | null,
  contract: CapabilityContract<H>,
  queryKey: QueryKey,
  run: (handle: H, signal: AbortSignal) => Promise<T>,
) {
  const computerId = app?.context.get().computerId;
  return queryOptions<T, AppError>({
    queryKey,
    meta: scopeMeta(app),
    enabled: app !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        if (!app)
          throw new AppError("No App connection", {
            code: "DISCONNECTED",
            retryable: true,
          });
        if (app.context.get().computerId !== computerId)
          throw new AppError("The selected Computer changed", {
            code: "SELECTION_CHANGED",
            retryable: false,
          });
        return await run(app.capabilities.require(contract), signal);
      } catch (cause) {
        throw queryError(cause);
      }
    },
  });
}

/**
 * Optimistic writes for one cache entry, followed by owner reconciliation.
 * Apply must return new data. Concurrent writes to this key run in order;
 * queued writes wait for reconciliation instead of stacking rollback snapshots.
 */
export function optimisticMutation<TData, TVars, TResult = unknown>(options: {
  queryKey: QueryKey;
  mutationFn: MutationFunction<TResult, TVars>;
  apply: (previous: TData, variables: TVars) => TData;
}) {
  return mutationOptions<
    TResult,
    AppError,
    TVars,
    { previous: TData; optimistic: TData | undefined } | undefined
  >({
    mutationKey: options.queryKey,
    scope: { id: hashKey(options.queryKey) },
    mutationFn: async (variables, context) => {
      try {
        return await options.mutationFn(variables, context);
      } catch (cause) {
        throw queryError(cause);
      }
    },
    onMutate: async (variables, { client }) => {
      if (client.isMutating({ mutationKey: options.queryKey, exact: true }) > 1)
        return undefined;
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      const previous = client.getQueryData<TData>(options.queryKey);
      if (previous === undefined) return undefined;
      client.setQueryData(options.queryKey, options.apply(previous, variables));
      return {
        previous,
        optimistic: client.getQueryData<TData>(options.queryKey),
      };
    },
    onError: (_error, _variables, snapshot, { client }) => {
      if (
        snapshot &&
        client.getQueryData(options.queryKey) === snapshot.optimistic
      )
        client.setQueryData(options.queryKey, snapshot.previous);
    },
    onSettled: (_data, _error, _variables, _snapshot, { client }) =>
      client.invalidateQueries({ queryKey: options.queryKey, exact: true }),
  });
}

/** One shared inbox watch; reloads and stream failures retain the last live rows. */
export function useMemberInbox(app: QueryApp | null) {
  useStore(app?.context);
  const client = useQueryClient();
  const computerId = app?.context.get().computerId;
  const queryKey = useMemo(
    () => queryKeys.of(app, "member-inbox"),
    [app, computerId],
  );
  const watch = useCallback(
    (
      onChange: (snapshot: FeedSnapshot<readonly MemberInboxItem[]>) => void,
      signal: AbortSignal,
    ) => {
      if (app?.context.get().computerId !== computerId)
        throw new AppError("The selected Computer changed", {
          code: "SELECTION_CHANGED",
          retryable: false,
        });
      return watchInbox(app, onChange, signal);
    },
    [app, computerId],
  );
  const query = useFeedQuery(queryKey, watch, {
    enabled: app !== null,
    meta: scopeMeta(app),
  });
  // A watch has no completion promise; refreshing restarts it in the cache.
  const refresh = useCallback((): void => {
    void client.invalidateQueries({ queryKey, exact: true });
  }, [client, queryKey]);
  const visit = useCallback(
    async (agentId: string, sessionId: string) => {
      if (!app)
        throw new AppError("No App connection", {
          code: "DISCONNECTED",
          retryable: true,
        });
      const transport = await openAppInbox(app.capabilities);
      try {
        const response = await transport.fetch(
          `${transport.baseUrl}/inbox/visits`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId, sessionId }),
          },
        );
        if (!response.ok && response.status !== 404)
          throw new AppError("Visit was not recorded", {
            code: "HOST_FAILURE",
            retryable: true,
          });
      } finally {
        await transport.close();
      }
    },
    [app],
  );
  return {
    items: query.data?.data ?? [],
    status: query.isError
      ? ("error" as const)
      : (query.data?.status ?? ("loading" as const)),
    error: query.error,
    /** Restart the inbox watch; use after a change that the live feed
     * would not otherwise observe. */
    refresh,
    /** Record that the member visited one agent session, so the inbox
     * can clear its unread state for it. */
    visit,
  };
}
