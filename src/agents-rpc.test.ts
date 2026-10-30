import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import * as z from "zod";

import { agentSessionRead, openAppAgent, openAppInbox } from "./agents.js";
import { createCapabilityRegistry } from "./capabilities.js";

it.each([
  { kind: "agent", cancellation: "request" },
  { kind: "agent", cancellation: "connection" },
  { kind: "agent", cancellation: "reader" },
  { kind: "agent", cancellation: "session" },
  { kind: "inbox", cancellation: "request" },
  { kind: "inbox", cancellation: "connection" },
  { kind: "inbox", cancellation: "reader" },
  { kind: "inbox", cancellation: "session" },
] as const)(
  "releases the $kind HTTP stream on $cancellation cancellation across RPC",
  async ({ kind, cancellation }) => {
    const disconnected = vi.fn();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      response.once("close", disconnected);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z
      .object({ port: z.number().int().min(1).max(65_535) })
      .parse(server.address());
    const origin = `http://127.0.0.1:${String(port)}`;

    // Like Oyster's transport handle, this owns whole-connection cancellation.
    // Request/Response and stream cancellation cross the real RPC serializer.
    class Transport extends RpcTarget {
      readonly abort = new AbortController();
      fetch(request: Request): Promise<Response> {
        return fetch(`${origin}${new URL(request.url).pathname}`, {
          signal: AbortSignal.any([request.signal, this.abort.signal]),
        });
      }
      close(): Promise<void> {
        this.abort.abort();
        return Promise.resolve();
      }
    }
    class Directory extends RpcTarget {
      open() {
        return new Transport();
      }
      openInbox() {
        return new Transport();
      }
    }
    const channel = new MessageChannel();
    const host = newMessagePortRpcSession(channel.port1, new Directory());
    const remote = newMessagePortRpcSession<Directory>(channel.port2);
    const capabilities = createCapabilityRegistry();
    capabilities.provide(
      agentSessionRead,
      agentSessionRead.schema.parse(remote),
    );
    const transport =
      kind === "agent"
        ? await openAppAgent(capabilities, { agentId: "agent_test" })
        : await openAppInbox(capabilities);
    let remoteClosed = false;
    try {
      const abort = new AbortController();
      const path = kind === "agent" ? "/sessions/main/events" : "/inbox/events";
      const response = await transport.fetch(`${transport.baseUrl}${path}`, {
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      expect((await reader?.read())?.done).toBe(false);
      if (cancellation === "request") abort.abort();
      else if (cancellation === "connection") await transport.close();
      else if (cancellation === "reader") await reader?.cancel();
      else {
        remote[Symbol.dispose]();
        remoteClosed = true;
      }
      await vi.waitFor(() => {
        expect(disconnected).toHaveBeenCalledExactlyOnceWith();
      });
    } finally {
      if (!remoteClosed) {
        await transport.close();
        remote[Symbol.dispose]();
      }
      host[Symbol.dispose]();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  },
);
