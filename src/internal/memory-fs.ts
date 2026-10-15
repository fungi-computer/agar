/**
 * A minimal in-memory filesystem with the promise API isomorphic-git uses,
 * so a merge runs inside an App backend with no Node built-ins. One instance
 * lives for one merge.
 */

type Entry =
  | Readonly<{ kind: "file"; data: Uint8Array; mtimeMs: number }>
  | Readonly<{ kind: "dir"; mtimeMs: number }>;

/** The error shape isomorphic-git checks (`code`). */
class FsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "ENOTEMPTY" | "EISDIR",
    path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

/** File metadata in the subset of `fs.Stats` isomorphic-git reads. */
export type MemoryStats = Readonly<{
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}>;

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The `{ promises }` filesystem isomorphic-git accepts as `fs`. */
export type MemoryFs = Readonly<{
  promises: Readonly<{
    readFile(
      path: string,
      options?: { encoding?: string } | string,
    ): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<MemoryStats>;
    lstat(path: string): Promise<MemoryStats>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
    chmod(path: string): Promise<void>;
  }>;
}>;

export function memoryFs(): MemoryFs {
  const entries = new Map<string, Entry>([
    ["/", { kind: "dir", mtimeMs: Date.now() }],
  ]);
  const inodes = new Map<string, number>();
  const inode = (path: string) => {
    let value = inodes.get(path);
    if (value === undefined) {
      value = inodes.size + 1;
      inodes.set(path, value);
    }
    return value;
  };
  const stats = (path: string): MemoryStats => {
    const entry = entries.get(path);
    if (entry === undefined) throw new FsError("ENOENT", path);
    const file = entry.kind === "file";
    return {
      type: entry.kind,
      mode: file ? 0o100644 : 0o40000,
      size: file ? entry.data.length : 0,
      ino: inode(path),
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.mtimeMs,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => file,
      isDirectory: () => !file,
      isSymbolicLink: () => false,
    };
  };
  const requireDir = (path: string) => {
    const entry = entries.get(path);
    if (entry === undefined) throw new FsError("ENOENT", path);
    if (entry.kind !== "dir") throw new FsError("ENOTDIR", path);
  };
  const sync = {
    readFile: (raw: string, options?: { encoding?: string } | string) => {
      const path = normalize(raw);
      const entry = entries.get(path);
      if (entry === undefined) throw new FsError("ENOENT", path);
      if (entry.kind !== "file") throw new FsError("EISDIR", path);
      const utf8 =
        options === "utf8" ||
        (options instanceof Object && options.encoding === "utf8");
      return utf8 ? decoder.decode(entry.data) : entry.data;
    },
    writeFile: (raw: string, data: Uint8Array | string) => {
      const path = normalize(raw);
      requireDir(parentOf(path));
      entries.set(path, {
        kind: "file",
        data:
          data instanceof Uint8Array
            ? new Uint8Array(data)
            : encoder.encode(data),
        mtimeMs: Date.now(),
      });
    },
    unlink: (raw: string) => {
      const path = normalize(raw);
      if (entries.get(path)?.kind !== "file") throw new FsError("ENOENT", path);
      entries.delete(path);
    },
    readdir: (raw: string) => {
      const path = normalize(raw);
      requireDir(path);
      const prefix = path === "/" ? "/" : `${path}/`;
      return [...entries.keys()]
        .filter(
          (key) =>
            key !== path &&
            key.startsWith(prefix) &&
            !key.slice(prefix.length).includes("/"),
        )
        .map((key) => key.slice(prefix.length));
    },
    mkdir: (raw: string) => {
      const path = normalize(raw);
      if (entries.has(path)) throw new FsError("EEXIST", path);
      requireDir(parentOf(path));
      entries.set(path, { kind: "dir", mtimeMs: Date.now() });
    },
    rmdir: (raw: string) => {
      const path = normalize(raw);
      const prefix = `${path}/`;
      if ([...entries.keys()].some((key) => key.startsWith(prefix)))
        throw new FsError("ENOTEMPTY", path);
      entries.delete(path);
    },
    stat: (raw: string) => {
      return stats(normalize(raw));
    },
    lstat: (raw: string) => {
      return stats(normalize(raw));
    },
    readlink: (raw: string): string => {
      throw new FsError("ENOENT", normalize(raw));
    },
    symlink: (_target: string, raw: string): void => {
      throw new FsError("EEXIST", normalize(raw));
    },
    chmod: (): void => undefined,
  };
  const lift =
    <A extends unknown[], R>(run: (...args: A) => R) =>
    async (...args: A): Promise<R> =>
      await run(...args);
  const promises = {
    readFile: lift(sync.readFile),
    writeFile: lift(sync.writeFile),
    unlink: lift(sync.unlink),
    readdir: lift(sync.readdir),
    mkdir: lift(sync.mkdir),
    rmdir: lift(sync.rmdir),
    stat: lift(sync.stat),
    lstat: lift(sync.lstat),
    readlink: lift(sync.readlink),
    symlink: lift(sync.symlink),
    chmod: lift(sync.chmod),
  };
  return { promises };
}
