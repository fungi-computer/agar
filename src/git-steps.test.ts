import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { realGit } from "../test/git-http.fixture.js";
import { commitFiles, type GitCommitStore } from "./git-commit.js";
import {
  begin,
  runStep,
  gitStepSchema,
  memoryGitStepMaterial,
  sqliteGitStepMaterial,
  dropMaterial,
  type GitStepMaterial,
  type GitStep,
  type GitStepOperation,
  type GitStepOutcome,
} from "./git-steps.js";

const author = { name: "Steps", email: "steps@app.local" };
const changes = (text: string) => [
  { path: "draft.json", content: new TextEncoder().encode(text) },
];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function trackedMaterial(base: GitStepMaterial = memoryGitStepMaterial()) {
  const keys: string[] = [];
  const material: GitStepMaterial = {
    ...base,
    async put(key, seq, bytes) {
      await base.put(key, seq, bytes);
      keys.push(key);
    },
  };
  return { material, keys };
}
function lastKey(keys: readonly string[]): string {
  const key = keys.at(-1);
  if (key === undefined) throw new Error("No retained material");
  return key;
}
async function pendingCommit(
  server: ReturnType<typeof realGit>,
  material: GitStepMaterial,
  head: string,
  requestKey: string,
  content: string,
) {
  let step = await begin(
    {
      kind: "commit",
      requestKey,
      timestamp: 1000,
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes(content),
        message: content,
        author,
      },
    },
    material,
  );
  const signal = new AbortController().signal;
  while (step.phase !== "push") {
    const before = server.exchanges.length;
    const reply = await runStep(step, { git: server.store, material }, signal);
    expect(server.exchanges.length - before).toBeLessThanOrEqual(1);
    if (!("next" in reply)) throw new Error("Build failed");
    step = reply.next;
  }
  return step;
}
async function seed(server: ReturnType<typeof realGit>) {
  server.repository("steps");
  const result = await commitFiles(server.store, {
    repository: "steps",
    branch: "main",
    expectedHead: null,
    changes: changes("before"),
    message: "Seed",
    author,
  });
  if (result.kind !== "committed") throw new Error("Seed failed");
  return result.commit;
}
async function drive(
  server: ReturnType<typeof realGit>,
  op: GitStepOperation,
  store: GitCommitStore = server.store,
): Promise<{ result: GitStepOutcome; phases: string[] }> {
  const path = join(server.root, "material.sqlite");
  let db = new DatabaseSync(path);
  let material = sqliteGitStepMaterial(fromNodeSqlite(db).sql);
  let step = await begin(op, material);
  const phases: string[] = [];
  for (let turn = 0; turn < 20; turn += 1) {
    // A cold facet keeps only JSON checkpoint plus SQLite rows, never the MemoryFs.
    db.close();
    db = new DatabaseSync(path);
    material = sqliteGitStepMaterial(fromNodeSqlite(db).sql);
    step = gitStepSchema.parse(JSON.parse(JSON.stringify(step)));
    const before = server.exchanges.length;
    phases.push(step.phase);
    const reply = await runStep(
      step,
      { git: store, material },
      new AbortController().signal,
    );
    const calls = server.exchanges.slice(before);
    expect(calls.length).toBeLessThanOrEqual(1);
    if (step.phase === "fetch-base" || step.phase === "push")
      expect(calls.every(({ phase }) => phase === "exchange")).toBe(true);
    if ("done" in reply) {
      await dropMaterial(step, material);
      db.close();
      return { result: reply.done, phases };
    }
    if ("yield" in reply) throw new Error("Unexpected yield");
    step = reply.next;
  }
  db.close();
  throw new Error("Step did not finish");
}
it("keeps one replay step within one actual Git exchange and survives loss of every memory session", async () => {
  const server = realGit();
  const head = await seed(server);
  server.exchanges.length = 0;
  const { result, phases } = await drive(server, {
    kind: "commit",
    requestKey: "save-one",
    request: {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("after"),
      message: "Save",
      author,
    },
  });
  expect(result.kind).toBe("committed");
  expect(phases).toEqual(["inspect-base", "fetch-base", "push", "confirm"]);
  expect(
    server.exchanges.map(({ service, phase }) => [service, phase]),
  ).toEqual([
    ["upload-pack", "advertise"],
    ["upload-pack", "exchange"],
    ["receive-pack", "exchange"],
    ["upload-pack", "advertise"],
  ]);
  expect(server.run("--git-dir=steps.git", "show", "main:draft.json")).toBe(
    "after",
  );
});
it("fixes the timestamp and rebuilds the same commit for an exact checkpoint replay", async () => {
  const server = realGit();
  const head = await seed(server);
  const { material, keys } = trackedMaterial();
  const step = await begin(
    {
      kind: "commit",
      requestKey: "deterministic",
      timestamp: 1000,
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("after"),
        message: "Save",
        author,
      },
    },
    material,
  );
  const checked = await runStep(
    step,
    { git: server.store, material },
    new AbortController().signal,
  );
  if (!("next" in checked)) throw new Error("Missing fetch checkpoint");
  const fetch = checked.next;
  const first = await runStep(
    fetch,
    { git: server.store, material },
    new AbortController().signal,
  );
  const second = await runStep(
    gitStepSchema.parse(JSON.parse(JSON.stringify(fetch))),
    { git: server.store, material },
    new AbortController().signal,
  );
  expect(first).toEqual(second);
  if (!("next" in first) || first.next.phase !== "push")
    throw new Error("No built pack");
  expect((await material.read(lastKey(keys))).length).toBeGreaterThan(0);
});
it("yields before exchange when a frame has already closed and refuses extra checkpoint keys", async () => {
  const material = memoryGitStepMaterial();
  const step = await begin(
    {
      kind: "commit",
      requestKey: "closed",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: null,
        changes: changes("after"),
        message: "Save",
        author,
      },
    },
    material,
  );
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  expect(
    await runStep(
      step,
      {
        material,
        git: {
          exchange: () => {
            calls += 1;
            throw new Error("No transport");
          },
        },
      },
      abort.signal,
    ),
  ).toEqual({ yield: true });
  expect(calls).toBe(0);
  expect(
    gitStepSchema.safeParse({ ...step, authority: "not a checkpoint field" })
      .success,
  ).toBe(false);
});
it("SQLite material keeps each row within one MiB and refuses conflicting replay bytes", async () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const material = sqliteGitStepMaterial(fromNodeSqlite(db).sql);
  const prefix = 'git:["commit","row-test"]:';
  const key = `${prefix}pack`;
  const row = new Uint8Array(1024 * 1024);
  row[0] = 7;
  await material.put(key, 0, row);
  await material.put(key, 1, new Uint8Array([8]));
  expect((await material.read(key)).length).toBe(1024 * 1024 + 1);
  expect(
    db.prepare("SELECT max(length(bytes)) AS size FROM git_step_material").get()
      ?.size,
  ).toBe(1024 * 1024);
  await material.put(key, 0, row);
  await expect(material.put(key, 0, new Uint8Array([9]))).rejects.toThrow(
    "conflict",
  );
  await expect(
    material.put("too-large", 0, new Uint8Array(1024 * 1024 + 1)),
  ).rejects.toThrow(RangeError);
  await material.drop(prefix);
  await expect(material.read(key)).rejects.toThrow("unavailable");
});

it("resolves an accepted push whose response was lost without making a second commit", async () => {
  const server = realGit();
  const head = await seed(server);
  let lost = false;
  const store: GitCommitStore = {
    async exchange(repo, request) {
      const response = await server.store.exchange(repo, request);
      if (
        !lost &&
        request.service === "receive-pack" &&
        request.phase === "exchange"
      ) {
        lost = true;
        throw new Error("Lost response after provider accepted");
      }
      return response;
    },
  };
  server.exchanges.length = 0;
  const reply = await drive(
    server,
    {
      kind: "commit",
      requestKey: "lost-response",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("after"),
        message: "Save",
        author,
      },
    },
    store,
  );
  expect(reply.result.kind).toBe("committed");
  expect(reply.phases).toEqual([
    "inspect-base",
    "fetch-base",
    "push",
    "confirm",
  ]);
  expect(server.run("--git-dir=steps.git", "rev-list", "--count", "main")).toBe(
    "2",
  );
  expect(
    server.exchanges.filter((request) => request.service === "receive-pack"),
  ).toHaveLength(1);
});
it("retains the concurrent writer when the ref moves between build and push", async () => {
  const server = realGit();
  const head = await seed(server);
  server.raceOnNextPush("steps", "main");
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "commit",
    requestKey: "cas-race",
    request: {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("after"),
      message: "Save",
      author,
    },
  });
  expect(reply.result).toEqual({
    kind: "stale",
    head: server.run("--git-dir=steps.git", "rev-parse", "main"),
  });
  expect(server.run("--git-dir=steps.git", "show", "main:draft.json")).toBe(
    "before",
  );
});
it("refuses a stale base before any receive-pack", async () => {
  const server = realGit();
  const head = await seed(server);
  const moved = await commitFiles(server.store, {
    repository: "steps",
    branch: "main",
    expectedHead: head,
    changes: changes("other writer"),
    message: "Other",
    author,
  });
  if (moved.kind !== "committed") throw new Error("Concurrent write failed");
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "commit",
    requestKey: "stale-base",
    request: {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("after"),
      message: "Save",
      author,
    },
  });
  expect(reply.result).toEqual({ kind: "stale", head: moved.commit });
  expect(
    server.exchanges.filter(
      ({ service, phase }) =>
        service === "receive-pack" && phase === "exchange",
    ),
  ).toHaveLength(0);
});
it("bounds input material before any push without putting file bytes in a checkpoint", async () => {
  const material = memoryGitStepMaterial();
  let calls = 0;
  const step = await begin(
    {
      kind: "commit",
      requestKey: "oversize",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: null,
        changes: [
          { path: "large.bin", content: new Uint8Array(8 * 1024 * 1024) },
        ],
        message: "Large",
        author,
      },
    },
    material,
  );
  expect(JSON.stringify(step).length).toBeLessThan(1024);
  expect(
    await runStep(
      step,
      {
        material,
        git: {
          exchange: () => {
            calls += 1;
            throw new Error("Must not push");
          },
        },
      },
      new AbortController().signal,
    ),
  ).toEqual({ done: { kind: "too_large" } });
  expect(calls).toBe(0);
});
it("an abort during material read cannot send the prepared push", async () => {
  const server = realGit();
  const head = await seed(server);
  const material = memoryGitStepMaterial();
  const first = await begin(
    {
      kind: "commit",
      requestKey: "close-during-read",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("after"),
        message: "Save",
        author,
      },
    },
    material,
  );
  const inspected = await runStep(
    first,
    { git: server.store, material },
    new AbortController().signal,
  );
  if (!("next" in inspected)) throw new Error("Missing fetch checkpoint");
  const built = await runStep(
    inspected.next,
    { git: server.store, material },
    new AbortController().signal,
  );
  if (!("next" in built) || built.next.phase !== "push")
    throw new Error("Missing push checkpoint");
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const abort = new AbortController();
  const held = {
    ...material,
    async read(key: string) {
      entered.resolve(undefined);
      await release.promise;
      return material.read(key);
    },
  };
  server.exchanges.length = 0;
  const pending = runStep(
    built.next,
    { git: server.store, material: held },
    abort.signal,
  );
  await entered.promise;
  abort.abort();
  release.resolve(undefined);
  expect(await pending).toEqual({ yield: true });
  expect(server.exchanges).toHaveLength(0);
});
it("publishes a missing tag for an unchanged saved tree without another commit", async () => {
  const server = realGit();
  const head = await seed(server);
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "commit",
    requestKey: "publish-unchanged",
    tags: [{ ref: "refs/tags/v1", expected: null }],
    request: {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("before"),
      message: "Publish",
      author,
    },
  });
  expect(reply.result).toEqual({ kind: "committed", commit: head });
  expect(reply.phases.at(-1)).toBe("confirm");
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
  expect(server.run("--git-dir=steps.git", "rev-parse", "refs/tags/v1")).toBe(
    head,
  );
  expect(server.run("--git-dir=steps.git", "rev-list", "--count", "main")).toBe(
    "1",
  );
  expect(
    server.exchanges.filter(
      ({ service, phase }) =>
        service === "receive-pack" && phase === "exchange",
    ),
  ).toHaveLength(1);
});

it("publishes main and tag in one atomic push after cold material reconstruction", async () => {
  const server = realGit();
  const head = await seed(server);
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "commit",
    requestKey: "publish",
    tags: [{ ref: "refs/tags/v1", expected: null }],
    request: {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("published"),
      message: "Publish",
      author,
    },
  });
  if (reply.result.kind !== "committed") throw new Error("Publish failed");
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(
    reply.result.commit,
  );
  expect(server.run("--git-dir=steps.git", "rev-parse", "refs/tags/v1")).toBe(
    reply.result.commit,
  );
  expect(
    server.exchanges.filter(
      ({ service, phase }) =>
        service === "receive-pack" && phase === "exchange",
    ),
  ).toHaveLength(1);
});

it("restores cross-repository merge material after every facet turn and keeps both parents", async () => {
  const server = realGit();
  const head = await seed(server);
  server.repository("fork");
  server.run(
    "--git-dir=fork.git",
    "fetch",
    "-q",
    join(server.root, "steps.git"),
    "main:main",
  );
  const source = await commitFiles(server.store, {
    repository: "fork",
    branch: "main",
    expectedHead: head,
    changes: [
      { path: "source.txt", content: new TextEncoder().encode("source") },
    ],
    message: "Source",
    author,
  });
  const target = await commitFiles(server.store, {
    repository: "steps",
    branch: "main",
    expectedHead: head,
    changes: [
      { path: "target.txt", content: new TextEncoder().encode("target") },
    ],
    message: "Target",
    author,
  });
  if (source.kind !== "committed" || target.kind !== "committed")
    throw new Error("Setup failed");
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "merge",
    requestKey: "cold-merge",
    request: {
      target: "steps",
      source: "fork",
      branch: "main",
      sourceBranch: "main",
      expectedSource: source.commit,
      message: "Merge",
      author,
    },
  });
  if (reply.result.kind !== "merged") throw new Error("Merge failed");
  expect(
    server
      .run("--git-dir=steps.git", "rev-list", "--parents", "-n", "1", "main")
      .split(" "),
  ).toEqual([reply.result.after, target.commit, source.commit]);
  expect(reply.phases).toEqual([
    "inspect-source",
    "fetch-source",
    "inspect-target",
    "fetch-target",
    "inspect-merge-push",
    "push",
    "confirm",
  ]);
});
it("same-repository merges fetch both heads in one POST and keep every step within one exchange", async () => {
  const server = realGit();
  const head = await seed(server);
  server.run("--git-dir=steps.git", "update-ref", "refs/heads/feature", head);
  const source = await commitFiles(server.store, {
    repository: "steps",
    branch: "feature",
    expectedHead: head,
    changes: [
      { path: "feature.txt", content: new TextEncoder().encode("feature") },
    ],
    message: "Feature",
    author,
  });
  if (source.kind !== "committed") throw new Error("Setup failed");
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "merge",
    requestKey: "same-merge",
    request: {
      target: "steps",
      source: "steps",
      branch: "main",
      sourceBranch: "feature",
      expectedSource: source.commit,
      message: "Merge",
      author,
    },
  });
  expect(reply.result.kind).toBe("merged");
  expect(
    server.exchanges.filter(
      ({ service, phase }) => service === "upload-pack" && phase === "exchange",
    ),
  ).toHaveLength(1);
  expect(reply.phases).toEqual([
    "inspect-source",
    "fetch-source",
    "inspect-merge-push",
    "push",
    "confirm",
  ]);
});
it("an occupied tag refuses the whole atomic publish without moving main", async () => {
  const server = realGit();
  const head = await seed(server);
  server.run("--git-dir=steps.git", "update-ref", "refs/tags/v1", head);
  server.exchanges.length = 0;
  const reply = await drive(server, {
    kind: "commit",
    requestKey: "atomic-conflict",
    tags: [{ ref: "refs/tags/v1", expected: null }],
    request: {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("published"),
      message: "Publish",
      author,
    },
  });
  expect(reply.result.kind).toBe("stale");
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
  expect(server.run("--git-dir=steps.git", "rev-parse", "refs/tags/v1")).toBe(
    head,
  );
});

it("retries an atomic publish when its tag already names the built commit", async () => {
  const server = realGit();
  const head = await seed(server);
  const { material, keys } = trackedMaterial();
  let step = await begin(
    {
      kind: "commit",
      requestKey: "tag-retry",
      tags: [{ ref: "refs/tags/v1", expected: null }],
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("published"),
        message: "Publish",
        author,
      },
    },
    material,
  );
  const signal = new AbortController().signal;
  while (step.phase !== "push") {
    const reply = await runStep(step, { git: server.store, material }, signal);
    if (!("next" in reply)) throw new Error("Build failed");
    step = reply.next;
  }
  const built = step.built;
  execFileSync("git", ["--git-dir=steps.git", "index-pack", "--stdin"], {
    cwd: server.root,
    input: await material.read(lastKey(keys)),
  });
  server.run("--git-dir=steps.git", "update-ref", "refs/tags/v1", built);
  for (let turn = 0; turn < 8; turn += 1) {
    const before = server.exchanges.length;
    const reply = await runStep(step, { git: server.store, material }, signal);
    expect(server.exchanges.length - before).toBeLessThanOrEqual(1);
    if ("done" in reply) {
      expect(reply.done.kind).toBe("committed");
      expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(
        built,
      );
      expect(
        server.run("--git-dir=steps.git", "rev-parse", "refs/tags/v1"),
      ).toBe(built);
      return;
    }
    if (!("next" in reply)) throw new Error("Unexpected yield");
    step = reply.next;
  }
  throw new Error("Publish did not finish");
});

it("material refuses a seventeenth row rather than retaining an unreadable checkpoint", async () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const stores = [
    memoryGitStepMaterial(),
    sqliteGitStepMaterial(fromNodeSqlite(db).sql),
  ];
  for (const material of stores) {
    await expect(
      material.put("over-limit", 16, new Uint8Array([1])),
    ).rejects.toThrow(RangeError);
  }
});

it("an accepted POST checkpoints a fresh ref confirmation before terminal settlement", async () => {
  const server = realGit();
  const head = await seed(server);
  const material = memoryGitStepMaterial();
  let step = await begin(
    {
      kind: "commit",
      requestKey: "accepted-confirm",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("confirmed"),
        message: "Save",
        author,
      },
    },
    material,
  );
  const signal = new AbortController().signal;
  while (step.phase !== "push") {
    const reply = await runStep(step, { git: server.store, material }, signal);
    if (!("next" in reply)) throw new Error("Build failed");
    step = reply.next;
  }
  const before = server.exchanges.length;
  const pushed = await runStep(step, { git: server.store, material }, signal);
  expect(server.exchanges.length - before).toBe(1);
  expect(pushed).toMatchObject({ next: { phase: "confirm" } });
  if (!("next" in pushed))
    throw new Error("Accepted push settled without ref confirmation");
  const confirmed = await runStep(
    gitStepSchema.parse(JSON.parse(JSON.stringify(pushed.next))),
    { git: server.store, material },
    signal,
  );
  expect(confirmed).toEqual({
    done: { kind: "committed", commit: step.built },
  });
  expect(server.exchanges.at(-1)?.phase).toBe("advertise");
});

it("a failed fetch rejects the foreground driver without repeating the failed POST", async () => {
  const server = realGit();
  const head = await seed(server);
  let posts = 0;
  const store: GitCommitStore = {
    exchange(repo, request) {
      if (request.service === "upload-pack" && request.phase === "exchange") {
        posts += 1;
        if (posts > 1) throw new Error("Repeated failed fetch");
        return Promise.resolve({
          status: 500,
          headers: {},
          body: new Uint8Array(),
        });
      }
      return server.store.exchange(repo, request);
    },
  };
  await expect(
    commitFiles(store, {
      repository: "steps",
      branch: "main",
      expectedHead: head,
      changes: changes("failed"),
      message: "Save",
      author,
    }),
  ).rejects.toThrow("Git fetch unavailable");
  expect(posts).toBe(1);
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
});

it("startFrom never replaces the parent of an existing branch", async () => {
  const server = realGit();
  const head = await seed(server);
  const feature = await commitFiles(server.store, {
    repository: "steps",
    branch: "feature",
    expectedHead: null,
    startFrom: "main",
    changes: [
      { path: "feature.txt", content: new TextEncoder().encode("retained") },
    ],
    message: "Feature",
    author,
  });
  if (feature.kind !== "committed") throw new Error("Setup failed");
  const before = server.exchanges.length;
  await expect(
    commitFiles(server.store, {
      repository: "steps",
      branch: "feature",
      expectedHead: feature.commit,
      startFrom: "main",
      changes: changes("invalid"),
      message: "Invalid",
      author,
    }),
  ).rejects.toThrow("startFrom");
  expect(server.exchanges.length).toBe(before);
  expect(server.run("--git-dir=steps.git", "rev-parse", "feature")).toBe(
    feature.commit,
  );
  const saved = await commitFiles(server.store, {
    repository: "steps",
    branch: "feature",
    expectedHead: feature.commit,
    changes: changes("saved"),
    message: "Save",
    author,
  });
  expect(saved.kind).toBe("committed");
  expect(server.run("--git-dir=steps.git", "rev-parse", "feature^")).toBe(
    feature.commit,
  );
  expect(server.run("--git-dir=steps.git", "show", "feature:feature.txt")).toBe(
    "retained",
  );
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
});

it.each([false, true])(
  "confirms a landed write superseded by a later writer (tagged:%s)",
  async (tagged) => {
    const server = realGit();
    const head = await seed(server);
    server.run("--git-dir=steps.git", "config", "user.name", "Other");
    server.run(
      "--git-dir=steps.git",
      "config",
      "user.email",
      "other@app.local",
    );
    let built = "";
    let later = "";
    let lost = false;
    const store: GitCommitStore = {
      async exchange(repo, request) {
        const response = await server.store.exchange(repo, request);
        if (
          request.service === "receive-pack" &&
          request.phase === "exchange" &&
          !lost
        ) {
          lost = true;
          built = server.run("--git-dir=steps.git", "rev-parse", "main");
          const tree = server.run(
            "--git-dir=steps.git",
            "rev-parse",
            "main^{tree}",
          );
          later = server.run(
            "--git-dir=steps.git",
            "commit-tree",
            tree,
            "-p",
            built,
            "-m",
            "Other",
          );
          server.run(
            "--git-dir=steps.git",
            "update-ref",
            "refs/heads/main",
            later,
          );
          throw new Error("Lost accepted response");
        }
        return response;
      },
    };
    const reply = await drive(
      server,
      {
        kind: "commit",
        requestKey: "superseded",
        tags: tagged ? [{ ref: "refs/tags/v1", expected: null }] : [],
        request: {
          repository: "steps",
          branch: "main",
          expectedHead: head,
          changes: changes("mine"),
          message: "Mine",
          author,
        },
      },
      store,
    );
    expect(reply.result).toEqual({ kind: "committed", commit: built });
    expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(later);
    expect(
      server.run(
        "--git-dir=steps.git",
        "merge-base",
        "--is-ancestor",
        built,
        "main",
      ),
    ).toBe("");
    expect(
      server.exchanges.filter(
        ({ service, phase }) =>
          service === "receive-pack" && phase === "exchange",
      ),
    ).toHaveLength(2); // seed + exactly one uncertain push
    if (tagged)
      expect(
        server.run("--git-dir=steps.git", "rev-parse", "refs/tags/v1"),
      ).toBe(built);
  },
);

it("replays a fetched source after the server changes pack compression", async () => {
  const server = realGit();
  const head = await seed(server);
  server.repository("fork");
  server.run(
    "--git-dir=fork.git",
    "fetch",
    "-q",
    join(server.root, "steps.git"),
    "main:main",
  );
  const source = await commitFiles(server.store, {
    repository: "fork",
    branch: "main",
    expectedHead: head,
    changes: [
      {
        path: "source.txt",
        content: new TextEncoder().encode("source".repeat(2048)),
      },
    ],
    message: "Source",
    author,
  });
  if (source.kind !== "committed") throw new Error("Setup failed");
  const { material, keys } = trackedMaterial();
  const initial = await begin(
    {
      kind: "merge",
      requestKey: "repacked-source",
      request: {
        source: "fork",
        target: "steps",
        sourceBranch: "main",
        branch: "main",
        expectedSource: source.commit,
        message: "Merge",
        author,
      },
    },
    material,
  );
  const signal = new AbortController().signal;
  const inspected = await runStep(
    initial,
    { git: server.store, material },
    signal,
  );
  if (!("next" in inspected)) throw new Error("Inspection failed");
  const first = await runStep(
    inspected.next,
    { git: server.store, material },
    signal,
  );
  if (!("next" in first) || first.next.phase !== "inspect-target")
    throw new Error("Fetch failed");
  const firstBytes = await material.read(lastKey(keys));
  // The first checkpoint was not committed by the owner. Re-fetch the SAME OIDs.
  server.run("--git-dir=fork.git", "config", "core.compression", "0");
  const second = await runStep(
    inspected.next,
    { git: server.store, material },
    signal,
  );
  if (!("next" in second) || second.next.phase !== "inspect-target")
    throw new Error("Replay failed");
  expect(await material.read(lastKey(keys))).not.toEqual(firstBytes);
  let step: GitStep = second.next;
  for (let turn = 0; turn < 12; turn += 1) {
    const before = server.exchanges.length;
    const reply = await runStep(step, { git: server.store, material }, signal);
    expect(server.exchanges.length - before).toBeLessThanOrEqual(1);
    if ("done" in reply) {
      expect(reply.done.kind).toBe("merged");
      expect(server.run("--git-dir=steps.git", "show", "main:source.txt")).toBe(
        "source".repeat(2048),
      );
      return;
    }
    if (!("next" in reply)) throw new Error("Unexpected yield");
    step = reply.next;
  }
  throw new Error("Merge did not settle");
});

it("refuses a checkpoint's substituted material address before provider I/O", async () => {
  const server = realGit();
  const head = await seed(server);
  const { material } = trackedMaterial();
  let step = await begin(
    {
      kind: "commit",
      requestKey: "original-owner",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("mine"),
        message: "Mine",
        author,
      },
    },
    material,
  );
  if (step.operation.kind !== "commit") throw new Error("Unexpected operation");
  expect(
    gitStepSchema.safeParse({
      ...step,
      operation: { ...step.operation, changesKey: "other:changes" },
    }).success,
  ).toBe(false);
  const signal = new AbortController().signal;
  while (step.phase !== "push") {
    const reply = await runStep(step, { git: server.store, material }, signal);
    if (!("next" in reply)) throw new Error("Build failed");
    step = reply.next;
  }
  expect(
    gitStepSchema.safeParse({ ...step, packKey: "anything-at-all" }).success,
  ).toBe(false);
  server.exchanges.length = 0;
  await expect(
    runStep(
      gitStepSchema.parse({ ...step, key: "other-owner" }),
      { git: server.store, material },
      signal,
    ),
  ).rejects.toThrow("unavailable");
  expect(server.exchanges).toHaveLength(0);
});
it("refuses substituted changes bytes before building or pushing a different commit", async () => {
  const server = realGit();
  const head = await seed(server);
  const tracked = trackedMaterial();
  const initial = await begin(
    {
      kind: "commit",
      requestKey: "integrity",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("mine"),
        message: "Mine",
        author,
      },
    },
    tracked.material,
  );
  const inputKey = lastKey(tracked.keys);
  const tampered: GitStepMaterial = {
    ...tracked.material,
    read(key) {
      return key === inputKey
        ? Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify([
                {
                  path: "draft.json",
                  content: Buffer.from("substituted").toString("base64"),
                },
              ]),
            ),
          )
        : tracked.material.read(key);
    },
  };
  const signal = new AbortController().signal;
  const inspected = await runStep(
    initial,
    { git: server.store, material: tampered },
    signal,
  );
  if (!("next" in inspected)) throw new Error("Inspection failed");
  server.exchanges.length = 0;
  await expect(
    runStep(inspected.next, { git: server.store, material: tampered }, signal),
  ).rejects.toThrow("Git material digest mismatch");
  expect(
    server.exchanges.filter(
      ({ service, phase }) =>
        service === "receive-pack" && phase === "exchange",
    ),
  ).toHaveLength(0);
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
});

it("terminal owner cleanup drops orphaned packs without deleting another operation or request", async () => {
  const server = realGit();
  const head = await seed(server);
  server.repository("fork");
  server.run(
    "--git-dir=fork.git",
    "fetch",
    "-q",
    join(server.root, "steps.git"),
    "main:main",
  );
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const tracked = trackedMaterial(
    sqliteGitStepMaterial(fromNodeSqlite(db).sql),
  );
  const material = tracked.material;
  const signal = new AbortController().signal;
  const initial = await begin(
    {
      kind: "commit",
      requestKey: "shared-id",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("mine"),
        message: "Mine",
        author,
      },
    },
    material,
  );
  const inspected = await runStep(
    initial,
    { git: server.store, material },
    signal,
  );
  if (!("next" in inspected)) throw new Error("Inspection failed");
  const prepared = await runStep(
    inspected.next,
    { git: server.store, material },
    signal,
  );
  if (!("next" in prepared) || prepared.next.phase !== "push")
    throw new Error("Build failed");
  // Pack is durable, but its successor checkpoint never committed.
  const merge = await begin(
    {
      kind: "merge",
      requestKey: "shared-id",
      request: {
        target: "steps",
        source: "fork",
        branch: "main",
        sourceBranch: "main",
        expectedSource: head,
        message: "Merge",
        author,
      },
    },
    material,
  );
  const mergeInspection = await runStep(
    merge,
    { git: server.store, material },
    signal,
  );
  if (!("next" in mergeInspection)) throw new Error("Merge inspection failed");
  const mergeFetched = await runStep(
    mergeInspection.next,
    { git: server.store, material },
    signal,
  );
  if (!("next" in mergeFetched)) throw new Error("Merge fetch failed");
  const mergeKey = lastKey(tracked.keys);
  await begin(
    {
      kind: "commit",
      requestKey: "shared-id:neighbor",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("neighbor"),
        message: "Neighbor",
        author,
      },
    },
    material,
  );
  const neighborKey = lastKey(tracked.keys);
  const moved = await commitFiles(server.store, {
    repository: "steps",
    branch: "main",
    expectedHead: head,
    changes: changes("other writer"),
    message: "Other",
    author,
  });
  if (moved.kind !== "committed") throw new Error("Concurrent writer failed");
  expect(
    await runStep(initial, { git: server.store, material }, signal),
  ).toEqual({ done: { kind: "stale", head: moved.commit } });
  await dropMaterial(initial, material);
  expect(
    db.prepare("SELECT count(*) AS n FROM git_step_material").get()?.n,
  ).toBe(2);
  expect((await material.read(mergeKey)).length).toBeGreaterThan(0);
  expect((await material.read(neighborKey)).length).toBeGreaterThan(0);
  server.exchanges.length = 0;
  await expect(
    runStep(prepared.next, { git: server.store, material }, signal),
  ).rejects.toThrow("unavailable");
  expect(server.exchanges).toHaveLength(0);
  await runStep(mergeFetched.next, { git: server.store, material }, signal);
  expect(server.exchanges).toHaveLength(1);
});

it("begin refuses startFrom on an existing branch before retaining material", async () => {
  const { material, keys } = trackedMaterial();
  await expect(
    begin(
      {
        kind: "commit",
        requestKey: "invalid-start",
        request: {
          repository: "steps",
          branch: "feature",
          expectedHead: "a".repeat(40),
          startFrom: "main",
          changes: changes("mine"),
          message: "Mine",
          author,
        },
      },
      material,
    ),
  ).rejects.toThrow("startFrom");
  expect(keys).toHaveLength(0);
});

it("refuses a tag publish before POST when the server does not advertise atomic", async () => {
  const server = realGit();
  const head = await seed(server);
  server.run(
    "--git-dir=steps.git",
    "config",
    "receive.advertiseAtomic",
    "false",
  );
  server.exchanges.length = 0;
  await expect(
    drive(server, {
      kind: "commit",
      requestKey: "no-atomic",
      tags: [{ ref: "refs/tags/v1", expected: null }],
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("published"),
        message: "Publish",
        author,
      },
    }),
  ).rejects.toMatchObject({
    name: "GitStepMaterialError",
    code: "atomic_unavailable",
  });
  expect(
    server.exchanges.filter(
      ({ service, phase }) =>
        service === "receive-pack" && phase === "exchange",
    ),
  ).toHaveLength(0);
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
});

it.each(["", "git:", "pack"])(
  "refuses non-owner cleanup prefix %j without deleting material",
  async (prefix) => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    for (const base of [
      memoryGitStepMaterial(),
      sqliteGitStepMaterial(fromNodeSqlite(db).sql),
    ]) {
      const { material, keys } = trackedMaterial(base);
      await begin(
        {
          kind: "commit",
          requestKey: "guarded",
          request: {
            repository: "steps",
            branch: "main",
            expectedHead: null,
            changes: [],
            message: "Save",
            author,
          },
        },
        material,
      );
      const retained = lastKey(keys);
      await expect(material.drop(prefix)).rejects.toThrow(RangeError);
      expect(await material.read(retained)).toEqual(
        new TextEncoder().encode("[]"),
      );
    }
  },
);

it("classifies missing material as a permanent failure for background owners", async () => {
  const server = realGit();
  const head = await seed(server);
  const { material } = trackedMaterial();
  let step = await begin(
    {
      kind: "commit",
      requestKey: "permanent-missing",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("mine"),
        message: "Mine",
        author,
      },
    },
    material,
  );
  const signal = new AbortController().signal;
  while (step.phase !== "push") {
    const reply = await runStep(step, { git: server.store, material }, signal);
    if (!("next" in reply)) throw new Error("Build failed");
    step = reply.next;
  }
  await dropMaterial(step, material);
  server.exchanges.length = 0;
  await expect(
    runStep(step, { git: server.store, material }, signal),
  ).rejects.toMatchObject({
    name: "GitStepMaterialError",
    code: "unavailable",
  });
  expect(server.exchanges).toHaveLength(0);
});

it.each(["pack", "source"])(
  "refuses tampered %s bytes under their correct derived SQLite address",
  async (kind) => {
    const server = realGit();
    const head = await seed(server);
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const { material, keys } = trackedMaterial(
      sqliteGitStepMaterial(fromNodeSqlite(db).sql),
    );
    const signal = new AbortController().signal;
    let step: GitStep;
    if (kind === "pack")
      step = await pendingCommit(
        server,
        material,
        head,
        "corrupt-pack",
        "mine",
      );
    else {
      server.repository("fork");
      server.run(
        "--git-dir=fork.git",
        "fetch",
        "-q",
        join(server.root, "steps.git"),
        "main:main",
      );
      step = await begin(
        {
          kind: "merge",
          requestKey: "corrupt-source",
          request: {
            target: "steps",
            source: "fork",
            branch: "main",
            sourceBranch: "main",
            expectedSource: head,
            message: "Merge",
            author,
          },
        },
        material,
      );
      for (let turn = 0; turn < 2; turn += 1) {
        const reply = await runStep(
          step,
          { git: server.store, material },
          signal,
        );
        if (!("next" in reply)) throw new Error("Fetch failed");
        step = reply.next;
      }
      expect(step.phase).toBe("inspect-target");
    }
    const key = lastKey(keys);
    const bytes = await material.read(key);
    bytes[0] ^= 1;
    db.prepare(
      "UPDATE git_step_material SET bytes=? WHERE key=? AND seq=0",
    ).run(bytes, key);
    server.exchanges.length = 0;
    await expect(
      runStep(step, { git: server.store, material }, signal),
    ).rejects.toMatchObject({
      name: "GitStepMaterialError",
      code: "digest_mismatch",
    });
    expect(server.exchanges).toHaveLength(0);
    expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
  },
);
it.each([false, true])(
  "refuses another owner's pack digest (also swap built:%s)",
  async (swapBuilt) => {
    const server = realGit();
    const head = await seed(server);
    const material = memoryGitStepMaterial();
    const a = await pendingCommit(server, material, head, "owner-a", "a");
    const b = await pendingCommit(server, material, head, "owner-b", "b");
    const swapped = { ...a, packDigest: b.packDigest };
    if (swapBuilt) swapped.built = b.built;
    const changed = gitStepSchema.parse(swapped);
    server.exchanges.length = 0;
    await expect(
      runStep(
        changed,
        { git: server.store, material },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "GitStepMaterialError",
      code: "unavailable",
    });
    expect(server.exchanges).toHaveLength(0);
  },
);
it("deletes exactly one wildcard or quoted owner in native SQLite", async () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const { material, keys } = trackedMaterial(
    sqliteGitStepMaterial(fromNodeSqlite(db).sql),
  );
  const ids = ["a", "a%", "a_", 'a"', 'a":x', "a\\", "a\u0000b", "é"];
  const entries = [];
  for (const requestKey of ids) {
    const step = await begin(
      {
        kind: "commit",
        requestKey,
        request: {
          repository: "steps",
          branch: "main",
          expectedHead: null,
          changes: [],
          message: "Save",
          author,
        },
      },
      material,
    );
    entries.push({ step, key: lastKey(keys) });
  }
  for (const [index, entry] of entries.entries()) {
    await dropMaterial(entry.step, material);
    await expect(material.read(entry.key)).rejects.toThrow("unavailable");
    for (const retained of entries.slice(index + 1))
      expect(await material.read(retained.key)).toEqual(
        new TextEncoder().encode("[]"),
      );
    expect(
      db.prepare("SELECT count(*) AS n FROM git_step_material").get()?.n,
    ).toBe(entries.length - index - 1);
  }
});
it("negative ancestry confirms that a rejected branch write never landed", async () => {
  const server = realGit();
  const head = await seed(server);
  const material = memoryGitStepMaterial();
  const step = await pendingCommit(server, material, head, "rejected", "Mine");
  server.raceOnNextPush("steps", "main");
  const signal = new AbortController().signal;
  const pushed = await runStep(step, { git: server.store, material }, signal);
  if (!("next" in pushed)) throw new Error("Missing confirmation");
  const checked = await runStep(
    pushed.next,
    { git: server.store, material },
    signal,
  );
  if (!("next" in checked) || checked.next.phase !== "confirm-ancestry")
    throw new Error("Missing ancestry checkpoint");
  const before = server.exchanges.length;
  const reply = await runStep(
    checked.next,
    { git: server.store, material },
    signal,
  );
  expect(server.exchanges.length - before).toBe(1);
  const current = server.run("--git-dir=steps.git", "rev-parse", "main");
  expect(reply).toEqual({ done: { kind: "stale", head: current } });
  expect(
    server.run("--git-dir=steps.git", "log", "--format=%s", "main"),
  ).not.toContain("Mine");
});

it("rechecks the reviewed source before retrying a refused merge push", async () => {
  const server = realGit();
  const head = await seed(server);
  const source = await commitFiles(server.store, {
    repository: "steps",
    branch: "feature",
    expectedHead: null,
    startFrom: "main",
    changes: changes("source"),
    message: "Source",
    author,
  });
  if (source.kind !== "committed") throw new Error("Setup failed");
  const hook = join(server.root, "steps.git/hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  let moved = source.commit;
  let pushes = 0;
  const store: GitCommitStore = {
    async exchange(repo, request) {
      const reply = await server.store.exchange(repo, request);
      if (request.service === "receive-pack" && request.phase === "exchange") {
        pushes += 1;
        if (pushes === 1) {
          unlinkSync(hook);
          moved = execFileSync(
            "git",
            [
              "--git-dir=steps.git",
              "commit-tree",
              server.run("--git-dir=steps.git", "rev-parse", "feature^{tree}"),
              "-p",
              source.commit,
              "-m",
              "New source",
            ],
            {
              cwd: server.root,
              encoding: "utf8",
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: author.name,
                GIT_COMMITTER_EMAIL: author.email,
              },
            },
          ).trim();
          server.run(
            "--git-dir=steps.git",
            "update-ref",
            "refs/heads/feature",
            moved,
          );
        }
      }
      return reply;
    },
  };
  const reply = await drive(
    server,
    {
      kind: "merge",
      requestKey: "retry-source",
      request: {
        target: "steps",
        source: "steps",
        branch: "main",
        sourceBranch: "feature",
        expectedSource: source.commit,
        message: "Merge",
        author,
      },
    },
    store,
  );
  expect(reply.result).toEqual({ kind: "source-moved", head: moved });
  expect(pushes).toBe(1);
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
});

it("throws after bounded permanent hook refusal instead of reporting an unchanged head as stale", async () => {
  const server = realGit();
  const head = await seed(server);
  writeFileSync(
    join(server.root, "steps.git/hooks/pre-receive"),
    "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  server.exchanges.length = 0;
  await expect(
    drive(server, {
      kind: "commit",
      requestKey: "refused-hook",
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("refused"),
        message: "Refused",
        author,
      },
    }),
  ).rejects.toMatchObject({
    name: "GitStepMaterialError",
    code: "push_refused",
  });
  expect(
    server.exchanges.filter(
      ({ service, phase }) =>
        service === "receive-pack" && phase === "exchange",
    ),
  ).toHaveLength(3);
  expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
});

it.each(["base", "unrelated"])(
  "confirms only the selected commit for an unchanged tree with an existing %s tag",
  async (existing) => {
    const server = realGit();
    const head = await seed(server);
    const tag =
      existing === "base"
        ? head
        : execFileSync(
            "git",
            [
              "--git-dir=steps.git",
              "commit-tree",
              server.run("--git-dir=steps.git", "rev-parse", "main^{tree}"),
              "-m",
              "Unrelated",
            ],
            {
              cwd: server.root,
              encoding: "utf8",
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: author.name,
                GIT_COMMITTER_EMAIL: author.email,
              },
            },
          ).trim();
    server.run("--git-dir=steps.git", "update-ref", "refs/tags/v1", tag);
    server.exchanges.length = 0;
    const reply = await drive(server, {
      kind: "commit",
      requestKey: "existing-tag",
      tags: [{ ref: "refs/tags/v1", expected: null }],
      request: {
        repository: "steps",
        branch: "main",
        expectedHead: head,
        changes: changes("before"),
        message: "Publish",
        author,
      },
    });
    expect(reply.result).toEqual(
      existing === "base"
        ? { kind: "committed", commit: head }
        : { kind: "stale", head },
    );
    expect(reply.phases.at(-1)).toBe("confirm");
    expect(server.run("--git-dir=steps.git", "rev-parse", "main")).toBe(head);
    expect(server.run("--git-dir=steps.git", "rev-parse", "refs/tags/v1")).toBe(
      tag,
    );
    expect(
      server.run("--git-dir=steps.git", "rev-list", "--count", "main"),
    ).toBe("1");
    expect(
      server.exchanges.filter(
        ({ service, phase }) =>
          service === "receive-pack" && phase === "exchange",
      ),
    ).toHaveLength(1);
  },
);
