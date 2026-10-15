/** Resumable, credential-free Git writes. Each step performs at most one exchange. */
import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import * as z from "zod";
import {
  gitRepositoryNameSchema,
  gitSha1Schema,
} from "@fungi.computer/puffball/git-representation";
import type { GitExchangeResponse } from "./git.js";
import type {
  CommitFilesRequest,
  MergeBranchRequest,
  GitCommitStore,
  GitWriteOutcome,
  GitMergeOutcome,
} from "./git-commit.js";
import {
  acceptedRefs,
  advertisedRefs,
  advertisedCapabilities,
  pktLine,
  sideBandData,
} from "./git-wire.js";
import { memoryFs, type MemoryFs } from "./internal/memory-fs.js";
import { editTree } from "./internal/git-edit-tree.js";

const DIR = "/repository";
const ZERO = "0".repeat(40);
const ROW_BYTES = 1024 * 1024;
const COMMIT_BYTES = 8 * ROW_BYTES;
const MERGE_BYTES = 16 * ROW_BYTES;
const requestKeySchema = z.string().min(1).max(256);
const materialOwnerSchema = z.tuple([
  z.enum(["commit", "merge"]),
  requestKeySchema,
]);
function checkedOwnerPrefix(prefix: string): string {
  try {
    if (!prefix.startsWith("git:") || !prefix.endsWith(":"))
      throw new RangeError("Invalid Git material owner");
    const owner = materialOwnerSchema.parse(JSON.parse(prefix.slice(4, -1)));
    if (prefix !== `git:${JSON.stringify(owner)}:`)
      throw new RangeError("Invalid Git material owner");
    return prefix;
  } catch {
    throw new RangeError("Invalid Git material owner");
  }
}
const encoder = new TextEncoder();
if (!("Buffer" in globalThis)) Reflect.set(globalThis, "Buffer", Buffer);

/** Permanent continuation failure: background owners settle their lane instead of retrying it. */
export class GitStepMaterialError extends Error {
  /** Invalid material, unavailable atomic support, or an exhausted unchanged-head push refusal. */
  readonly code:
    | "unavailable"
    | "conflict"
    | "digest_mismatch"
    | "atomic_unavailable"
    | "push_refused";
  /** Construct the canonical permanent continuation error.
   * @param code - Permanent continuation failure reason.
   */
  constructor(code: GitStepMaterialError["code"]) {
    super(
      {
        unavailable: "Git material unavailable",
        conflict: "Git material key conflict",
        digest_mismatch: "Git material digest mismatch",
        atomic_unavailable: "Atomic Git push unavailable",
        push_refused: "Git push refused",
      }[code],
    );
    this.name = "GitStepMaterialError";
    this.code = code;
  }
}
/** Facet-owned immutable material, split into individually bounded rows. */
export type GitStepMaterial = Readonly<{
  /** Retain one immutable row; an exact replay succeeds and conflicting bytes refuse. */
  put(key: string, seq: number, bytes: Uint8Array): Promise<void>;
  /** Restore ordered material from bounded rows, refusing missing rows. */
  read(key: string): Promise<Uint8Array>;
  /** Delete a literal owner prefix after durable terminal settlement, including orphaned rows. */
  drop(prefix: string): Promise<void>;
}>;
/** Existing facet SQLite owner; no transaction or scheduler is introduced here. */
export type GitStepSql = Readonly<{
  /** Execute a statement in the existing facet database; its owner controls transactions. */
  exec(
    query: string,
    ...bindings: (string | number | ArrayBuffer)[]
  ): {
    /** Read the native SQLite cursor rows. */
    toArray(): readonly Readonly<
      Record<string, string | number | ArrayBuffer | null>
    >[];
  };
}>;
const materialRow = z.strictObject({
  seq: z.number().int().nonnegative(),
  bytes: z.instanceof(ArrayBuffer).transform((bytes) => new Uint8Array(bytes)),
});
/** One-MiB material rows; exact replays are idempotent, conflicting material refuses. */
export function sqliteGitStepMaterial(sql: GitStepSql): GitStepMaterial {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS git_step_material (key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes)<=1048576), PRIMARY KEY(key,seq))",
  );
  return {
    put(key, seq, bytes) {
      return Promise.resolve().then(() => {
        if (
          bytes.length > ROW_BYTES ||
          !Number.isSafeInteger(seq) ||
          seq < 0 ||
          seq >= MERGE_BYTES / ROW_BYTES
        )
          throw new RangeError("Invalid Git material row");
        sql.exec(
          "INSERT INTO git_step_material(key,seq,bytes) VALUES(?,?,?) ON CONFLICT(key,seq) DO NOTHING",
          key,
          seq,
          new Uint8Array(bytes).buffer,
        );
        const row = sql
          .exec(
            "SELECT seq,bytes FROM git_step_material WHERE key=? AND seq=?",
            key,
            seq,
          )
          .toArray()[0];
        const stored = materialRow.parse(row);
        if (!Buffer.from(stored.bytes).equals(Buffer.from(bytes)))
          throw new GitStepMaterialError("conflict");
      });
    },
    read(key) {
      return Promise.resolve().then(() => {
        const rows = sql
          .exec(
            "SELECT seq,bytes FROM git_step_material WHERE key=? ORDER BY seq LIMIT 17",
            key,
          )
          .toArray()
          .map((row) => materialRow.parse(row));
        if (
          rows.length === 0 ||
          rows.length > MERGE_BYTES / ROW_BYTES ||
          rows.some((row, index) => row.seq !== index)
        )
          throw new GitStepMaterialError("unavailable");
        return new Uint8Array(Buffer.concat(rows.map((row) => row.bytes)));
      });
    },
    drop(prefix) {
      return Promise.resolve().then(() => {
        checkedOwnerPrefix(prefix);
        sql.exec(
          "DELETE FROM git_step_material WHERE substr(key,1,length(?))=?",
          prefix,
          prefix,
        );
      });
    },
  };
}
/** Volatile foreground driver material; background callers use the facet owner. */
export function memoryGitStepMaterial(): GitStepMaterial {
  const rows = new Map<string, Map<number, Uint8Array>>();
  return {
    put(key, seq, bytes) {
      return Promise.resolve().then(() => {
        if (
          bytes.length > ROW_BYTES ||
          !Number.isSafeInteger(seq) ||
          seq < 0 ||
          seq >= MERGE_BYTES / ROW_BYTES
        )
          throw new RangeError("Invalid Git material row");
        let values = rows.get(key);
        if (values === undefined) {
          values = new Map();
          rows.set(key, values);
        }
        const previous = values.get(seq);
        if (
          previous !== undefined &&
          !Buffer.from(previous).equals(Buffer.from(bytes))
        )
          throw new GitStepMaterialError("conflict");
        values.set(seq, new Uint8Array(bytes));
      });
    },
    read(key) {
      return Promise.resolve().then(() => {
        const values = rows.get(key);
        if (values === undefined || values.size === 0)
          throw new GitStepMaterialError("unavailable");
        const parts = [...values].sort(([a], [b]) => a - b);
        if (parts.some(([seq], index) => seq !== index))
          throw new GitStepMaterialError("unavailable");
        return new Uint8Array(Buffer.concat(parts.map(([, bytes]) => bytes)));
      });
    },
    drop(prefix) {
      return Promise.resolve().then(() => {
        checkedOwnerPrefix(prefix);
        for (const key of rows.keys())
          if (key.startsWith(prefix)) rows.delete(key);
      });
    },
  };
}
function ownerPrefix(step: GitStep): string {
  return `git:${JSON.stringify([step.operation.kind, step.key])}:`;
}
function changesKey(
  step: GitStep & {
    operation: Extract<GitStep["operation"], { kind: "commit" }>;
  },
): string {
  return `${ownerPrefix(step)}changes:${step.operation.changesDigest}`;
}
function sourceKey(step: GitStep & { sourceDigest: string }): string {
  return `${ownerPrefix(step)}source:${step.sourceDigest}`;
}
function packKey(
  step: GitStep & { built: string; packDigest: string },
): string {
  return `${ownerPrefix(step)}pack:${step.built}:${step.packDigest}`;
}
async function restore(
  material: GitStepMaterial,
  key: string,
  digest: string,
  limit: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await material.read(key));
  if (bytes.length > limit) throw new RangeError("Git material too large");
  if ((await materialDigest(bytes)) !== digest)
    throw new GitStepMaterialError("digest_mismatch");
  return bytes;
}
async function materialDigest(bytes: Uint8Array): Promise<string> {
  return Buffer.from(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(bytes).buffer,
    ),
  ).toString("hex");
}
async function retain(
  material: GitStepMaterial,
  key: string,
  bytes: Uint8Array,
) {
  for (
    let offset = 0, seq = 0;
    offset < bytes.length || seq === 0;
    offset += ROW_BYTES, seq += 1
  ) {
    await material.put(key, seq, bytes.subarray(offset, offset + ROW_BYTES));
  }
}
const identitySchema = z.strictObject({ name: z.string(), email: z.string() });
const commitRequest = z
  .strictObject({
    repository: gitRepositoryNameSchema,
    branch: z.string().min(1),
    expectedHead: gitSha1Schema.nullable(),
    startFrom: z.string().min(1).optional(),
    message: z.string(),
    author: identitySchema,
  })
  .refine(
    (request) =>
      request.startFrom === undefined || request.expectedHead === null,
    { message: "startFrom requires an empty branch", path: ["startFrom"] },
  );
const mergeRequest = z.strictObject({
  target: gitRepositoryNameSchema,
  source: gitRepositoryNameSchema,
  branch: z.string().min(1),
  sourceBranch: z.string().min(1),
  expectedSource: gitSha1Schema,
  expectedTarget: gitSha1Schema.optional(),
  behind: z.number().int().nonnegative().optional(),
  message: z.string(),
  author: identitySchema,
});
const operation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("commit"),
    request: commitRequest,
    changesDigest: z.hash("sha256"),
    tags: z.array(
      z.strictObject({
        ref: z.string().startsWith("refs/tags/"),
        expected: gitSha1Schema.nullable(),
      }),
    ),
  }),
  z.strictObject({ kind: z.literal("merge"), request: mergeRequest }),
]);
const common = {
  key: requestKeySchema,
  timestamp: z.number().int().nonnegative(),
  operation,
};
const built = {
  ...common,
  old: gitSha1Schema.nullable(),
  built: gitSha1Schema,
  packDigest: z.hash("sha256"),
  attempt: z.number().int().min(0).max(3),
  pushBefore: gitSha1Schema.nullable().optional(),
  atomic: z.literal(true).optional(),
};
/** Strict, JSON-only continuation grammar; material and authority are not stored in it. */
export const gitStepSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...common,
    phase: z.literal("fetch-base"),
    base: gitSha1Schema.nullable(),
  }),
  z.strictObject({ ...common, phase: z.literal("too-large") }),
  z.strictObject({ ...common, phase: z.literal("inspect-base") }),
  z.strictObject({ ...common, phase: z.literal("inspect-source") }),
  z.strictObject({
    ...common,
    phase: z.literal("fetch-source"),
    target: gitSha1Schema.optional(),
  }),
  z.strictObject({
    ...common,
    phase: z.literal("inspect-target"),
    sourceDigest: z.hash("sha256"),
  }),
  z.strictObject({
    ...common,
    phase: z.literal("fetch-target"),
    sourceDigest: z.hash("sha256"),
    target: gitSha1Schema,
  }),
  z.strictObject({ ...built, phase: z.literal("inspect-merge-push") }),
  z.strictObject({ ...built, phase: z.literal("inspect-atomic") }),
  z.strictObject({ ...built, phase: z.literal("push") }),
  z.strictObject({ ...built, phase: z.literal("confirm") }),
  z.strictObject({
    ...built,
    phase: z.literal("confirm-ancestry"),
    head: gitSha1Schema,
  }),
]);
/** Durable checkpoint, suitable for a Watchdog payload and fresh-frame re-admission. */
export type GitStep = z.output<typeof gitStepSchema>;
/** Caller-owned operation; begin fixes the timestamp and stores file bytes outside the checkpoint. */
export type GitStepOperation =
  | Readonly<{
      kind: "commit";
      requestKey: string;
      request: CommitFilesRequest;
      tags?: readonly Readonly<{ ref: string; expected: string | null }>[];
      timestamp?: number;
    }>
  | Readonly<{
      kind: "merge";
      requestKey: string;
      request: MergeBranchRequest;
      timestamp?: number;
    }>;
/** Final Git outcome; oversize material refuses before any receive-pack. */
export type GitStepOutcome =
  GitWriteOutcome | GitMergeOutcome | Readonly<{ kind: "too_large" }>;
/** One step either checkpoints, settles, or yields before transport. */
export type GitStepResult =
  | Readonly<{ next: GitStep }>
  | Readonly<{ done: GitStepOutcome }>
  | Readonly<{ yield: true }>;
/** Per-frame transport plus the existing facet's durable material owner. */
export type GitStepPorts = Readonly<{
  git: GitCommitStore;
  material: GitStepMaterial;
}>;
const changesSchema = z.array(
  z.strictObject({
    path: z.string().min(1).max(4096),
    content: z.base64().nullable(),
    mode: z.enum(["100644", "100755"]).optional(),
  }),
);
function checkedPath(path: string) {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new RangeError("Invalid repository path");
  return path;
}
/** Prepare immutable request material before atomically enqueueing the first checkpoint. */
export async function begin(
  input: GitStepOperation,
  material: GitStepMaterial,
): Promise<GitStep> {
  const key = input.requestKey;
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  if (input.kind === "merge")
    return gitStepSchema.parse({
      key,
      timestamp,
      operation: { kind: "merge", request: input.request },
      phase: "inspect-source",
    });
  const { changes, ...request } = input.request;
  const bytes = encoder.encode(
    JSON.stringify(
      changesSchema.parse(
        changes.map((change) => ({
          ...change,
          path: checkedPath(change.path),
          content:
            change.content === null
              ? null
              : Buffer.from(change.content).toString("base64"),
        })),
      ),
    ),
  );
  const changesDigest = await materialDigest(bytes);
  const checkpoint = gitStepSchema.parse({
    key,
    timestamp,
    operation: {
      kind: "commit",
      request,
      changesDigest,
      tags: input.tags ?? [],
    },
    phase: "inspect-base",
  });
  if (bytes.length > COMMIT_BYTES)
    return gitStepSchema.parse({
      key,
      timestamp,
      operation: checkpoint.operation,
      phase: "too-large",
    });
  await retain(
    material,
    changesKey({ ...checkpoint, operation: commitOnly(checkpoint) }),
    bytes,
  );
  return checkpoint;
}
async function freshFs(): Promise<MemoryFs> {
  const fs = memoryFs();
  await fs.promises.mkdir(DIR);
  await git.init({ fs, dir: DIR });
  return fs;
}
async function index(fs: MemoryFs, pack: Uint8Array, name: string) {
  const filepath = `.git/objects/pack/${name}.pack`;
  await fs.promises.writeFile(`${DIR}/${filepath}`, pack);
  return (await git.indexPack({ fs, dir: DIR, filepath })).oids;
}
async function looseObjects(fs: MemoryFs) {
  const result: string[] = [];
  for (const prefix of await fs.promises.readdir(`${DIR}/.git/objects`)) {
    if (!/^[0-9a-f]{2}$/u.test(prefix)) continue;
    for (const suffix of await fs.promises.readdir(
      `${DIR}/.git/objects/${prefix}`,
    ))
      if (/^[0-9a-f]{38}$/u.test(suffix)) result.push(prefix + suffix);
  }
  return result;
}
async function fetchPack(
  store: GitCommitStore,
  repo: string,
  wants: readonly string[],
  shallow: boolean,
) {
  const body =
    wants
      .map((oid, index) =>
        pktLine(
          `want ${oid}${index === 0 ? " side-band-64k ofs-delta no-progress" : ""}\n`,
        ),
      )
      .join("") +
    (shallow ? pktLine("deepen 1\n") : "") +
    "0000" +
    pktLine("done\n");
  return store.exchange(repo, {
    service: "upload-pack",
    phase: "exchange",
    headers: { "content-type": "application/x-git-upload-pack-request" },
    body: encoder.encode(body),
  });
}
function packResponse(response: GitExchangeResponse) {
  if (response.status !== 200) throw new Error("Git fetch unavailable");
  const pack = sideBandData(response.body);
  if (pack.length === 0) throw new Error("Git fetch returned no pack");
  return pack;
}
async function refHeads(store: GitCommitStore, repo: string) {
  const response = await store.exchange(repo, {
    service: "upload-pack",
    phase: "advertise",
    body: null,
    headers: {},
  });
  if (response.status !== 200) throw new Error("Git advertisement unavailable");
  return advertisedRefs(response.body);
}
function commitOnly(step: GitStep) {
  if (step.operation.kind !== "commit")
    throw new Error("Invalid commit checkpoint");
  return step.operation;
}
function mergeOnly(step: GitStep) {
  if (step.operation.kind !== "merge")
    throw new Error("Invalid merge checkpoint");
  return step.operation.request;
}
async function preparePush(
  step: GitStep,
  fs: MemoryFs,
  old: string | null,
  oid: string,
  oids: string[],
  ports: GitStepPorts,
): Promise<GitStepResult> {
  const { packfile } = await git.packObjects({
    fs,
    dir: DIR,
    oids: [...new Set(oids)],
  });
  if (packfile === undefined) throw new Error("Git pack unavailable");
  if (packfile.length > COMMIT_BYTES) return { done: { kind: "too_large" } };
  const packDigest = await materialDigest(packfile);
  const materialKey = packKey({ ...step, built: oid, packDigest });
  await retain(ports.material, materialKey, packfile);
  return {
    next: gitStepSchema.parse({
      key: step.key,
      timestamp: step.timestamp,
      operation: step.operation,
      phase:
        step.operation.kind === "merge"
          ? "inspect-merge-push"
          : step.operation.tags.length > 0
            ? "inspect-atomic"
            : "push",
      old,
      built: oid,
      packDigest,
      attempt: 0,
    }),
  };
}
async function buildCommit(
  step: GitStep,
  fs: MemoryFs,
  base: string | null,
  ports: GitStepPorts,
): Promise<GitStepResult> {
  const op = commitOnly(step);
  const changes = changesSchema
    .parse(
      JSON.parse(
        new TextDecoder().decode(
          await restore(
            ports.material,
            changesKey({ ...step, operation: op }),
            op.changesDigest,
            COMMIT_BYTES,
          ),
        ),
      ),
    )
    .map((change) => {
      const restored = {
        path: change.path,
        content:
          change.content === null
            ? null
            : new Uint8Array(Buffer.from(change.content, "base64")),
        parts: checkedPath(change.path).split("/"),
      };
      if (change.mode === undefined) return restored;
      return { ...restored, mode: change.mode };
    });
  const baseTree =
    base === null
      ? null
      : (await git.readCommit({ fs, dir: DIR, oid: base })).commit.tree;
  const tree = await editTree(fs, baseTree, changes);
  if (base !== null && tree === baseTree) {
    if (op.tags.length === 0)
      return { done: { kind: "unchanged", commit: base } };
    return preparePush(
      step,
      fs,
      op.request.expectedHead,
      base,
      await looseObjects(fs),
      ports,
    );
  }
  const identity = {
    ...op.request.author,
    timestamp: step.timestamp,
    timezoneOffset: 0,
  };
  const oid = await git.commit({
    fs,
    dir: DIR,
    message: op.request.message,
    author: identity,
    committer: identity,
    tree: tree ?? (await git.writeTree({ fs, dir: DIR, tree: [] })),
    parent: base === null ? [] : [base],
    ref: `refs/heads/${op.request.branch}`,
  });
  return preparePush(
    step,
    fs,
    op.request.expectedHead,
    oid,
    await looseObjects(fs),
    ports,
  );
}
async function buildMerge(
  step: GitStep,
  fs: MemoryFs,
  target: string,
  sourceOids: string[],
  targetOids: string[],
  ports: GitStepPorts,
): Promise<GitStepResult> {
  const request = mergeOnly(step);
  const theirs = request.expectedSource;
  if (
    target === theirs ||
    (await git.isDescendent({
      fs,
      dir: DIR,
      oid: target,
      ancestor: theirs,
      depth: -1,
    }))
  )
    return { done: { kind: "up-to-date", head: target } };
  await git.writeRef({
    fs,
    dir: DIR,
    ref: `refs/heads/${request.branch}`,
    value: target,
    force: true,
  });
  await git.writeRef({
    fs,
    dir: DIR,
    ref: "refs/heads/step-source",
    value: theirs,
    force: true,
  });
  const identity = {
    ...request.author,
    timestamp: step.timestamp,
    timezoneOffset: 0,
  };
  let oid: string | undefined;
  try {
    oid = (
      await git.merge({
        fs,
        dir: DIR,
        ours: request.branch,
        theirs: "step-source",
        fastForward: false,
        abortOnConflict: true,
        message: request.message,
        author: identity,
        committer: identity,
      })
    ).oid;
  } catch (cause) {
    if (cause instanceof git.Errors.MergeConflictError)
      return {
        done: { kind: "conflict", head: target, paths: cause.data.filepaths },
      };
    throw cause;
  }
  if (oid === undefined) return { done: { kind: "up-to-date", head: target } };
  const excluded = new Set(targetOids);
  return preparePush(
    step,
    fs,
    target,
    oid,
    [
      ...sourceOids.filter((id) => !excluded.has(id)),
      ...(await looseObjects(fs)),
    ],
    ports,
  );
}
function outcome(
  step: GitStep & { phase: "push" | "confirm" | "confirm-ancestry" },
): GitStepOutcome {
  return step.operation.kind === "commit"
    ? { kind: "committed", commit: step.built }
    : { kind: "merged", before: step.old ?? ZERO, after: step.built };
}
function frameClosed(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Execute one fresh-admitted frame; the caller persists next and its successor job atomically. */
export async function runStep(
  raw: GitStep,
  ports: GitStepPorts,
  signal: AbortSignal,
): Promise<GitStepResult> {
  const step = gitStepSchema.parse(raw);
  if (frameClosed(signal)) return { yield: true };
  switch (step.phase) {
    case "too-large":
      return { done: { kind: "too_large" } };
    case "inspect-base": {
      const op = commitOnly(step);
      const heads = await refHeads(ports.git, op.request.repository);
      const current = heads.get(`refs/heads/${op.request.branch}`) ?? null;
      if (current !== op.request.expectedHead)
        return { done: { kind: "stale", head: current } };
      const base =
        current !== null || op.request.startFrom === undefined
          ? current
          : (heads.get(`refs/heads/${op.request.startFrom}`) ?? null);
      if (
        current === null &&
        op.request.startFrom !== undefined &&
        base === null
      )
        throw new Error("Start branch unavailable");
      if (base === null) return buildCommit(step, await freshFs(), null, ports);
      return {
        next: gitStepSchema.parse({ ...step, phase: "fetch-base", base }),
      };
    }
    case "fetch-base": {
      const op = commitOnly(step);
      const fs = await freshFs();
      if (step.base !== null) {
        if (frameClosed(signal)) return { yield: true };
        const response = await fetchPack(
          ports.git,
          op.request.repository,
          [step.base],
          true,
        );
        const pack = packResponse(response);
        if (pack.length > COMMIT_BYTES) return { done: { kind: "too_large" } };
        await index(fs, pack, "base");
      }
      return buildCommit(step, fs, step.base, ports);
    }
    case "inspect-source": {
      const request = mergeOnly(step);
      const heads = await refHeads(ports.git, request.source);
      const head = heads.get(`refs/heads/${request.sourceBranch}`);
      if (head === undefined) throw new Error("Source branch unavailable");
      if (head !== request.expectedSource)
        return { done: { kind: "source-moved", head } };
      const target =
        request.source === request.target
          ? heads.get(`refs/heads/${request.branch}`)
          : request.expectedTarget;
      const next: Extract<GitStep, { phase: "fetch-source" }> = {
        key: step.key,
        timestamp: step.timestamp,
        operation: step.operation,
        phase: "fetch-source",
      };
      if (target !== undefined) next.target = target;
      return { next: gitStepSchema.parse(next) };
    }
    case "fetch-source": {
      const request = mergeOnly(step);
      const wants = [
        request.expectedSource,
        ...(request.source === request.target && step.target !== undefined
          ? [step.target]
          : []),
      ];
      const pack = packResponse(
        await fetchPack(ports.git, request.source, [...new Set(wants)], false),
      );
      if (pack.length > MERGE_BYTES) return { done: { kind: "too_large" } };
      const fs = await freshFs();
      const oids = await index(fs, pack, "source");
      if (request.source === request.target && step.target !== undefined)
        return buildMerge(step, fs, step.target, [], oids, ports);
      const sourceDigest = await materialDigest(pack);
      await retain(ports.material, sourceKey({ ...step, sourceDigest }), pack);
      return {
        next: gitStepSchema.parse({
          key: step.key,
          timestamp: step.timestamp,
          operation: step.operation,
          phase: "inspect-target",
          sourceDigest,
        }),
      };
    }
    case "inspect-target": {
      const request = mergeOnly(step);
      const source = await restore(
        ports.material,
        sourceKey(step),
        step.sourceDigest,
        MERGE_BYTES,
      );
      const fs = await freshFs();
      const sourceOids = await index(fs, source, "source");
      const copied = request.behind === 0 ? request.expectedTarget : undefined;
      const contains =
        copied !== undefined &&
        copied !== request.expectedSource &&
        (await git.isDescendent({
          fs,
          dir: DIR,
          oid: request.expectedSource,
          ancestor: copied,
          depth: -1,
        }));
      if (frameClosed(signal)) return { yield: true };
      const heads = await refHeads(ports.git, request.target);
      const target = heads.get(`refs/heads/${request.branch}`);
      if (target === undefined) throw new Error("Target branch unavailable");
      if (contains && target !== copied)
        return { done: { kind: "stale", head: target } };
      if (contains) return buildMerge(step, fs, target, sourceOids, [], ports);
      return {
        next: gitStepSchema.parse({ ...step, phase: "fetch-target", target }),
      };
    }
    case "fetch-target": {
      const request = mergeOnly(step);
      const source = await restore(
        ports.material,
        sourceKey(step),
        step.sourceDigest,
        MERGE_BYTES,
      );
      const fs = await freshFs();
      const sourceOids = await index(fs, source, "source");
      if (frameClosed(signal)) return { yield: true };
      const target = packResponse(
        await fetchPack(ports.git, request.target, [step.target], false),
      );
      if (source.length + target.length > MERGE_BYTES)
        return { done: { kind: "too_large" } };
      const targetOids = await index(fs, target, "target");
      return buildMerge(step, fs, step.target, sourceOids, targetOids, ports);
    }
    case "inspect-merge-push": {
      const request = mergeOnly(step);
      const heads = await refHeads(ports.git, request.source);
      const source = heads.get(`refs/heads/${request.sourceBranch}`);
      if (source === undefined) throw new Error("Source branch unavailable");
      if (source !== request.expectedSource)
        return { done: { kind: "source-moved", head: source } };
      if (request.source === request.target) {
        const target = heads.get(`refs/heads/${request.branch}`) ?? null;
        if (target !== step.old)
          return { done: { kind: "stale", head: target } };
      }
      return { next: gitStepSchema.parse({ ...step, phase: "push" }) };
    }
    case "inspect-atomic": {
      const op = commitOnly(step);
      const response = await ports.git.exchange(op.request.repository, {
        service: "receive-pack",
        phase: "advertise",
        body: null,
        headers: {},
      });
      if (response.status !== 200)
        throw new Error("Git advertisement unavailable");
      if (!advertisedCapabilities(response.body).has("atomic"))
        throw new GitStepMaterialError("atomic_unavailable");
      return {
        next: gitStepSchema.parse({ ...step, phase: "push", atomic: true }),
      };
    }
    case "push": {
      const repo =
        step.operation.kind === "commit"
          ? step.operation.request.repository
          : step.operation.request.target;
      const ref = `refs/heads/${step.operation.request.branch}`;
      const refs = [
        {
          ref,
          old: step.pushBefore === undefined ? step.old : step.pushBefore,
        },
        ...(step.operation.kind === "commit"
          ? step.operation.tags.map((tag) => ({
              ref: tag.ref,
              old: tag.expected,
            }))
          : []),
      ];
      if (refs.length > 1 && step.atomic !== true)
        throw new GitStepMaterialError("atomic_unavailable");
      const pack = await restore(
        ports.material,
        packKey(step),
        step.packDigest,
        COMMIT_BYTES,
      );
      const commands =
        refs
          .map((update, index) =>
            pktLine(
              `${update.old ?? ZERO} ${step.built} ${update.ref}${index === 0 ? `\0report-status side-band-64k${refs.length > 1 ? " atomic" : ""}` : ""}\n`,
            ),
          )
          .join("") + "0000";
      if (frameClosed(signal)) return { yield: true };
      try {
        const response = await ports.git.exchange(repo, {
          service: "receive-pack",
          phase: "exchange",
          headers: { "content-type": "application/x-git-receive-pack-request" },
          body: new Uint8Array(Buffer.concat([encoder.encode(commands), pack])),
        });
        const accepted = acceptedRefs(response.body, true);
        if (
          response.status === 200 &&
          refs.every(({ ref }) => accepted.has(ref))
        )
          return {
            next: gitStepSchema.parse({
              ...step,
              phase: "confirm",
              attempt: Math.min(step.attempt + 1, 3),
            }),
          };
      } catch {
        /* An uncertain POST is resolved by the next independently admitted ref read. */
      }
      return {
        next: gitStepSchema.parse({
          ...step,
          phase: "confirm",
          attempt: Math.min(step.attempt + 1, 3),
        }),
      };
    }
    case "confirm": {
      const repo =
        step.operation.kind === "commit"
          ? step.operation.request.repository
          : step.operation.request.target;
      const heads = await refHeads(ports.git, repo);
      const ref = `refs/heads/${step.operation.request.branch}`;
      const head = heads.get(ref) ?? null;
      const tags = step.operation.kind === "commit" ? step.operation.tags : [];
      const tagsBuilt = tags.every(({ ref }) => heads.get(ref) === step.built);
      if (
        tagsBuilt &&
        (head === step.built ||
          (tags.length > 0 && head !== step.old && step.atomic === true))
      )
        return { done: outcome(step) };
      if (
        tags.length === 0 &&
        head !== null &&
        head !== step.old &&
        head !== step.built
      )
        return {
          next: gitStepSchema.parse({
            ...step,
            phase: "confirm-ancestry",
            head,
          }),
        };
      if (
        (head === step.old || head === step.built) &&
        tags.every(
          ({ ref, expected }) =>
            (heads.get(ref) ?? null) === expected ||
            heads.get(ref) === step.built,
        ) &&
        step.attempt < 3
      )
        return {
          next: gitStepSchema.parse({
            ...step,
            phase:
              step.operation.kind === "merge" ? "inspect-merge-push" : "push",
            pushBefore: head,
            operation:
              step.operation.kind === "commit"
                ? {
                    ...step.operation,
                    tags: tags.map((tag) => ({
                      ...tag,
                      expected: heads.get(tag.ref) ?? null,
                    })),
                  }
                : step.operation,
          }),
        };
      if (
        head === step.old &&
        tags.every(
          ({ ref, expected }) =>
            (heads.get(ref) ?? null) === expected ||
            heads.get(ref) === step.built,
        )
      )
        throw new GitStepMaterialError("push_refused");
      return { done: { kind: "stale", head } };
    }
    case "confirm-ancestry": {
      const repo =
        step.operation.kind === "commit"
          ? step.operation.request.repository
          : step.operation.request.target;
      const pack = packResponse(
        await fetchPack(ports.git, repo, [step.head], false),
      );
      if (pack.length > MERGE_BYTES)
        throw new RangeError("Git confirmation material too large");
      const fs = await freshFs();
      await index(fs, pack, "confirmation");
      const landed = await git.isDescendent({
        fs,
        dir: DIR,
        oid: step.head,
        ancestor: step.built,
        depth: -1,
      });
      return {
        done: landed ? outcome(step) : { kind: "stale", head: step.head },
      };
    }
  }
}

/** Drop material only after the owner has durably recorded the terminal outcome. */
export async function dropMaterial(
  step: GitStep,
  material: GitStepMaterial,
): Promise<void> {
  await material.drop(ownerPrefix(step));
}
