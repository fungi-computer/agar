import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
import { cwd } from "node:process";
import * as z from "zod";
import { build } from "esbuild";
import { connectAppHost } from "@fungi.computer/agar/host";
import { AppError } from "@fungi.computer/agar";
import { computerPortsSchema } from "@fungi.computer/agar/computer";
import * as Schema from "effect/Schema";

const previewPort = {
  port: 3000,
  previewUrl: "https://preview.example.test/",
  expiresAt: 1_800_000_000_000,
};
assert.throws(() =>
  Schema.decodeUnknownSync(computerPortsSchema)({ ports: [previewPort] }),
);
for (const openMode of ["inline", "external-only"])
  assert.equal(
    Schema.decodeUnknownSync(computerPortsSchema)({
      ports: [{ ...previewPort, openMode }],
    }).ports[0].openMode,
    openMode,
  );
import { describeAppError } from "@fungi.computer/agar/errors";
import {
  defineAppBackend,
  defineAppMethod,
  pending,
  pendingSchema,
} from "@fungi.computer/agar/backend-definition";
import { buildAppApi } from "@fungi.computer/agar/backend-declaration";
import { moveRefs } from "@fungi.computer/agar/git-commit";
import {
  repositoryRefKey,
  repositoryRefsEqual,
} from "@fungi.computer/agar/git";

const repository = {
  kind: "installation",
  installationId: "installation_stranger",
  repository: "project",
};
assert.equal(
  repositoryRefKey(repository),
  '{"kind":"installation","installationId":"installation_stranger","repository":"project"}',
);
assert.equal(
  repositoryRefsEqual(repository, {
    repository: "project",
    installationId: "installation_stranger",
    kind: "installation",
  }),
  true,
);
assert.equal(
  repositoryRefsEqual(repository, {
    kind: "team-source",
    repository: "project",
  }),
  false,
);

assert.deepEqual(
  await moveRefs(
    {
      exchange: () =>
        Promise.reject(new Error("Unexpected empty ref move I/O")),
    },
    {
      repository: "project",
      source: "main",
      commit: "a".repeat(40),
      updates: [],
    },
  ),
  { kind: "updated" },
);

const caller = {
  computerId: null,
  actor: { kind: "member", memberId: "member_stranger" },
};
assert.deepEqual(pendingSchema.parse(pending(5000)), {
  kind: "pending",
  retryAfterMs: 5000,
});
// Compile the packed entry under the App publisher's neutral export conditions.
const neutral = await build({
  stdin: {
    contents: `
      import * as z from "zod";
      import { defineAppMethod, pending, pendingSchema } from "@fungi.computer/agar/backend-definition";
      import { workflowGitPassResultSchema } from "@fungi.computer/agar/computer-contracts";
      export const workflowPass = workflowGitPassResultSchema.parse({
        passId: "pass_stranger",
        remote: "https://git.team.internal/workflow/pass_stranger/app_source.git",
        expiresAt: 62000
      });
      export const reply = pendingSchema.parse(pending(5000));
      export const method = defineAppMethod({
        description: "Wait for work", effect: "read", requires: [], pending: true,
        input: z.null(), output: z.string(), handler: () => pending(5000)
      });
    `,
    resolveDir: cwd(),
    loader: "js",
  },
  bundle: true,
  minify: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser"],
  target: ["es2022"],
  tsconfigRaw: {},
  write: false,
});
const [compiled] = neutral.outputFiles;
assert.ok(compiled);
const evaluated = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.text).toString("base64")}`
);
assert.deepEqual(evaluated.reply, { kind: "pending", retryAfterMs: 5000 });
assert.deepEqual(evaluated.workflowPass, {
  passId: "pass_stranger",
  remote: "https://git.team.internal/workflow/pass_stranger/app_source.git",
  expiresAt: 62000,
});
assert.deepEqual(await evaluated.method.call(null, undefined, caller), {
  kind: "pending",
  retryAfterMs: 5000,
});
const backend = defineAppBackend({
  methods: {
    echo: defineAppMethod({
      description: "Echo text",
      effect: "read",
      requires: [],
      input: z.object({ text: z.string() }),
      output: z.string(),
      handler: ({ text }) => text,
    }),
  },
});

assert.deepEqual(Object.keys(buildAppApi(backend).methods), ["echo"]);
assert.equal(
  await backend.call("echo", { text: "stranger" }, undefined, caller),
  "stranger",
);
await assert.rejects(backend.call("missing", {}, undefined, caller));
await assert.rejects(backend.call("echo", { text: 1 }, undefined, caller));
const failure = new AppError("Host failed", {
  code: "HOST_FAILURE",
  retryable: true,
});
assert.equal(describeAppError(failure).retryable, true);
assert.equal(describeAppError(new Error("opaque")).retryable, false);

// App authors can import and exercise the standalone iframe adapter from npm.
await assert.rejects(
  connectAppHost({ expectedAppOrigin: "https://app.example/with-a-path" }),
  { code: "INVALID_ARGUMENT" },
);
for (const subpath of [
  "seam-signature",
  "workbench",
  "command-host",
  "shell-keys",
  "shell-commands",
  "window-manager",
  "app-directory",
  "workflows-wire",
  "workflows",
]) {
  await assert.rejects(import(`@fungi.computer/agar/${subpath}`), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
}
const { dispatchAppGitPush } = await import("@fungi.computer/agar/git");
const delivered = [];
await dispatchAppGitPush(
  {
    onGitPush: (fact) => {
      delivered.push(fact.eventId);
      return Promise.resolve();
    },
  },
  {
    repository: "notes",
    writer: {
      kind: "actor",
      actor: { kind: "member", memberId: "member_stranger" },
    },
    updates: [
      { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
    ],
    eventId: "push_stranger",
  },
);
assert.deepEqual(delivered, ["push_stranger"]);

const { authorMeta, messageAuthor } =
  await import("@fungi.computer/agar/agents");
assert.deepEqual(messageAuthor(authorMeta({ id: "user_ada", name: "Ada" })), {
  id: "user_ada",
  name: "Ada",
});
assert.equal(
  messageAuthor({ author: { id: "user_ada", name: "Ada", role: "admin" } }),
  undefined,
);

const { MediaGeneration } = await import("@fungi.computer/agar/media-json");
const { mediaRequestIds } =
  await import("@fungi.computer/agar/media-request-id");
const jsonMedia = new MediaGeneration(
  () =>
    Promise.resolve({ computerId: "workspace", canGenerate: true, models: [] }),
  "workspace",
);
assert.deepEqual(await jsonMedia.describe(), {
  computerId: "workspace",
  canGenerate: true,
  models: [],
});
const mediaReference = await (await jsonMedia.createAttempt()).reference();
assert.equal(mediaRequestIds.request.parse(mediaReference.requestId).ok, true);
assert.equal(mediaReference.computerId, "workspace");

const { parseReceivePack, refusalReport } =
  await import("@fungi.computer/agar/git-wire");
const command = `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status\n`;
const parsedPush = parseReceivePack(
  new TextEncoder().encode(
    (command.length + 4).toString(16).padStart(4, "0") + command + "0000",
  ),
);
assert.equal(parsedPush.kind, "ok");
assert.deepEqual(parsedPush.updates, [
  { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
]);
assert.match(
  new TextDecoder().decode(
    refusalReport(
      {
        allowed: false,
        refused: [{ ref: "refs/heads/main", message: "open a Change" }],
      },
      parsedPush.updates,
      parsedPush.capabilities,
    ),
  ),
  /ng refs\/heads\/main open a Change/,
);

const { nativeGitCodecs, nativeGitFrameMethods, nativeGitMethodNameSchema } =
  await import("@fungi.computer/agar/git-rpc");
const nativeExchange = nativeGitFrameMethods.exchange.decodeArgs([
  "notes",
  {
    service: "receive-pack",
    phase: "exchange",
    body: new Uint8Array([0, 255]),
    headers: {},
  },
]);
assert.deepEqual(nativeExchange[1].body, new Uint8Array([0, 255]));
assert.deepEqual(
  nativeGitFrameMethods.exchange.requiredOperations(nativeExchange),
  ["exchange", "write"],
);
assert.deepEqual(
  nativeGitCodecs.exchange.result.parse({
    status: 200,
    headers: {},
    body: new Uint8Array([255, 0]),
  }).body,
  new Uint8Array([255, 0]),
);
assert.equal(nativeGitMethodNameSchema.safeParse("forged").success, false);

// The packed read-copy entry is portable and reads a saved App row without Git.
const { DatabaseSync } = await import("node:sqlite");
const { createReadCopies, countingGit } =
  await import("@fungi.computer/agar/read-copy");
const copyDatabase = new DatabaseSync(":memory:");
const copySql = {
  exec(query, ...args) {
    const rows = copyDatabase
      .prepare(query)
      .all(
        ...args.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        ),
      );
    return { toArray: () => rows };
  },
};
const screenCopies = createReadCopies(copySql, {
  version: 1,
  maxRows: 10,
  maxValueBytes: 1000,
  maxBlobBytes: 1000,
  maxBlobTotalBytes: 2000,
});
const screenDocument = screenCopies.open("documents", z.string());
screenDocument.write("draft", "a".repeat(40), "ready");
assert.deepEqual(screenDocument.read("draft"), {
  kind: "ready",
  head: "a".repeat(40),
  value: "ready",
});
const rejectCopyOperation = () =>
  Promise.reject(new Error("Unexpected provider operation"));
const countedCopyGit = countingGit(
  {
    create: rejectCopyOperation,
    fork: rejectCopyOperation,
    cloneUrl: rejectCopyOperation,
    info: rejectCopyOperation,
    delete: rejectCopyOperation,
    log: rejectCopyOperation,
    readCommit: rejectCopyOperation,
    readTree: rejectCopyOperation,
    refs: rejectCopyOperation,
    exchange: rejectCopyOperation,
    readBlob: () => Promise.resolve(new Uint8Array([7])),
  },
  { limit: 40, signal: new globalThis.AbortController().signal },
);
assert.deepEqual(
  await countedCopyGit.git.readBlob("workflows", "a".repeat(40)),
  new Uint8Array([7]),
);
assert.equal(countedCopyGit.total(), 1);
copyDatabase.close();

const steps = await import("@fungi.computer/agar/git-steps");
const stepBase = steps.memoryGitStepMaterial();
const materialKeys = [];
const stepMaterial = {
  ...stepBase,
  async put(key, seq, bytes) {
    await stepBase.put(key, seq, bytes);
    materialKeys.push(key);
  },
};
const checkpoint = await steps.begin(
  {
    kind: "commit",
    requestKey: "packed-write",
    timestamp: 1000,
    request: {
      repository: "project",
      branch: "main",
      expectedHead: null,
      changes: [
        { path: "draft.txt", content: new TextEncoder().encode("saved") },
      ],
      message: "Save",
      author: { name: "Stranger", email: "stranger@app.local" },
    },
  },
  stepMaterial,
);
assert.equal(checkpoint.phase, "inspect-base");
assert.equal(JSON.stringify(checkpoint).includes("saved"), false);
const closedStep = new globalThis.AbortController();
closedStep.abort();
assert.deepEqual(
  await steps.runStep(
    checkpoint,
    {
      material: stepMaterial,
      git: {
        exchange: () => Promise.reject(new Error("Aborted step performed I/O")),
      },
    },
    closedStep.signal,
  ),
  { yield: true },
);
assert.equal(
  steps.gitStepSchema.safeParse({ ...checkpoint, grants: [] }).success,
  false,
);
await steps.dropMaterial(checkpoint, stepMaterial);
for (const key of materialKeys)
  await assert.rejects(stepMaterial.read(key), (error) => {
    assert.ok(error instanceof steps.GitStepMaterialError);
    assert.equal(error.code, "unavailable");
    return true;
  });
