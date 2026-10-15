// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import * as z from "zod";
import { createReadCopies, countingGit } from "./read-copy.js";
import type { GitBinding } from "./git.js";

const head = "a".repeat(40);
const next = "b".repeat(40);
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...args: (string | number | null | ArrayBuffer)[]) {
      const statement = db.prepare(query);
      const rows = statement.all(
        ...args.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        ),
      );
      return { toArray: () => rows };
    },
  };
  return createReadCopies(sql, {
    version: 1,
    maxRows: 100,
    maxValueBytes: 10000,
    maxBlobBytes: 10000,
    maxBlobTotalBytes: 20000,
  });
}
const unavailable = () =>
  Promise.reject(new Error("unexpected provider operation"));
const git: GitBinding = {
  create: unavailable,
  fork: unavailable,
  cloneUrl: unavailable,
  delete: unavailable,
  info: unavailable,
  log: unavailable,
  readCommit: unavailable,
  readTree: unavailable,
  readBlob: () => Promise.resolve(new Uint8Array([1])),
  refs: unavailable,
  exchange: unavailable,
};
test("a saved document answers a warm screen without contacting Git", async () => {
  const copy = fixture().open(
    "documents",
    z.strictObject({ title: z.string() }),
  );
  copy.write("draft", head, { title: "Pond" });
  const counted = countingGit(git, {
    limit: 40,
    signal: new AbortController().signal,
  });
  const result = await copy.load("draft", {
    git: counted.git,
    signal: new AbortController().signal,
    rebuild: async (source) => {
      await source.readBlob("workflows", head);
      return { head, value: { title: "Wrong" } };
    },
  });
  expect(result).toEqual({ kind: "ready", head, value: { title: "Pond" } });
  expect(counted.total()).toBe(0);
});
test("a push chains from the copied head and its own-write echo does no work", () => {
  const copy = fixture().open("documents", z.string());
  copy.write("draft", head, "old");
  expect(copy.apply("draft", { before: head, after: next, value: "new" })).toBe(
    "applied",
  );
  expect(
    copy.apply("draft", { before: head, after: next, value: "echo" }),
  ).toBe("echo");
  expect(copy.read("draft")).toEqual({
    kind: "ready",
    head: next,
    value: "new",
  });
});
test("gaps, deletions and unexplained pushes invalidate rather than claim fresh data", () => {
  const copy = fixture().open("documents", z.string());
  copy.write("draft", head, "old");
  expect(
    copy.apply("draft", { before: "c".repeat(40), after: next, value: "gap" }),
  ).toBe("stale");
  expect(copy.read("draft")).toEqual({ kind: "missing" });
  copy.write("draft", head, "old");
  expect(
    copy.apply("draft", {
      before: head,
      after: next,
      value: "unexplained",
      unexplained: true,
    }),
  ).toBe("stale");
  copy.write("draft", head, "old");
  expect(
    copy.apply("draft", {
      before: head,
      after: "0".repeat(40),
      value: "deleted",
    }),
  ).toBe("stale");
});
test("a rebuild stops at forty provider-bound packets and publishes no partial copy", async () => {
  const copy = fixture().open("documents", z.string());
  const controller = new AbortController();
  const counted = countingGit(git, { limit: 100, signal: controller.signal });
  const result = await copy.load("draft", {
    git: counted.git,
    signal: controller.signal,
    rebuild: async (source) => {
      for (let i = 0; i < 41; i++) await source.readBlob("workflows", head);
      return { head, value: "partial" };
    },
  });
  expect(result).toEqual({ kind: "rebuilding" });
  expect(counted.total()).toBe(40);
  expect(copy.read("draft")).toEqual({ kind: "missing" });
});
test("a settled frame cannot resume provider work or publish its late rebuild", async () => {
  const copy = fixture().open("documents", z.string());
  const controller = new AbortController();
  const barrier = Promise.withResolvers<Uint8Array>();
  const entered = Promise.withResolvers<undefined>();
  let calls = 0;
  const source = {
    ...git,
    readBlob: () => {
      calls++;
      entered.resolve(undefined);
      return barrier.promise;
    },
  };
  const pending = copy.load("draft", {
    git: source,
    signal: controller.signal,
    rebuild: async (binding) => {
      await binding.readBlob("workflows", head);
      await binding.readBlob("workflows", next);
      return { head, value: "late" };
    },
  });
  await entered.promise;
  controller.abort(new Error("frame settled"));
  barrier.resolve(new Uint8Array([1]));
  await expect(pending).rejects.toThrow("frame settled");
  expect(calls).toBe(1);
  expect(copy.read("draft")).toEqual({ kind: "missing" });
});
test("a newer write during a rebuild wins over its late result", async () => {
  const copy = fixture().open("documents", z.string());
  const barrier = Promise.withResolvers<{ head: string; value: string }>();
  const pending = copy.load("draft", {
    git,
    signal: new AbortController().signal,
    rebuild: () => barrier.promise,
  });
  copy.write("draft", next, "newer");
  barrier.resolve({ head, value: "old" });
  expect(await pending).toEqual({ kind: "ready", head: next, value: "newer" });
});
test("content-addressed blobs evict oldest bytes and reject oversized objects", () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...args: (string | number | null | ArrayBuffer)[]) {
      const rows = db
        .prepare(query)
        .all(
          ...args.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        );
      return { toArray: () => rows };
    },
  };
  const copies = createReadCopies(sql, {
    version: 1,
    maxRows: 2,
    maxValueBytes: 10,
    maxBlobBytes: 3,
    maxBlobTotalBytes: 4,
  });
  copies.putBlob(head, new Uint8Array([1, 2, 3]));
  copies.putBlob(next, new Uint8Array([4, 5]));
  expect(copies.readBlob(head)).toBeNull();
  expect(copies.readBlob(next)).toEqual(new Uint8Array([4, 5]));
  expect(() => {
    copies.putBlob(head, new Uint8Array(4));
  }).toThrow(RangeError);
  const first = copies.open("doc", z.string());
  first.write("a", head, "one");
  const bumped = createReadCopies(sql, {
    version: 2,
    maxRows: 2,
    maxValueBytes: 10,
    maxBlobBytes: 3,
    maxBlobTotalBytes: 4,
  }).open("doc", z.string());
  expect(bumped.read("a")).toEqual({ kind: "missing" });
});
test("push invalidation during a missing-key rebuild cannot be overwritten by late data", async () => {
  const copy = fixture().open("documents", z.string());
  copy.stale("draft");
  const barrier = Promise.withResolvers<{ head: string; value: string }>();
  const pending = copy.load("draft", {
    git,
    signal: new AbortController().signal,
    rebuild: () => barrier.promise,
  });
  copy.stale("draft");
  barrier.resolve({ head, value: "obsolete" });
  expect(await pending).toEqual({ kind: "missing" });
});
test("an unborn branch is a ready saved copy with no commit, not a fabricated OID", () => {
  const copy = fixture().open("documents", z.string());
  copy.write("branch", null, "empty");
  expect(copy.read("branch")).toEqual({
    kind: "ready",
    head: null,
    value: "empty",
  });
  expect(
    copy.apply("branch", {
      before: "0".repeat(40),
      after: head,
      value: "created",
    }),
  ).toBe("applied");
});

test("blobs round-trip through the maintained Workers-compatible SQLite adapter", async () => {
  const { fromNodeSqlite } =
    await import("@fungi.computer/watchdog/node-sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    const copies = createReadCopies(fromNodeSqlite(db).sql, {
      version: 1,
      maxRows: 10,
      maxValueBytes: 1000,
      maxBlobBytes: 1000,
      maxBlobTotalBytes: 2000,
    });
    copies.putBlob(head, new Uint8Array([1, 2, 3]));
    expect(copies.readBlob(head)).toEqual(new Uint8Array([1, 2, 3]));
  } finally {
    db.close();
  }
});
