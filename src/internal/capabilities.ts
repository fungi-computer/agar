import type {
  CapabilityContract,
  CapabilityDirectory,
} from "../capabilities.js";
import type { CapabilityGrantWire } from "./protocol.js";

import { AppError } from "../errors.js";
import * as z from "zod";
import * as Schema from "effect/Schema";
import { parseCapabilityGrant } from "./schemas.js";
import { createReadonlyStore } from "./store.js";

export type CapabilityDirectoryController = {
  readonly directory: CapabilityDirectory;
  replace(values: readonly CapabilityGrantWire[]): void;
  disconnect(): void;
};

export function createCapabilityDirectory(
  values: readonly CapabilityGrantWire[],
): CapabilityDirectoryController {
  const grants = new Map<string, object>();
  const version = createReadonlyStore(0);
  let disconnected = false;

  const decode = (nextValues: readonly CapabilityGrantWire[]) => {
    const next = new Map<string, object>();
    try {
      for (const value of nextValues) {
        const grant = parseCapabilityGrant(value);
        const key = capabilityKey(grant.id, grant.version);
        if (next.has(key)) {
          disposeRpcValue(grant.handle);
          throw new AppError("Duplicate capability grant", {
            code: "PROTOCOL",
            retryable: false,
          });
        }
        // Do not clone or freeze an object-capability handle.
        next.set(key, grant.handle);
      }
    } catch (cause) {
      for (const handle of next.values()) disposeRpcValue(handle);
      throw cause;
    }
    return next;
  };
  for (const [key, handle] of decode(values)) grants.set(key, handle);

  const dispose = (handles: Iterable<object>): void => {
    for (const handle of handles) disposeRpcValue(handle);
  };

  const find = (contract: CapabilityContract<unknown>): object | undefined => {
    if (disconnected) {
      throw new AppError("The app connection is disposed", {
        code: "DISCONNECTED",
        retryable: true,
      });
    }
    const key = capabilityKey(contract.id, contract.version);
    return grants.get(key);
  };

  const directory: CapabilityDirectory = Object.freeze({
    get version() {
      return version.get();
    },
    subscribe: (listener) => version.subscribe(listener),
    has(contract: CapabilityContract<unknown>) {
      return Boolean(find(contract));
    },
    require<T>(contract: CapabilityContract<T>): T {
      const handle = find(contract);
      if (!handle) {
        throw new AppError("The capability is not granted", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      }
      try {
        return contract.schema.parse(handle);
      } catch (cause) {
        throw new AppError("The capability interface is malformed", {
          cause,
          code: "PROTOCOL",
          retryable: false,
        });
      }
    },
  });
  return {
    directory,
    replace(values) {
      if (disconnected)
        throw new AppError("The app connection is disposed", {
          code: "DISCONNECTED",
          retryable: true,
        });
      const next = decode(values);
      const previous = [...grants.values()];
      grants.clear();
      for (const [key, handle] of next) grants.set(key, handle);
      dispose(
        previous.filter((handle) => ![...next.values()].includes(handle)),
      );
      version.update(version.get() + 1);
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      dispose(grants.values());
      grants.clear();
      version.update(version.get() + 1);
    },
  };
}

const rpcDisposalSchema = z.unknown().transform((value) => {
  const result = z.instanceof(Object).safeParse(value);
  if (!result.success) return undefined;
  const view: unknown = Object.create(result.data);
  const fields = Schema.decodeUnknownSync(
    Schema.Struct({
      [Symbol.dispose]: Schema.optional(Schema.instanceOf(Function)),
    }),
  )(view);
  return { owner: result.data, dispose: fields[Symbol.dispose] };
});

export function disposeRpcValue(value: unknown): void {
  try {
    const disposal = rpcDisposalSchema.parse(value);
    if (disposal === undefined || disposedValues.has(disposal.owner)) return;
    disposedValues.add(disposal.owner);
    disposal.dispose?.call(disposal.owner);
  } catch (cause) {
    console.warn("RPC value disposal failed", cause);
  }
}

/** Own a Cap'n Web result until its decoded data has been copied. */
export function ownedRpcValue<T extends Partial<Disposable>>(
  value: T,
): Readonly<{ value: T }> & Disposable {
  return {
    value,
    [Symbol.dispose]() {
      disposeRpcValue(value);
    },
  };
}

const disposedValues = new WeakSet();

function capabilityKey(id: string, version: number): string {
  return `${id}@${String(version)}`;
}
