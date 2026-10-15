// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  MutationObserver,
  QueryClientProvider,
  QueryObserver,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import * as z from "zod";
import { createCapabilityRegistry, defineCapability } from "./capabilities.js";
import { AppError } from "./errors.js";
import { agentSessionRead } from "./agents.js";
import type { AppContext } from "./lifecycle.js";
import { createReadonlyStore } from "./internal/store.js";
import {
  capabilityQuery,
  createQueryClient,
  optimisticMutation,
  queryKeys,
  useFeedQuery,
  useMemberInbox,
  type FeedSnapshot,
  type FeedWatch,
} from "./query.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const reader = defineCapability(
  "test.read",
  1,
  z.object({ read: z.function({ output: z.promise(z.string()) }) }),
);
const clients: ReturnType<typeof createQueryClient>[] = [];
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const client of clients.splice(0)) client.clear();
});
function client() {
  const value = createQueryClient();
  clients.push(value);
  return value;
}
function app(surfaceId = "surface", computerId = "computer") {
  return {
    identity: { surfaceId, appId: "app", releaseId: "release" },
    context: createReadonlyStore<AppContext>({
      computerId,
      focus: { editing: false, surface: null },
      visibility: "visible",
      openRequest: null,
    }),
    capabilities: createCapabilityRegistry(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

it("uses App defaults and separates equal resource names by surface and Computer", async () => {
  const cache = client();
  expect(cache.getDefaultOptions()).toMatchObject({
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    mutations: { retry: false },
  });
  const first = app();
  const second = app("other-surface");
  const read = vi.fn(() => Promise.resolve("first"));
  first.capabilities.provide(reader, { read });
  second.capabilities.provide(reader, {
    read: () => Promise.resolve("second"),
  });
  const options = (source: typeof first) =>
    capabilityQuery(source, reader, queryKeys.of(source, "read"), (handle) =>
      handle.read(),
    );
  expect(await cache.query(options(first))).toBe("first");
  expect(await cache.query(options(first))).toBe("first");
  expect(read).toHaveBeenCalledOnce();
  expect(await cache.query(options(second))).toBe("second");
  first.context.update({
    ...first.context.get(),
    computerId: "other-computer",
  });
  expect(queryKeys.of(first, "read")).toEqual([
    "surface",
    "other-computer",
    "read",
  ]);
  expect(cache.getQueryData(queryKeys.of(first, "read"))).toBeUndefined();
});

it("preserves typed capability refusals and maps unexpected failures without retrying", async () => {
  const cache = client();
  const source = app();
  await expect(
    cache.query(
      capabilityQuery(
        source,
        reader,
        queryKeys.of(source, "denied"),
        (handle) => handle.read(),
      ),
    ),
  ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  const cause = new Error("transport failed");
  const read = vi.fn(() => Promise.reject(cause));
  source.capabilities.provide(reader, { read });
  await expect(
    cache.query(
      capabilityQuery(
        source,
        reader,
        queryKeys.of(source, "failure"),
        (handle) => handle.read(),
      ),
    ),
  ).rejects.toMatchObject({ code: "HOST_FAILURE", cause });
  expect(read).toHaveBeenCalledOnce();
});

it("rebinds grant changes after context publication and never runs new grants under an old Computer key", async () => {
  const cache = client();
  const source = app();
  source.capabilities.provide(reader, { read: () => Promise.resolve("old") });
  const oldKey = queryKeys.of(source, "read");
  const observer = new QueryObserver(
    cache,
    capabilityQuery(source, reader, oldKey, (handle) => handle.read()),
  );
  const release = observer.subscribe(() => undefined);
  await vi.waitFor(() => {
    expect(cache.getQueryData(oldKey)).toBe("old");
  });
  const read = vi.fn(() => Promise.resolve("new"));
  // Actual host order: grants first, then the new Computer context, in one turn.
  source.capabilities.provide(reader, { read });
  source.context.update({ ...source.context.get(), computerId: "next" });
  await vi.waitFor(() => {
    expect(observer.getCurrentResult().error?.code).toBe("SELECTION_CHANGED");
  });
  expect(read).not.toHaveBeenCalled();
  expect(cache.getQueryData(oldKey)).toBeUndefined();
  observer.setOptions(
    capabilityQuery(source, reader, queryKeys.of(source, "read"), (handle) =>
      handle.read(),
    ),
  );
  await vi.waitFor(() => {
    expect(observer.getCurrentResult().data).toBe("new");
  });
  release();
});

it("cancels an abandoned capability read and releases cache-owned grant subscriptions", async () => {
  const cache = client();
  const source = app();
  const pending = deferred<string>();
  let signal: AbortSignal | undefined;
  source.capabilities.provide(reader, { read: () => pending.promise });
  const releases = vi.fn();
  const subscribe = source.capabilities.subscribe.bind(source.capabilities);
  source.capabilities.subscribe = (listener) => {
    const stop = subscribe(listener);
    return () => {
      releases();
      stop();
    };
  };
  const key = queryKeys.of(source, "read");
  const observer = new QueryObserver(
    cache,
    capabilityQuery(source, reader, key, (handle, current) => {
      signal = current;
      return handle.read();
    }),
  );
  const release = observer.subscribe(() => undefined);
  release();
  expect(signal?.aborted).toBe(true);
  pending.resolve("late");
  await settle();
  expect(cache.getQueryData(key)).toBeUndefined();
  cache.clear();
  expect(releases).toHaveBeenCalledOnce();
});

it("rolls back a rejected optimistic write and invalidates the owner's query", async () => {
  const cache = client();
  const key = ["surface", "computer", "rows"];
  const pending = deferred<undefined>();
  cache.setQueryData(key, ["a", "b"]);
  const observer = new MutationObserver(
    cache,
    optimisticMutation({
      queryKey: key,
      mutationFn: () => pending.promise,
      apply: (rows: string[], id: string) => rows.filter((row) => row !== id),
    }),
  );
  const mutation = observer.mutate("a");
  const rejected = expect(mutation).rejects.toMatchObject({
    code: "HOST_FAILURE",
  });
  await vi.waitFor(() => {
    expect(cache.getQueryData(key)).toEqual(["b"]);
  });
  pending.reject(new Error("refused"));
  await rejected;
  expect(cache.getQueryData(key)).toEqual(["a", "b"]);
  expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
});

it("does not resurrect an optimistic snapshot cleared by a grant change", async () => {
  const cache = client();
  const key = ["surface", "computer", "rows"];
  const pending = deferred<undefined>();
  cache.setQueryData(key, ["a"]);
  const observer = new MutationObserver(
    cache,
    optimisticMutation({
      queryKey: key,
      mutationFn: () => pending.promise,
      apply: (rows: string[]) => rows.slice(0, 0),
    }),
  );
  const mutation = observer.mutate(undefined);
  const rejected = expect(mutation).rejects.toBeInstanceOf(AppError);
  await vi.waitFor(() => {
    expect(cache.getQueryData(key)).toEqual([]);
  });
  await cache.resetQueries({ queryKey: key });
  pending.reject(new Error("revoked"));
  await rejected;
  expect(cache.getQueryData(key)).toBeUndefined();
});

it("serializes concurrent writes to a cache entry without stacking rollback snapshots", async () => {
  const cache = client();
  const key = ["rows"];
  cache.setQueryData(key, ["a", "b"]);
  const first = deferred<undefined>();
  const second = deferred<undefined>();
  const run = vi.fn((id: string) =>
    id === "a" ? first.promise : second.promise,
  );
  const options = optimisticMutation({
    queryKey: key,
    mutationFn: run,
    apply: (rows: string[], id: string) => rows.filter((row) => row !== id),
  });
  const a = new MutationObserver(cache, options).mutate("a");
  const failure = expect(a).rejects.toBeInstanceOf(AppError);
  await vi.waitFor(() => {
    expect(cache.getQueryData(key)).toEqual(["b"]);
  });
  const b = new MutationObserver(cache, options).mutate("b");
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  first.reject(new Error("no"));
  await failure;
  await vi.waitFor(() => {
    expect(run).toHaveBeenCalledTimes(2);
  });
  expect(cache.getQueryData(key)).toEqual(["a", "b"]);
  second.resolve(undefined);
  await b;
  expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
});

function mount(
  cache: ReturnType<typeof createQueryClient>,
  component: () => ReturnType<typeof createElement>,
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(component),
      ),
    );
  });
  return { root, container };
}

it("shares a feed and retains its last live rows through reload and error until the final observer leaves", async () => {
  const cache = client();
  let emit: ((snapshot: FeedSnapshot<string[]>) => void) | undefined;
  const close = vi.fn();
  const watch = vi.fn<FeedWatch<string[]>>((onChange) => {
    emit = onChange;
    return close;
  });
  function Probe() {
    const query = useFeedQuery(["feed"], watch);
    return createElement("output", null, JSON.stringify(query.data));
  }
  const first = mount(cache, Probe);
  const second = mount(cache, Probe);
  await vi.waitFor(() => {
    expect(watch).toHaveBeenCalledOnce();
  });
  await act(async () => {
    emit?.({ status: "live", data: ["held"] });
    await vi.waitFor(() => {
      expect(cache.getQueryData(["feed"])).toEqual({
        status: "live",
        data: ["held"],
      });
    });
  });
  expect(first.container.textContent).toContain("held");
  expect(second.container.textContent).toContain("held");
  await act(async () => {
    emit?.({ status: "loading" });
    emit?.({ status: "error" });
    await vi.waitFor(() => {
      expect(cache.getQueryData(["feed"])).toEqual({
        status: "error",
        data: ["held"],
      });
    });
  });
  expect(first.container.textContent).toContain('"status":"error"');
  expect(first.container.textContent).toContain("held");
  act(() => {
    first.root.unmount();
  });
  roots.splice(roots.indexOf(first.root), 1);
  expect(close).not.toHaveBeenCalled();
  act(() => {
    second.root.unmount();
  });
  roots.splice(roots.indexOf(second.root), 1);
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce();
  });
});

it("owns member-inbox transport and EventSource, retaining rows when a reset read fails", async () => {
  const source = app();
  const cache = client();
  const encoder = new TextEncoder();
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      events = controller;
    },
  });
  const close = vi.fn(() => Promise.resolve());
  const dispose = vi.fn();
  let failRead = false;
  const fetch = vi.fn((request: Request) => {
    if (request.url.includes("/events"))
      return Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    return Promise.resolve(
      failRead
        ? new Response(null, { status: 503 })
        : Response.json({
            items: [
              {
                agentId: "a",
                sessionId: "s",
                title: "held",
                createdAt: 1,
                lastActivityAt: 2,
                state: "running",
              },
            ],
            next: null,
            cursor: 1,
          }),
    );
  });
  source.capabilities.provide(agentSessionRead, {
    open: () => Promise.reject(new Error("unused")),
    openInbox: () =>
      Promise.resolve({ fetch, close, [Symbol.dispose]: dispose }),
  });
  function Probe() {
    const inbox = useMemberInbox(source);
    return createElement(
      "output",
      null,
      JSON.stringify({ items: inbox.items, status: inbox.status }),
    );
  }
  const first = mount(cache, Probe);
  const second = mount(cache, Probe);
  await settle();
  await vi.waitFor(() => {
    expect(first.container.textContent).toContain('"status":"live"');
  });
  expect(
    fetch.mock.calls.filter(([request]) => request.url.includes("/events")),
  ).toHaveLength(1);
  failRead = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    events?.enqueue(encoder.encode("event: reset\ndata: {}\n\n"));
    await settle();
    await vi.waitFor(() => {
      expect(first.container.textContent).toContain('"status":"error"');
    });
    expect(first.container.textContent).toContain("held");
    expect(second.container.textContent).toContain("held");
  } finally {
    error.mockRestore();
  }
  act(() => {
    first.root.unmount();
    second.root.unmount();
  });
  roots.length = 0;
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce();
  });
  expect(dispose).toHaveBeenCalledOnce();
});

it("closes a feed acquired after its final observer has already left", async () => {
  const cache = client();
  const opened = deferred<() => void>();
  const close = vi.fn();
  const watch = vi.fn(() => opened.promise);
  function Probe() {
    useFeedQuery(["late-feed"], watch);
    return createElement("output");
  }
  const mounted = mount(cache, Probe);
  await vi.waitFor(() => {
    expect(watch).toHaveBeenCalledOnce();
  });
  act(() => {
    mounted.root.unmount();
  });
  roots.splice(roots.indexOf(mounted.root), 1);
  opened.resolve(close);
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce();
  });
});

it("keeps capability denial typed when an inbox cannot open", async () => {
  const cache = client();
  const source = app();
  let failure: unknown;
  function Probe() {
    const inbox = useMemberInbox(source);
    failure = inbox.error;
    return createElement("output", null, inbox.status);
  }
  const mounted = mount(cache, Probe);
  await settle();
  await vi.waitFor(() => {
    expect(mounted.container.textContent).toBe("error");
  });
  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({ code: "CAPABILITY_DENIED" });
});

it("binds grants when a capability query takes over a pre-seeded cache entry", async () => {
  const cache = client();
  const source = app();
  const key = queryKeys.of(source, "seeded");
  cache.setQueryData(key, "seeded");
  source.capabilities.provide(reader, {
    read: () => Promise.resolve("loaded"),
  });
  await cache.query({
    ...capabilityQuery(source, reader, key, (handle) => handle.read()),
    staleTime: 0,
  });
  expect(cache.getQueryData(key)).toBe("loaded");
  source.capabilities.provide(reader, {
    read: () => Promise.resolve("changed"),
  });
  await vi.waitFor(() => {
    expect(cache.getQueryData(key)).toBeUndefined();
  });
});

it("refreshes the inbox as a void trigger and replaces the previous watch", async () => {
  const source = app();
  const cache = client();
  const close = vi.fn(() => Promise.resolve());
  const openInbox = vi.fn(() =>
    Promise.resolve({
      fetch: (request: Request) =>
        Promise.resolve(
          request.url.includes("/events")
            ? new Response(new ReadableStream(), {
                headers: { "content-type": "text/event-stream" },
              })
            : Response.json({ items: [], next: null, cursor: 1 }),
        ),
      close,
      [Symbol.dispose]: () => undefined,
    }),
  );
  source.capabilities.provide(agentSessionRead, {
    open: () => Promise.reject(new Error("unused")),
    openInbox,
  });
  let refresh: (() => void) | undefined;
  let visit: ReturnType<typeof useMemberInbox>["visit"] | undefined;
  function Probe() {
    const inbox = useMemberInbox(source);
    refresh = inbox.refresh;
    visit = inbox.visit;
    return createElement("output", null, inbox.status);
  }
  const mounted = mount(cache, Probe);
  await settle();
  await vi.waitFor(() => {
    expect(mounted.container.textContent).toBe("live");
  });
  const firstRefresh = refresh;
  const firstVisit = visit;
  act(() => {
    expect(refresh?.()).toBeUndefined();
  });
  await settle();
  await vi.waitFor(() => {
    expect(openInbox).toHaveBeenCalledTimes(2);
  });
  expect(refresh).toBe(firstRefresh);
  expect(visit).toBe(firstVisit);
  expect(close).toHaveBeenCalledOnce();
  expect(mounted.container.textContent).toBe("live");
});

it("replaces handles and clears cached data when the same surface reconnects", async () => {
  const cache = client();
  const original = app();
  const replacement = app();
  const close = vi.fn(() => Promise.resolve());
  original.capabilities.provide(reader, {
    read: () => Promise.resolve("old directory"),
  });
  original.capabilities.provide(agentSessionRead, {
    open: () => Promise.reject(new Error("unused")),
    openInbox: () =>
      Promise.resolve({
        fetch: (request: Request) =>
          Promise.resolve(
            request.url.includes("/events")
              ? new Response(new ReadableStream(), {
                  headers: { "content-type": "text/event-stream" },
                })
              : Response.json({
                  items: [
                    {
                      agentId: "a",
                      sessionId: "old",
                      title: "old inbox",
                      createdAt: 1,
                      lastActivityAt: 2,
                      state: "running",
                    },
                  ],
                  next: null,
                  cursor: 1,
                }),
          ),
        close,
        [Symbol.dispose]: () => undefined,
      }),
  });
  const read = vi.fn(() =>
    Promise.reject(new Error("New directory unavailable")),
  );
  const openInbox = vi.fn(() =>
    Promise.reject(new Error("New inbox unavailable")),
  );
  replacement.capabilities.provide(reader, { read });
  replacement.capabilities.provide(agentSessionRead, {
    open: () => Promise.reject(new Error("unused")),
    openInbox,
  });
  let current = original;
  function Probe() {
    const inbox = useMemberInbox(current);
    const directory = useQuery(
      capabilityQuery(
        current,
        reader,
        queryKeys.of(current, "directory"),
        (handle) => handle.read(),
      ),
    );
    return createElement(
      "output",
      null,
      JSON.stringify({
        items: inbox.items,
        status: inbox.status,
        directory: directory.data,
      }),
    );
  }
  const mounted = mount(cache, Probe);
  await settle();
  await vi.waitFor(() => {
    expect(mounted.container.textContent).toContain("old inbox");
    expect(mounted.container.textContent).toContain("old directory");
  });
  act(() => {
    current = replacement;
    mounted.root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(Probe),
      ),
    );
  });
  await settle();
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce();
    expect(openInbox).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).toContain('"status":"error"');
  });
  expect(mounted.container.textContent).not.toContain("old inbox");
  expect(mounted.container.textContent).not.toContain("old directory");
});
