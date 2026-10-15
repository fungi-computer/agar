import {
  experimental_streamedQuery,
  useQuery,
  type QueryKey,
  type QueryMeta,
} from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { EventSource } from "eventsource";
import * as z from "zod";
import { openAppInbox } from "../agents.js";
import { AppError } from "../errors.js";
import { reportCatchFailure } from "../failure.js";
import { watchMemberInbox, type MemberInboxItem } from "../inbox.js";
import type { AppRoot } from "../root.js";
import type { Disposer } from "../store.js";

/** A feed can lose its connection without losing its last owner snapshot. */
export type FeedSnapshot<T> =
  | Readonly<{ status: "live"; data: T }>
  | Readonly<{ status: "loading" | "error"; data?: T }>;

/** Start a live feed, calling `onChange` with each snapshot until
 * `signal` aborts; the returned (or resolved) Disposer tears it down. */
export type FeedWatch<T> = (
  onChange: (snapshot: FeedSnapshot<T>) => void,
  signal: AbortSignal,
) => Disposer | Promise<Disposer>;

function retain<T>(
  previous: FeedSnapshot<T>,
  next: FeedSnapshot<T>,
): FeedSnapshot<T> {
  return next.status === "live"
    ? next
    : { ...next, data: next.data ?? previous.data };
}

/** Query owns sharing and teardown; Effect supplies a bounded latest-snapshot queue. */
export function useFeedQuery<T>(
  queryKey: QueryKey,
  watch: FeedWatch<T>,
  options: { enabled?: boolean; meta?: QueryMeta } = {},
) {
  return useQuery<FeedSnapshot<T>, AppError>({
    queryKey,
    ...options,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: "always",
    queryFn: experimental_streamedQuery<FeedSnapshot<T>, FeedSnapshot<T>>({
      initialValue: { status: "loading" },
      refetchMode: "append",
      reducer: retain,
      streamFn: ({ signal }) =>
        Stream.toAsyncIterable(
          Stream.callback<FeedSnapshot<T>, AppError>(
            (queue) =>
              Effect.gen(function* () {
                let latest: FeedSnapshot<T> = { status: "loading" };
                const end = () => {
                  Queue.endUnsafe(queue);
                };
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    signal.addEventListener("abort", end, { once: true });
                  }),
                  () =>
                    Effect.sync(() => {
                      signal.removeEventListener("abort", end);
                    }),
                );
                if (signal.aborted) {
                  end();
                  return;
                }
                yield* Effect.acquireRelease(
                  Effect.tryPromise({
                    try: () =>
                      Promise.resolve(
                        watch((snapshot) => {
                          latest = retain(latest, snapshot);
                          Queue.offerUnsafe(queue, latest);
                        }, signal),
                      ),
                    catch: queryError,
                  }),
                  (release) => Effect.sync(release),
                );
              }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
            { bufferSize: 1, strategy: "sliding" },
          ),
        ),
    }),
  });
}

export async function watchInbox(
  app: Pick<AppRoot, "capabilities"> | null,
  onChange: (snapshot: FeedSnapshot<readonly MemberInboxItem[]>) => void,
  signal: AbortSignal,
): Promise<Disposer> {
  if (!app)
    throw new AppError("No App connection", {
      code: "DISCONNECTED",
      retryable: true,
    });
  const transport = await openAppInbox(app.capabilities);
  const close = () => {
    void transport.close().catch((cause: unknown) => {
      reportCatchFailure("inbox.query-close", cause);
    });
  };
  if (signal.aborted) {
    close();
    return () => undefined;
  }
  const feed = watchMemberInbox({
    baseUrl: transport.baseUrl,
    fetch: transport.fetch,
    openEvents: (url) => {
      const source = new EventSource(url, {
        fetch: (input, init) => transport.fetch(input, init),
      });
      return {
        addEventListener: (type, listener) => {
          source.addEventListener(type, (event) => {
            if (type === "open" || type === "error")
              listener(new MessageEvent(type));
            else if (event instanceof MessageEvent)
              listener(
                new MessageEvent<string>(type, {
                  data: z.string().parse(event.data),
                }),
              );
          });
        },
        close: () => {
          source.close();
        },
      };
    },
    onChange: (snapshot) => {
      onChange(
        snapshot.status === "live"
          ? { status: "live", data: snapshot.items }
          : { status: snapshot.status },
      );
    },
  });
  return () => {
    feed.close();
    close();
  };
}

export function queryError(cause: unknown): AppError {
  return cause instanceof AppError
    ? cause
    : new AppError("App operation failed", {
        cause,
        code: "HOST_FAILURE",
        retryable: false,
      });
}
