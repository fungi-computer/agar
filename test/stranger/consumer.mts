import {
  connectAppHost,
  type ConnectAppHostOptions,
  type AppHost,
} from "@fungi.computer/agar/host";
import * as z from "zod";
import { AppError, connectApp, type AppRoot } from "@fungi.computer/agar";
import {
  describeAppError,
  type ErrorDescription,
} from "@fungi.computer/agar/errors";
import {
  defineAppBackend,
  defineAppMethod,
  type AppBackendDefinition,
  pending,
  pendingSchema,
  type Pending,
} from "@fungi.computer/agar/backend-definition";
import { buildAppApi } from "@fungi.computer/agar/backend-declaration";
import { appStorage } from "@fungi.computer/agar/storage";
import {
  computerPortsSchema,
  type ComputerPorts,
} from "@fungi.computer/agar/computer";
import * as Schema from "effect/Schema";

import {
  commitFiles,
  moveRefs,
  mergeBranch,
  type CommitFilesRequest,
  type GitWriteOutcome,
  type GitCommitStore,
  type MoveRefsRequest,
  type GitRefMovesOutcome,
  type MergeBranchRequest,
} from "@fungi.computer/agar/git-commit";

export const externalPreviewPorts: ComputerPorts = Schema.decodeUnknownSync(
  computerPortsSchema,
)({
  ports: [
    {
      port: 3000,
      previewUrl: "https://preview.example.test/",
      expiresAt: 1_800_000_000_000,
      openMode: "external-only",
    },
  ],
});

export function commitValidatedFiles(
  store: GitCommitStore,
  request: CommitFilesRequest,
  beforeWrite: () => Promise<void>,
): Promise<GitWriteOutcome> {
  return commitFiles(store, request, beforeWrite);
}

export function movePublicationRefs(
  store: GitCommitStore,
  request: MoveRefsRequest,
): Promise<GitRefMovesOutcome> {
  return moveRefs(store, request);
}

const backend: AppBackendDefinition = defineAppBackend({
  methods: {
    count: defineAppMethod({
      description: "Count characters",
      effect: "read",
      requires: [],
      input: z.object({ text: z.string() }),
      output: z.number().int(),
      handler: ({ text }) => text.length,
    }),
  },
});
const api = buildAppApi(backend);
export const polling: Pending = pendingSchema.parse(pending(5000));
export const pollingMethod = defineAppMethod({
  description: "Wait for work",
  effect: "read",
  requires: [],
  pending: true,
  input: z.null(),
  output: z.string(),
  handler: (): string | Pending => pending(5000),
});
const description: ErrorDescription = describeAppError(
  new AppError("Capability denied", {
    code: "CAPABILITY_DENIED",
    retryable: false,
  }),
);
export const connect: typeof connectApp = connectApp;
export const roots: readonly AppRoot[] = [];
export { api, description, appStorage };

export const mountHost: (options: ConnectAppHostOptions) => Promise<AppHost> =
  connectAppHost;
import {
  dispatchAppGitPush,
  type AppGitLifecycle,
  type GitBinding,
  type GitExchangeRequest,
  type GitExchangeResponse,
} from "@fungi.computer/agar/git";
export const lifecycle: AppGitLifecycle = {
  onGitPush: () => Promise.resolve(),
};
export const deliver: typeof dispatchAppGitPush = dispatchAppGitPush;
export type RepositoryBinding = GitBinding;

export const exchangeRequest: GitExchangeRequest = {
  service: "upload-pack",
  phase: "advertise",
  headers: {},
  body: null,
};
export function exchangeRepository(
  binding: GitBinding,
): Promise<GitExchangeResponse> {
  return binding.exchange("project", exchangeRequest);
}

import {
  authorMeta,
  messageAuthor,
  type FungiAuthor,
} from "@fungi.computer/agar/agents";
export const messageMetadataAuthor: FungiAuthor | undefined = messageAuthor(
  authorMeta({ id: "user_ada", name: "Ada" }),
);

import { MediaGeneration } from "@fungi.computer/agar/media-json";
import { mediaRequestIds } from "@fungi.computer/agar/media-request-id";
import type { MediaGenerationHandle } from "@fungi.computer/agar/media";
export const jsonMedia: MediaGenerationHandle = new MediaGeneration(
  () =>
    Promise.resolve({ computerId: "workspace", canGenerate: true, models: [] }),
  "workspace",
);
export const mediaReplayId: string = mediaRequestIds.request.generate();

import {
  repositoryRefKey,
  repositoryRefsEqual,
  type RepositoryRef,
  type GitPushQuestion,
  type GitPushVerdict,
  type GitWriter,
} from "@fungi.computer/agar/git";
const repository: RepositoryRef = {
  kind: "installation",
  installationId: "installation_stranger",
  repository: "project",
};
export const repositoryIdentity: string = repositoryRefKey(repository);
export const sameRepository: boolean = repositoryRefsEqual(repository, {
  repository: "project",
  installationId: "installation_stranger",
  kind: "installation",
});
import {
  parseReceivePack,
  acceptedRefs,
  refusalReport,
} from "@fungi.computer/agar/git-wire";
export const parseGitCommands: typeof parseReceivePack = parseReceivePack;
export const acceptedGitRefs: typeof acceptedRefs = acceptedRefs;
export const reportGitRefusal: typeof refusalReport = refusalReport;
export const authorizePush: (
  question: GitPushQuestion,
) => Promise<GitPushVerdict> = () => Promise.resolve({ allowed: true });
export const workflowWriter: GitWriter = {
  kind: "actor",
  actor: { kind: "member", memberId: "member_stranger" },
  role: "owner",
  workflow: {
    workflowId: "workflow_stranger",
    runId: "run_stranger",
    nodeId: "node_stranger",
    armedBy: { kind: "member", memberId: "member_stranger" },
    branches: ["refs/heads/work"],
  },
};

import {
  invokeNativeGit,
  nativeGitCodecs,
  nativeGitFrameMethods,
  nativeGitMethodNameSchema,
  type NativeGitOperation,
} from "@fungi.computer/agar/git-rpc";
export const nativeOperation: NativeGitOperation = "exchange";
export const nativeExchange = nativeGitCodecs.exchange.args.parse([
  "notes",
  {
    service: "receive-pack",
    phase: "exchange",
    body: new Uint8Array([0, 255]),
    headers: {},
  },
]);
export const nativeRequiredOperations: readonly string[] =
  nativeGitFrameMethods.exchange.requiredOperations(nativeExchange);
export const nativeMethod = nativeGitMethodNameSchema.parse("exchange");

import { appComputerAdmissionRefusalSchema } from "@fungi.computer/agar/computer-contracts";
export const computerAdmissionRefusal: z.output<
  typeof appComputerAdmissionRefusalSchema
> = appComputerAdmissionRefusalSchema.parse({ error: "not_granted" });
export function invokeExchange(
  git: import("@fungi.computer/agar/git").GitBinding,
) {
  return invokeNativeGit(git, "exchange", nativeExchange);
}

import {
  createReadCopies,
  countingGit,
  type ReadCopySql,
  type ReadCopyResult,
} from "@fungi.computer/agar/read-copy";
export function savedScreen(
  sql: ReadCopySql,
  git: import("@fungi.computer/agar/git").GitBinding,
  signal: AbortSignal,
): ReadCopyResult<string> {
  const copies = createReadCopies(sql, {
    version: 1,
    maxRows: 100,
    maxValueBytes: 65536,
    maxBlobBytes: 65536,
    maxBlobTotalBytes: 1048576,
  });
  countingGit(git, { limit: 40, signal });
  return copies.open("documents", z.string()).read("draft");
}

/** The optional copy hints use the public packaged merge request. */
export function mergeReviewedFork(store: GitCommitStore) {
  const request: MergeBranchRequest = {
    target: "canonical",
    source: "fork",
    branch: "main",
    sourceBranch: "main",
    expectedSource: "2222222222222222222222222222222222222222",
    expectedTarget: "1111111111111111111111111111111111111111",
    behind: 0,
    message: "Merge reviewed work",
    author: { name: "Stranger", email: "stranger@example.test" },
  };
  return mergeBranch(store, request);
}

import {
  begin,
  runStep,
  gitStepSchema,
  sqliteGitStepMaterial,
  dropMaterial,
  GitStepMaterialError,
  type GitStep,
  type GitStepOperation,
  type GitStepMaterial,
  type GitStepSql,
  type GitStepResult,
} from "@fungi.computer/agar/git-steps";

export async function resumeWrite(
  operation: GitStepOperation,
  sql: GitStepSql,
  git: GitCommitStore,
  signal: AbortSignal,
): Promise<GitStepResult> {
  const material: GitStepMaterial = sqliteGitStepMaterial(sql);
  const checkpoint: GitStep = gitStepSchema.parse(
    await begin(operation, material),
  );
  return runStep(checkpoint, { git, material }, signal);
}
export async function releaseSettledWrite(
  step: GitStep,
  material: GitStepMaterial,
): Promise<void> {
  await dropMaterial(step, material);
}

export function permanentGitMaterialReason(
  error: GitStepMaterialError,
): GitStepMaterialError["code"] {
  return error.code;
}
