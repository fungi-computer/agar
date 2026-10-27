import { RpcStub, RpcTarget } from "@fungi.computer/capnweb";
import { expect, it } from "vitest";
import type { ApprovalView, AutoApproveInput } from "@fungi.computer/approvals";
import { approvals } from "./approvals.js";

const view: ApprovalView = {
  record: {
    recordId: "approval:one",
    requester: {
      principalId: "agent:worker",
      agentId: "worker",
      sessionId: "session:one",
      displayName: "Worker",
    },
    module: "app:notes",
    operation: "notes.create",
    access: "write",
    description: {
      title: "Create a note",
      inputBytes: 2,
      inputSha256:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    },
    authorityFence: "generation:one",
    reversibility: "reversible",
    state: "pending",
    by: null,
    reason: null,
    requestedAt: 1,
    expiresAt: 86400001,
    updatedAt: 1,
    revision: 1,
  },
  canAnswer: false,
  canSetAutoApprove: false,
};

class ApprovalHost extends RpcTarget {
  constructor(
    private readonly malformed = false,
    private readonly denialNote?: string,
  ) {
    super();
  }
  list() {
    return { items: [view], nextCursor: null };
  }
  get() {
    // A real serialized producer can accidentally leak a private field. It
    // cannot supply invented Proxy/getter adversaries through Cap'n Web data.
    return this.malformed
      ? {
          ...view,
          record: { ...view.record, inputJson: "private operation bytes" },
        }
      : view;
  }
  answer() {
    return this.denialNote === undefined
      ? { kind: "refused", reason: "not-eligible" }
      : { kind: "refused", reason: "declined", denialNote: this.denialNote };
  }
  setAutoApprove(rule: AutoApproveInput) {
    return { kind: "updated", rule };
  }
}

it("decodes all four approval methods through a native RPC handle without inventing holder rights", async () => {
  using remote = new RpcStub(new ApprovalHost());
  const handle = approvals.schema.parse(remote);
  expect(await handle.list({ limit: 1 })).toEqual({
    items: [view],
    nextCursor: null,
  });
  expect(await handle.get({ recordId: "approval:one" })).toEqual(view);
  expect(
    await handle.answer({
      recordId: "approval:one",
      decision: "approve",
      expectedRevision: 1,
    }),
  ).toEqual({ kind: "refused", reason: "not-eligible" });
  const rule: AutoApproveInput = {
    scope: { agentId: null },
    family: { module: "app:notes", access: "write" },
    enabled: false,
  };
  expect(await handle.setAutoApprove(rule)).toEqual({ kind: "updated", rule });
});

it("preserves a human denial note across the native approval RPC result", async () => {
  const note = "use npm, not pnpm";
  using remote = new RpcStub(new ApprovalHost(false, note));
  const handle = approvals.schema.parse(remote);
  expect(
    await handle.answer({
      recordId: "approval:one",
      decision: "deny",
      expectedRevision: 1,
      denialNote: note,
    }),
  ).toEqual({ kind: "refused", reason: "declined", denialNote: note });
});

it("rejects a private input field in a native approval result as a protocol error", async () => {
  using remote = new RpcStub(new ApprovalHost(true));
  const handle = approvals.schema.parse(remote);
  await expect(handle.get({ recordId: "approval:one" })).rejects.toMatchObject({
    code: "PROTOCOL",
  });
});

it("accepts a missing record, but rejects an invalid policy reply", async () => {
  class Missing extends RpcTarget {
    list() {
      return { items: [], nextCursor: null };
    }
    answer() {
      return { kind: "refused", reason: "not-found" };
    }
    get() {
      return null;
    }
    setAutoApprove() {
      return { kind: "updated", rule: { enabled: "true" } };
    }
  }
  using remote = new RpcStub(new Missing());
  const handle = approvals.schema.parse(remote);
  expect(await handle.get({ recordId: "approval:missing" })).toBeNull();
  await expect(
    handle.setAutoApprove({
      scope: { agentId: null },
      family: { module: null, access: "write" },
      enabled: true,
    }),
  ).rejects.toMatchObject({ code: "PROTOCOL" });
});
