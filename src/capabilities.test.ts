import * as z from "zod";
import { expect, expectTypeOf, it } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import { AppError } from "./errors.js";
import {
  createCapabilityDirectory,
  disposeRpcValue,
} from "./internal/capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
} from "./internal/rpc-contract.js";
import {
  createCapabilityRegistry,
  defineCapability,
  type CapabilityContract,
} from "./capabilities.js";

it("requires callable RPC methods after extracting the owner view", async () => {
  const schema = rpcHandleSchema({ read: rpcMethod(z.string()) });
  expect(() => schema.parse({})).toThrow(z.ZodError);
  expect(() => schema.parse({ read: "not callable" })).toThrow(z.ZodError);
  const owner = {
    value: "owned",
    read() {
      return Promise.resolve(this.value);
    },
  };
  await expect(schema.parse(owner).read()).resolves.toBe("owned");
  await expect(
    schema.parse({ read: () => Promise.resolve(42) }).read(),
  ).rejects.toMatchObject({ code: "PROTOCOL", retryable: false });
});

it("binds class and celld virtual methods without requiring a has trap", async () => {
  class Reader {
    value = "class owner";
    read() {
      return Promise.resolve(this.value);
    }
  }
  const virtual = new Proxy(
    {},
    {
      get(_target, name) {
        return name === "read"
          ? () => Promise.resolve("virtual owner")
          : undefined;
      },
    },
  );
  const schema = rpcHandleSchema({ read: rpcMethod(z.string()) });
  expect("read" in virtual).toBe(false);
  await expect(schema.parse(virtual).read()).resolves.toBe("virtual owner");
  await expect(schema.parse(new Reader()).read()).resolves.toBe("class owner");
  expect(() => schema.parse({})).toThrow(z.ZodError);
});

it("keeps typed implementations separate by owner ID and version", () => {
  const first: CapabilityContract<{ read(): string }> = defineCapability(
    "test.read",
    1,
    z.object({ read: z.function({ output: z.string() }) }),
  );
  const second: CapabilityContract<{ read(): number }> = defineCapability(
    "test.read",
    2,
    z.object({ read: z.function({ output: z.number() }) }),
  );
  const absent: CapabilityContract<{ read(): boolean }> = defineCapability(
    "test.absent",
    1,
    z.object({ read: z.function({ output: z.boolean() }) }),
  );
  const registry = createCapabilityRegistry();
  const changes: string[] = [];
  const unsubscribe = registry.subscribe(() => {
    changes.push(registry.require(first).read());
  });
  registry.provide(first, { read: () => "first" });
  registry.provide(second, { read: () => 2 });
  expectTypeOf(registry.require(first).read()).toEqualTypeOf<string>();
  expectTypeOf(registry.require(second).read()).toEqualTypeOf<number>();
  expect(registry.require(first).read()).toBe("first");
  expect(registry.require(second).read()).toBe(2);
  expect(registry.has(absent)).toBe(false);
  expect(() => registry.require(absent)).toThrow(
    expect.objectContaining({ code: "CAPABILITY_DENIED", retryable: false }),
  );
  registry.provide(first, { read: () => "replacement" });
  expect(registry.require(first).read()).toBe("replacement");
  expect(changes).toEqual(["first", "first", "replacement"]);
  expect(registry.version).toBe(3);
  unsubscribe();
  registry.provide(first, { read: () => "after unsubscribe" });
  expect(changes).toHaveLength(3);
});

it("keeps owner decoders out of serialized grant descriptors", () => {
  const contract: CapabilityContract<{ read(): Promise<string> }> =
    defineCapability(
      "test.read",
      1,
      rpcHandleSchema({
        read: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => z.string().parse(value)),
          ),
        ),
      }),
    );
  expect({ ...contract }).toEqual({ id: "test.read", version: 1 });
  expect(Object.isFrozen(contract)).toBe(true);
});

it("decodes native RPC results with the requested owner's schema and retains failure causes", async () => {
  class Reader extends RpcTarget {
    constructor(readonly value: string | number) {
      super();
    }
    read() {
      return this.value;
    }
  }
  const contract: CapabilityContract<{ read(): Promise<string> }> =
    defineCapability(
      "test.read",
      1,
      rpcHandleSchema({
        read: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => z.string().parse(value)),
          ),
        ),
      }),
    );
  for (const value of ["valid", 42]) {
    const channel = new MessageChannel();
    const client = newMessagePortRpcSession<Reader>(channel.port1);
    const peer = newMessagePortRpcSession(channel.port2, new Reader(value));
    const controller = createCapabilityDirectory([
      { ...contract, handle: client },
    ]);
    try {
      const handle = controller.directory.require(contract);
      expectTypeOf<ReturnType<typeof handle.read>>().toEqualTypeOf<
        Promise<string>
      >();
      if (value === "valid") {
        await expect(handle.read()).resolves.toBe(value);
      } else {
        const result = await handle.read().then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(result).toBeInstanceOf(AppError);
        expect(result).toMatchObject({ code: "PROTOCOL", retryable: false });
        if (!(result instanceof AppError))
          throw new Error("Expected a typed protocol refusal");
        expect(result.cause).toBeInstanceOf(z.ZodError);
      }
    } finally {
      controller.disconnect();
      disposeRpcValue(peer);
      channel.port1.close();
      channel.port2.close();
    }
  }
});
