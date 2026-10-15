import * as z from "zod";
import { type GitBinding } from "./git.js";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";

/** A facet's synchronous SQLite port, shared by Workers and local proofs. */
export type ReadCopySql = {
  /** Execute immediately, as ctx.storage.sql does. */
  exec(
    query: string,
    ...bindings: (string | number | null | ArrayBuffer)[]
  ): {
    /** Decode the returned SQLite rows at the App boundary. */ toArray(): readonly unknown[];
  };
};
/** App-selected shape and retention bounds; changing version discards old representations. */
export type ReadCopyLimits = {
  /** App copy-shape version, changed by a clean representation break. */
  version: number;
  /** Maximum retained document rows across this facet. */
  maxRows: number;
  /** Maximum UTF-8 JSON bytes per row. */
  maxValueBytes: number;
  /** Maximum bytes of one immutable blob. */
  maxBlobBytes: number;
  /** Maximum total retained blob bytes, oldest objects evicted first. */
  maxBlobTotalBytes: number;
};
/** A screen reads this projection without asking Git whether it is current. */
export type ReadCopyResult<T> =
  | { kind: "ready"; head: string | null; value: T }
  | { kind: "missing" }
  | { kind: "rebuilding" };
/** A rebuild stops before dispatching the first call beyond its budget. */
export class ReadCopyBudgetExceeded extends Error {
  constructor() {
    super("Read-copy Git call budget exhausted");
    this.name = "ReadCopyBudgetExceeded";
  }
}
/** Count binding operations, never authority or results. The signal is the caller's frame lifetime. */
export function countingGit(
  binding: GitBinding,
  options: { limit: number; signal: AbortSignal },
) {
  z.number().int().positive().parse(options.limit);
  const counts = new Map<keyof GitBinding, number>();
  let total = 0;
  function wrap<A extends unknown[], R>(
    operation: keyof GitBinding,
    call: (...args: A) => Promise<R>,
  ) {
    return async (...args: A): Promise<R> => {
      options.signal.throwIfAborted();
      if (total >= options.limit) throw new ReadCopyBudgetExceeded();
      total++;
      counts.set(operation, (counts.get(operation) ?? 0) + 1);
      const result = await call(...args);
      options.signal.throwIfAborted();
      return result;
    };
  }
  const git: GitBinding = {
    create: wrap("create", (...args: Parameters<GitBinding["create"]>) =>
      binding.create(...args),
    ),
    fork: wrap("fork", (...args: Parameters<GitBinding["fork"]>) =>
      binding.fork(...args),
    ),
    cloneUrl: wrap("cloneUrl", (...args: Parameters<GitBinding["cloneUrl"]>) =>
      binding.cloneUrl(...args),
    ),
    info: wrap("info", (...args: Parameters<GitBinding["info"]>) =>
      binding.info(...args),
    ),
    delete: wrap("delete", (...args: Parameters<GitBinding["delete"]>) =>
      binding.delete(...args),
    ),
    log: wrap("log", (...args: Parameters<GitBinding["log"]>) =>
      binding.log(...args),
    ),
    readCommit: wrap(
      "readCommit",
      (...args: Parameters<GitBinding["readCommit"]>) =>
        binding.readCommit(...args),
    ),
    readTree: wrap("readTree", (...args: Parameters<GitBinding["readTree"]>) =>
      binding.readTree(...args),
    ),
    readBlob: wrap("readBlob", (...args: Parameters<GitBinding["readBlob"]>) =>
      binding.readBlob(...args),
    ),
    refs: wrap("refs", (...args: Parameters<GitBinding["refs"]>) =>
      binding.refs(...args),
    ),
    exchange: wrap("exchange", (...args: Parameters<GitBinding["exchange"]>) =>
      binding.exchange(...args),
    ),
  };
  return {
    git,
    /** Number of dispatched operations. */ total: () => total,
    /** Dispatch counts by maintained Git operation. */ counts: () =>
      Object.fromEntries(counts),
  };
}
const rowSchema = z.strictObject({
  head: gitSha1Schema.nullable(),
  version: z.number().int(),
  revision: z.number().int(),
  value: z.string().nullable(),
});
const name = z.string().min(1).max(1024);
const zero = "0".repeat(40);
const blobHash = z.union([
  gitSha1Schema,
  z.string().regex(/^sha256:[0-9a-f]{64}$/),
]);

/** Own bounded rows and content-addressed bytes in the App facet, not a host/provider cache. */
export function createReadCopies(sql: ReadCopySql, limits: ReadCopyLimits) {
  z.strictObject({
    version: z.number().int().positive(),
    maxRows: z.number().int().positive(),
    maxValueBytes: z.number().int().positive(),
    maxBlobBytes: z.number().int().positive(),
    maxBlobTotalBytes: z.number().int().positive(),
  }).parse(limits);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app_read_copy (copy TEXT NOT NULL, key TEXT NOT NULL, head TEXT, version INTEGER NOT NULL, revision INTEGER NOT NULL, value TEXT, PRIMARY KEY(copy,key))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app_read_blob (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)",
  );
  function row(copy: string, key: string) {
    const raw = sql
      .exec(
        "SELECT head,version,revision,value FROM app_read_copy WHERE copy=? AND key=?",
        copy,
        key,
      )
      .toArray()[0];
    return raw === undefined ? null : rowSchema.parse(raw);
  }
  /** Bind an App-owned schema and copy namespace. */
  function open<T>(copy: string, schema: z.ZodType<T>) {
    name.parse(copy);
    /** Decode a local row; missing and stale never probe Git. */
    function read(key: string): ReadCopyResult<T> {
      name.parse(key);
      const saved = row(copy, key);
      if (saved?.version !== limits.version || saved.value === null)
        return { kind: "missing" };
      return {
        kind: "ready",
        head: saved.head,
        value: schema.parse(JSON.parse(saved.value)),
      };
    }
    /** Store an accepted write after Git CAS succeeds. */
    function write(key: string, head: string | null, value: T) {
      name.parse(key);
      gitSha1Schema.nullable().parse(head);
      const encoded = JSON.stringify(z.json().parse(schema.parse(value)));
      if (new TextEncoder().encode(encoded).byteLength > limits.maxValueBytes)
        throw new RangeError("Read-copy row exceeds its byte bound");
      sql.exec(
        "INSERT INTO app_read_copy(copy,key,head,version,revision,value) VALUES(?,?,?,?,1,?) ON CONFLICT(copy,key) DO UPDATE SET head=excluded.head,version=excluded.version,revision=app_read_copy.revision+1,value=excluded.value",
        copy,
        key,
        head,
        limits.version,
        encoded,
      );
      sql.exec(
        "DELETE FROM app_read_copy WHERE rowid IN (SELECT rowid FROM app_read_copy ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
        limits.maxRows,
      );
    }
    /** Invalidate one key and its in-flight rebuild. */
    function stale(key: string) {
      name.parse(key);
      sql.exec(
        "INSERT INTO app_read_copy(copy,key,head,version,revision,value) VALUES(?,?,NULL,?,1,NULL) ON CONFLICT(copy,key) DO UPDATE SET revision=app_read_copy.revision+1,value=NULL",
        copy,
        key,
        limits.version,
      );
      sql.exec(
        "DELETE FROM app_read_copy WHERE rowid IN (SELECT rowid FROM app_read_copy ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
        limits.maxRows,
      );
    }
    return {
      /** Read the schema-decoded local projection. */
      read,
      /** Publish a successful Git write. */
      write,
      /** Refuse the row until rebuilt. */
      stale,
      /** An accepted push chains on before, ignores its own-write echo, and invalidates gaps/deletions. */
      apply(
        key: string,
        update: {
          before: string;
          after: string;
          value: T;
          unexplained?: boolean;
        },
      ): "applied" | "echo" | "stale" {
        gitSha1Schema.parse(update.before);
        gitSha1Schema.parse(update.after);
        const current = read(key);
        if (update.unexplained || update.after === zero) {
          stale(key);
          return "stale";
        }
        if (current.kind === "ready" && current.head === update.after)
          return "echo";
        if (
          current.kind !== "ready" ||
          (current.head ?? zero) !== update.before
        ) {
          stale(key);
          return "stale";
        }
        write(key, update.after, update.value);
        return "applied";
      },
      /** A missing key rebuilds only in this frame; budget exhaustion publishes no partial row. */
      async load(
        key: string,
        options: {
          git: GitBinding;
          signal: AbortSignal;
          rebuild: (
            git: GitBinding,
          ) => Promise<{ head: string | null; value: T }>;
        },
      ): Promise<ReadCopyResult<T>> {
        options.signal.throwIfAborted();
        const ready = read(key);
        if (ready.kind === "ready") return ready;
        const before = JSON.stringify(row(copy, key));
        const counted = countingGit(options.git, {
          limit: 40,
          signal: options.signal,
        });
        try {
          const rebuilt = await options.rebuild(counted.git);
          options.signal.throwIfAborted();
          if (JSON.stringify(row(copy, key)) !== before) return read(key);
          write(key, rebuilt.head, rebuilt.value);
          return read(key);
        } catch (error) {
          if (error instanceof ReadCopyBudgetExceeded)
            return { kind: "rebuilding" };
          throw error;
        }
      },
    };
  }
  return {
    /** Bind a namespace to its maintained App decoder. */
    open,
    /** Store immutable provider-identified bytes; enforce per-object and total retention bounds. */
    putBlob(hash: string, bytes: Uint8Array) {
      blobHash.parse(hash);
      if (
        bytes.byteLength >
        Math.min(limits.maxBlobBytes, limits.maxBlobTotalBytes)
      )
        throw new RangeError("Read-copy blob exceeds its byte bound");
      sql.exec(
        "INSERT INTO app_read_blob(hash,bytes) VALUES(?,?) ON CONFLICT(hash) DO NOTHING",
        hash,
        new Uint8Array(bytes).buffer,
      );
      while (
        z
          .strictObject({ size: z.number() })
          .parse(
            sql
              .exec(
                "SELECT COALESCE(SUM(length(bytes)),0) AS size FROM app_read_blob",
              )
              .toArray()[0],
          ).size > limits.maxBlobTotalBytes
      )
        sql.exec(
          "DELETE FROM app_read_blob WHERE rowid=(SELECT MIN(rowid) FROM app_read_blob)",
        );
    },
    /** A blob miss never performs I/O; the App decides which bounded rebuild owns it. */
    readBlob(hash: string): Uint8Array | null {
      blobHash.parse(hash);
      const result = sql
        .exec("SELECT bytes FROM app_read_blob WHERE hash=?", hash)
        .toArray()[0];
      return result === undefined
        ? null
        : new Uint8Array(
            z
              .strictObject({
                bytes: z.union([
                  z.instanceof(ArrayBuffer),
                  z.instanceof(Uint8Array),
                ]),
              })
              .parse(result).bytes,
          );
    },
  };
}
