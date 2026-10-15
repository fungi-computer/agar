import { expect, it } from "vitest";
import * as git from "./git.js";

it("compares parsed repository identity by namespace and value, not object identity", () => {
  const installation: git.RepositoryRef = {
    kind: "installation",
    installationId: "bonsai-a",
    repository: "project",
  };
  expect(git.repositoryRefsEqual(installation, { ...installation })).toBe(true);
  expect(
    git.repositoryRefsEqual(installation, {
      ...installation,
      installationId: "bonsai-b",
    }),
  ).toBe(false);
  expect(
    git.repositoryRefsEqual(installation, {
      kind: "team-source",
      repository: "project",
    }),
  ).toBe(false);
  expect(
    git.repositoryRefsEqual(installation, {
      ...installation,
      repository: "other",
    }),
  ).toBe(false);
  expect(
    git.repositoryRefsEqual(
      { kind: "team-source", repository: "project" },
      { repository: "project", kind: "team-source" },
    ),
  ).toBe(true);
});

it("serializes canonical repository identity independently of input property order", () => {
  const first: git.RepositoryRef = {
    kind: "installation",
    installationId: "bonsai-a",
    repository: "project",
  };
  const reordered: git.RepositoryRef = {
    repository: "project",
    installationId: "bonsai-a",
    kind: "installation",
  };
  expect(git.repositoryRefKey(first)).toBe(git.repositoryRefKey(reordered));
  expect(git.repositoryRefKey(first)).not.toBe(
    git.repositoryRefKey({ kind: "team-source", repository: "project" }),
  );
  expect(
    git.repositoryRefSchema.parse(JSON.parse(git.repositoryRefKey(first))),
  ).toEqual(first);
});
