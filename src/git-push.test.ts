import { expect, test } from "vitest";
import { buildAppDeclaration } from "./backend-declaration.js";
import { defineAppBackend, defineAppMethod } from "./backend-definition.js";
import * as z from "zod";
import {
  repositoryRefSchema,
  gitPushQuestionSchema,
  gitWriterSchema,
} from "./git.js";

test("authorizeGitPush never admits a visitor as a Git writer or Workflow grantor", () => {
  const actor = { kind: "visitor" };
  expect(gitWriterSchema.safeParse({ kind: "actor", actor }).success).toBe(
    false,
  );
  expect(
    gitWriterSchema.safeParse({
      kind: "installation",
      installationId: "notes",
      onBehalfOf: actor,
    }).success,
  ).toBe(false);
  expect(
    gitWriterSchema.safeParse({
      kind: "actor",
      actor: { kind: "member", memberId: "owner" },
      workflow: {
        workflowId: "garden",
        runId: "run_one",
        nodeId: "save",
        armedBy: actor,
        branches: ["refs/heads/main"],
      },
    }).success,
  ).toBe(false);
  expect(
    gitPushQuestionSchema.safeParse({
      repository: "garden",
      writer: { kind: "actor", actor },
      updates: [
        {
          ref: "refs/heads/main",
          before: "0".repeat(40),
          after: "a".repeat(40),
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    gitWriterSchema.safeParse({
      kind: "actor",
      actor: { kind: "team-key", keyId: "visitor" },
    }).success,
  ).toBe(true);
});

test("the generated declaration retains git push reception and its requested grant", () => {
  const declaration = buildAppDeclaration(defineAppBackend({ methods: {} }), {
    capabilities: ["git.repository"],
    handlers: [],
    roles: [],
    receives: ["git.push"],
  });
  expect(declaration).toMatchObject({
    capabilities: ["git.repository"],
    receives: ["git.push"],
  });
});

test("Git push reception requires its capability and unique known event names", () => {
  const backend = defineAppBackend({ methods: {} });
  expect(() =>
    buildAppDeclaration(backend, {
      capabilities: [],
      handlers: [],
      roles: [],
      receives: ["git.push"],
    }),
  ).toThrow();
  for (const receives of [["git.push", "git.push"], ["unknown"]]) {
    expect(() =>
      buildAppDeclaration(backend, {
        capabilities: ["git.repository"],
        handlers: [],
        roles: [],
        receives,
      }),
    ).toThrow();
  }
});

test.each(["onGitPush", "authorizeGitPush"])(
  "%s is a lifecycle handler, never an ordinary App method",
  (name) => {
    const method = defineAppMethod({
      description: "Push",
      effect: "write",
      requires: [],
      input: z.object({}),
      output: z.null(),
      handler: () => null,
    });
    expect(() => defineAppBackend({ methods: { [name]: method } })).toThrow();
    class GitApp {
      onGitPush() {
        return Promise.resolve();
      }
    }
    expect(defineAppBackend({ methods: {} }).implement(GitApp)).toBe(GitApp);
  },
);

test("repository references keep installation and registered Team sources distinct", () => {
  expect(
    repositoryRefSchema.parse({
      kind: "installation",
      installationId: "installation_a",
      repository: "notes",
    }),
  ).toEqual({
    kind: "installation",
    installationId: "installation_a",
    repository: "notes",
  });
  expect(
    repositoryRefSchema.parse({ kind: "team-source", repository: "notes" }),
  ).toEqual({ kind: "team-source", repository: "notes" });
  for (const value of [
    { kind: "installation", repository: "notes" },
    { kind: "installation", installationId: "", repository: "notes" },
    {
      kind: "team-source",
      installationId: "installation_a",
      repository: "notes",
    },
    { kind: "team-source", repository: "../notes" },
    { kind: "unclassified", repository: "notes" },
  ])
    expect(repositoryRefSchema.safeParse(value).success).toBe(false);
});
