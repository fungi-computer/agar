import { RpcStub, RpcTarget } from "@fungi.computer/capnweb";
import { describe, expect, it, vi } from "vitest";

import { computerList } from "../computer.js";
import { createCapabilityDirectory } from "./capabilities.js";

class Handle extends RpcTarget {
  readonly disposeSpy = vi.fn();

  [Symbol.dispose](): void {
    this.disposeSpy();
  }
}

function grant(handle: Handle) {
  return {
    id: computerList.id,
    version: computerList.version,
    handle: new RpcStub(handle),
  };
}

describe("capability directory replacement", () => {
  it("keeps one directory identity and swaps only after a valid candidate decodes", () => {
    const first = new Handle();
    const candidate = new Handle();
    const second = new Handle();
    const invalid = new Handle();
    const controller = createCapabilityDirectory([grant(first)]);
    const directory = controller.directory;
    const changes: number[] = [];
    const unsubscribe = directory.subscribe(() => {
      changes.push(directory.version);
    });

    expect(directory.version).toBe(0);
    expect(directory.has(computerList)).toBe(true);
    expect(() => {
      controller.replace([grant(candidate), grant(invalid)]);
    }).toThrow();
    expect(directory.has(computerList)).toBe(true);
    expect(first.disposeSpy).not.toHaveBeenCalled();
    expect(candidate.disposeSpy).toHaveBeenCalledOnce();
    expect(changes).toEqual([]);

    controller.replace([grant(second)]);
    expect(controller.directory).toBe(directory);
    expect(first.disposeSpy).toHaveBeenCalledOnce();
    expect(changes).toEqual([1]);
    controller.disconnect();
    controller.disconnect();
    expect(second.disposeSpy).toHaveBeenCalledOnce();
    expect(changes).toEqual([1, 2]);
    expect(() => directory.has(computerList)).toThrow(
      expect.objectContaining({ code: "DISCONNECTED" }),
    );
    unsubscribe();
  });

  it("notifies after the new grants are readable and releases unsubscribed listeners", () => {
    const controller = createCapabilityDirectory([]);
    const observed: boolean[] = [];
    const unsubscribe = controller.directory.subscribe(() => {
      observed.push(controller.directory.has(computerList));
    });
    controller.replace([grant(new Handle())]);
    controller.replace([]);
    expect(observed).toEqual([true, false]);
    unsubscribe();
    unsubscribe();
    controller.replace([grant(new Handle())]);
    controller.disconnect();
    expect(observed).toEqual([true, false]);
    expect(controller.directory.version).toBe(4);
  });
});
