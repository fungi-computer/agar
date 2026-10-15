import * as z from "zod";
import type { GillCall, GillReply } from "@fungi.computer/gills";
import type { AppBackendGill } from "./gills.js";
export type { AppBackendGill } from "./gills.js";
import {
  backgroundSyncAllowed,
  parseAppMethodCallContext,
  isAppApiMethodName,
  type AppMethodCallContext,
  appApiReservedMethodNames,
} from "@fungi.computer/puffball/app-method-runtime";
import type { AppApi, AppCapabilityId } from "@fungi.computer/puffball";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { pendingSchema, type Pending } from "./pending.js";
import {
  AppMethodRefusal,
  appMethodRefusedReplySchema,
  type AppMethodReply,
} from "./method-refusal.js";

export { pending, pendingSchema, type Pending } from "./pending.js";

/** EVENTS.emit acknowledges delivery with native void, not a JSON value. */
export const appEventEmitResultSchema = z.undefined();

/** App-originated Session send refusal; retry advice is a duration, not a timestamp. */
export const appSendBudgetRefusalSchema = z.strictObject({
  error: z.literal("send_budget_exceeded"),
  retryAfterMs: z.number().int().min(1).max(60_000),
});
/** A declined Session send, with how long to wait before retrying. */
export type AppSendBudgetRefusal = z.output<typeof appSendBudgetRefusalSchema>;

/** A method's schemas own both its TypeScript contract and JSON boundary. */
export type MethodPolicy = Readonly<{
  description: string;
  effect: "read" | "write" | "external";
  requires: readonly AppCapabilityId[];
  /** Omit this method from Workflow and tool discovery; direct calls keep their validators. */
  hidden?: true;
  /** Request anonymous read admission; hosts still require explicit installer approval. */
  anonymous?: true;
  /** Allow the shared Pending result while this method is still working. */
  pending?: true;
}>;

/** Prepared method export consumed by the backend and its build. */
export type AppBackendMethod<Context = void> = Readonly<{
  policy: MethodPolicy;
  input: z.ZodType;
  output: z.ZodType;
  /** Parse the raw input, run the handler, and return its JSON result. */
  call: (
    input: WhistleJsonValue,
    context: Context,
    caller: AppMethodCallContext,
  ) => Promise<WhistleJsonValue>;
}>;

/** Define a typed method once; neither discovery nor builds execute its handler. */
export function defineAppMethod<
  I extends z.ZodType,
  O extends z.ZodType,
  Context = void,
>(
  method: MethodPolicy & {
    input: I;
    output: O;
  } & (
      | {
          pending: true;
          handler: (
            input: z.output<I>,
            context: Context,
            caller: AppMethodCallContext,
          ) => z.input<O> | Pending | Promise<z.input<O> | Pending>;
        }
      | {
          pending?: undefined;
          handler: (
            input: z.output<I>,
            context: Context,
            caller: AppMethodCallContext,
          ) => z.input<O> | Promise<z.input<O>>;
        }
    ),
): AppBackendMethod<Context> {
  const output =
    method.pending === true
      ? z.union([method.output, pendingSchema])
      : method.output;
  let policy: MethodPolicy = {
    description: method.description,
    effect: method.effect,
    requires: Object.freeze([...method.requires]),
  };
  if (method.pending === true) policy = { ...policy, pending: true };
  if (method.hidden === true) policy = { ...policy, hidden: true };
  if (method.anonymous === true) policy = { ...policy, anonymous: true };
  return Object.freeze({
    policy: Object.freeze(policy),
    input: method.input,
    output,
    call: async (rawInput, context, rawCaller) => {
      const caller = parseAppMethodCallContext(rawCaller);
      const parsed = method.input.parse(rawInput);
      const result = await method.handler(parsed, context, caller);
      return z.json().parse(output.parse(result));
    },
  });
}

/** Typed backend export shared by a build and its runtime method admission. */
export type AppBackendClass = (abstract new (...args: never[]) => object) & {
  prototype: object;
};

/** A backend's full generated API: its declared methods, the facet
 * installer, and runtime dispatch by method name. */
export type AppBackendDefinition<Context = void> = Readonly<{
  methods: Readonly<Record<string, AppBackendMethod<Context>>>;
  /** Declared ordinary write method re-admitted for member background work. */
  sync?: Readonly<{ method: string }>;
  /** Generated, digest-covered views of declared read methods. */
  gills?: readonly AppBackendGill[];
  /** Run a declared projection through its source method. */
  gill: (
    input: GillCall,
    context: Context,
    caller: AppMethodCallContext,
  ) => Promise<GillReply>;
  /** Signed discovery metadata; listing never grants authority to execute. */
  toolFamily?: AppApi["toolFamily"];
  /** Event schemas are projected into the Release for host-side emit validation. */
  events?: Readonly<
    Record<string, Readonly<{ description: string; payload: z.ZodType }>>
  >;
  /** Install declared methods on the facet, retaining its exact constructor
   * type. Each installed method answers with an {@link AppMethodReply}. */
  implement: <C extends AppBackendClass>(implementation: C) => C;
  /** Look up a declared method by name and run its `call`, rejecting any
   * name that was not declared. A handler's {@link AppMethodRefusal} is
   * thrown to the caller unchanged. */
  call: (
    method: string,
    input: WhistleJsonValue,
    context: Context,
    caller: AppMethodCallContext,
  ) => Promise<WhistleJsonValue>;
}>;

/** The generated method RPC answers with a typed reply: a handler's
 * {@link AppMethodRefusal} crosses as a refusal, never as an execution failure. */
async function methodReply(
  run: () => Promise<WhistleJsonValue>,
): Promise<AppMethodReply> {
  try {
    return { kind: "ok", value: await run() };
  } catch (error) {
    if (!(error instanceof AppMethodRefusal)) throw error;
    return appMethodRefusedReplySchema.parse({
      kind: "refused",
      code: error.code,
      message: error.message,
    });
  }
}

/** Generate the API from the method exports; callers cannot supply a second catalog. */
export function defineAppBackend<Context = void>(
  options: Readonly<{
    methods: Readonly<Record<string, AppBackendMethod<Context>>>;
    events?: AppBackendDefinition<Context>["events"];
    gills?: readonly AppBackendGill[];
    sync?: AppBackendDefinition<Context>["sync"];
    toolFamily?: AppBackendDefinition<Context>["toolFamily"];
  }>,
): AppBackendDefinition<Context> {
  const methods = new Map(Object.entries(options.methods));
  for (const name of methods.keys())
    if (!isAppApiMethodName(name))
      throw new Error(`Invalid App backend method name: ${name}`);
  if (
    !backgroundSyncAllowed(
      {
        methods: Object.fromEntries(
          [...methods].map(([name, method]) => [name, method.policy]),
        ),
      },
      options.sync,
    )
  )
    throw new Error(
      "Background continuation must be a declared write covering all write requirements",
    );
  const call = async (
    name: string,
    input: WhistleJsonValue,
    context: Context,
    caller: AppMethodCallContext,
  ) => {
    const method = methods.get(name);
    if (!method) throw new Error(`Undeclared App backend method: ${name}`);
    return method.call(input, context, caller);
  };
  const gills = new Map<string, AppBackendGill>();
  for (const view of options.gills ?? []) {
    if (gills.has(view.declaration.id))
      throw new Error(`Duplicate App Gill: ${view.declaration.id}`);
    gills.set(view.declaration.id, view);
  }
  const gill = async (
    raw: GillCall,
    context: Context,
    caller: AppMethodCallContext,
  ): Promise<GillReply> => {
    const first = options.gills?.[0];
    if (first === undefined) throw new Error("Undeclared App Gill");
    const selection = first.parseCall(raw);
    const view = gills.get(selection.id);
    if (!view) throw new Error(`Undeclared App Gill: ${selection.id}`);
    const method = methods.get(view.declaration.source);
    if (method?.policy.effect !== "read")
      throw new Error(
        `App Gill source must be a declared read method: ${view.declaration.source}`,
      );
    return view.call(selection, async (name, input, kind) => {
      const source = methods.get(name);
      if (source?.policy.effect !== "read")
        throw new Error(
          kind === "options"
            ? "Gill options source must be a declared read method"
            : `App Gill source must be a declared read method: ${name}`,
        );
      return source.call(input, context, caller);
    });
  };
  let definition: AppBackendDefinition<Context> = {
    methods: Object.freeze({ ...options.methods }),
    implement: <C extends AppBackendClass>(implementation: C): C => {
      const members = new Map<string, PropertyDescriptor>();
      let prototype: object | null = implementation.prototype;
      while (prototype !== null && prototype !== Object.prototype) {
        for (const [name, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(prototype),
        )) {
          if (!members.has(name)) members.set(name, descriptor);
        }
        prototype = Reflect.getPrototypeOf(prototype);
      }
      const allowed = new Set<string>([
        ...appApiReservedMethodNames.intrinsic,
        ...appApiReservedMethodNames.lifecycle,
      ]);
      for (const [name, descriptor] of members) {
        if (descriptor.get !== undefined || descriptor.set !== undefined)
          throw new Error(`App backend accessor unavailable: ${name}`);
        if (methods.has(name))
          throw new Error(`App backend method must be generated: ${name}`);
        if (
          allowed.has(name) &&
          (name === "constructor" ||
            z.function().safeParse(descriptor.value).success)
        )
          continue;
        throw new Error(`Undeclared App backend method: ${name}`);
      }
      for (const name of methods.keys())
        Object.defineProperty(implementation.prototype, name, {
          value: function (
            this: Context,
            input: WhistleJsonValue,
            caller: AppMethodCallContext,
          ) {
            return methodReply(() =>
              definition.call(name, input, this, caller),
            );
          },
        });
      if (gills.size > 0)
        Object.defineProperty(implementation.prototype, "gill", {
          value: function (
            this: Context,
            input: GillCall,
            caller: AppMethodCallContext,
          ) {
            return definition.gill(input, this, caller);
          },
        });
      return implementation;
    },
    call,
    gill,
  };
  if (options.sync !== undefined)
    definition = { ...definition, sync: Object.freeze({ ...options.sync }) };
  if (options.gills !== undefined)
    definition = { ...definition, gills: Object.freeze([...options.gills]) };
  if (options.events !== undefined)
    definition = {
      ...definition,
      events: Object.freeze({ ...options.events }),
    };
  if (options.toolFamily !== undefined)
    definition = {
      ...definition,
      toolFamily: Object.freeze({ ...options.toolFamily }),
    };
  return Object.freeze(definition);
}
