import { createCapabilityRegistry } from "./capabilities.js";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityDirectory } from "./capabilities.js";
import {
  agentList,
  agentManage,
  agentRename,
  agentSessionRead,
  agentSessionWrite,
  agentToolPolicy,
  type AppAgentDirectoryHandle,
  listAppAgents,
  createAppAgent,
  openAppAgent,
  openAppInbox,
  renameAppAgent,
  appAgentListResultSchema,
} from "./agents.js";

it("decodes the broker Agent list projection without directory-only fields", () => {
  const result = { agents: [{ agentId: "agent_a", name: "Helper" }] };
  expect(appAgentListResultSchema.parse(result)).toEqual(result);
  expect(appAgentListResultSchema.parse({ agents: [] })).toEqual({
    agents: [],
  });
  for (const reply of [
    { error: "not_granted" },
    { agents: [{ agentId: "agent_a" }] },
    { agents: [{ agentId: "agent_a", name: "Helper", createdAt: 1 }] },
  ])
    expect(appAgentListResultSchema.safeParse(reply).success).toBe(false);
});

function directory(
  handle: Omit<AppAgentDirectoryHandle, "openInbox"> &
    Partial<Pick<AppAgentDirectoryHandle, "openInbox">>,
): CapabilityDirectory {
  const value: AppAgentDirectoryHandle = {
    openInbox: () => Promise.reject(new Error("unexpected inbox")),
    ...handle,
  };
  const registry = createCapabilityRegistry();
  registry.provide(agentList, value);
  registry.provide(agentManage, value);
  registry.provide(agentSessionRead, value);
  registry.provide(agentSessionWrite, value);
  return registry;
}

describe("Agent App capability", () => {
  it.each([undefined, "new", "none"] as const)(
    "forwards the admitted Computer create choice %s",
    async (computer) => {
      const agent = {
        agentId: "agent-created",
        name: "Helper",
        sessionOperations: [],
      };
      const create = vi.fn<AppAgentDirectoryHandle["create"]>(() =>
        Promise.resolve(agent),
      );
      const capabilities = directory({
        list: () => Promise.resolve([]),
        create,
        open: () => Promise.reject(new Error("Unexpected open")),
      });
      const request =
        computer === undefined
          ? { name: "Helper", requestId: "create" }
          : { name: "Helper", requestId: "create", computer };
      expect(await createAppAgent(capabilities, request)).toEqual(agent);
      expect(create).toHaveBeenCalledWith(request);
    },
  );

  it("keeps Agent addresses distinct and stable when reopening a connection", async () => {
    const capabilities = directory({
      list: () => Promise.resolve([]),
      create: () => Promise.reject(new Error("unexpected create")),
      open: () =>
        Promise.resolve({
          fetch: () => Promise.resolve(new Response()),
          close: () => Promise.resolve(),
          [Symbol.dispose]: () => undefined,
        }),
    });
    const first = await openAppAgent(capabilities, { agentId: "agent_A" });
    const second = await openAppAgent(capabilities, { agentId: "agent_a" });
    await first.close();
    const reopened = await openAppAgent(capabilities, { agentId: "agent_A" });

    expect(first.baseUrl).not.toBe(second.baseUrl);
    expect(reopened.baseUrl).toBe(first.baseUrl);
    await Promise.all([second.close(), reopened.close()]);
  });

  it("forwards only this Agent's requests with the host path, body, headers, query, and signal intact", async () => {
    const abort = new AbortController();
    const forwarded: Request[] = [];
    const capabilities = directory({
      list: () => Promise.resolve([]),
      create: () => Promise.reject(new Error("unexpected create")),
      open: () =>
        Promise.resolve({
          fetch: (request: Request) => {
            forwarded.push(request);
            return Promise.resolve(new Response());
          },
          close: () => Promise.resolve(),
          [Symbol.dispose]: () => undefined,
        }),
    });
    const first = await openAppAgent(capabilities, { agentId: "agent_one" });
    const second = await openAppAgent(capabilities, { agentId: "agent_two" });
    await first.fetch(`${first.baseUrl}/sessions/main/command?after=cursor`, {
      method: "POST",
      body: JSON.stringify({ type: "abort" }),
      headers: {
        "content-type": "application/json",
        "last-event-id": "cursor",
      },
      signal: abort.signal,
    });
    const request = forwarded.at(0);
    if (!request) throw new Error("Agent request was not forwarded");
    expect(request.url).toBe(
      "https://agent-session.fungi.invalid/sessions/main/command?after=cursor",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("last-event-id")).toBe("cursor");
    await expect(request.json()).resolves.toEqual({ type: "abort" });
    abort.abort();
    expect(request.signal.aborted).toBe(true);

    await expect(
      first.fetch(`${second.baseUrl}/sessions`),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      first.fetch(`${first.baseUrl}-suffix/sessions`),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(forwarded).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  it("decodes the bounded Agent directory before exposing it", async () => {
    const unexpectedOpen = () => Promise.reject(new Error("unexpected open"));
    const list = vi.fn(() =>
      Promise.resolve([
        {
          agentId: "agent_one",
          name: "Helper",
          sessionOperations: ["agent.read" as const],
        },
      ]),
    );

    await expect(
      listAppAgents(
        directory({ list, create: unexpectedOpen, open: unexpectedOpen }),
      ),
    ).resolves.toEqual([
      {
        agentId: "agent_one",
        name: "Helper",
        sessionOperations: ["agent.read"],
      },
    ]);
  });

  it("keeps the parent URL private and closes the live handle exactly once", async () => {
    const dispose = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const fetch = vi.fn((request: Request) =>
      Promise.resolve(Response.json({ path: new URL(request.url).pathname })),
    );
    const open = vi.fn(() =>
      Promise.resolve({ close, fetch, [Symbol.dispose]: dispose }),
    );
    const transport = await openAppAgent(
      directory({
        list: () => Promise.resolve([]),
        create: () => Promise.reject(new Error("unexpected create")),
        open,
      }),
      {
        agentId: "agent_one",
      },
    );

    const response = await transport.fetch(`${transport.baseUrl}/sessions`);
    await expect(response.json()).resolves.toEqual({ path: "/sessions" });
    expect(open).toHaveBeenCalledWith({ agentId: "agent_one" });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(
      transport.fetch("https://hub.example.test/private"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await transport.close();
    await transport.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(
      transport.fetch(`${transport.baseUrl}/sessions`),
    ).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("opens the member inbox and forwards visits without exposing the parent URL", async () => {
    const fetch = vi.fn(async (request: Request) =>
      Response.json({
        path: new URL(request.url).pathname,
        method: request.method,
        body: await request.text(),
      }),
    );
    const dispose = vi.fn();
    const transport = await openAppInbox(
      directory({
        list: () => Promise.resolve([]),
        create: () => Promise.reject(new Error("unexpected create")),
        open: () => Promise.reject(new Error("unexpected open")),
        openInbox: () =>
          Promise.resolve({
            fetch,
            close: () => Promise.resolve(),
            [Symbol.dispose]: dispose,
          }),
      }),
    );
    const response = await transport.fetch(`${transport.baseUrl}/inbox/events`);
    expect(await response.json()).toEqual({
      path: "/inbox/events",
      method: "GET",
      body: "",
    });
    const body = JSON.stringify({ agentId: "agent_one", sessionId: "main" });
    const visit = await transport.fetch(`${transport.baseUrl}/inbox/visits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(await visit.json()).toEqual({
      path: "/inbox/visits",
      method: "POST",
      body,
    });
    await expect(
      transport.fetch("https://agent-session.fungi.invalid/agents/x/sessions"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await transport.close();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

it("opens a management-only App transport without adding read or send grants", async () => {
  const registry = createCapabilityRegistry();
  const opened = vi.fn(() =>
    Promise.resolve({
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      close: () => Promise.resolve(),
      [Symbol.dispose]: () => undefined,
    }),
  );
  registry.provide(agentManage, {
    create: () => Promise.reject(new Error("Agent creation is not requested")),
    open: opened,
  });
  const transport = await openAppAgent(registry, { agentId: "agent_one" });
  expect(opened).toHaveBeenCalledWith({ agentId: "agent_one" });
  expect(registry.has(agentSessionRead)).toBe(false);
  expect(registry.has(agentSessionWrite)).toBe(false);
  await transport.close();
});

it.each(["send", "manage"] as const)(
  "routes reads to read and Session mutations to the admitted %s handle",
  async (writer) => {
    const registry = createCapabilityRegistry();
    const seen: string[] = [];
    const closed: string[] = [];
    const disposed: string[] = [];
    const open = (name: string) => () =>
      Promise.resolve({
        fetch: (request: Request) => {
          seen.push(`${name}:${request.method}`);
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        close: () => {
          closed.push(name);
          return Promise.resolve();
        },
        [Symbol.dispose]: () => {
          disposed.push(name);
        },
      });
    registry.provide(agentSessionRead, {
      open: open("read"),
      openInbox: () => Promise.reject(new Error("No inbox requested")),
    });
    registry.provide(agentManage, {
      open: open("manage"),
      create: () => Promise.reject(new Error("No Agent creation requested")),
    });
    if (writer === "send")
      registry.provide(agentSessionWrite, {
        open: open("send"),
        openInbox: () => Promise.reject(new Error("No inbox requested")),
      });
    const transport = await openAppAgent(registry, { agentId: "agent_one" });
    for (const method of ["POST", "GET", "PUT", "HEAD", "DELETE"])
      await transport.fetch(`${transport.baseUrl}/sessions`, { method });
    expect(seen).toEqual([
      `${writer}:POST`,
      "read:GET",
      `${writer}:PUT`,
      "read:HEAD",
      `${writer}:DELETE`,
    ]);
    await transport.close();
    await transport.close();
    expect(closed).toEqual(["read", writer]);
    expect(disposed).toEqual(["read", writer]);
  },
);

describe("Agent rename capability", () => {
  it("renames an Agent through the owner-only rename capability", async () => {
    const registry = createCapabilityRegistry();
    const agent = {
      agentId: "agent-one",
      name: "Gardener",
      sessionOperations: [],
    };
    const rename = vi.fn(() => Promise.resolve(agent));
    registry.provide(agentRename, { rename });
    const request = { agentId: "agent-one", name: "Gardener" };
    expect(await renameAppAgent(registry, request)).toEqual(agent);
    expect(rename).toHaveBeenCalledWith(request);
  });

  it("refuses to rename without the owner-only capability granted", async () => {
    const registry = createCapabilityRegistry();
    await expect(
      renameAppAgent(registry, { agentId: "agent-one", name: "Gardener" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("refuses an empty or oversized name before the capability is called", async () => {
    const registry = createCapabilityRegistry();
    const rename = vi.fn(() => Promise.reject(new Error("Unexpected rename")));
    registry.provide(agentRename, { rename });
    await expect(
      renameAppAgent(registry, { agentId: "agent-one", name: "" }),
    ).rejects.toThrow();
    await expect(
      renameAppAgent(registry, {
        agentId: "agent-one",
        name: "x".repeat(257),
      }),
    ).rejects.toThrow();
    expect(rename).not.toHaveBeenCalled();
  });
});

describe("Agent App-tool policy capability", () => {
  it("reads a pending status and approves it under its exact revision", async () => {
    const registry = createCapabilityRegistry();
    const status = vi.fn(() =>
      Promise.resolve({ status: "pending" as const, revision: "agent-one:1" }),
    );
    const approve = vi.fn(() =>
      Promise.resolve({
        status: "approved" as const,
        revision: "agent-one:2",
      }),
    );
    registry.provide(agentToolPolicy, { status, approve });
    const handle = registry.require(agentToolPolicy);
    expect(await handle.status({ agentId: "agent-one" })).toEqual({
      status: "pending",
      revision: "agent-one:1",
    });
    expect(
      await handle.approve({
        agentId: "agent-one",
        level: "write",
        expectedRevision: "agent-one:1",
      }),
    ).toEqual({ status: "approved", revision: "agent-one:2" });
  });

  it("reports no such Agent as null", async () => {
    const registry = createCapabilityRegistry();
    registry.provide(agentToolPolicy, {
      status: () => Promise.resolve(null),
      approve: () => Promise.reject(new Error("Unexpected approve")),
    });
    expect(
      await registry.require(agentToolPolicy).status({ agentId: "agent-9" }),
    ).toBeNull();
  });
});
