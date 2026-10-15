import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { GitCommitStore } from "@fungi.computer/agar/git-commit";
import type { GitExchangeRequest } from "../src/git.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/** A real Git smart-HTTP server (git http-backend) behind the exchange port. */
export function realGit() {
  const root = mkdtempSync(join(tmpdir(), "agar-git-commit-"));
  roots.push(root);
  const repository = (name: string) => {
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", `${name}.git`], {
      cwd: root,
    });
    execFileSync("git", ["config", "http.receivepack", "true"], {
      cwd: join(root, `${name}.git`),
    });
  };
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  /** Runs once, just before the next receive-pack data exchange reaches the server. */
  let beforeReceive: (() => void) | null = null;
  const exchanges: (GitExchangeRequest & { repository: string })[] = [];
  const store: GitCommitStore = {
    exchange(name: string, request: GitExchangeRequest) {
      exchanges.push({ ...request, repository: name });
      if (request.service === "receive-pack" && request.phase === "exchange") {
        const hook = beforeReceive;
        beforeReceive = null;
        hook?.();
      }
      const pathInfo =
        request.phase === "advertise"
          ? `/${name}.git/info/refs`
          : `/${name}.git/git-${request.service}`;
      const result = spawnSync("git", ["http-backend"], {
        input: request.body ?? new Uint8Array(),
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: pathInfo,
          REQUEST_METHOD: request.phase === "advertise" ? "GET" : "POST",
          QUERY_STRING:
            request.phase === "advertise"
              ? `service=git-${request.service}`
              : "",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
        },
      });
      const output = new Uint8Array(result.stdout);
      const split = Buffer.from(output).indexOf("\r\n\r\n");
      const head = Buffer.from(output.subarray(0, split)).toString("utf8");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split("\r\n")) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      return Promise.resolve({
        status,
        headers,
        body: output.subarray(split + 4),
      });
    },
  };
  /** Another writer moves `branch` on, between our advertisement and our push. */
  const raceOnNextPush = (name: string, branch: string) => {
    beforeReceive = () => {
      const gitDir = `--git-dir=${name}.git`;
      // Same tree, new commit: another writer's unrelated work.
      const parent = run(gitDir, "rev-parse", branch);
      const tree = run(gitDir, "rev-parse", `${branch}^{tree}`);
      const concurrent = execFileSync(
        "git",
        [gitDir, "commit-tree", tree, "-p", parent, "-m", "Concurrent"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Other",
            GIT_AUTHOR_EMAIL: "other@app.local",
            GIT_COMMITTER_NAME: "Other",
            GIT_COMMITTER_EMAIL: "other@app.local",
          },
        },
      ).trim();
      run(gitDir, "update-ref", `refs/heads/${branch}`, concurrent);
    };
  };
  return { root, repository, run, store, raceOnNextPush, exchanges };
}
