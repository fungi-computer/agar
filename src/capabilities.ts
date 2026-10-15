import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as z from "zod";
import { AppError } from "./errors.js";
import { createReadonlyStore } from "./internal/store.js";
import type { Disposer } from "./store.js";

/** A capability owner's frozen, typed descriptor. Descriptor identity is not authority. */
export type CapabilityContract<T> = {
  readonly id: string;
  readonly version: number;
  readonly schema: z.ZodType<T>;
};

class DefinedCapability<T> implements CapabilityContract<T> {
  readonly #schema: z.ZodType<T>;

  constructor(
    readonly id: string,
    readonly version: number,
    schema: z.ZodType<T>,
  ) {
    this.#schema = schema;
    Object.freeze(this);
  }

  // Only id/version travel with a wire grant; the parser stays with its owner.
  get schema(): z.ZodType<T> {
    return this.#schema;
  }
}

/** Define a capability with the owner's decoder for its live RPC interface. */
export function defineCapability<T>(
  id: string,
  version: number,
  schema: z.ZodType<T>,
): CapabilityContract<T> {
  return new DefinedCapability(id, version, schema);
}
/** The App's read-only view of its currently admitted capabilities. */
export type CapabilityDirectory = {
  /** Changes after a successful grant replacement or disconnection. */
  readonly version: number;
  /** Read the current directory after a change. Does not emit on subscribe. */
  subscribe(listener: () => void): Disposer;
  /** Whether an implementation for this contract is currently admitted. */
  has(contract: CapabilityContract<unknown>): boolean;
  /** The admitted implementation for this contract, or throw a
   * `CAPABILITY_DENIED` AppError when none is granted. */
  require<T>(contract: CapabilityContract<T>): T;
};

/** Local capabilities admitted through their owner's typed contract. */
export type CapabilityRegistry = CapabilityDirectory & {
  /** Admit an implementation for this contract, replacing any previous one
   * and bumping `version` so subscribers can react. */
  provide: <T>(
    contract: CapabilityContract<T>,
    implementation: NoInfer<T>,
  ) => void;
};

/** Register typed local implementations without reopening their erased types. */
export function createCapabilityRegistry(): CapabilityRegistry {
  let services = Context.empty();
  const version = createReadonlyStore(0);
  const key = <T>(contract: CapabilityContract<T>) =>
    Context.Service<T>(`${contract.id}@${String(contract.version)}`);
  return {
    get version() {
      return version.get();
    },
    subscribe: (listener) => version.subscribe(listener),
    provide: <T>(
      contract: CapabilityContract<T>,
      implementation: NoInfer<T>,
    ) => {
      services = Context.add(services, key(contract), implementation);
      version.update(version.get() + 1);
    },
    has: (contract) =>
      Option.isSome(Context.getOption(services, key(contract))),
    require<T>(contract: CapabilityContract<T>): T {
      const implementation = Context.getOption(services, key(contract));
      if (Option.isSome(implementation)) return implementation.value;
      throw new AppError("The capability is not granted", {
        code: "CAPABILITY_DENIED",
        retryable: false,
      });
    },
  };
}
