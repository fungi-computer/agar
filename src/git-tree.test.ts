import { expectTypeOf, test } from "vitest";
import type { GitTreeEntry } from "./git.js";

test("Git object type is separate from executable and symlink file modes", () => {
  expectTypeOf<GitTreeEntry["type"]>().toEqualTypeOf<
    "blob" | "tree" | "commit"
  >();
  const executable: GitTreeEntry = {
    name: "run.sh",
    mode: "100755",
    hash: "a".repeat(40),
    type: "blob",
  };
  const symlink: GitTreeEntry = {
    name: "latest",
    mode: "120000",
    hash: "b".repeat(40),
    type: "blob",
  };
  const submodule: GitTreeEntry = {
    name: "module",
    mode: "160000",
    hash: "c".repeat(40),
    type: "commit",
  };
  expectTypeOf([executable, symlink, submodule]).toEqualTypeOf<
    GitTreeEntry[]
  >();
});
