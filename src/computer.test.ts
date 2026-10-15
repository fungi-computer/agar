import { describe, expect, it, vi } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import * as Schema from "effect/Schema";
import { createCapabilityDirectory } from "./internal/capabilities.js";
import {
  computerProcessesSchema,
  computerProcesses,
  computerProcessKillSchema,
  computerPorts,
  computerPortsSchema,
  computerTerminal,
  computerWriteFile,
  type ComputerFileReplacementOutcome,
  type ComputerProcesses,
  type ComputerPortsResult,
} from "./computer.js";
import {
  listComputerProcesses,
  killComputerProcess,
  listComputerPorts,
  exposeComputerPort,
  unexposeComputerPort,
  openComputerTerminal,
  replaceComputerFileIfUnchanged,
  type AppComputerTerminal,
} from "./computer.js";

describe("Agar Computer conditional replacement", () => {
  it("returns the committed result without losing the expected baseline", async () => {
    const replace = vi.fn().mockResolvedValue({
      kind: "replaced",
      path: "/note.txt",
      bytes: 4,
    });
    const owner = replacementDirectory(replace);
    try {
      const input = {
        path: "/note.txt",
        expectedContent: "opened",
        content: "mine",
      };
      await expect(
        replaceComputerFileIfUnchanged(owner.directory, input, {}),
      ).resolves.toEqual({ path: "/note.txt", bytes: 4 });
      expect(replace).toHaveBeenCalledWith(input);
    } finally {
      owner.close();
    }
  });

  it("returns a typed conflict instead of acknowledging a stale save", async () => {
    const owner = replacementDirectory(() =>
      Promise.resolve({ kind: "conflict" }),
    );
    try {
      await expect(
        replaceComputerFileIfUnchanged(
          owner.directory,
          {
            path: "/note.txt",
            expectedContent: "opened",
            content: "mine",
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", retryable: false });
    } finally {
      owner.close();
    }
  });
});

class ReplacementOwner extends RpcTarget {
  constructor(
    readonly replaceFile: (input: {
      path: string;
      expectedContent: string;
      content: string;
    }) => Promise<ComputerFileReplacementOutcome>,
  ) {
    super();
  }

  open(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  replace(input: {
    path: string;
    expectedContent: string;
    content: string;
  }): Promise<ComputerFileReplacementOutcome> {
    return this.replaceFile(input);
  }
}

function replacementDirectory(replace: ReplacementOwner["replaceFile"]) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(
    channel.port2,
    new ReplacementOwner(replace),
  );
  const controller = createCapabilityDirectory([
    {
      handle: client,
      id: computerWriteFile.id,
      version: computerWriteFile.version,
    },
  ]);
  return {
    directory: controller.directory,
    close() {
      controller.disconnect();
      client[Symbol.dispose]();
      peer[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe("Agar Computer ports capability", () => {
  it("requires a decoded display mode without inferring it from the URL", () => {
    expect(() =>
      Schema.decodeUnknownSync(computerPortsSchema)({
        ports: [
          {
            port: 3000,
            previewUrl: "https://preview.example.test/",
            expiresAt: Date.now() + 300_000,
          },
        ],
      }),
    ).toThrow();
  });
  it("decodes signed member-scoped previews from the admitted Computer", async () => {
    const ports = [
      {
        port: 5173,
        previewUrl: "https://member-preview.example.test/",
        openMode: "inline" as const,
        expiresAt: 1_800_000_000_000,
      },
    ];
    const capabilities = portsDirectory({ ports });

    await expect(listComputerPorts(capabilities.directory)).resolves.toEqual({
      ports,
    });
    capabilities.close();
  });

  it("preserves an unconfigured deployment across the capability RPC", async () => {
    const owner = portsDirectory({ error: "port_previews_not_configured" });
    try {
      await expect(listComputerPorts(owner.directory)).resolves.toEqual({
        error: "port_previews_not_configured",
      });
    } finally {
      owner.close();
    }
  });

  it("rejects malformed port metadata at the SDK boundary", async () => {
    const capabilities = portsDirectory({
      ports: [
        {
          port: 70_000,
          previewUrl: "javascript:alert(1)",
          openMode: "inline",
          expiresAt: 0,
        },
      ],
    });

    await expect(listComputerPorts(capabilities.directory)).rejects.toThrow();
    capabilities.close();
  });

  it("rejects expired previews at the SDK boundary", async () => {
    const capabilities = portsDirectory({
      ports: [
        {
          port: 5173,
          previewUrl: "https://expired.example.test/",
          openMode: "inline",
          expiresAt: 1,
        },
      ],
    });
    await expect(listComputerPorts(capabilities.directory)).rejects.toThrow(
      "Computer preview URL is invalid",
    );
    capabilities.close();
  });

  it("exposes and removes ports through the selected Computer capability", async () => {
    const expose = vi.fn().mockResolvedValue({ port: 5173, exposed: true });
    const unexpose = vi.fn().mockResolvedValue({ port: 5173, removed: true });
    const owner = portsDirectory({ ports: [] }, { expose, unexpose });

    await expect(exposeComputerPort(owner.directory, 5173)).resolves.toEqual({
      port: 5173,
      exposed: true,
    });
    await expect(unexposeComputerPort(owner.directory, 5173)).resolves.toEqual({
      port: 5173,
      removed: true,
    });
    expect(expose).toHaveBeenCalledWith(5173);
    expect(unexpose).toHaveBeenCalledWith(5173);
    owner.close();
  });
});

describe("Agar Computer process capability", () => {
  it("decodes the selected Computer owner's lifecycle inventory", async () => {
    const processes: ComputerProcesses = {
      processes: [
        {
          port: null,
          id: "proc-1",
          command: "node server.js",
          cwd: "/workspace",
          startedAt: 1_750_000_000_000,
          state: "running",
          exitCode: null,
          sync: "synced",
          endedAt: null,
        },
        {
          port: null,
          id: "proc-2",
          command: "npm run build",
          cwd: "/workspace/app",
          startedAt: 1_750_000_000_100,
          state: "exited",
          exitCode: 1,
          sync: "pending",
          endedAt: 1_750_000_000_200,
        },
        {
          port: null,
          id: "proc-3",
          command: "python -m http.server",
          cwd: "/workspace",
          startedAt: 1_749_999_999_000,
          state: "uncertain",
          exitCode: null,
          sync: "synced",
          endedAt: null,
        },
      ],
    };
    const capabilities = processesDirectory(processes);

    await expect(
      listComputerProcesses(capabilities.directory),
    ).resolves.toEqual(processes);
    capabilities.close();
  });

  it("rejects unknown or malformed lifecycle data at the SDK boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(computerProcessesSchema)({
        processes: [
          {
            port: null,
            id: "proc-1",
            command: "node server.js",
            cwd: "/workspace",
            startedAt: 1_750_000_000_000,
            state: "maybe",
            exitCode: null,
            sync: "synced",
            endedAt: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an unknown sync state at the SDK boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(computerProcessesSchema)({
        processes: [
          {
            port: null,
            id: "proc-1",
            command: "node server.js",
            cwd: "/workspace",
            startedAt: 1_750_000_000_000,
            state: "exited",
            exitCode: 0,
            sync: "stale",
            endedAt: 1_750_000_000_100,
          },
        ],
      }),
    ).toThrow();
  });

  it("decodes a kill result from the same Computer owner", async () => {
    const processes: ComputerProcesses = {
      processes: [
        {
          port: null,
          id: "process-1",
          command: "sleep 600",
          cwd: "/workspace",
          startedAt: 1_750_000_000_000,
          state: "exited",
          exitCode: 143,
          sync: "synced",
          endedAt: 1_750_000_000_500,
        },
      ],
    };
    const result = { process: processes.processes[0], signalled: true };
    const capabilities = processesDirectory(processes, result);

    await expect(
      killComputerProcess(capabilities.directory, result.process.id),
    ).resolves.toEqual(result);
    expect(() =>
      Schema.decodeUnknownSync(computerProcessKillSchema)({
        ...result,
        process: { ...result.process, state: "unknown" },
      }),
    ).toThrow();
    capabilities.close();
  });
});

describe("Agar Computer terminal capability", () => {
  it("opens streams and closes the parent-owned session once", async () => {
    const close = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const terminal = new TerminalOwner(
      {
        output: () => Promise.resolve(new ReadableStream<Uint8Array>()),
        input: () => Promise.resolve(new WritableStream<Uint8Array>()),
        resize: vi.fn(() => Promise.resolve()),
        close,
      },
      dispose,
    );
    const capabilities = directory(terminal);
    const controller = new AbortController();

    const opened = await openComputerTerminal(
      capabilities.directory,
      { cols: 80, rows: 24 },
      { signal: controller.signal },
    );
    expect(opened.information.computerName).toBe("Home");
    expect(opened.output).toBeInstanceOf(ReadableStream);
    expect(opened.input).toBeInstanceOf(WritableStream);

    controller.abort();
    await opened.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    capabilities.close();
  });

  it("closes the remote terminal when stream acquisition fails", async () => {
    const close = vi.fn(() => Promise.resolve());
    const terminal = new TerminalOwner(
      {
        output: () => Promise.reject(new Error("output unavailable")),
        input: () => Promise.resolve(new WritableStream<Uint8Array>()),
        resize: vi.fn(() => Promise.resolve()),
        close,
      },
      vi.fn(),
    );

    await expect(
      openComputerTerminal(directory(terminal).directory, {
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow("output unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

type TerminalMethods = Pick<
  AppComputerTerminal,
  "output" | "input" | "resize" | "close"
>;

class TerminalOwner extends RpcTarget {
  constructor(
    readonly methods: TerminalMethods,
    readonly dispose = vi.fn(),
  ) {
    super();
  }

  information() {
    return Promise.resolve({
      computerName: "Home",
      teamName: "Botanical",
      modelDoor: "Team inference",
      uptimeSeconds: 120,
      version: "0.0.0",
    });
  }

  output() {
    return this.methods.output();
  }

  input() {
    return this.methods.input();
  }

  resize(size: { cols: number; rows: number }) {
    return this.methods.resize(size);
  }

  close() {
    return this.methods.close();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

function directory(terminal: TerminalOwner) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, new Owner(terminal));
  const controller = createCapabilityDirectory([
    {
      handle: client,
      id: computerTerminal.id,
      version: computerTerminal.version,
    },
  ]);
  return {
    directory: controller.directory,
    close() {
      controller.disconnect();
      client[Symbol.dispose]();
      peer[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function portsDirectory(
  ports: ComputerPortsResult,
  mutations?: {
    expose: (port: number) => Promise<{ port: number; exposed: boolean }>;
    unexpose: (port: number) => Promise<{ port: number; removed: boolean }>;
  },
) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(
    channel.port2,
    new PortsOwner(ports, mutations),
  );
  const controller = createCapabilityDirectory([
    {
      handle: client,
      id: computerPorts.id,
      version: computerPorts.version,
    },
  ]);
  return {
    directory: controller.directory,
    close() {
      controller.disconnect();
      client[Symbol.dispose]();
      peer[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function processesDirectory(
  processes: ComputerProcesses,
  killResult = { process: processes.processes[0], signalled: false },
) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const owner = new ProcessesOwner(processes, killResult);
  const peer = newMessagePortRpcSession(channel.port2, owner);
  const controller = createCapabilityDirectory([
    {
      handle: client,
      id: computerProcesses.id,
      version: computerProcesses.version,
    },
  ]);
  return {
    directory: controller.directory,
    owner,
    close() {
      controller.disconnect();
      client[Symbol.dispose]();
      peer[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

class Owner extends RpcTarget {
  constructor(readonly terminal: TerminalOwner) {
    super();
  }

  open() {
    return Promise.resolve(this.terminal);
  }
}

class PortsOwner extends RpcTarget {
  constructor(
    readonly ports: ComputerPortsResult,
    readonly mutations?: {
      expose: (port: number) => Promise<{ port: number; exposed: boolean }>;
      unexpose: (port: number) => Promise<{ port: number; removed: boolean }>;
    },
  ) {
    super();
  }

  list() {
    return Promise.resolve(this.ports);
  }

  expose(port: number) {
    return (
      this.mutations?.expose(port) ?? Promise.resolve({ port, exposed: true })
    );
  }

  unexpose(port: number) {
    return (
      this.mutations?.unexpose(port) ?? Promise.resolve({ port, removed: true })
    );
  }
}

class ProcessesOwner extends RpcTarget {
  constructor(
    readonly processes: ComputerProcesses,
    readonly killResult: {
      process: ComputerProcesses["processes"][number];
      signalled: boolean;
    },
  ) {
    super();
  }

  readonly starts: {
    command: string;
    port?: number;
    requestId: string;
  }[] = [];
  start(input: { command: string; port?: number; requestId: string }) {
    this.starts.push(input);
    const process = this.processes.processes.at(0);
    if (!process) throw new Error("Start fixture needs an accepted process");
    return Promise.resolve(process);
  }

  list() {
    return Promise.resolve(this.processes);
  }

  kill() {
    return Promise.resolve(this.killResult);
  }
}

describe("Agar Computer process Start", () => {
  it("sends the same opaque request key and decodes the accepted tracked port", async () => {
    const process: ComputerProcesses["processes"][number] = {
      id: "process-one",
      port: 3000,
      command: "node server.mjs",
      cwd: "/workspace",
      startedAt: 1,
      state: "running",
      exitCode: null,
      sync: "synced",
      endedAt: null,
    };
    const owner = processesDirectory({ processes: [process] });
    const input = {
      command: "node server.mjs",
      port: 3000,
      requestId: "same-click:42",
    };
    try {
      await expect(
        owner.directory.require(computerProcesses).start(input),
      ).resolves.toEqual(process);
      expect(owner.owner.starts).toEqual([input]);
    } finally {
      owner.close();
    }
  });
});
