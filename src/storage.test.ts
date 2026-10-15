import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
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
    { error: "not_granted" },
    { error: "unavailable" },
    { error: "too_large" },
  ]) {
    expect(read(reply)).toEqual(reply);
    expect(mutation(reply)).toEqual(reply);
  }
  expect(() => read(acceptedMutation)).toThrow();
  expect(() => mutation(acceptedRead)).toThrow();
  for (const reply of [
    { kind: "local_refusal", code: "not_granted" },
    { error: 1 },
    { error: "unavailable", extra: true },
  ]) {
    expect(() => read(reply)).toThrow();
    expect(() => mutation(reply)).toThrow();
  }
});
