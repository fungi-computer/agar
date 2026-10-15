import { describe, expect, it } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import { createCapabilityDirectory } from "./internal/capabilities.js";
import {
  computerInstrumentRead,
  computerInstrumentControl,
  readComputerInstrument,
  startInstrumentComputer,
  setInstrumentInternetAccess,
  detachInstrumentLocalBackend,
} from "./computer.js";

type InstrumentFixtureSnapshot = typeof snapshot;

class InstrumentOwner extends RpcTarget {
  constructor(readonly snapshot: InstrumentFixtureSnapshot) {
    super();
  }
  read() {
    return Promise.resolve(this.snapshot);
  }
  start() {
    return Promise.resolve({ state: "running" });
  }
  setInternetAccess(enabled: boolean) {
    return Promise.resolve({ enabled, effective: enabled, blockedBy: null });
  }
  detachLocal() {
    return Promise.resolve({ detached: true });
  }
}

function instrument(snapshot: InstrumentFixtureSnapshot) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(
    channel.port2,
    new InstrumentOwner(snapshot),
  );
  const controller = createCapabilityDirectory([
    {
      handle: client,
      id: computerInstrumentRead.id,
      version: computerInstrumentRead.version,
    },
    {
      handle: client,
      id: computerInstrumentControl.id,
      version: computerInstrumentControl.version,
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

const snapshot = {
  computerId: "computer_one",
  name: "Workspace",
  runtime: { state: "queued", position: 2 },
  backends: [
    {
      id: "local-abcdefghijklmnop",
      kind: "local",
      status: "offline",
      queuePosition: null,
      hostId: null,
      hostLabel: "Laptop",
      folderLabel: "Code",
      detachable: true,
    },
  ],
  internet: { enabled: true, effective: false, blockedBy: "team" },
};

describe("Computer instrument capability", () => {
  it("decodes the selected Computer snapshot and controls", async () => {
    const owner = instrument(snapshot);
    try {
      await expect(readComputerInstrument(owner.directory)).resolves.toEqual(
        snapshot,
      );
      await expect(startInstrumentComputer(owner.directory)).resolves.toEqual({
        state: "running",
      });
      await expect(
        setInstrumentInternetAccess(owner.directory, false),
      ).resolves.toEqual({ enabled: false, effective: false, blockedBy: null });
      await expect(
        detachInstrumentLocalBackend(owner.directory, "local-abcdefghijklmnop"),
      ).resolves.toEqual({ detached: true });
    } finally {
      owner.close();
    }
  });

  it("rejects malformed host metadata at the RPC boundary", async () => {
    const owner = instrument({
      ...snapshot,
      runtime: { state: "queued", position: 0 },
    });
    try {
      await expect(readComputerInstrument(owner.directory)).rejects.toThrow();
    } finally {
      owner.close();
    }
  });
});
