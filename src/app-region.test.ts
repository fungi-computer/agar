import { describe, expect, test } from "vitest";
import { maxAppRegionMessageBytes } from "@fungi.computer/puffball/backend";
import { appRegion } from "./backend.js";
import { AppRegionHost } from "./host.js";

/** The browser WebSocket surface the host bridge uses. */
class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  closed: number | null = null;
  readyState = 0;
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
  async open() {
    // A browser socket opens on a later task, never inside connect().
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

async function readAll(stream: ReadableStream<string>) {
  const values: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return values;
    values.push(next.value);
  }
}

describe("App Region connection", () => {
  test("the host keeps the socket; the App sees text frames only", async () => {
    const socket = new FakeSocket();
    const host = appRegion.schema.parse(new AppRegionHost(() => socket));
    const connecting = host.connect();
    await socket.open();
    const connection = await connecting;
    const messages = readAll(await connection.messages());
    socket.receive("hello");
    socket.receive(new ArrayBuffer(4));
    socket.receive("tick");
    await connection.send("move");
    expect(socket.sent).toEqual(["move"]);
    await expect(
      connection.send("x".repeat(maxAppRegionMessageBytes + 1)),
    ).rejects.toThrow();
    await connection.close();
    expect(socket.closed).toBe(1000);
    expect(await messages).toEqual(["hello", "tick"]);
  });

  test("a refused upgrade never yields a connection", async () => {
    const socket = new FakeSocket();
    const connecting = new AppRegionHost(() => socket).connect();
    socket.close(1006);
    await expect(connecting).rejects.toThrow();
  });

  test("a host close ends the App's message stream", async () => {
    const socket = new FakeSocket();
    const connecting = new AppRegionHost(() => socket).connect();
    await socket.open();
    const connection = await connecting;
    const messages = readAll(await connection.messages());
    socket.receive("before");
    socket.close(4403);
    expect(await messages).toEqual(["before"]);
  });
});
