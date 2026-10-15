/**
 * Write to an installation's repository through its GIT binding: commit files
 * to a branch, point a ref at an existing commit, or merge one repository's
 * branch into another's. All run isomorphic-git over the binding's byte-RPC smart-HTTP exchange in memory, so an App never
 * holds a remote or a credential. Every write is compare-and-swap on the ref:
 * the caller names the head it built on, and a ref that moved is reported
 * stale instead of overwritten.
 */
import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import type { GitBinding, GitExchangeRequest } from "./git.js";
import { advertisedRefs } from "./git-wire.js";
import { memoryFs, type MemoryFs } from "./internal/memory-fs.js";
import {
  begin,
  runStep,
  memoryGitStepMaterial,
  type GitStepOperation,
  type GitStepOutcome,
} from "./git-steps.js";

/** The binding operations these writes use. */
export type GitCommitStore = Pick<GitBinding, "exchange">;

/** One file to write (`content`) or delete (`content: null`), repository-relative. */
export type GitFileChange = Readonly<{
  /** Slash-separated path inside the repository, without `.` or `..` parts. */
  path: string;
  /** New file bytes, or null to delete the file. */
  content: Uint8Array | null;
  /**
   * File mode for a written file. Defaults to the existing entry's mode, or
   * `100644` for a new file.
   */
  mode?: "100644" | "100755";
}>;

/** Name and email recorded as a commit's author and committer. */
export type GitIdentity = Readonly<{ name: string; email: string }>;

/** A commit of file changes to one branch. */
export type CommitFilesRequest = Readonly<{
  /** Installation-local repository name. */
  repository: string;
  /** Branch to commit to, without `refs/heads/`. */
  branch: string;
  /** The branch head the changes were made against, or null to create the branch. */
  expectedHead: string | null;
  /** When creating the branch, start from this branch's head instead of an empty tree. */
  startFrom?: string;
  /** Files to write or delete. */
  changes: readonly GitFileChange[];
  /** Commit message. */
  message: string;
  /** Author and committer. */
  author: GitIdentity;
}>;

/** What a compare-and-swap write did. */
export type GitWriteOutcome =
  | Readonly<{ kind: "committed"; commit: string }>
  | Readonly<{ kind: "unchanged"; commit: string }>
  | Readonly<{ kind: "updated" }>
  /** The ref was not at the expected head; nothing was written. */
  | Readonly<{ kind: "stale"; head: string | null }>;

/** Merge a branch of `source` (such as a fork) into a branch of `target`. */
export type MergeBranchRequest = Readonly<{
  /** Repository receiving the merge. */
  target: string;
  /** Repository the work comes from; may equal `target`. */
  source: string;
  /** Branch in `target` to merge into, without `refs/heads/`. */
  branch: string;
  /** Branch in `source` to merge, without `refs/heads/`. */
  sourceBranch: string;
  /** Reviewed source commit; must match the fetched source branch head. */
  expectedSource: string;
  /** Copied target head; used only when full source history proves it is an ancestor. */
  expectedTarget?: string;
  /** Copied distance behind the target. Zero permits an ancestry-checked source-only fetch. */
  behind?: number;
  /** Merge commit message. */
  message: string;
  /** Author and committer of the merge commit. */
  author: GitIdentity;
}>;

/** What a merge did. Merges always write a merge commit when there is new work. */
export type GitMergeOutcome =
  | Readonly<{ kind: "merged"; before: string; after: string }>
  /** The target already contains the source's work. */
  | Readonly<{ kind: "up-to-date"; head: string }>
  /** Both sides changed the same lines; nothing was written. */
  | Readonly<{ kind: "conflict"; head: string; paths: readonly string[] }>
  /** The target moved while merging; nothing was written. */
  | Readonly<{ kind: "stale"; head: string | null }>
  /** The fetched source differs from the reviewed commit; nothing was written. */
  | Readonly<{ kind: "source-moved"; head: string }>;

/** Point a ref at a commit that is the head of `source`. */
export type MoveRefRequest = Readonly<{
  /** Installation-local repository name. */
  repository: string;
  /** Full ref name, such as `refs/heads/main` or `refs/tags/v1`. */
  ref: string;
  /** The ref's current commit, or null to create it. */
  expected: string | null;
  /** Commit to point the ref at. */
  commit: string;
  /** Branch (without `refs/heads/`) whose head is `commit`. */
  source: string;
}>;

/** Ordered ref moves to one fetched source commit; each move has its own CAS guard. */
export type MoveRefsRequest = Readonly<{
  /** Installation-local repository name. */
  repository: string;
  /** Branch whose fetched head must be the selected commit. */
  source: string;
  /** Commit shared by all ref moves. */
  commit: string;
  /** Ordered compare-and-swap moves; an accepted prefix is never rolled back. */
  updates: readonly Readonly<{ ref: string; expected: string | null }>[];
}>;

/** Earlier moves remain accepted if a later ref is stale; this is not an atomic push. */
export type GitRefMovesOutcome =
  | Readonly<{ kind: "updated" }>
  | Readonly<{ kind: "stale"; ref: string; head: string | null }>;

const DIR = "/repository";
const ORIGIN = "https://git.binding.invalid/";
const ADVERTISE =
  /^https:\/\/git\.binding\.invalid\/[^/]+\.git\/info\/refs\?service=git-(upload|receive)-pack$/u;
const EXCHANGE =
  /^https:\/\/git\.binding\.invalid\/[^/]+\.git\/git-(upload|receive)-pack$/u;

// isomorphic-git expects a global Buffer; App backends run without Node's.
if (!("Buffer" in globalThis)) Reflect.set(globalThis, "Buffer", Buffer);

class StaleRef extends Error {
  constructor(readonly head: string | null) {
    super("Ref moved");
  }
}

type Guard = Readonly<{ ref: string; expected: string | null }>;

async function collect(
  body: AsyncIterableIterator<Uint8Array> | undefined,
): Promise<Uint8Array | null> {
  if (body === undefined) return null;
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts);
}

async function* once(chunk: Uint8Array): AsyncIterableIterator<Uint8Array> {
  await Promise.resolve();
  yield chunk;
}

/**
 * isomorphic-git's HTTP client over the binding. A guard checks the expected
 * head in the fetch advertisement and again in the push advertisement; the
 * server's ref update is compare-and-swap on that advertised head.
 */
function exchangeClient(
  store: GitCommitStore,
  repository: string,
  guard: Guard | null,
): git.HttpClient {
  return {
    async request(input) {
      const advertise = ADVERTISE.exec(input.url);
      const exchange = advertise === null ? EXCHANGE.exec(input.url) : null;
      const match = advertise ?? exchange;
      if (match === null) throw new Error("Unexpected Git URL");
      const service = match[1] === "receive" ? "receive-pack" : "upload-pack";
      const request: GitExchangeRequest = {
        service,
        phase: advertise === null ? "exchange" : "advertise",
        headers: input.headers ?? {},
        body: await collect(input.body),
      };
      const response = await store.exchange(repository, request);
      if (guard !== null && request.phase === "advertise") {
        const head = advertisedRefs(response.body).get(guard.ref) ?? null;
        if (head !== guard.expected) throw new StaleRef(head);
      }
      return {
        url: input.url,
        method: input.method ?? "GET",
        statusCode: response.status,
        statusMessage: "",
        headers: { ...response.headers },
        body: once(response.body),
      };
    },
  };
}

async function heads(
  store: GitCommitStore,
  repository: string,
): Promise<ReadonlyMap<string, string>> {
  const response = await store.exchange(repository, {
    service: "upload-pack",
    phase: "advertise",
    headers: {},
    body: null,
  });
  if (response.status !== 200)
    throw new Error("Repository advertisement unavailable");
  return advertisedRefs(response.body);
}

/**
 * The server refused the ref update (another push landed between our
 * advertisement and our pack: non-fast-forward, "fetch first", a lost ref
 * lock). Nothing was written; report the branch's fresh head.
 */
function rejectedPush(cause: unknown): boolean {
  return (
    cause instanceof git.Errors.PushRejectedError ||
    cause instanceof git.Errors.GitPushError
  );
}

async function staleAfterRejection(
  store: GitCommitStore,
  repository: string,
  ref: string,
): Promise<Readonly<{ kind: "stale"; head: string | null }>> {
  return {
    kind: "stale",
    head: (await heads(store, repository)).get(ref) ?? null,
  };
}

async function open(store: GitCommitStore, repository: string) {
  const fs: MemoryFs = memoryFs();
  await fs.promises.mkdir(DIR);
  await git.init({ fs, dir: DIR });
  await git.addRemote({
    fs,
    dir: DIR,
    remote: "origin",
    url: `${ORIGIN}${repository}.git`,
  });
  /** Fetch one branch's head (depth 1) and return its commit. */
  const fetchHead = async (branch: string, guard: Guard | null = null) => {
    await git.fetch({
      fs,
      http: exchangeClient(store, repository, guard),
      dir: DIR,
      remote: "origin",
      ref: branch,
      singleBranch: true,
      depth: 1,
      tags: false,
    });
    return git.resolveRef({
      fs,
      dir: DIR,
      ref: `refs/remotes/origin/${branch}`,
    });
  };
  return { fs, fetchHead };
}

/** Foreground driver over the same resumable engine used by background owners. */
async function driveSteps(
  store: GitCommitStore,
  operation: GitStepOperation,
  beforeWrite?: () => Promise<void>,
): Promise<GitStepOutcome> {
  // This key is local to a new volatile store per call, not a minted identity.
  const material = memoryGitStepMaterial();
  let checkpoint = await begin(operation, material);
  const ports = { git: store, material };
  const signal = new AbortController().signal;
  const [started, checked] = await Promise.allSettled([
    runStep(checkpoint, ports, signal),
    Promise.resolve().then(() => beforeWrite?.()),
  ]);
  // Preserve validation precedence and settle the fetch before the first push.
  if (checked.status === "rejected") throw checked.reason;
  if (started.status === "rejected") throw started.reason;
  let reply = started.value;
  for (;;) {
    if ("done" in reply) {
      if (reply.done.kind === "too_large")
        throw new RangeError("Git material exceeds resumable write bound");
      return reply.done;
    }
    if ("yield" in reply) throw new Error("Foreground Git write yielded");
    checkpoint = reply.next;
    reply = await runStep(checkpoint, ports, signal);
  }
}

/** Commit files using independently resumable, CAS-guarded Git steps. */
export async function commitFiles(
  store: GitCommitStore,
  request: CommitFilesRequest,
  beforeWrite?: () => Promise<void>,
): Promise<GitWriteOutcome> {
  const result = await driveSteps(
    store,
    { kind: "commit", requestKey: "foreground", request },
    beforeWrite,
  );
  if (
    result.kind === "committed" ||
    result.kind === "unchanged" ||
    result.kind === "updated" ||
    result.kind === "stale"
  )
    return result;
  throw new Error("Invalid commit step outcome");
}

/** Point a ref at the head commit of `source`, compare-and-swap on the ref. */
export async function moveRef(
  store: GitCommitStore,
  request: MoveRefRequest,
): Promise<GitWriteOutcome> {
  const result = await moveRefs(store, {
    repository: request.repository,
    source: request.source,
    commit: request.commit,
    updates: [{ ref: request.ref, expected: request.expected }],
  });
  return result.kind === "stale"
    ? { kind: "stale", head: result.head }
    : result;
}

/** Fetch a source once, then move refs in order with separate guarded pushes. */
export async function moveRefs(
  store: GitCommitStore,
  request: MoveRefsRequest,
): Promise<GitRefMovesOutcome> {
  const first = request.updates.at(0);
  if (first === undefined) return { kind: "updated" };
  const { fs, fetchHead } = await open(store, request.repository);
  try {
    if ((await fetchHead(request.source, first)) !== request.commit)
      throw new RangeError("Commit is not the head of its source branch");
  } catch (cause) {
    if (cause instanceof StaleRef)
      return { kind: "stale", ref: first.ref, head: cause.head };
    throw cause;
  }
  for (const update of request.updates) {
    await git.writeRef({
      fs,
      dir: DIR,
      ref: update.ref,
      value: request.commit,
      force: true,
    });
    try {
      const pushed = await git.push({
        fs,
        http: exchangeClient(store, request.repository, update),
        dir: DIR,
        remote: "origin",
        ref: update.ref,
        remoteRef: update.ref,
        // Each push's advertisement checks that ref's expected head.
        force: true,
      });
      if (!pushed.ok)
        return {
          ...(await staleAfterRejection(store, request.repository, update.ref)),
          ref: update.ref,
        };
    } catch (cause) {
      if (cause instanceof StaleRef)
        return { kind: "stale", ref: update.ref, head: cause.head };
      if (rejectedPush(cause))
        return {
          ...(await staleAfterRejection(store, request.repository, update.ref)),
          ref: update.ref,
        };
      throw cause;
    }
  }
  return { kind: "updated" };
}

/** Merge branches through the same one-exchange step engine as background owners. */
export async function mergeBranch(
  store: GitCommitStore,
  request: MergeBranchRequest,
): Promise<GitMergeOutcome> {
  const result = await driveSteps(store, {
    kind: "merge",
    requestKey: "foreground",
    request,
  });
  if (
    result.kind === "merged" ||
    result.kind === "up-to-date" ||
    result.kind === "conflict" ||
    result.kind === "stale" ||
    result.kind === "source-moved"
  )
    return result;
  throw new Error("Invalid merge step outcome");
}
