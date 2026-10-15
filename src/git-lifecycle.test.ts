import { expect, test, vi } from "vitest";
import { dispatchAppGitPush, type AppGitLifecycle } from "./git.js";

const fact = {
  eventId: "computer_fixture:push_fixture",
  repository: "project",
  writer: { kind: "actor", actor: { kind: "agent", agentId: "agent_fixture" } },
  updates: [
    { ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40) },
  ],
};

test("lifecycle dispatch preserves the receiver and the stable event ID on redelivery", async () => {
  const handled: string[] = [];
  const lifecycle: AppGitLifecycle = {
    onGitPush(delivered) {
      expect(this).toBe(lifecycle);
      handled.push(delivered.eventId);
      return Promise.resolve();
    },
  };
  await dispatchAppGitPush(lifecycle, fact);
  await dispatchAppGitPush(lifecycle, fact);
  expect(handled).toEqual([fact.eventId, fact.eventId]);
});

test("only accepted ref facts cross the lifecycle boundary; malformed or credential fields refuse", async () => {
  const onGitPush = vi.fn(() => Promise.resolve());
  for (const invalid of [
    { ...fact, token: "forbidden" },
    { ...fact, repository: "../another-installation" },
    { ...fact, writer: { kind: "actor", actor: { kind: "unknown" } } },
    { ...fact, updates: [] },
    { ...fact, updates: [{ ...fact.updates[0], after: "not-a-sha1" }] },
    { ...fact, updates: [{ ...fact.updates[0], ref: "not-a-ref" }] },
  ])
    await expect(dispatchAppGitPush({ onGitPush }, invalid)).rejects.toThrow();
  expect(onGitPush).not.toHaveBeenCalled();
});

test.each([
  { kind: "agent", agentId: "agent_fixture" },
  { kind: "member", memberId: "member_fixture" },
  { kind: "team-key", keyId: "key_fixture" },
])("push attribution retains a host-admitted $kind actor", async (actor) => {
  const onGitPush = vi.fn(() => Promise.resolve());
  const writer = { kind: "actor", actor };
  await dispatchAppGitPush({ onGitPush }, { ...fact, writer });
  expect(onGitPush).toHaveBeenCalledWith({ ...fact, writer });
});

test("a rejected handler remains rejected so the host can retry delivery", async () => {
  const cause = new Error("store unavailable");
  await expect(
    dispatchAppGitPush({ onGitPush: () => Promise.reject(cause) }, fact),
  ).rejects.toBe(cause);
});

test("installation pushes retain their explicit installation identity", async () => {
  const onGitPush = vi.fn(() => Promise.resolve());
  const writer = {
    kind: "installation",
    installationId: "installation_fixture",
    onBehalfOf: null,
  };
  await dispatchAppGitPush({ onGitPush }, { ...fact, writer });
  expect(onGitPush).toHaveBeenCalledWith({ ...fact, writer });
  await expect(
    dispatchAppGitPush(
      { onGitPush },
      {
        ...fact,
        writer: {
          ...writer,
          actor: { kind: "agent", agentId: "invented-key" },
        },
      },
    ),
  ).rejects.toThrow();
});
