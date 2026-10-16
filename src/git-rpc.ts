import * as z from "zod";
import { type GitBinding } from "./git.js";
import {
  gitRepositoryNameSchema,
  gitSha1Schema,
} from "@fungi.computer/puffball/git-representation";

const bytes = z.lazy(() =>
  z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= 32 * 1024 * 1024),
);
const headers = z.lazy(() =>
  z.record(z.string().max(256), z.string().max(8192)),
);
const identity = z.strictObject({ name: z.string(), email: z.string() });
const info = z.lazy(() =>
  z.strictObject({
    name: gitRepositoryNameSchema,
    defaultBranch: z.string(),
    lastPushAt: z.string().nullable(),
    source: gitRepositoryNameSchema.nullable(),
  }),
);
const commit = z.lazy(() =>
  z.strictObject({
    hash: gitSha1Schema,
    treeHash: gitSha1Schema,
    message: z.string(),
    author: identity,
    committer: identity,
    parents: z.array(gitSha1Schema),
    authoredAt: z.number().int(),
    committedAt: z.number().int(),
  }),
);
const tree = z.lazy(() =>
  z.strictObject({
    name: z.string(),
    mode: z.string(),
    hash: gitSha1Schema,
    type: z.enum(["blob", "tree", "commit"]),
  }),
);
const request = z.strictObject({
  service: z.enum(["upload-pack", "receive-pack"]),
  phase: z.enum(["advertise", "exchange"]),
  body: bytes.nullable(),
  headers,
});
const response = z.strictObject({
  status: z.number().int().min(100).max(599),
  headers,
  body: bytes,
});
const createOptions = z.lazy(() =>
  z
    .strictObject({
      description: z.string().max(8192).optional(),
      defaultBranch: z.string().min(1).max(1024).optional(),
    })
    .optional(),
);
const forkOptions = z.lazy(() =>
  z.strictObject({ description: z.string().max(8192).optional() }).optional(),
);
const logOptions = z.lazy(() =>
  z.strictObject({
    ref: z.string().min(1).max(1024),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
);

/** The native tuple and result grammar shared by the handle and frame entrypoint. */
export const nativeGitCodecs = {
  create: {
    args: z.tuple([gitRepositoryNameSchema, createOptions]),
    result: info,
  },
  fork: {
    args: z.tuple([
      gitRepositoryNameSchema,
      gitRepositoryNameSchema,
      forkOptions,
    ]),
    result: info,
  },
  cloneUrl: { args: z.tuple([gitRepositoryNameSchema]), result: z.url() },
  info: { args: z.tuple([gitRepositoryNameSchema]), result: info.nullable() },
  delete: { args: z.tuple([gitRepositoryNameSchema]), result: z.boolean() },
  log: {
    args: z.tuple([gitRepositoryNameSchema, logOptions]),
    result: z.array(commit),
  },
  readCommit: {
    args: z.tuple([gitRepositoryNameSchema, gitSha1Schema]),
    result: commit.nullable(),
  },
  readTree: {
    args: z.tuple([gitRepositoryNameSchema, gitSha1Schema]),
    result: z.array(tree).nullable(),
  },
  readBlob: {
    args: z.tuple([gitRepositoryNameSchema, gitSha1Schema]),
    result: bytes.nullable(),
  },
  refs: {
    args: z.tuple([gitRepositoryNameSchema]),
    result: z.array(z.strictObject({ name: z.string(), hash: gitSha1Schema })),
  },
  exchange: {
    args: z.tuple([gitRepositoryNameSchema, request]),
    result: response,
  },
};

/** Host operation required before a native Git effect. */
export type NativeGitOperation =
  "create" | "fork" | "read" | "write" | "exchange";
/** A frame entrypoint uses the same native argument and result codecs as the handle. */
function frameMethod<Args extends readonly unknown[], Result>(
  codec: Readonly<{ args: z.ZodType<Args>; result: z.ZodType<Result> }>,
  operations: (args: Args) => readonly NativeGitOperation[],
) {
  return {
    /** Decode the native positional arguments with the method's tuple codec. */
    decodeArgs: (raw: readonly unknown[]): Args => codec.args.parse(raw),
    /** Validate the native result, preserving binary values. */
    decodeResult: (raw: unknown): Result => codec.result.parse(raw),
    /** Operations the host must grant for these decoded arguments. */

    requiredOperations: (args: readonly unknown[]): readonly string[] =>
      operations(codec.args.parse(args)),
  };
}

/** Native Git preserves tuples and binary values through the shared frame factory. */
export const nativeGitFrameMethods = {
  create: frameMethod(nativeGitCodecs.create, () => ["create"]),
  fork: frameMethod(nativeGitCodecs.fork, () => ["fork"]),
  cloneUrl: frameMethod(nativeGitCodecs.cloneUrl, () => ["read"]),
  info: frameMethod(nativeGitCodecs.info, () => ["read"]),
  delete: frameMethod(nativeGitCodecs.delete, () => ["write"]),
  log: frameMethod(nativeGitCodecs.log, () => ["read"]),
  readCommit: frameMethod(nativeGitCodecs.readCommit, () => ["read"]),
  readTree: frameMethod(nativeGitCodecs.readTree, () => ["read"]),
  readBlob: frameMethod(nativeGitCodecs.readBlob, () => ["read"]),
  refs: frameMethod(nativeGitCodecs.refs, () => ["read"]),
  exchange: frameMethod(nativeGitCodecs.exchange, ([, input]) => [
    "exchange",
    input.service === "receive-pack" ? "write" : "read",
  ]),
};

/** Native method identity is a source-owned refinement, not a transport parser. */
export const nativeGitMethodNameSchema = z.enum([
  "create",
  "fork",
  "cloneUrl",
  "info",
  "delete",
  "log",
  "readCommit",
  "readTree",
  "readBlob",
  "refs",
  "exchange",
]);

/** Dispatch owned tuples through the retained native handle without a JSON conversion. */
export async function invokeNativeGit(
  git: GitBinding,
  method: string,
  raw: readonly unknown[],
): Promise<Awaited<ReturnType<GitBinding[keyof GitBinding]>>> {
  switch (nativeGitMethodNameSchema.parse(method)) {
    case "create":
      return await git.create(...nativeGitCodecs.create.args.parse(raw));
    case "fork":
      return await git.fork(...nativeGitCodecs.fork.args.parse(raw));
    case "cloneUrl":
      return await git.cloneUrl(...nativeGitCodecs.cloneUrl.args.parse(raw));
    case "info":
      return await git.info(...nativeGitCodecs.info.args.parse(raw));
    case "delete":
      return await git.delete(...nativeGitCodecs.delete.args.parse(raw));
    case "log":
      return await git.log(...nativeGitCodecs.log.args.parse(raw));
    case "readCommit":
      return await git.readCommit(
        ...nativeGitCodecs.readCommit.args.parse(raw),
      );
    case "readTree":
      return await git.readTree(...nativeGitCodecs.readTree.args.parse(raw));
    case "readBlob":
      return await git.readBlob(...nativeGitCodecs.readBlob.args.parse(raw));
    case "refs":
      return await git.refs(...nativeGitCodecs.refs.args.parse(raw));
    case "exchange":
      return await git.exchange(...nativeGitCodecs.exchange.args.parse(raw));
  }
}
