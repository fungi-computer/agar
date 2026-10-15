import { RpcTarget, newMessagePortRpcSession } from "@fungi.computer/capnweb";
import { expect, it } from "vitest";
import { readAppFile, writeAppFile } from "./files.js";

const bytes = new Uint8Array([0, 128, 255, 10]);

it.each([
  { body: '{"error":"too_large"}', code: "FILE_TOO_LARGE" },
  { body: '{"error":"unavailable"}', code: "PROTOCOL" },
  { body: "not JSON", code: "PROTOCOL" },
])(
  "decodes a 413 response ($body) without losing cleanup",
  async ({ body, code }) => {
    let closed = false;
    let disposed = false;
    await expect(
      readAppFile(
        {
          response: () => Promise.resolve(new Response(body, { status: 413 })),
          close: () => {
            closed = true;
            return Promise.resolve();
          },
          [Symbol.dispose]: () => {
            disposed = true;
          },
        },
        { name: "image.png" },
      ),
    ).rejects.toMatchObject({ code, retryable: false });
    expect(closed).toBe(true);
    expect(disposed).toBe(true);
  },
);

it("receives native binary and releases the parent read after local File construction", async () => {
  let closed = false;
  class Read extends RpcTarget {
    response() {
      return new Response(bytes);
    }
    close() {
      closed = true;
    }
  }
  class Files extends RpcTarget {
    open() {
      return new Read();
    }
  }
  const channel = new MessageChannel();
  const peer = newMessagePortRpcSession(channel.port1, new Files());
  using client = newMessagePortRpcSession<Files>(channel.port2, {});
  try {
    const file = await readAppFile(await client.open(), { name: "sample.bin" });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file.name).toBe("sample.bin");
    expect(closed).toBe(true);
  } finally {
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
});

it("closes a denied response instead of returning file bytes", async () => {
  let closed = false;
  class Read extends RpcTarget {
    response() {
      return new Response(null, { status: 403 });
    }
    close() {
      closed = true;
    }
  }
  class Files extends RpcTarget {
    open() {
      return new Read();
    }
  }
  const channel = new MessageChannel();
  const peer = newMessagePortRpcSession(channel.port1, new Files());
  using client = newMessagePortRpcSession<Files>(channel.port2, {});
  try {
    await expect(
      readAppFile(await client.open(), { name: "denied.bin" }),
    ).rejects.toThrow("403");
    expect(closed).toBe(true);
  } finally {
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
});

it("closes the remote read when the receiver aborts an idle body", async () => {
  const abort = new AbortController();
  let closed = false;
  class Read extends RpcTarget {
    readonly controller = new AbortController();
    response() {
      return new Response(
        new ReadableStream({
          start: (body) => {
            this.controller.signal.addEventListener(
              "abort",
              () => {
                body.error(new DOMException("Read closed", "AbortError"));
              },
              { once: true },
            );
            abort.abort();
          },
        }),
      );
    }
    close() {
      closed = true;
      this.controller.abort();
    }
  }
  class Files extends RpcTarget {
    open() {
      return new Read();
    }
  }
  const channel = new MessageChannel();
  const peer = newMessagePortRpcSession(channel.port1, new Files());
  using client = newMessagePortRpcSession<Files>(channel.port2, {});
  try {
    await expect(
      readAppFile(await client.open(), {
        name: "pending.bin",
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  } finally {
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
});

it("sends native Blob bytes and closes only after the parent acknowledges the write", async () => {
  let received: Uint8Array | undefined;
  let closed = false;
  class Write extends RpcTarget {
    async write(content: ReadableStream<Uint8Array>) {
      received = new Uint8Array(await new Response(content).arrayBuffer());
    }
    close() {
      closed = true;
    }
  }
  class Files extends RpcTarget {
    open() {
      return new Write();
    }
  }
  const channel = new MessageChannel();
  const peer = newMessagePortRpcSession(channel.port1, new Files());
  using client = newMessagePortRpcSession<Files>(channel.port2, {});
  try {
    await writeAppFile(await client.open(), new Blob([bytes]), {});
    expect(received).toEqual(bytes);
    expect(closed).toBe(true);
  } finally {
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
});

it("retains a write rejection and closes its parent target", async () => {
  let closed = false;
  class Write extends RpcTarget {
    write(content: ReadableStream<Uint8Array>): Promise<void> {
      void content.cancel();
      return Promise.reject(new Error("write denied"));
    }
    close() {
      closed = true;
    }
  }
  class Files extends RpcTarget {
    open() {
      return new Write();
    }
  }
  const channel = new MessageChannel();
  const peer = newMessagePortRpcSession(channel.port1, new Files());
  using client = newMessagePortRpcSession<Files>(channel.port2, {});
  try {
    await expect(
      writeAppFile(await client.open(), new Blob([bytes]), {}),
    ).rejects.toThrow("write denied");
    expect(closed).toBe(true);
  } finally {
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
});

it.each([false, true])(
  "write settlement survives close rejection (write fails: %s)",
  async (fails) => {
    class Write extends RpcTarget {
      write(content: ReadableStream<Uint8Array>): Promise<void> {
        void content.cancel();
        return fails
          ? Promise.reject(new Error("primary write failure"))
          : Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.reject(new Error("cleanup failure"));
      }
    }
    class Files extends RpcTarget {
      open() {
        return new Write();
      }
    }
    const channel = new MessageChannel();
    const peer = newMessagePortRpcSession(channel.port1, new Files());
    using client = newMessagePortRpcSession<Files>(channel.port2, {});
    try {
      const result = writeAppFile(await client.open(), new Blob([bytes]), {});
      if (fails) await expect(result).rejects.toThrow("primary write failure");
      else await expect(result).resolves.toBeUndefined();
    } finally {
      peer[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    }
  },
);
