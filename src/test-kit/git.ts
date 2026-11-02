import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { GitBinding, GitCommit, GitRepositoryInfo } from "../git.js";

/** Real smart HTTP writes and git plumbing reads in one disposable bare repository. */
export function realGit() {
  const root = mkdtempSync(join(tmpdir(), "agar-real-git-"));
  const run = (name: string, ...args: string[]) =>
    execFileSync("git", [`--git-dir=${join(root, `${name}.git`)}`, ...args], {
      encoding: "utf8",
    }).trim();
  const info = (name: string): GitRepositoryInfo | null =>
    existsSync(join(root, `${name}.git`))
      ? { name, defaultBranch: "main", lastPushAt: null, source: null }
      : null;
  const gitOutput = (name: string, ...args: string[]) =>
    execFileSync("git", [`--git-dir=${join(root, `${name}.git`)}`, ...args], {
      encoding: "utf8",
      // A thousand-commit log page is over execFileSync's 1 MiB default.
      maxBuffer: 256 * 1024 * 1024,
    });
  // A full object id names an immutable commit, so one read serves every
  // later ask; refs and abbreviations move and are never cached.
  const commits = new Map<string, GitCommit>();
  const immutable = (hash: string) => /^[0-9a-f]{40,64}$/u.test(hash);
  const cacheKey = (name: string, hash: string) => {
    // The repository's directory identity keeps a deleted-and-recreated name
    // from serving the old repository's commits, however it was removed.
    const dir = statSync(join(root, `${name}.git`), {
      bigint: true,
      throwIfNoEntry: false,
    });
    return `${name}\0${String(dir?.ino)}\0${String(dir?.birthtimeNs)}\0${hash}`;
  };
  const remember = (name: string, commit: GitCommit) => {
    commits.set(cacheKey(name, commit.hash), structuredClone(commit));
  };
  const readCommit = (name: string, hash: string): GitCommit | null => {
    const cached = immutable(hash)
      ? commits.get(cacheKey(name, hash))
      : undefined;
    if (cached !== undefined) return structuredClone(cached);
    const found = spawnSync(
      "git",
      [`--git-dir=${join(root, `${name}.git`)}`, "cat-file", "-t", hash],
      { encoding: "utf8" },
    );
    if (found.status !== 0 || found.stdout.trim() !== "commit") return null;
    const commit = parseCommits(
      gitOutput(name, "show", "-s", "-z", `--format=${COMMIT_FORMAT}`, hash),
    ).at(0);
    if (!commit) throw new Error("Commit unreadable");
    if (immutable(hash)) remember(name, commit);
    return commit;
  };
  const git: GitBinding = {
    cloneUrl: (name) => {
      if (info(name) === null)
        return Promise.reject(new Error("Repository unavailable"));
      return Promise.resolve(pathToFileURL(join(root, `${name}.git`)).href);
    },
    info: (name) => Promise.resolve(info(name)),
    create: (name, options) => {
      if (!info(name)) {
        execFileSync(
          "git",
          [
            "init",
            "--bare",
            "-q",
            "-b",
            options?.defaultBranch ?? "main",
            `${name}.git`,
          ],
          { cwd: root },
        );
        run(name, "config", "http.receivepack", "true");
      }
      const created = info(name);
      if (!created) throw new Error("Repository creation failed");
      return Promise.resolve(created);
    },
    fork: () => Promise.reject(new Error("Unexpected fork")),
    delete: (name) => {
      const existed = info(name) !== null;
      rmSync(join(root, `${name}.git`), { recursive: true, force: true });
      return Promise.resolve(existed);
    },
    readCommit: (name, hash) => Promise.resolve(readCommit(name, hash)),
    log: (name, { ref, limit = 50, offset = 0 }) => {
      if (!readCommit(name, ref)) return Promise.resolve([]);
      // One walk with the same rev-list flags reads every page commit.
      const page = parseCommits(
        gitOutput(
          name,
          "log",
          "-z",
          `--format=${COMMIT_FORMAT}`,
          "--first-parent",
          `--max-count=${String(limit)}`,
          `--skip=${String(offset)}`,
          ref,
        ),
      );
      for (const commit of page) remember(name, commit);
      return Promise.resolve(page);
    },
    readTree: (name, hash) =>
      Promise.resolve(
        run(name, "ls-tree", "-z", hash)
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [head, entryName] = z
              .tuple([z.string(), z.string()])
              .parse(line.split("\t"));
            const [mode, type, oid] = z
              .tuple([
                z.string(),
                z.enum(["tree", "blob", "commit"]),
                z.string(),
              ])
              .parse(head.split(" "));
            return { name: entryName, mode, type, hash: oid };
          }),
      ),
    readBlob: (name, hash) =>
      Promise.resolve(
        new Uint8Array(
          execFileSync("git", [
            `--git-dir=${join(root, `${name}.git`)}`,
            "cat-file",
            "blob",
            hash,
          ]),
        ),
      ),
    refs: (name) =>
      Promise.resolve(
        info(name)
          ? run(name, "for-each-ref", "--format=%(refname) %(objectname)")
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [ref, hash] = z
                  .tuple([z.string(), z.string()])
                  .parse(line.split(" "));
                return { name: ref, hash };
              })
          : [],
      ),
    exchange: (name, request) => {
      const result = spawnSync("git", ["http-backend"], {
        input: request.body ?? new Uint8Array(),
        // A whole App source pack is far over spawnSync's 1 MiB default.
        maxBuffer: 256 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO:
            request.phase === "advertise"
              ? `/${name}.git/info/refs`
              : `/${name}.git/git-${request.service}`,
          REQUEST_METHOD: request.phase === "advertise" ? "GET" : "POST",
          QUERY_STRING:
            request.phase === "advertise"
              ? `service=git-${request.service}`
              : "",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        },
      });
      if (result.status !== 0) throw new Error("git http-backend failed");
      const output = Buffer.from(result.stdout);
      const split = output.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of output
        .subarray(0, split)
        .toString("utf8")
        .split("\r\n")) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      return Promise.resolve({
        status,
        headers,
        body: new Uint8Array(result.stdout.subarray(split + 4)),
      });
    },
  };
  return {
    git,
    run,
    close: () => {
      rmSync(root, { recursive: true });
    },
  };
}

// Ten NUL-separated fields per commit; `-z` ends each commit with NUL too.
const COMMIT_FORMAT =
  "%H%x00%T%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%at%x00%ct%x00%B";
const COMMIT_FIELDS = 10;
const commitFields = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

function parseCommits(output: string): GitCommit[] {
  const fields = output.split("\0");
  // The final commit's NUL terminator leaves one empty trailing field.
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % COMMIT_FIELDS !== 0)
    throw new Error("Unexpected git commit format");
  const parsed: GitCommit[] = [];
  for (let start = 0; start < fields.length; start += COMMIT_FIELDS) {
    const [
      oid,
      treeHash,
      parents,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      authoredAt,
      committedAt,
      message,
    ] = commitFields.parse(fields.slice(start, start + COMMIT_FIELDS));
    parsed.push({
      hash: oid,
      treeHash,
      parents: parents ? parents.split(" ") : [],
      author: { name: authorName, email: authorEmail },
      committer: { name: committerName, email: committerEmail },
      authoredAt: Number(authoredAt),
      committedAt: Number(committedAt),
      // %B keeps the raw message's trailing newline; readers see it trimmed.
      message: message.trimEnd(),
    });
  }
  return parsed;
}
