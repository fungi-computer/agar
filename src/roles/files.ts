/**
 * The `files` App role contract. An App that fills the Team's files role
 * receives a {@link FilesLocation} through an `apps.open` navigate intent, and
 * file browsing, edit and snapshot payloads travel in these shapes. Role names
 * belong to Puffball's App vocabulary; this module owns the files role's wire.
 */
import * as z from "zod";
import type { AppRole } from "@fungi.computer/puffball";
import {
  gitRepositoryNameSchema as repoName,
  gitSha1Schema as hash,
} from "@fungi.computer/puffball/git-representation";
import type { AppNavigateIntent } from "../apps.js";

/** The App role this contract serves. */
export const filesRole = "files" satisfies AppRole;

const person = z.strictObject({
  name: z.string(),
  email: z.string(),
});

export const commit = z.strictObject({
  hash,
  treeHash: hash,
  message: z.string(),
  author: person,
  committer: person,
  parents: z.array(hash),
  authoredAt: z.number(),
  committedAt: z.number(),
});
export type Commit = z.infer<typeof commit>;

export const treeEntry = z.strictObject({
  name: z.string(),
  mode: z.string(),
  hash,
  /** Git object kind; executable and symlink permissions live in mode. */
  type: z.enum(["blob", "tree", "commit"]),
});
export type TreeEntry = z.infer<typeof treeEntry>;

export const treeListing = z.strictObject({
  ref: z.string(),
  commit: commit,
  path: z.string(),
  entries: z.array(treeEntry),
});
export type TreeListing = z.infer<typeof treeListing>;

/** Saved text stays bounded by the admitted file-edit request. */
export const repositoryFileByteLimit = 64 * 1024;
export const repositoryFilePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (part) =>
            part !== "" && part !== "." && part !== ".." && part !== ".git",
        ),
    "Choose a relative repository file path.",
  );
/** A repository branch name as the files role carries it. */
export const repositoryBranch = z.string().min(1).max(256);
const editKey = {
  repo: repoName,
  branch: repositoryBranch,
  path: repositoryFilePath,
};
export const fileEditState = z.enum([
  "pending",
  "synced",
  "conflict",
  "failed",
]);
export const pendingFileEdit = z.strictObject({
  text: z.string(),
  revision: z.number().int().positive(),
  state: fileEditState,
  theirs: z.strictObject({ blob: hash.nullable(), commit: hash }).optional(),
  failure: z
    .enum([
      "branch_missing",
      "access_changed",
      "sync_failed",
      "permanent_material",
    ])
    .optional(),
});
export const fileSaveInput = z.strictObject({
  ...editKey,
  baseBlob: hash.nullable(),
  baseCommit: hash,
  text: z.string().max(repositoryFileByteLimit),
  revision: z.number().int().positive().nullable(),
});
export const fileSaveResult = z.union([
  z.strictObject({
    kind: z.literal("saved"),
    revision: z.number().int().positive(),
    state: z.literal("pending"),
  }),
  z.strictObject({
    kind: z.literal("synced"),
    revision: z.number().int().positive(),
    commit: hash,
  }),
  z.strictObject({
    kind: z.literal("conflict"),
    revision: z.number().int().nonnegative(),
    theirs: pendingFileEdit.shape.theirs.optional(),
  }),
  z.strictObject({
    kind: z.literal("failed"),
    revision: z.number().int().positive(),
    reason: z.enum([
      "branch_missing",
      "access_changed",
      "sync_failed",
      "permanent_material",
    ]),
  }),
  z.strictObject({
    kind: z.literal("refused"),
    reason: z.enum(["not-source-writer", "background-unavailable"]),
  }),
]);
export const fileDiscardInput = z.strictObject({
  ...editKey,
  revision: z.number().int().positive(),
});
export const fileDiscardResult = z.union([
  z.strictObject({ kind: z.enum(["discarded", "not_found"]) }),
  z.strictObject({
    kind: z.literal("conflict"),
    revision: z.number().int().positive(),
  }),
]);
export const fileSyncResult = z.strictObject({
  settled: z.array(z.strictObject({ ...editKey, result: fileSaveResult })),
  more: z.boolean(),
});
export type FileSaveInput = z.output<typeof fileSaveInput>;
export type FileSaveResult = z.output<typeof fileSaveResult>;

export const fileContent = z.strictObject({
  /** This member's saved row revision; null for committed-only readers or no row. */
  version: z.number().int().positive().nullable(),
  commit: hash,
  /** Null only for a path proven absent at this committed branch head. */
  blob: hash.nullable(),
  pending: pendingFileEdit.optional(),
  ref: z.string(),
  path: z.string(),
  size: z.number(),
  binary: z.boolean(),
  /** Absent when binary or larger than the viewer limit. */
  text: z.string().nullable(),
});
export type FileContent = z.infer<typeof fileContent>;

export const commitPage = z.strictObject({
  ref: z.string(),
  commits: z.array(z.strictObject({ commit, agent: z.string().nullable() })),
  next: z.string().optional(),
});
export type CommitPage = z.infer<typeof commitPage>;

/** Every path at a commit: files, and directories with a trailing slash. */
export const fileList = z.strictObject({
  ref: z.string(),
  commit,
  paths: z.array(z.string()),
  truncated: z.boolean(),
});
export type FileList = z.infer<typeof fileList>;

/** A foreground copy rebuild needs another admitted method frame. */
export const readCopyRebuilding = z.strictObject({
  kind: z.literal("rebuilding"),
});
export const copyRebuildPage = z.strictObject({
  done: z.boolean(),
  cursor: z.string().nullable(),
});

/** Where the files role opens: a repository file at a branch, or a Computer file. */
export const filesLocation = z.union([
  z.strictObject({
    repository: repoName,
    branch: repositoryBranch,
    path: repositoryFilePath,
  }),
  z.strictObject({ path: z.string().min(1).max(1024) }),
]);
export type FilesLocation = z.output<typeof filesLocation>;

/** The `apps.open` navigate intent that opens a location in the files role App. */
export function filesNavigateIntent(
  location: FilesLocation,
): AppNavigateIntent {
  return {
    kind: "navigate",
    params: Object.entries(filesLocation.parse(location)).map(
      ([key, value]) => ({ key, value }),
    ),
  };
}

/** Decode a received navigate intent's params; null when they name no files location. */
export function readFilesLocation(
  params: AppNavigateIntent["params"],
): FilesLocation | null {
  const parsed = filesLocation.safeParse(
    Object.fromEntries(params.map(({ key, value }) => [key, value])),
  );
  return parsed.success ? parsed.data : null;
}
