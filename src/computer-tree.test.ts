import { describe, expect, it } from "vitest";
import type { ComputerListing } from "./computer.js";
import {
  entryPath,
  isHiddenEntry,
  mergeListing,
  revealParents,
  type ComputerTreeModel,
} from "./computer-tree.js";

function entry(name: string, type: "file" | "directory" | "symlink" = "file") {
  return { name, type, size: 0, modifiedAt: 0 };
}

/** A model that is not any tree library's, to prove the module needs none. */
function model(initial: readonly string[] = []) {
  const held = new Set(initial);
  const batches: string[][] = [];
  const tree: ComputerTreeModel = {
    remove: () => undefined,
    resetPaths: () => undefined,
    batch(operations) {
      batches.push(operations.map((operation) => operation.path));
      for (const operation of operations) {
        if (held.has(operation.path)) throw new Error("duplicate row");
        held.add(operation.path);
      }
    },
    getItem: (path) => (held.has(path) ? { path } : null),
  };
  return { tree, held, batches };
}

describe("computer tree model", () => {
  it("spells directories with a trailing slash", () => {
    expect(entryPath("/", "src", "directory")).toBe("/src/");
    expect(entryPath("/src/", "a.ts", "file")).toBe("/src/a.ts");
    expect(entryPath("/src", "a.ts", "file")).toBe("/src/a.ts");
  });

  it("hides dot-entries and keeps named ones", () => {
    expect(isHiddenEntry(entry(".git", "directory"))).toBe(true);
    expect(isHiddenEntry(entry("Characters", "directory"))).toBe(false);
  });

  it("merges a listing once, skipping symlinks and rows the model holds", () => {
    const { tree, batches } = model(["/notes.md"]);
    const known = new Set<string>();
    const first: ComputerListing = {
      path: "/",
      entries: [
        entry("src", "directory"),
        entry("notes.md"),
        entry("link", "symlink"),
      ],
      nextOffset: 3,
    };
    expect(mergeListing(tree, first, known)).toEqual(["/src/"]);
    expect(mergeListing(tree, first, known)).toEqual([]);
    expect(batches).toEqual([["/src/"]]);
  });

  it("names the directories to list so a path is visible under the root", () => {
    expect(revealParents("/lib/Characters/Mira/a.png", "/lib")).toEqual([
      "/lib",
      "/lib/Characters",
      "/lib/Characters/Mira",
    ]);
    expect(revealParents("/elsewhere/a.png", "/lib")).toEqual([]);
    expect(revealParents("/a/b.png", "/")).toEqual(["/", "/a"]);
  });
});
