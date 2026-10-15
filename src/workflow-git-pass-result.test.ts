import { expect, it } from "vitest";
import { workflowGitPassResultSchema } from "./computer-contracts.js";

it("preserves the complete credential-free Workflow pass selector and expiry", () => {
  const reply = {
    passId: "pass_fixture",
    remote: "https://git.team.internal/workflow/pass_fixture/app_source.git",
    expiresAt: 62000,
  };
  expect(workflowGitPassResultSchema.parse(reply)).toEqual(reply);
});

it("refuses credential-bearing remotes instead of passing them into a command", () => {
  for (const remote of [
    "https://fixture@git.team.internal/workflow/pass_fixture/app_source.git",
    "https://fixture:fixture@git.team.internal/workflow/pass_fixture/app_source.git",
  ])
    expect(
      workflowGitPassResultSchema.safeParse({
        passId: "pass_fixture",
        remote,
        expiresAt: 62000,
      }).success,
    ).toBe(false);
});

it("refuses malformed pass metadata and additional authority fields", () => {
  const reply = {
    passId: "pass_fixture",
    remote: "https://git.team.internal/workflow/pass_fixture/app_source.git",
    expiresAt: 62000,
  };
  for (const invalid of [
    { ...reply, passId: "" },
    {
      ...reply,
      remote: "http://git.team.internal/workflow/pass_fixture/app_source.git",
    },
    { ...reply, remote: "/workflow/pass_fixture/app_source.git" },
    { ...reply, expiresAt: 0 },
    { ...reply, expiresAt: -1 },
    { ...reply, expiresAt: 62000.5 },
    { ...reply, expiresAt: "62000" },
    { ...reply, memberId: "untrusted-member" },
  ])
    expect(workflowGitPassResultSchema.safeParse(invalid).success).toBe(false);
});
