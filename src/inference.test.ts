import { expect, it, vi } from "vitest";
import { RpcTarget, newMessagePortRpcSession } from "@fungi.computer/capnweb";
import { createCapabilityDirectory } from "./internal/capabilities.js";
import { createAppInferenceTransport, llmGeneration } from "./inference.js";

it("cancels while the request handle is pending and disposes that handle when it arrives", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened: () => void = () => undefined;
  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const fetched = vi.fn();
  const disposed = vi.fn();
  class PendingRequest extends RpcTarget {
    fetch() {
      fetched();
      return Promise.resolve(new Response());
    }
    close() {
      this[Symbol.dispose]();
      return Promise.resolve();
    }
    [Symbol.dispose]() {
      disposed();
    }
  }
  class Owner extends RpcTarget {
    async open() {
      opened();
      await gate;
      return new PendingRequest();
    }
  }
  const channel = new MessageChannel();
  const remote = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, new Owner());
  const directory = createCapabilityDirectory([
    { ...llmGeneration, handle: remote },
  ]);
  const transport = createAppInferenceTransport(directory.directory);
  const controller = new AbortController();
  try {
    const pending = transport.fetch(`${transport.baseURL}/models`, {
      signal: controller.signal,
    });
    const failed = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await opening;
    controller.abort();
    await failed;
    release();
    await expect.poll(() => disposed.mock.calls.length).toBeGreaterThan(0);
    expect(fetched).not.toHaveBeenCalled();
  } finally {
    release();
    directory.disconnect();
    remote[Symbol.dispose]();
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
});
