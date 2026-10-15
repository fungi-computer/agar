import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { appOpenInputSchema } from "../apps.js";
import {
  fileSaveInput,
  filesNavigateIntent,
  readFilesLocation,
} from "./files.js";

const blob = "a".repeat(40);

describe("files role open intent", () => {
  it("round-trips a repository file through a bounded apps.open intent", () => {
    const intent = filesNavigateIntent({
      repository: "pond",
      branch: "main",
      path: "docs/README.md",
    });
    expect(intent).toEqual({
      kind: "navigate",
      params: [
        { key: "repository", value: "pond" },
        { key: "branch", value: "main" },
        { key: "path", value: "docs/README.md" },
      ],
    });
    expect(
      Schema.decodeUnknownSync(appOpenInputSchema)({ role: "files", intent }),
    ).toEqual({ role: "files", intent });
    expect(readFilesLocation(intent.params)).toEqual({
      repository: "pond",
      branch: "main",
      path: "docs/README.md",
    });
  });

  it("carries a Computer file path without a repository", () => {
    const intent = filesNavigateIntent({ path: "/home/notes.md" });
    expect(readFilesLocation(intent.params)).toEqual({
      path: "/home/notes.md",
    });
  });

  it("refuses escaping repository paths and unknown parameters", () => {
    expect(() =>
      filesNavigateIntent({
        repository: "pond",
        branch: "main",
        path: "../secret",
      }),
    ).toThrow();
    expect(
      readFilesLocation([
        { key: "repository", value: "pond" },
        { key: "branch", value: "main" },
        { key: "path", value: ".git/config" },
      ]),
    ).toBeNull();
    expect(
      readFilesLocation([
        { key: "path", value: "/notes.md" },
        { key: "mode", value: "raw" },
      ]),
    ).toBeNull();
    expect(readFilesLocation([])).toBeNull();
  });
});

describe("files role edit payloads", () => {
  it("bounds saved text by the repository file byte limit", () => {
    const input = {
      repo: "pond",
      branch: "main",
      path: "README.md",
      baseBlob: blob,
      baseCommit: blob,
      revision: null,
    };
    expect(fileSaveInput.safeParse({ ...input, text: "ok" }).success).toBe(
      true,
    );
    expect(
      fileSaveInput.safeParse({ ...input, text: "x".repeat(64 * 1024 + 1) })
        .success,
    ).toBe(false);
  });
});
