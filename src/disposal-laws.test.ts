import { RpcStub, RpcTarget } from "@fungi.computer/capnweb";
import { parseVoidResult } from "./internal/schemas.js";
import { describe, expect, it, vi } from "vitest";

import { disposeRpcValue, ownedRpcValue } from "./internal/capabilities.js";
import { callRpc, rpcSuccess } from "./internal/result.js";

describe("app SDK disposal laws", () => {
  it("LAW: result disposal is exactly once and cannot replace success", async () => {
    const dispose = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const result = disposableResult(dispose);
    await expect(
      callRpc(Promise.resolve(result), (value) => rpcSuccess(value)),
    ).resolves.toBe(result);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("LAW: result cleanup cannot replace the original parser verdict", async () => {
    const dispose = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const result = disposableResult(dispose);
    await expect(
      callRpc(Promise.resolve(result), () => {
        throw new Error("parser verdict");
      }),
    ).rejects.toMatchObject({
      cause: { message: "parser verdict" },
      code: "HOST_FAILURE",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("LAW: direct RPC value disposal is exhaustive and exactly once", () => {
    const dispose = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const value = disposableResult(dispose);
    expect(() => {
      disposeRpcValue(value);
    }).not.toThrow();
    expect(() => {
      disposeRpcValue(value);
    }).not.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("LAW: one typed owner releases a result once after copying its data", () => {
    const dispose = vi.fn();
    {
      using owned = ownedRpcValue(disposableResult(dispose));
      expect(owned.value.ok).toBe(true);
      owned[Symbol.dispose]();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("LAW: plain result envelopes need no disposal method", () => {
    const plain: { ok: boolean } & Partial<Disposable> = { ok: true };
    {
      using owned = ownedRpcValue(plain);
      expect(owned.value.ok).toBe(true);
    }
  });
});

function disposableResult(dispose: () => void) {
  return { ok: true, [Symbol.dispose]: dispose, value: undefined };
}

it("accepts native RPC disposal metadata but rejects an extra serialized key", async () => {
  class Producer extends RpcTarget {
    accepted() {
      return { ok: true, value: undefined };
    }
    extra() {
      return { ok: true, value: undefined, extra: true };
    }
  }
  using remote = new RpcStub(new Producer());
  await expect(
    callRpc(remote.accepted(), parseVoidResult),
  ).resolves.toBeUndefined();
  await expect(callRpc(remote.extra(), parseVoidResult)).rejects.toMatchObject({
    code: "PROTOCOL",
  });
});
