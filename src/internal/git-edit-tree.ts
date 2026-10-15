import * as git from "isomorphic-git";
import type { GitFileChange } from "../git-commit.js";
import type { MemoryFs } from "./memory-fs.js";
const DIR = "/repository";
type TreeEntry = Awaited<ReturnType<typeof git.readTree>>["tree"][number];
type PathChange = GitFileChange & Readonly<{ parts: readonly string[] }>;

/** Apply changes under one tree; null means the tree became empty. */
export async function editTree(
  fs: MemoryFs,
  oid: string | null,
  changes: readonly (GitFileChange & Readonly<{ parts: readonly string[] }>)[],
): Promise<string | null> {
  if (changes.length === 0) return oid;
  const entries = new Map<string, TreeEntry>(
    oid === null
      ? []
      : (await git.readTree({ fs, dir: DIR, oid })).tree.map((entry) => [
          entry.path,
          entry,
        ]),
  );
  const nested = new Map<string, PathChange[]>();
  for (const change of changes) {
    const [name = "", ...rest] = change.parts;
    if (rest.length > 0) {
      nested.set(name, [
        ...(nested.get(name) ?? []),
        { ...change, parts: rest },
      ]);
      continue;
    }
    if (change.content === null) {
      entries.delete(name);
      continue;
    }
    const existing = entries.get(name);
    entries.set(name, {
      path: name,
      type: "blob",
      mode:
        change.mode ?? (existing?.type === "blob" ? existing.mode : "100644"),
      oid: await git.writeBlob({ fs, dir: DIR, blob: change.content }),
    });
  }
  for (const [name, children] of nested) {
    const existing = entries.get(name);
    const sub = await editTree(
      fs,
      existing?.type === "tree" ? existing.oid : null,
      children,
    );
    if (sub === null) entries.delete(name);
    else
      entries.set(name, { path: name, type: "tree", mode: "040000", oid: sub });
  }
  if (entries.size === 0) return null;
  return git.writeTree({ fs, dir: DIR, tree: [...entries.values()] });
}
