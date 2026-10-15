import {
  gitRepositoryNameSchema,
  gitSha1Schema,
  gitRefUpdateSchema,
  gitPushEventIdSchema,
} from "@fungi.computer/puffball/git-representation";
import * as z from "zod";
import type { AppCapabilityId } from "@fungi.computer/puffball";
import {
  appMethodCallerSchema,
  hostActorSchema,
  workflowAttestationSchema,
  type HostActor,
  type WorkflowAttestation,
} from "@fungi.computer/puffball/app-method-runtime";

/** Requested installation-scoped Git authority; a declaration is never a grant. */
export const gitRepositoryCapability =
  "git.repository" satisfies AppCapabilityId;

/** Local repository name decoded at a host's repository boundary. */
export type GitRepositoryName = z.output<typeof gitRepositoryNameSchema>;
/**
 * Host-selected repository namespace. Team identity comes from the host;
 * decoding this reference never grants access to either namespace.
 */
export const repositoryRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("installation"),
    installationId: z.string().min(1).max(256),
    repository: gitRepositoryNameSchema,
  }),
  z.strictObject({
    kind: z.literal("team-source"),
    repository: gitRepositoryNameSchema,
  }),
]);
/** Installation-local repository or registered Team source, selected by its host. */
export type RepositoryRef = z.output<typeof repositoryRefSchema>;
/** Stable namespace identity, serialized through the canonical repository decoder. */
export function repositoryRefKey(repository: RepositoryRef): string {
  return JSON.stringify(repositoryRefSchema.parse(repository));
}
/** Compare repository namespace and coordinates independently of allocation or property order. */
export function repositoryRefsEqual(
  left: RepositoryRef,
  right: RepositoryRef,
): boolean {
  return repositoryRefKey(left) === repositoryRefKey(right);
}
/** Host-held writer identity; Workflow attribution reuses Puffball's sole grammar. */
export type GitWriter =
  | Readonly<{
      kind: "actor";
      actor: HostActor;
      role?: "owner" | "member";
      workflow?: WorkflowAttestation & { branches: readonly string[] };
    }>
  | Readonly<{
      kind: "installation";
      installationId: string;
      onBehalfOf: HostActor | null;
    }>;
const hostActor = z.discriminatedUnion("kind", [
  z.strictObject(hostActorSchema.def.options[0].shape),
  z.strictObject(hostActorSchema.def.options[1].shape),
  z.strictObject(hostActorSchema.def.options[2].shape),
]);
/** Canonical Git writer decoder; identity is attested by a host, never by an App. */
export const gitWriterSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("actor"),
    actor: hostActor,
    role: appMethodCallerSchema.shape.role,
    workflow: z
      .strictObject({
        ...workflowAttestationSchema.shape,
        armedBy: hostActor,
        branches: z
          .array(z.string().startsWith("refs/heads/").max(1024))
          .min(1)
          .max(256),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("installation"),
    installationId: z.string().min(1).max(256),
    onBehalfOf: hostActor.nullable(),
  }),
]);
/** The App's question covers the whole push, under host-held attribution. */
export const gitPushQuestionSchema = z.strictObject({
  repository: gitRepositoryNameSchema,
  writer: gitWriterSchema.options[0],
  updates: z.array(gitRefUpdateSchema).min(1).max(256),
});
/** A whole push verdict; refusal messages are shown by ordinary Git clients. */
export const gitPushVerdictSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({
    allowed: z.literal(false),
    refused: z
      .array(
        z.strictObject({
          ref: z.string().startsWith("refs/").max(1024),
          message: z.string().max(200),
        }),
      )
      .min(1)
      .max(256),
  }),
]);
/** Ref question sent only after host grant and Workflow branch admission. */
export type GitPushQuestion = z.output<typeof gitPushQuestionSchema>;
/** Explicit permission or bounded per-ref refusal for the whole push. */
export type GitPushVerdict = z.output<typeof gitPushVerdictSchema>;
/** One accepted push, with host attribution and no remote or credential. */
export const appGitPushFactSchema = z.strictObject({
  repository: gitRepositoryNameSchema,
  writer: gitWriterSchema,
  updates: z.array(gitRefUpdateSchema).min(1).max(256),
  unexplained: z
    .array(
      z.strictObject({
        ref: z.string().startsWith("refs/").max(1024),
        journaled: gitSha1Schema.nullable(),
      }),
    )
    .max(256)
    .optional(),
  // Host event IDs may include a Computer ID as well as its local event ID.
  eventId: gitPushEventIdSchema,
});
/** One bounded ref update, shared by push questions and accepted facts. */
export type GitRefUpdate = z.output<
  typeof appGitPushFactSchema
>["updates"][number];
/** Host-delivered push fact; retries retain the same event ID. */
export type AppGitPushFact = z.output<typeof appGitPushFactSchema>;
/** App-owned lifecycle handler, separate from its callable method catalog. */
export type AppGitLifecycle = Readonly<{
  /** An absent authorization handler refuses external pushes. */
  authorizeGitPush?: (question: GitPushQuestion) => Promise<GitPushVerdict>;
  /** Handle an accepted push; persist eventId with the effects to make retries idempotent. */
  onGitPush?: (fact: AppGitPushFact) => Promise<void>;
}>;
/** Parse a host-admitted fact and invoke its lifecycle handler, preserving rejection. */
export async function dispatchAppGitPush(
  lifecycle: AppGitLifecycle,
  raw: unknown,
): Promise<void> {
  const fact = appGitPushFactSchema.parse(raw);
  if (lifecycle.onGitPush === undefined)
    throw new Error("App Git push handler unavailable");
  await lifecycle.onGitPush(fact);
}

/** Credential-free repository metadata, with installation-local names. */
export type GitRepositoryInfo = Readonly<{
  /** Local repository name. */
  name: string;
  /** Default branch, without the refs/heads prefix. */
  defaultBranch: string;
  /** ISO timestamp of the last push, or null before the first push. */
  lastPushAt: string | null;
  /** Local fork source, or null for a newly created repository. */
  source: string | null;
}>;
/** Artifacts commit metadata, with the provider's credential fields absent. */
export type GitCommit = Readonly<{
  /** SHA-1 commit ID. */
  hash: string;
  /** SHA-1 root tree ID. */
  treeHash: string;
  /** Commit message. */
  message: string;
  /** Author identity recorded in the commit. */
  author: { name: string; email: string };
  /** Committer identity recorded in the commit. */
  committer: { name: string; email: string };
  /** Parent commit IDs, in Git order. */
  parents: string[];
  /** Author timestamp, in Unix seconds. */
  authoredAt: number;
  /** Committer timestamp, in Unix seconds. */
  committedAt: number;
}>;
/** One immediate child of a Git tree. */
export type GitTreeEntry = Readonly<{
  /** Name relative to the tree. */
  name: string;
  /** Canonical Git mode. */
  mode: string;
  /** SHA-1 object ID. */
  hash: string;
  /** Git object type; executable and symlink entries are blobs distinguished by mode. */
  type: "blob" | "tree" | "commit";
}>;
/** Smart-HTTP request; the host supplies and keeps the provider credential. */
export type GitExchangeRequest = Readonly<{
  /** Git upload-pack (read) or receive-pack (write). */
  service: "upload-pack" | "receive-pack";
  /** Advertisement or data exchange phase. */
  phase: "advertise" | "exchange";
  /** Request bytes for exchange, or null for advertisement; bounded by the host. */
  body: Uint8Array | null;
  /** Protocol headers; the host never trusts incoming authorization headers. */
  headers: Readonly<Record<string, string>>;
}>;
/** Credential-free RPC response; host adapters own stream conversion and byte bounds. */
export type GitExchangeResponse = Readonly<{
  /** Provider HTTP status. */
  status: number;
  /** Protocol response headers, without host credentials. */
  headers: Readonly<Record<string, string>>;
  /** Git protocol response bytes. */
  body: Uint8Array;
}>;
/** Installation-scoped GIT backend binding; approved operations and actor grants bound every call. */
export type GitBinding = Readonly<{
  /** Create a repository in this installation. */
  create(
    name: string,
    options?: { description?: string; defaultBranch?: string },
  ): Promise<GitRepositoryInfo>;
  /**
   * Fork another repository in this installation, waiting for it to serve
   * reads. When `target` already exists the host answers with that
   * repository instead; callers compare its `source` before adopting it.
   */
  fork(
    source: string,
    target: string,
    options?: { description?: string },
  ): Promise<GitRepositoryInfo>;
  /** Return the host-issued clone URL for this installation repository; authentication stays with the host. */
  cloneUrl(name: string): Promise<string>;
  /** Read repository metadata, or null when missing. */
  info(name: string): Promise<GitRepositoryInfo | null>;
  /** Delete a repository in this installation. */
  delete(name: string): Promise<boolean>;
  /** Read first-parent history, newest first. */
  log(
    name: string,
    options: { ref: string; limit?: number; offset?: number },
  ): Promise<GitCommit[]>;
  /** Read commit metadata, or null when missing. */
  readCommit(name: string, hash: string): Promise<GitCommit | null>;
  /** Read tree children, or null when missing. */
  readTree(name: string, hash: string): Promise<GitTreeEntry[] | null>;
  /** Read a blob bounded to 32 MiB, or null when missing. */
  readBlob(name: string, hash: string): Promise<Uint8Array | null>;
  /** Read advertised ref names and object IDs. */
  refs(name: string): Promise<{ name: string; hash: string }[]>;
  /** Exchange Git bytes; receive-pack requires both exchange and write approval. */
  exchange(
    name: string,
    request: GitExchangeRequest,
  ): Promise<GitExchangeResponse>;
}>;
