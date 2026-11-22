import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import {
  appStorage,
  appStorageBrokerReadResultSchema,
  appStorageBrokerMutationResultSchema,
  type ResolvedAppStorage,
} from "./storage.js";

it("awaits an armed stream and real snapshot, then follows live invalidations", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  let readCount = 0,
    closes = 0;
  let value: ResolvedAppStorage = {
    value: "seeded",
    source: "team",
    team: { value: "seeded", revision: 1 },
    member: null,
    canWriteTeam: false,
  };
  let fetched: () => void = () => undefined;
  const fetching = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const raw = {
    read: () => {
      readCount++;
      return Promise.resolve({ kind: "accepted" as const, value });
    },
    write: () =>
      Promise.resolve({
        kind: "rejected" as const,
        code: "owner_required" as const,
      }),
    reset: () =>
      Promise.resolve({ kind: "accepted" as const, value: { revision: 3 } }),
    claim: () =>
      Promise.resolve({
        kind: "accepted" as const,
        value: { value: "seeded", revision: 1, claimed: false },
      }),
    openEvents: () =>
      Promise.resolve({
        fetch: () => {
          const body = new ReadableStream<Uint8Array>({
            start(next) {
              controller = next;
            },
            cancel() {
              controller = undefined;
            },
          });
          fetched();
          return Promise.resolve(
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        },
        close: () => {
          closes++;
          return Promise.resolve();
        },
        [Symbol.dispose]: () => undefined,
      }),
  };
  const storage = appStorage.schema.parse(raw);
  const pending = storage.watch("desktop");
  await fetching;
  expect(readCount).toBe(0);
  if (controller === undefined) throw new Error("No fixture event stream");
  controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
  const watch = await pending;
  try {
    expect(watch.get().value).toBe("seeded");
    const changed = new Promise<ResolvedAppStorage>((resolve) =>
      watch.subscribe(resolve),
    );
    value = {
      ...value,
      value: "private",
      source: "member",
      member: { value: "private", revision: 2 },
    };
    controller.enqueue(
      encoder.encode(
        'event: changed\ndata: {"appId":"app_notes","key":"desktop","scope":"member","revision":2}\n\n',
      ),
    );
    expect((await changed).value).toBe("private");
    expect(watch.get().value).toBe("private");
    await expect(
      storage.write({ key: "desktop", scope: "team", value: 0, basedOn: 1 }),
    ).rejects.toMatchObject({ code: "owner_required" });
    expect(
      await storage.claim({ key: "desktop", scope: "team", value: 0 }),
    ).toEqual({ value: "seeded", revision: 1, claimed: false });
    // A caller passing a write request to claim still meets the exact claim decoder.
    const staleWrite = {
      key: "desktop",
      scope: "team" as const,
      value: 0,
      basedOn: null,
    };
    await expect(storage.claim(staleWrite)).rejects.toMatchObject({
      code: "invalid",
    });
  } finally {
    watch.close();
    watch[Symbol.dispose]();
  }
  await Promise.resolve();
  expect(closes).toBe(1);
});

it("preserves an undeclared-key refusal before opening a watch snapshot", async () => {
  let closes = 0;
  const storage = appStorage.schema.parse({
    read: () => Promise.resolve({ kind: "rejected", code: "undeclared_key" }),
    write: () => Promise.resolve({ kind: "rejected", code: "owner_required" }),
    reset: () => Promise.resolve({ kind: "rejected", code: "owner_required" }),
    claim: () => Promise.resolve({ kind: "rejected", code: "owner_required" }),
    openEvents: () =>
      Promise.resolve({
        fetch: () =>
          Promise.resolve(
            Response.json(
              { kind: "rejected", code: "undeclared_key" },
              { status: 404 },
            ),
          ),
        close: () => {
          closes++;
          return Promise.resolve();
        },
        [Symbol.dispose]: () => undefined,
      }),
  });
  await expect(storage.watch("missing")).rejects.toMatchObject({
    code: "undeclared_key",
  });
  await Promise.resolve();
  expect(closes).toBe(1);
});

it("preserves read and mutation broker replies through the neutral storage owner", () => {
  const read = Schema.decodeUnknownSync(appStorageBrokerReadResultSchema, {
    onExcessProperty: "error",
  });
  const mutation = Schema.decodeUnknownSync(
    appStorageBrokerMutationResultSchema,
    { onExcessProperty: "error" },
  );
  const acceptedRead = {
    kind: "accepted",
    value: {
      value: ["saved"],
      source: "none",
      team: null,
      member: null,
      canWriteTeam: false,
    },
  };
  const acceptedMutation = { kind: "accepted", value: { revision: 2 } };
  expect(read(acceptedRead)).toEqual(acceptedRead);
  expect(mutation(acceptedMutation)).toEqual(acceptedMutation);
  for (const reply of [
    { kind: "rejected", code: "invalid" },
    { kind: "rejected", code: "conflict" },
    { error: "undeclared_key" },
    { error: "unavailable" },
    { error: "too_large" },
  ]) {
    expect(read(reply)).toEqual(reply);
    expect(mutation(reply)).toEqual(reply);
  }
  expect(() => read(acceptedMutation)).toThrow();
  expect(() => mutation(acceptedRead)).toThrow();
  for (const reply of [
    { kind: "local_refusal", code: "undeclared_key" },
    { error: 1 },
    { error: "unavailable", extra: true },
  ]) {
    expect(() => read(reply)).toThrow();
    expect(() => mutation(reply)).toThrow();
  }
});

afterEach(() => vi.restoreAllMocks());

const resolved = (value: string): ResolvedAppStorage => ({
  value,
  source: "team",
  team: { value, revision: 1 },
  member: null,
  canWriteTeam: false,
});

function watchFixture(
  reads: (n: number) => "unavailable" | "denied" | Readonly<{ value: string }>,
) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let readCount = 0;
  let opened: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const raw = {
    read: () => {
      const next = reads(readCount++);
      return Promise.resolve(
        next === "unavailable"
          ? { kind: "rejected" as const, code: "unavailable" as const }
          : next === "denied"
            ? { kind: "rejected" as const, code: "undeclared_key" as const }
            : { kind: "accepted" as const, value: resolved(next.value) },
      );
    },
    write: () => Promise.reject(new Error("unused")),
    reset: () => Promise.reject(new Error("unused")),
    claim: () => Promise.reject(new Error("unused")),
    openEvents: () =>
      Promise.resolve({
        fetch: () => {
          controller = undefined;
          const body = new ReadableStream<Uint8Array>({
            start(next) {
              controller = next;
            },
          });
          opened();
          return Promise.resolve(
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        },
        close: () => Promise.resolve(),
        [Symbol.dispose]: () => undefined,
      }),
  };
  const ready = async () => {
    await open;
    controller?.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
  };
  return {
    storage: appStorage.schema.parse(raw),
    ready,
    reads: () => readCount,
  };
}

it("keeps watching through a transient unavailable read after ready", async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { storage, ready, reads } = watchFixture((n) =>
      n < 2 ? "unavailable" : { value: "recovered" },
    );
    const pending = storage.watch("desktop");
    await ready();
    await vi.advanceTimersByTimeAsync(10_000);
    const watch = await pending;
    expect(watch.get().value).toBe("recovered");
    expect(reads()).toBe(3);
    expect(report).not.toHaveBeenCalled();
    watch.close();
  } finally {
    vi.useRealTimers();
  }
});

it("recovers a live watch whose later read is transiently unavailable", async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { storage, ready } = watchFixture((n) =>
      n === 0
        ? { value: "first" }
        : n < 3
          ? "unavailable"
          : { value: "second" },
    );
    const pending = storage.watch("desktop");
    await ready();
    const watch = await pending;
    expect(watch.get().value).toBe("first");
    await ready();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watch.get().value).toBe("second");
    expect(report).not.toHaveBeenCalled();
    watch.close();
  } finally {
    vi.useRealTimers();
  }
});

it("closes a watch once on a permanent refusal and names its code", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { storage, ready } = watchFixture((n) =>
    n === 0 ? { value: "first" } : "denied",
  );
  const pending = storage.watch("desktop");
  await ready();
  const watch = await pending;
  await ready();
  await vi.waitFor(() => {
    expect(report).toHaveBeenCalledOnce();
  });
  expect(JSON.parse(String(report.mock.calls[0]?.[0]))).toMatchObject({
    operation: "storage.watch",
    code: "undeclared_key",
  });
  expect(watch.get().value).toBe("first");
});

function failingOpenFixture(failures: number) {
  let opens = 0;
  const raw = {
    read: () =>
      Promise.resolve({
        kind: "accepted" as const,
        value: resolved("first"),
      }),
    write: () => Promise.reject(new Error("unused")),
    reset: () => Promise.reject(new Error("unused")),
    claim: () => Promise.reject(new Error("unused")),
    openEvents: () =>
      Promise.resolve({
        fetch: () => {
          opens += 1;
          if (opens <= failures) return Promise.reject(new Error("offline"));
          return Promise.resolve(
            new Response("event: ready\ndata: {}\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        },
        close: () => Promise.resolve(),
        [Symbol.dispose]: () => undefined,
      }),
  };
  return { storage: appStorage.schema.parse(raw), opens: () => opens };
}

it("reconnects when the event stream errors before the first read", async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { storage, opens } = failingOpenFixture(1);
    const pending = storage.watch("desktop");
    await vi.advanceTimersByTimeAsync(10_000);
    const watch = await pending;
    expect(watch.get().value).toBe("first");
    expect(opens()).toBeGreaterThan(1);
    expect(report).not.toHaveBeenCalled();
    watch.close();
  } finally {
    vi.useRealTimers();
  }
});

it("names its code once when the event stream never comes back", async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { storage } = failingOpenFixture(Number.POSITIVE_INFINITY);
    const pending = storage.watch("desktop");
    const settled = pending.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await settled).toMatchObject({ code: "unavailable" });
    expect(report).toHaveBeenCalledOnce();
    expect(JSON.parse(String(report.mock.calls[0]?.[0]))).toMatchObject({
      operation: "storage.watch",
      code: "unavailable",
    });
  } finally {
    vi.useRealTimers();
  }
});
