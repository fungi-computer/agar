import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitFiles,
  mergeBranch,
  moveRef,
  moveRefs,
  type GitCommitStore,
} from "./git-commit.js";
import { realGit } from "../test/git-http.fixture.js";

const encoder = new TextEncoder();
const author = { name: "Workflows", email: "workflows@app.local" };

const file = (path: string, text: string) => ({
  path,
  content: encoder.encode(text),
});

describe("commitFiles", () => {
  it("saves an existing draft with a fresh ref check and two stateless POSTs, retaining the push guard", async () => {
    const git = realGit();
    git.repository("workflows");
    const first = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("draft.json", "one")],
      message: "Seed",
      author,
    });
    if (first.kind !== "committed") throw new Error("seed failed");
    git.exchanges.length = 0;
    const saved = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: first.commit,
      changes: [file("draft.json", "two")],
      message: "Save",
      author,
    });
    expect(saved.kind).toBe("committed");
    expect(git.run("--git-dir=workflows.git", "show", "main:draft.json")).toBe(
      "two",
    );
    expect(git.exchanges.map(({ service, phase }) => [service, phase])).toEqual(
      [
        ["upload-pack", "advertise"],
        ["upload-pack", "exchange"],
        ["receive-pack", "exchange"],
        ["upload-pack", "advertise"],
      ],
    );
  });
  it("creates a branch, commits on top of the expected head, and refuses a stale one", async () => {
    const git = realGit();
    git.repository("workflows");
    const first = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("workflows/echo.json", '{"title":"Echo"}')],
      message: "Create echo",
      author,
    });
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") return;
    expect(git.run("--git-dir=workflows.git", "rev-parse", "main")).toBe(
      first.commit,
    );
    const second = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: first.commit,
      changes: [
        file("workflows/echo.json", '{"title":"Echo twice"}'),
        file("workflows/other.json", "{}"),
      ],
      message: "Edit echo",
      author,
    });
    expect(second.kind).toBe("committed");
    if (second.kind !== "committed") return;
    expect(
      git.run("--git-dir=workflows.git", "show", "main:workflows/echo.json"),
    ).toBe('{"title":"Echo twice"}');
    expect(git.run("--git-dir=workflows.git", "rev-parse", "main~1")).toBe(
      first.commit,
    );
    // A writer still on the first head is told the branch moved; nothing is written.
    await expect(
      commitFiles(git.store, {
        repository: "workflows",
        branch: "main",
        expectedHead: first.commit,
        changes: [file("workflows/echo.json", "{}")],
        message: "Stale edit",
        author,
      }),
    ).resolves.toEqual({ kind: "stale", head: second.commit });
    expect(git.run("--git-dir=workflows.git", "rev-parse", "main")).toBe(
      second.commit,
    );
    // Creating a branch that exists is stale too.
    await expect(
      commitFiles(git.store, {
        repository: "workflows",
        branch: "main",
        expectedHead: null,
        changes: [file("x.json", "{}")],
        message: "Create again",
        author,
      }),
    ).resolves.toEqual({ kind: "stale", head: second.commit });
  });

  it("starts a new branch from another, deletes files, and reports an unchanged tree", async () => {
    const git = realGit();
    git.repository("workflows");
    const main = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("a.json", "1"), file("b.json", "2")],
      message: "Seed",
      author,
    });
    if (main.kind !== "committed") throw new Error("seed failed");
    const draft = await commitFiles(git.store, {
      repository: "workflows",
      branch: "drafts/a",
      expectedHead: null,
      startFrom: "main",
      changes: [{ path: "b.json", content: null }, file("a.json", "3")],
      message: "Draft",
      author,
    });
    if (draft.kind !== "committed") throw new Error("draft failed");
    expect(git.run("--git-dir=workflows.git", "rev-parse", "drafts/a~1")).toBe(
      main.commit,
    );
    expect(
      git.run("--git-dir=workflows.git", "ls-tree", "--name-only", "drafts/a"),
    ).toBe("a.json");
    await expect(
      commitFiles(git.store, {
        repository: "workflows",
        branch: "drafts/a",
        expectedHead: draft.commit,
        changes: [file("a.json", "3")],
        message: "No-op",
        author,
      }),
    ).resolves.toEqual({ kind: "unchanged", commit: draft.commit });
  });
});

describe("moveRef", () => {
  it("guards every ordered ref, keeps an accepted prefix and stops at a stale ref", async () => {
    const git = realGit();
    git.repository("workflows");
    const main = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("a.json", "one")],
      message: "Seed",
      author,
    });
    if (main.kind !== "committed") throw new Error("seed failed");
    const draft = await commitFiles(git.store, {
      repository: "workflows",
      branch: "drafts/a",
      expectedHead: null,
      startFrom: "main",
      changes: [file("a.json", "two")],
      message: "Draft",
      author,
    });
    if (draft.kind !== "committed") throw new Error("draft failed");
    git.run(
      "--git-dir=workflows.git",
      "update-ref",
      "refs/tags/a@v1",
      main.commit,
    );
    await expect(
      moveRefs(git.store, {
        repository: "workflows",
        source: "drafts/a",
        commit: draft.commit,
        updates: [
          { ref: "refs/heads/main", expected: main.commit },
          { ref: "refs/tags/a@v1", expected: null },
          { ref: "refs/tags/a@v2", expected: null },
        ],
      }),
    ).resolves.toEqual({
      kind: "stale",
      ref: "refs/tags/a@v1",
      head: main.commit,
    });
    expect(git.run("--git-dir=workflows.git", "rev-parse", "main")).toBe(
      draft.commit,
    );
    expect(
      git.run("--git-dir=workflows.git", "rev-parse", "refs/tags/a@v1"),
    ).toBe(main.commit);
    expect(
      git.run(
        "--git-dir=workflows.git",
        "for-each-ref",
        "--format=%(objectname)",
        "refs/tags/a@v2",
      ),
    ).toBe("");
    git.exchanges.length = 0;
    await expect(
      moveRefs(git.store, {
        repository: "workflows",
        source: "drafts/a",
        commit: draft.commit,
        updates: [
          { ref: "refs/heads/main", expected: main.commit },
          { ref: "refs/tags/a@v2", expected: null },
        ],
      }),
    ).resolves.toEqual({
      kind: "stale",
      ref: "refs/heads/main",
      head: draft.commit,
    });
    expect(
      git.exchanges.filter(({ service }) => service === "receive-pack"),
    ).toHaveLength(0);
  });

  it("refuses to move any ref when the fetched source is not the selected commit", async () => {
    const git = realGit();
    git.repository("workflows");
    const main = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("a.json", "one")],
      message: "Seed",
      author,
    });
    if (main.kind !== "committed") throw new Error("seed failed");
    git.exchanges.length = 0;
    await expect(
      moveRefs(git.store, {
        repository: "workflows",
        source: "main",
        commit: "a".repeat(40),
        updates: [{ ref: "refs/tags/a@v1", expected: null }],
      }),
    ).rejects.toThrow("Commit is not the head of its source branch");
    expect(
      git.exchanges.filter(({ service }) => service === "receive-pack"),
    ).toHaveLength(0);
    expect(
      git.run(
        "--git-dir=workflows.git",
        "for-each-ref",
        "--format=%(objectname)",
        "refs/tags/a@v1",
      ),
    ).toBe("");
  });
  it("moves a publication's main and version refs with six smart-HTTP exchanges", async () => {
    const git = realGit();
    git.repository("workflows");
    const main = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("a.json", "one")],
      message: "Seed",
      author,
    });
    if (main.kind !== "committed") throw new Error("seed failed");
    const draft = await commitFiles(git.store, {
      repository: "workflows",
      branch: "drafts/a",
      expectedHead: null,
      startFrom: "main",
      changes: [file("a.json", "two")],
      message: "Draft",
      author,
    });
    if (draft.kind !== "committed") throw new Error("draft failed");
    git.exchanges.length = 0;
    await expect(
      moveRefs(git.store, {
        repository: "workflows",
        source: "drafts/a",
        commit: draft.commit,
        updates: [
          { ref: "refs/heads/main", expected: main.commit },
          { ref: "refs/tags/a@v1", expected: null },
        ],
      }),
    ).resolves.toEqual({ kind: "updated" });
    expect(git.run("--git-dir=workflows.git", "rev-parse", "main")).toBe(
      draft.commit,
    );
    expect(
      git.run("--git-dir=workflows.git", "rev-parse", "refs/tags/a@v1"),
    ).toBe(draft.commit);
    expect(git.exchanges.map(({ service, phase }) => [service, phase])).toEqual(
      [
        ["upload-pack", "advertise"],
        ["upload-pack", "exchange"],
        ["receive-pack", "advertise"],
        ["receive-pack", "exchange"],
        ["receive-pack", "advertise"],
        ["receive-pack", "exchange"],
      ],
    );
  });
  it("fast-forwards or creates a ref to an existing commit, compare-and-swap", async () => {
    const git = realGit();
    git.repository("workflows");
    const main = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("a.json", "1")],
      message: "Seed",
      author,
    });
    if (main.kind !== "committed") throw new Error("seed failed");
    const draft = await commitFiles(git.store, {
      repository: "workflows",
      branch: "drafts/a",
      expectedHead: null,
      startFrom: "main",
      changes: [file("a.json", "2")],
      message: "Draft",
      author,
    });
    if (draft.kind !== "committed") throw new Error("draft failed");
    await expect(
      moveRef(git.store, {
        repository: "workflows",
        ref: "refs/heads/main",
        expected: main.commit,
        commit: draft.commit,
        source: "drafts/a",
      }),
    ).resolves.toEqual({ kind: "updated" });
    expect(git.run("--git-dir=workflows.git", "rev-parse", "main")).toBe(
      draft.commit,
    );
    await expect(
      moveRef(git.store, {
        repository: "workflows",
        ref: "refs/tags/a@v1",
        expected: null,
        commit: draft.commit,
        source: "drafts/a",
      }),
    ).resolves.toEqual({ kind: "updated" });
    expect(git.run("--git-dir=workflows.git", "rev-parse", "a@v1")).toBe(
      draft.commit,
    );
    await expect(
      moveRef(git.store, {
        repository: "workflows",
        ref: "refs/heads/main",
        expected: main.commit,
        commit: draft.commit,
        source: "drafts/a",
      }),
    ).resolves.toEqual({ kind: "stale", head: draft.commit });
  });
});

describe("a push that loses a race after its advertisement", () => {
  it("reports the branch stale with its fresh head and writes nothing", async () => {
    const git = realGit();
    git.repository("workflows");
    const first = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: null,
      changes: [file("a.json", "1")],
      message: "Seed",
      author,
    });
    if (first.kind !== "committed") throw new Error("seed failed");
    git.raceOnNextPush("workflows", "main");
    const raced = await commitFiles(git.store, {
      repository: "workflows",
      branch: "main",
      expectedHead: first.commit,
      changes: [file("a.json", "2")],
      message: "Edit",
      author,
    });
    const head = git.run("--git-dir=workflows.git", "rev-parse", "main");
    expect(head).not.toBe(first.commit);
    expect(raced).toEqual({ kind: "stale", head });
    expect(
      git.run("--git-dir=workflows.git", "log", "-1", "--format=%s", "main"),
    ).toBe("Concurrent");

    git.raceOnNextPush("workflows", "main");
    const draft = await commitFiles(git.store, {
      repository: "workflows",
      branch: "drafts/a",
      expectedHead: null,
      startFrom: "main",
      changes: [file("a.json", "3")],
      message: "Draft",
      author,
    });
    // The race above was on main; this push targets drafts/a and succeeds.
    expect(draft.kind).toBe("committed");
    if (draft.kind !== "committed") return;
    git.raceOnNextPush("workflows", "main");
    const moved = await moveRef(git.store, {
      repository: "workflows",
      ref: "refs/heads/main",
      expected: git.run("--git-dir=workflows.git", "rev-parse", "main"),
      commit: draft.commit,
      source: "drafts/a",
    });
    expect(moved).toEqual({
      kind: "stale",
      head: git.run("--git-dir=workflows.git", "rev-parse", "main"),
    });
  });
});

describe("file modes", () => {
  it("keeps executable and symlink entries, and an edited file's mode", async () => {
    const git = realGit();
    git.repository("tools");
    const gitDir = "--git-dir=tools.git";
    const blob = (text: string) =>
      execFileSync("git", [gitDir, "hash-object", "-w", "--stdin"], {
        cwd: git.root,
        input: text,
        encoding: "utf8",
      }).trim();
    const tree = execFileSync("git", [gitDir, "mktree"], {
      cwd: git.root,
      encoding: "utf8",
      input: [
        `100755 blob ${blob("#!/bin/sh\necho hi\n")}\trun.sh`,
        `120000 blob ${blob("run.sh")}\tlatest`,
        `100644 blob ${blob("1")}\ta.json`,
      ].join("\n"),
    }).trim();
    const seed = execFileSync(
      "git",
      [gitDir, "commit-tree", tree, "-m", "Seed"],
      {
        cwd: git.root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Seed",
          GIT_AUTHOR_EMAIL: "seed@app.local",
          GIT_COMMITTER_NAME: "Seed",
          GIT_COMMITTER_EMAIL: "seed@app.local",
        },
      },
    ).trim();
    git.run(gitDir, "update-ref", "refs/heads/main", seed);
    const modes = () =>
      git.run(gitDir, "ls-tree", "main").replace(/ [0-9a-f]{40}/gu, "");
    const unrelated = await commitFiles(git.store, {
      repository: "tools",
      branch: "main",
      expectedHead: seed,
      changes: [file("a.json", "2"), file("nested/new.json", "{}")],
      message: "Edit data",
      author,
    });
    if (unrelated.kind !== "committed") throw new Error("commit failed");
    expect(modes()).toBe(
      [
        "100644 blob\ta.json",
        "120000 blob\tlatest",
        "040000 tree\tnested",
        "100755 blob\trun.sh",
      ].join("\n"),
    );
    const edited = await commitFiles(git.store, {
      repository: "tools",
      branch: "main",
      expectedHead: unrelated.commit,
      changes: [file("run.sh", "#!/bin/sh\necho bye\n")],
      message: "Edit script",
      author,
    });
    if (edited.kind !== "committed") throw new Error("commit failed");
    expect(git.run(gitDir, "ls-tree", "main", "run.sh").split(" ")[0]).toBe(
      "100755",
    );
    expect(git.run(gitDir, "show", "main:latest")).toBe("run.sh");
    const executable = await commitFiles(git.store, {
      repository: "tools",
      branch: "main",
      expectedHead: edited.commit,
      changes: [{ ...file("build.sh", "#!/bin/sh\n"), mode: "100755" }],
      message: "Add build",
      author,
    });
    if (executable.kind !== "committed") throw new Error("commit failed");
    expect(git.run(gitDir, "ls-tree", "main", "build.sh").split(" ")[0]).toBe(
      "100755",
    );
  });
});
async function mergeFixture() {
  const git = realGit();
  git.repository("canonical");
  git.repository("fork");
  const seed = await commitFiles(git.store, {
    repository: "canonical",
    branch: "main",
    expectedHead: null,
    changes: [file("base.txt", "base\n")],
    message: "Base",
    author,
  });
  if (seed.kind !== "committed") throw new Error("seed failed");
  git.run(
    "--git-dir=fork.git",
    "fetch",
    "-q",
    join(git.root, "canonical.git"),
    "main:main",
  );
  const work = await commitFiles(git.store, {
    repository: "fork",
    branch: "main",
    expectedHead: seed.commit,
    changes: [file("work.txt", "reviewed\n")],
    message: "Reviewed",
    author,
  });
  if (work.kind !== "committed") throw new Error("work failed");
  const request = {
    target: "canonical",
    source: "fork",
    branch: "main",
    sourceBranch: "main",
    expectedSource: work.commit,
    message: "Merge reviewed work",
    author,
  };
  return { git, seed, work, request };
}

describe("mergeBranch", () => {
  it("merges a source containing the copied target with fresh source and target checks", async () => {
    const { git, seed, work, request: baseRequest } = await mergeFixture();
    const request = {
      ...baseRequest,
      expectedTarget: seed.commit,
      behind: 0,
      message: "Merge reviewed work",
      author,
    };
    git.exchanges.length = 0;
    const merged = await mergeBranch(git.store, request);
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") throw new Error("merge failed");
    expect(
      git
        .run(
          "--git-dir=canonical.git",
          "rev-list",
          "--parents",
          "-n",
          "1",
          "main",
        )
        .split(" "),
    ).toEqual([merged.after, seed.commit, work.commit]);
    expect(
      git.exchanges.map(({ repository, service, phase }) => [
        repository,
        service,
        phase,
      ]),
    ).toEqual([
      ["fork", "upload-pack", "advertise"],
      ["fork", "upload-pack", "exchange"],
      ["canonical", "upload-pack", "advertise"],
      ["fork", "upload-pack", "advertise"],
      ["canonical", "receive-pack", "exchange"],
      ["canonical", "upload-pack", "advertise"],
    ]);
  });

  it("serializes divergent fetches into steps and retains both parents", async () => {
    const { git, seed, work, request } = await mergeFixture();
    const target = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: seed.commit,
      changes: [file("target.txt", "target\n")],
      message: "Target",
      author,
    });
    if (target.kind !== "committed") throw new Error("work failed");
    let active = 0;
    let peak = 0;
    const store: GitCommitStore = {
      async exchange(repository, request) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await git.store.exchange(repository, request);
        } finally {
          active -= 1;
        }
      },
    };
    git.exchanges.length = 0;
    const merged = await mergeBranch(store, request);
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") throw new Error("merge failed");
    expect(
      git
        .run(
          "--git-dir=canonical.git",
          "rev-list",
          "--parents",
          "-n",
          "1",
          "main",
        )
        .split(" "),
    ).toEqual([merged.after, target.commit, work.commit]);
    expect(git.exchanges).toHaveLength(7);
    expect(peak).toBe(1);
  });

  it("checks complete ancestry when a truncated copy incorrectly says behind zero", async () => {
    const { git, seed, work, request } = await mergeFixture();
    const target = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: seed.commit,
      changes: [file("target.txt", "target\n")],
      message: "Target",
      author,
    });
    if (target.kind !== "committed") throw new Error("target failed");
    git.exchanges.length = 0;
    const merged = await mergeBranch(git.store, {
      ...request,
      expectedTarget: target.commit,
      behind: 0,
    });
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") throw new Error("merge failed");
    expect(
      git
        .run(
          "--git-dir=canonical.git",
          "rev-list",
          "--parents",
          "-n",
          "1",
          "main",
        )
        .split(" "),
    ).toEqual([merged.after, target.commit, work.commit]);
    expect(git.exchanges).toHaveLength(7);
  });

  it.each(["before advertisement", "after advertisement"])(
    "refuses a moved copied target %s",
    async (phase) => {
      const { git, seed, request } = await mergeFixture();
      if (phase === "before advertisement") {
        const changed = await commitFiles(git.store, {
          repository: "canonical",
          branch: "main",
          expectedHead: seed.commit,
          changes: [file("concurrent.txt", "concurrent\n")],
          message: "Concurrent",
          author,
        });
        if (changed.kind !== "committed")
          throw new Error("concurrent write failed");
      } else {
        git.raceOnNextPush("canonical", "main");
      }
      git.exchanges.length = 0;
      const merged = await mergeBranch(git.store, {
        ...request,
        expectedTarget: seed.commit,
        behind: 0,
      });
      const current = git.run("--git-dir=canonical.git", "rev-parse", "main");
      expect(merged).toEqual({ kind: "stale", head: current });
      expect(current).not.toBe(seed.commit);
      expect(git.exchanges).toHaveLength(
        phase === "before advertisement" ? 3 : 7,
      );
      expect(
        git.exchanges.filter(
          ({ service, phase }) =>
            service === "receive-pack" && phase === "exchange",
        ),
      ).toHaveLength(phase === "before advertisement" ? 0 : 1);
      // The caller can retry without retaining the stale copy's optimization.
      expect((await mergeBranch(git.store, request)).kind).toBe("merged");
    },
  );

  it("refuses a source that moved even when a source-only fetch was requested", async () => {
    const { git, seed, work, request } = await mergeFixture();
    const changed = await commitFiles(git.store, {
      repository: "fork",
      branch: "main",
      expectedHead: work.commit,
      changes: [file("unreviewed.txt", "unreviewed\n")],
      message: "Unreviewed",
      author,
    });
    if (changed.kind !== "committed")
      throw new Error("unreviewed write failed");
    git.exchanges.length = 0;
    expect(
      await mergeBranch(git.store, {
        ...request,
        expectedTarget: seed.commit,
        behind: 0,
      }),
    ).toEqual({ kind: "source-moved", head: changed.commit });
    expect(git.exchanges).toHaveLength(1);
    expect(git.run("--git-dir=canonical.git", "rev-parse", "main")).toBe(
      seed.commit,
    );
  });

  it("rechecks a copied no-op against the current target before returning up-to-date", async () => {
    const { git, work, request } = await mergeFixture();
    git.run(
      "--git-dir=canonical.git",
      "fetch",
      "-q",
      join(git.root, "fork.git"),
      "+main:main",
    );
    const changed = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: work.commit,
      changes: [file("later.txt", "later\n")],
      message: "Later",
      author,
    });
    if (changed.kind !== "committed") throw new Error("target write failed");
    git.exchanges.length = 0;
    expect(
      await mergeBranch(git.store, {
        ...request,
        expectedTarget: work.commit,
        behind: 0,
      }),
    ).toEqual({ kind: "up-to-date", head: changed.commit });
    expect(git.exchanges).toHaveLength(4);
    expect(
      git.exchanges.every(({ service }) => service === "upload-pack"),
    ).toBe(true);
  });

  it("refuses source work pushed after the target fetch without writing the target", async () => {
    const git = realGit();
    git.repository("canonical");
    git.repository("fork");
    const seed = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: null,
      changes: [file("a.txt", "one\n")],
      message: "Start",
      author,
    });
    if (seed.kind !== "committed") throw new Error("seed failed");
    git.run(
      "--git-dir=fork.git",
      "fetch",
      "-q",
      join(git.root, "canonical.git"),
      "main:main",
    );
    const reviewed = await commitFiles(git.store, {
      repository: "fork",
      branch: "main",
      expectedHead: seed.commit,
      changes: [file("reviewed.txt", "approved\n")],
      message: "Reviewed work",
      author,
    });
    if (reviewed.kind !== "committed") throw new Error("reviewed work failed");
    let moved: string | null = null;
    const racingStore: GitCommitStore = {
      async exchange(repository, request) {
        // The real source push occurs after the target pack read. The step
        // engine must recheck the reviewed source before its receive-pack.
        const response = await git.store.exchange(repository, request);
        if (
          moved === null &&
          repository === "canonical" &&
          request.service === "upload-pack" &&
          request.phase === "exchange"
        ) {
          const pushed = await commitFiles(git.store, {
            repository: "fork",
            branch: "main",
            expectedHead: reviewed.commit,
            changes: [file("unreviewed.txt", "not approved\n")],
            message: "Unreviewed concurrent push",
            author,
          });
          if (pushed.kind !== "committed")
            throw new Error("source push failed");
          moved = pushed.commit;
        }
        return response;
      },
    };
    const request = {
      target: "canonical",
      source: "fork",
      branch: "main",
      sourceBranch: "main",
      expectedSource: reviewed.commit,
      message: "Merge reviewed work",
      author,
    };
    expect(await mergeBranch(racingStore, request)).toEqual({
      kind: "source-moved",
      head: moved,
    });
    expect(moved).not.toBeNull();
    expect(git.run("--git-dir=fork.git", "rev-parse", "main")).toBe(moved);
    expect(git.run("--git-dir=canonical.git", "rev-parse", "main")).toBe(
      seed.commit,
    );
  });

  it("merges a fork with a merge commit and reports a conflict on the same lines", async () => {
    const git = realGit();
    git.repository("canonical");
    git.repository("fork");
    const seed = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: null,
      changes: [file("a.txt", "one\n"), file("b.txt", "two\n")],
      message: "Start",
      author,
    });
    if (seed.kind !== "committed") throw new Error("seed failed");
    git.run(
      "--git-dir",
      "fork.git",
      "fetch",
      "-q",
      join(git.root, "canonical.git"),
      "main:main",
    );
    const forkWork = await commitFiles(git.store, {
      repository: "fork",
      branch: "main",
      expectedHead: seed.commit,
      changes: [file("c.txt", "fork\n")],
      message: "Fork work",
      author,
    });
    const mainWork = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: seed.commit,
      changes: [file("b.txt", "main\n")],
      message: "Main work",
      author,
    });
    if (forkWork.kind !== "committed" || mainWork.kind !== "committed")
      throw new Error("work failed");
    const request = {
      target: "canonical",
      source: "fork",
      branch: "main",
      sourceBranch: "main",
      expectedSource: forkWork.commit,
      message: "Merge fork",
      author,
    };
    const merged = await mergeBranch(git.store, request);
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") return;
    expect(merged.before).toBe(mainWork.commit);
    expect(
      git
        .run(
          "--git-dir",
          "canonical.git",
          "rev-list",
          "--parents",
          "-n",
          "1",
          "main",
        )
        .split(" "),
    ).toEqual([merged.after, mainWork.commit, forkWork.commit]);
    expect(await mergeBranch(git.store, request)).toEqual({
      kind: "up-to-date",
      head: merged.after,
    });

    const clash = await commitFiles(git.store, {
      repository: "fork",
      branch: "main",
      expectedHead: forkWork.commit,
      changes: [file("b.txt", "fork edit\n")],
      message: "Fork edits b",
      author,
    });
    const mainClash = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: merged.after,
      changes: [file("b.txt", "main edit\n")],
      message: "Main edits b",
      author,
    });
    if (clash.kind !== "committed" || mainClash.kind !== "committed")
      throw new Error("clash setup failed");
    expect(
      await mergeBranch(git.store, {
        ...request,
        expectedSource: clash.commit,
      }),
    ).toEqual({
      kind: "conflict",
      head: mainClash.commit,
      paths: ["b.txt"],
    });
  });
});

describe("mergeBranch keeps modes and reports a lost race as stale", () => {
  it("merges without dropping executables or symlinks, and refuses a moved target", async () => {
    const git = realGit();
    git.repository("canonical");
    git.repository("fork");
    const gitDir = "--git-dir=canonical.git";
    const blob = (text: string) =>
      execFileSync("git", [gitDir, "hash-object", "-w", "--stdin"], {
        cwd: git.root,
        input: text,
        encoding: "utf8",
      }).trim();
    const tree = execFileSync("git", [gitDir, "mktree"], {
      cwd: git.root,
      encoding: "utf8",
      input: [
        `100755 blob ${blob("#!/bin/sh\n")}\trun.sh`,
        `120000 blob ${blob("run.sh")}\tlatest`,
      ].join("\n"),
    }).trim();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Seed",
      GIT_AUTHOR_EMAIL: "seed@app.local",
      GIT_COMMITTER_NAME: "Seed",
      GIT_COMMITTER_EMAIL: "seed@app.local",
    };
    const seed = execFileSync(
      "git",
      [gitDir, "commit-tree", tree, "-m", "Seed"],
      {
        cwd: git.root,
        encoding: "utf8",
        env,
      },
    ).trim();
    git.run(gitDir, "update-ref", "refs/heads/main", seed);
    git.run(
      "--git-dir",
      "fork.git",
      "fetch",
      "-q",
      join(git.root, "canonical.git"),
      "main:main",
    );
    const forkWork = await commitFiles(git.store, {
      repository: "fork",
      branch: "main",
      expectedHead: seed,
      changes: [file("c.txt", "fork\n")],
      message: "Fork work",
      author,
    });
    const mainWork = await commitFiles(git.store, {
      repository: "canonical",
      branch: "main",
      expectedHead: seed,
      changes: [file("d.txt", "main\n")],
      message: "Main work",
      author,
    });
    if (forkWork.kind !== "committed" || mainWork.kind !== "committed")
      throw new Error("setup failed");
    const request = {
      target: "canonical",
      source: "fork",
      branch: "main",
      sourceBranch: "main",
      expectedSource: forkWork.commit,
      message: "Merge fork",
      author,
    };
    git.raceOnNextPush("canonical", "main");
    const raced = await mergeBranch(git.store, request);
    expect(raced).toEqual({
      kind: "stale",
      head: git.run(gitDir, "rev-parse", "main"),
    });
    const merged = await mergeBranch(git.store, request);
    expect(merged.kind).toBe("merged");
    expect(
      git.run(gitDir, "ls-tree", "main").replace(/ [0-9a-f]{40}/gu, ""),
    ).toBe(
      [
        "100644 blob\tc.txt",
        "100644 blob\td.txt",
        "120000 blob\tlatest",
        "100755 blob\trun.sh",
      ].join("\n"),
    );
  });
});
