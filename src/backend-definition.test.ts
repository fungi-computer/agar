import { defineAppGill } from "./gills.js";
const memberCaller = {
  computerId: null,
  actor: { kind: "member" as const, memberId: "member_fixture" },
};
import type { GillResponse } from "@fungi.computer/gills";
import type { AppMethodCallContext } from "@fungi.computer/puffball/app-method-runtime";
import { buildAppDeclaration, buildAppApi } from "./backend-declaration.js";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { AppMethodRefusal, type AppMethodReply } from "./method-refusal.js";
import * as z from "zod";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import {
  appBuildJsonSchema,
  appApiReservedMethodNames,
  createAppBuild,
} from "@fungi.computer/puffball/app";
import { parseArtifactRef, parseSha256Digest } from "@fungi.computer/puffball";
import {
  defineAppBackend,
  defineAppMethod,
  appEventEmitResultSchema,
  pending,
  type Pending,
  type AppBackendMethod,
  type MethodPolicy,
} from "./backend-definition.js";

test("EVENTS.emit keeps its native void acknowledgement", () => {
  expect(appEventEmitResultSchema.safeParse(undefined)).toEqual({
    success: true,
    data: undefined,
  });
  for (const reply of [null, {}, { error: "not_granted" }])
    expect(appEventEmitResultSchema.safeParse(reply).success).toBe(false);
});

describe("typed App backend exports", () => {
  test("projects an anonymous read request into the digest-covered API without granting admission", () => {
    const anonymousPolicy = { anonymous: true } satisfies Pick<
      MethodPolicy,
      "anonymous"
    >;
    const method = defineAppMethod({
      description: "Read a frozen public copy",
      effect: "read",
      requires: [],
      ...anonymousPolicy,
      input: z.strictObject({ token: z.string() }),
      output: z.strictObject({ bytes: z.string(), sha256: z.string() }),
      handler: () => ({ bytes: "{}", sha256: "digest" }),
    });
    expect(
      buildAppApi(defineAppBackend({ methods: { readCopy: method } })).methods
        .readCopy,
    ).toHaveProperty("anonymous", true);
  });

  test("signs the declared tool family without executing its methods", () => {
    const handler = vi.fn(() => ({}));
    const backend = defineAppBackend({
      toolFamily: {
        name: "flows",
        list: "listWorkflowTools",
        call: "runWorkflow",
      },
      methods: {
        listWorkflowTools: defineAppMethod({
          description: "List published tools",
          effect: "read",
          requires: [],
          hidden: true,
          input: z.strictObject({}),
          output: z.strictObject({}),
          handler,
        }),
        runWorkflow: defineAppMethod({
          description: "Run a published Workflow",
          effect: "write",
          requires: ["workflow.run"],
          input: z.strictObject({}),
          output: z.strictObject({}),
          handler,
        }),
      },
    });
    const api = buildAppApi(backend);
    expect(api).toMatchObject({
      toolFamily: {
        name: "flows",
        list: "listWorkflowTools",
        call: "runWorkflow",
      },
    });
    expect(
      buildAppDeclaration(backend, {
        capabilities: ["workflow.run"],
        handlers: [],
        roles: [],
      }).api,
    ).toEqual(api);
    expect(handler).not.toHaveBeenCalled();
  });
  test("projects hidden discovery metadata without changing direct method validation", async () => {
    const method = defineAppMethod({
      description: "Rebuild internal copies",
      effect: "read",
      requires: [],
      hidden: true,
      input: z.null(),
      output: z.string(),
      handler: () => "rebuilt",
    });
    const backend = defineAppBackend({ methods: { rebuildCopies: method } });
    expect(buildAppApi(backend).methods.rebuildCopies).toHaveProperty(
      "hidden",
      true,
    );
    await expect(
      backend.call("rebuildCopies", null, undefined, memberCaller),
    ).resolves.toBe("rebuilt");
    await expect(
      backend.call("rebuildCopies", 1, undefined, memberCaller),
    ).rejects.toThrow();
  });

  test("a method without the opt-in keeps its completed output contract", async () => {
    type Definition = Parameters<
      typeof defineAppMethod<z.ZodNull, z.ZodString>
    >[0];
    type Ordinary = Extract<Definition, { pending?: undefined }>;
    expectTypeOf<ReturnType<Ordinary["handler"]>>().toEqualTypeOf<
      string | Promise<string>
    >();
    const method = defineAppMethod({
      description: "Read status",
      effect: "read",
      requires: [],
      input: z.null(),
      output: z.string(),
      handler: () => "finished",
    });
    await expect(method.call(null, undefined, memberCaller)).resolves.toBe(
      "finished",
    );
    expect(method.policy.pending).toBeUndefined();
    expect(method.output.safeParse(pending(5000)).success).toBe(false);
  });
  test("an opted-in method can poll and then complete using its declared output", async () => {
    const handler = (_input: null, context: { running: boolean }) =>
      context.running ? pending(5000) : { exitCode: 0 };
    expectTypeOf<ReturnType<typeof handler>>().toEqualTypeOf<
      Pending | { exitCode: number }
    >();
    const method = defineAppMethod({
      description: "Wait for a process",
      effect: "write",
      requires: [],
      pending: true,
      input: z.null(),
      output: z.strictObject({ exitCode: z.number().int() }),
      handler,
    });
    await expect(
      method.call(null, { running: true }, memberCaller),
    ).resolves.toEqual({
      kind: "pending",
      retryAfterMs: 5000,
    });
    await expect(
      method.call(null, { running: false }, memberCaller),
    ).resolves.toEqual({ exitCode: 0 });
    expect(method.policy.pending).toBe(true);
    expect(
      method.output.safeParse({ kind: "pending", retryAfterMs: 999 }).success,
    ).toBe(false);
  });
  test("method policy and copied capability requirements cannot be changed by declaration code", () => {
    const requires: ("computer.writeFile" | "computer.readFile")[] = [
      "computer.writeFile",
    ];
    const method = defineAppMethod({
      description: "Write own file",
      effect: "write",
      requires,
      input: z.object({}),
      output: z.null(),
      handler: () => null,
    });
    expect(Reflect.set(requires, "0", "computer.readFile")).toBe(true);
    expect(method.policy.requires).toEqual(["computer.writeFile"]);
    expect(Reflect.set(method.policy, "effect", "read")).toBe(false);
    expect(Reflect.set(method.policy.requires, "0", "computer.readFile")).toBe(
      false,
    );
    expect(method.policy.effect).toBe("write");
    expect(method.policy.requires).toEqual(["computer.writeFile"]);
  });
  test("a generated method returns an App refusal as a typed reply and keeps faults thrown", async () => {
    const backend = defineAppBackend({
      methods: {
        remove: defineAppMethod({
          input: z.object({ name: z.string() }),
          output: z.object({ deleted: z.literal(true) }),
          description: "Remove",
          effect: "write",
          requires: [],
          handler: ({ name }) => {
            if (name === "forked")
              throw new AppMethodRefusal("conflict", "Delete its forks first");
            if (name === "verbose")
              throw new AppMethodRefusal("invalid", "x".repeat(501));
            if (name === "broken") throw new Error("storage fault");
            return { deleted: true as const };
          },
        }),
      },
    });
    class Removal {
      declare remove: (
        input: { name: string },
        caller: AppMethodCallContext,
      ) => Promise<AppMethodReply>;
    }
    const instance = new (backend.implement(Removal))();
    await expect(
      instance.remove({ name: "forked" }, memberCaller),
    ).resolves.toEqual({
      kind: "refused",
      code: "conflict",
      message: "Delete its forks first",
    });
    await expect(
      instance.remove({ name: "pond" }, memberCaller),
    ).resolves.toEqual({ kind: "ok", value: { deleted: true } });
    await expect(
      instance.remove({ name: "broken" }, memberCaller),
    ).rejects.toThrow("storage fault");
    // An unbounded App message is a contract defect, never a silent truncation.
    await expect(
      instance.remove({ name: "verbose" }, memberCaller),
    ).rejects.toThrow();
    // Direct dispatch keeps the App's own refusal for its own routes.
    await expect(
      backend.call("remove", { name: "forked" }, undefined, memberCaller),
    ).rejects.toBeInstanceOf(AppMethodRefusal);
  });
  test("facet class registration generates declared methods and refuses bypasses", async () => {
    const handler = vi.fn(
      ({ text }: { text: string }, context: { prefix: string }) =>
        `${context.prefix}${text}`,
    );
    const backend = defineAppBackend({
      methods: {
        echo: defineAppMethod({
          input: z.object({ text: z.string() }),
          output: z.string(),
          description: "Echo",
          effect: "read",
          requires: [],
          handler,
        }),
      },
    });
    class Echo {
      constructor(readonly prefix: string) {}
      declare echo: (
        input: { text: string | number },
        caller: import("@fungi.computer/puffball/app").AppMethodCallContext,
      ) => Promise<AppMethodReply>;
    }
    const Checked = backend.implement(Echo);
    expectTypeOf(Checked).toEqualTypeOf<typeof Echo>();
    const instance = new Checked("own:");
    expect(Object.hasOwn(Checked.prototype, "gill")).toBe(false);
    await expect(
      instance.echo({ text: "hello" }, memberCaller),
    ).resolves.toEqual({ kind: "ok", value: "own:hello" });
    expect(handler).toHaveBeenCalledOnce();
    await expect(instance.echo({ text: 1 }, memberCaller)).rejects.toThrow();
    expect(handler).toHaveBeenCalledOnce();
    class Missing {
      constructor(readonly prefix: string) {}
    }
    expect(backend.implement(Missing)).toBe(Missing);
    class Handwritten {
      echo() {
        return "bypass";
      }
    }
    expect(() => backend.implement(Handwritten)).toThrow(/generated/);
    class Extra extends Missing {
      secret() {
        return "hidden";
      }
    }
    expect(() => backend.implement(Extra)).toThrow(/Undeclared/);
    class InheritedExtra extends Extra {}
    expect(() => backend.implement(InheritedExtra)).toThrow(/Undeclared/);
    class Getter {
      constructor(readonly value: string) {}
      get secret() {
        return this.value;
      }
    }
    expect(() => backend.implement(Getter)).toThrow(/accessor/);
    class PromiseLike {
      fetch() {
        return new Response();
      }
    }
    Object.defineProperty(
      PromiseLike.prototype,
      appApiReservedMethodNames.rpc[0],
      {
        value: () => "hidden",
      },
    );
    expect(() => backend.implement(PromiseLike)).toThrow(/Undeclared/);
    class Duplicate {
      dup() {
        return "hidden";
      }
    }
    expect(() => backend.implement(Duplicate)).toThrow(/Undeclared/);
    class Lifecycle {
      fetch() {
        return new Response();
      }
      alarm() {
        return Promise.resolve();
      }
      webSocketMessage() {
        return Promise.resolve();
      }
      webSocketClose() {
        return Promise.resolve();
      }
      webSocketError() {
        return Promise.resolve();
      }
    }
    expect(backend.implement(Lifecycle)).toBe(Lifecycle);
  });
  test("handlers receive the calling instance's context, never module-level Team state", async () => {
    const backend = defineAppBackend({
      methods: {
        count: defineAppMethod({
          input: z.object({}),
          output: z.number(),
          description: "Read count",
          effect: "read",
          requires: [],
          handler: (_input, context: { count: number }) => context.count,
        }),
      },
    });
    await expect(
      backend.call("count", {}, { count: 1 }, memberCaller),
    ).resolves.toBe(1);
    await expect(
      backend.call("count", {}, { count: 2 }, memberCaller),
    ).resolves.toBe(2);
  });
  test("the build emits declared event payload schemas alongside methods", () => {
    const backend = defineAppBackend({
      methods: {},
      events: {
        "git.push": {
          description: "A repository accepted a push",
          payload: z.strictObject({
            type: z.literal("git.push"),
            timestamp: z.string(),
            data: z.strictObject({ branch: z.string() }),
          }),
        },
      },
    });
    const api = buildAppApi(backend);
    expect(api).toEqual({
      methods: {},
      events: {
        "git.push": {
          description: "A repository accepted a push",
          payload: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              type: { type: "string", const: "git.push" },
              timestamp: { type: "string" },
              data: {
                type: "object",
                properties: { branch: { type: "string" } },
                required: ["branch"],
                additionalProperties: false,
              },
            },
            required: ["type", "timestamp", "data"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(
      buildAppDeclaration(backend, {
        capabilities: [],
        handlers: [],
        roles: [],
      }).api,
    ).toEqual(api);
    expect(buildAppApi(defineAppBackend({ methods: {} }))).toEqual({
      methods: {},
    });
  });

  test("the build emits schemas from the serving method exports without executing handlers", () => {
    const handler = vi.fn(({ prompt }: { prompt: string }) => ({ prompt }));
    const compile = (input: z.ZodType<{ prompt: string }>) => {
      const backend = defineAppBackend({
        methods: {
          generate: defineAppMethod({
            input,
            output: z.object({ prompt: z.string() }),
            description: "Generate an image",
            effect: "write",
            requires: ["media.generation"],
            handler,
          }),
        },
      });
      const declaration = buildAppDeclaration(backend, {
        capabilities: ["media.generation"],
        handlers: [],
        roles: ["media"],
      });
      return Schema.encodeUnknownSync(appBuildJsonSchema)(
        createAppBuild(
          null,
          {
            artifactRef: parseArtifactRef("artifact:backend"),
            digest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
            version: "1",
            byteLength: 1,
            mediaType: "application/vnd.fungi.app-backend+json",
          },
          declaration,
        ),
      );
    };
    const first = compile(z.object({ prompt: z.string() }));
    const changed = compile(z.object({ prompt: z.string().max(200) }));
    expect(handler).not.toHaveBeenCalled();
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(changed).declaration?.api
        ?.methods.generate.input,
    ).toMatchObject({
      type: "object",
      properties: { prompt: { type: "string", maxLength: 200 } },
      required: ["prompt"],
    });
    const digest = (bytes: string) =>
      createHash("sha256").update(bytes).digest("hex");
    expect(digest(first)).not.toBe(digest(changed));
  });

  test("typed handlers and the admitted method table share JSON input/output parsing", async () => {
    const backend = defineAppBackend({
      methods: {
        echo: defineAppMethod({
          input: z.object({ text: z.string() }),
          output: z.object({ text: z.string() }),
          description: "Echo text",
          effect: "read",
          requires: [],
          handler: (input) => {
            expectTypeOf(input).toEqualTypeOf<{ text: string }>();
            return { text: input.text };
          },
        }),
      },
    });
    await expect(
      backend.call("echo", { text: "hello" }, undefined, memberCaller),
    ).resolves.toEqual({
      text: "hello",
    });
    await expect(
      backend.call("echo", { text: 1 }, undefined, memberCaller),
    ).rejects.toThrow();
    for (const name of ["secret", "constructor", "toString", "fetch"]) {
      await expect(
        backend.call(name, {}, undefined, memberCaller),
      ).rejects.toThrow(/Undeclared/);
    }
  });

  test("rejects invalid input before a handler can run", async () => {
    const handler = vi.fn(() => "valid");
    const backend = defineAppBackend({
      methods: {
        echo: defineAppMethod({
          input: z.object({ text: z.string() }),
          output: z.string(),
          description: "Echo text",
          effect: "read",
          requires: [],
          handler,
        }),
      },
    });
    await expect(
      backend.call("echo", { text: 1 }, undefined, memberCaller),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await expect(
      backend.call("echo", { text: "ready" }, undefined, memberCaller),
    ).resolves.toBe("valid");
    expect(handler).toHaveBeenCalledOnce();
  });

  test("checks outputs even when a handler obtains malformed data from storage", async () => {
    const backend = defineAppBackend({
      methods: {
        count: defineAppMethod({
          input: z.object({}),
          output: z.number().int().nonnegative(),
          description: "Count records",
          effect: "read",
          requires: [],
          handler: () => -1,
        }),
      },
    });
    await expect(
      backend.call("count", {}, undefined, memberCaller),
    ).rejects.toThrow();
  });

  test("build admission rejects undeclared capabilities and oversized exported schemas", () => {
    const method = (input: z.ZodType) =>
      defineAppMethod({
        input,
        output: z.string(),
        description: "Read",
        effect: "read",
        requires: ["computer.readFile"],
        handler: () => "value",
      });
    const backend = defineAppBackend({
      methods: { read: method(z.object({})) },
    });
    expect(() =>
      buildAppDeclaration(backend, {
        capabilities: [],
        handlers: [],
        roles: [],
      }),
    ).toThrow(/outside/);
    expect(() =>
      buildAppApi(
        defineAppBackend({
          methods: { read: method(z.object({}).describe("x".repeat(20_001))) },
        }),
      ),
    ).toThrow(/bound/);
  });

  test("external effects remain descriptive, not an App-declared approval promise", () => {
    const base = {
      input: z.object({}),
      output: z.boolean(),
      description: "Install",
      effect: "external",
      requires: [],
      handler: () => true,
    } as const;
    const backend = defineAppBackend({
      methods: {
        install: defineAppMethod(base),
      },
    });
    expect(buildAppApi(backend).methods.install.effect).toBe("external");
    expect(buildAppApi(backend).methods.install).not.toHaveProperty("approval");
  });
});

test("delivers the Hub caller separately from backend state and method input", async () => {
  const backend = defineAppBackend({
    methods: {
      caller: defineAppMethod({
        input: z.strictObject({ actor: z.string() }),
        output: z.strictObject({
          actor: z.string(),
          agentId: z.string(),
          marker: z.string(),
        }),
        description: "Observe trusted caller",
        effect: "read",
        requires: [],
        handler: (
          _input,
          state: { marker: string },
          caller: import("@fungi.computer/puffball/app").AppMethodCallContext,
        ) => ({
          actor: caller.actor.kind,
          agentId:
            caller.actor.kind === "agent" ? caller.actor.agentId : "missing",
          marker: state.marker,
        }),
      }),
    },
  });
  await expect(
    backend.call(
      "caller",
      { actor: "spoofed" },
      { marker: "backend" },
      { computerId: null, actor: { kind: "agent", agentId: "agent-a" } },
    ),
  ).resolves.toEqual({ actor: "agent", agentId: "agent-a", marker: "backend" });
});

test("runtime calls refuse invalid caller identities before a handler runs", async () => {
  const handler = vi.fn(() => null);
  const backend = defineAppBackend({
    methods: {
      read: defineAppMethod({
        description: "Read",
        effect: "read",
        requires: [],
        input: z.object({}),
        output: z.null(),
        handler,
      }),
    },
  });
  const callers: AppMethodCallContext[] = [
    { computerId: null, actor: { kind: "member", memberId: "" } },
    {
      computerId: null,
      actor: { kind: "member", memberId: "x".repeat(257) },
    },
    {
      computerId: null,
      actor: { kind: "team-key", keyId: "x".repeat(257) },
    },
    {
      computerId: "x".repeat(257),
      actor: { kind: "member", memberId: "member-a" },
    },
  ];
  for (const caller of callers)
    await expect(backend.call("read", {}, undefined, caller)).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
});
test.each(["then", "ctx", "fetch", "constructor"])(
  "runtime backend registration refuses reserved method %s before declaration generation",
  (name) => {
    const method = defineAppMethod({
      description: "Read",
      effect: "read",
      requires: [],
      input: z.object({}),
      output: z.null(),
      handler: () => null,
    });
    expect(() => defineAppBackend({ methods: { [name]: method } })).toThrow(
      /method name/,
    );
  },
);

test("a Gill generates its source declaration and calls the same parsed method", async () => {
  const backend = defineAppBackend({
    methods: {
      list: defineAppMethod({
        description: "Read entries",
        effect: "read",
        requires: [],
        input: z.strictObject({
          prefix: z.string().min(1),
          limit: z.number().int().min(1).max(200),
        }),
        output: z.strictObject({ label: z.string().trim() }),
        handler: (input, context: { suffix: string }) => ({
          label: ` ${input.prefix}${context.suffix} `,
        }),
      }),
    },
    gills: [
      defineAppGill({
        limit: 20,
        id: "entries",
        title: "Entries",
        sizes: ["M"],
        source: "list",
        params: [
          {
            key: "repository",
            label: "Repository",
            kind: "repository",
            required: true,
          },
        ],
        watch: { storage: "entries-changed" },
        input: ({ params, limit }) => ({
          prefix: params.repository ?? "",
          limit,
        }),
        rows: (output) => ({
          viewId: "entries",
          title: "Entries",
          state: "full",
          rows: [
            {
              id: "entry",
              title: z.strictObject({ label: z.string() }).parse(output).label,
            },
          ],
        }),
      }),
    ],
  });
  expect(
    buildAppDeclaration(backend, { capabilities: [], handlers: [], roles: [] })
      .gills,
  ).toEqual([
    {
      id: "entries",
      title: "Entries",
      source: "list",
      desktop: { sizes: ["M"] },
      params: [
        {
          key: "repository",
          label: "Repository",
          kind: "repository",
          required: true,
        },
      ],
      watch: { storage: "entries-changed" },
    },
  ]);
  await expect(
    backend.gill(
      { id: "entries", params: { repository: "notes" } },
      { suffix: "!" },
      memberCaller,
    ),
  ).resolves.toMatchObject({ rows: [{ title: "notes!" }] });
  await expect(
    backend.gill(
      { id: "entries", params: { repository: "x".repeat(257) } },
      { suffix: "!" },
      memberCaller,
    ),
  ).rejects.toThrow();
  await expect(
    backend.gill({ id: "missing" }, { suffix: "!" }, memberCaller),
  ).rejects.toThrow(/Undeclared/);
});

test("Gill builds refuse write and missing sources and a second manifest catalog", () => {
  const view = defineAppGill({
    limit: 20,
    id: "status",
    title: "Status",
    source: "status",
    input: ({ limit }) => ({ limit }),
    rows: () => ({
      viewId: "status",
      title: "Status",
      state: "empty",
      rows: [],
    }),
  });
  const declaration = { capabilities: [], handlers: [], roles: [] };
  const write = defineAppMethod({
    description: "Write",
    effect: "write",
    requires: [],
    input: z.strictObject({ limit: z.number().int().min(1).max(200) }),
    output: z.null(),
    handler: () => null,
  });
  expect(() =>
    buildAppDeclaration(
      defineAppBackend({ methods: { status: write }, gills: [view] }),
      declaration,
    ),
  ).toThrow(/read method/);
  expect(() =>
    buildAppDeclaration(
      defineAppBackend({ methods: {}, gills: [view] }),
      declaration,
    ),
  ).toThrow(/read method/);
  expect(() =>
    buildAppDeclaration(defineAppBackend({ methods: {} }), {
      ...declaration,
      gills: [view.declaration],
    }),
  ).toThrow(/second catalog/);
});

test("a Gill reports missing declared context and refuses unknown placement keys before its source", async () => {
  const handler = vi.fn(() => null);
  const backend = defineAppBackend({
    methods: {
      list: defineAppMethod({
        description: "List",
        effect: "read",
        requires: [],
        input: z.strictObject({ limit: z.number().int().min(1).max(200) }),
        output: z.null(),
        handler,
      }),
    },
    gills: [
      defineAppGill({
        limit: 20,
        id: "entries",
        title: "Entries",
        source: "list",
        params: [
          {
            key: "repository",
            label: "Repository",
            kind: "repository",
            required: true,
          },
        ],
        input: ({ limit }) => ({ limit }),
        rows: () => ({
          viewId: "entries",
          title: "Entries",
          state: "empty",
          rows: [],
        }),
      }),
    ],
  });
  await expect(
    backend.gill({ id: "entries" }, undefined, memberCaller),
  ).resolves.toMatchObject({
    reason: "params_required",
    error: "Choose repository",
  });
  await expect(
    backend.gill(
      { id: "entries", params: { arbitrary: "value" } },
      undefined,
      memberCaller,
    ),
  ).rejects.toThrow(/Undeclared Gill parameter/);
  expect(handler).not.toHaveBeenCalled();
});

test("a generated facet Gill preserves caller context and rejects malformed source output", async () => {
  const backend = defineAppBackend({
    methods: {
      list: defineAppMethod({
        description: "List",
        effect: "read",
        requires: [],
        input: z.strictObject({ limit: z.number().int().min(1).max(200) }),
        output: z.number().nonnegative(),
        handler: (_input, context: { count: number }, caller) => {
          expect(caller.actor).toEqual(memberCaller.actor);
          return context.count;
        },
      }),
    },
    gills: [
      defineAppGill({
        limit: 20,
        id: "count",
        title: "Count",
        source: "list",
        input: ({ limit }) => ({ limit }),
        rows: (output) => ({
          viewId: "count",
          title: "Count",
          state: "full",
          rows: [{ id: "count", title: String(z.number().parse(output)) }],
        }),
      }),
    ],
  });
  class Facet {
    constructor(readonly count: number) {}
    declare gill: (
      input: { id: string },
      caller: AppMethodCallContext,
    ) => Promise<GillResponse>;
  }
  const Checked = backend.implement(Facet);
  await expect(
    new Checked(2).gill({ id: "count" }, memberCaller),
  ).resolves.toMatchObject({ rows: [{ title: "2" }] });
  await expect(
    new Checked(-1).gill({ id: "count" }, memberCaller),
  ).rejects.toThrow();
  expect(() =>
    defineAppBackend({
      methods: {
        gill: defineAppMethod({
          description: "Override",
          effect: "read",
          requires: [],
          input: z.null(),
          output: z.null(),
          handler: () => null,
        }),
      },
    }),
  ).toThrow(/method name/);
});

test("Gill page size reaches the source and long text never removes a row or changes its next cursor", async () => {
  const backend = defineAppBackend({
    methods: {
      list: defineAppMethod({
        description: "List a page",
        effect: "read",
        requires: [],
        input: z.strictObject({ limit: z.number().int().min(1).max(200) }),
        output: z.strictObject({
          labels: z.array(z.string()),
          next: z.string(),
        }),
        handler: ({ limit }) => ({
          labels: Array.from(
            { length: limit },
            (_, i) => `${String(i)}:${"🌱".repeat(5000)}`,
          ),
          next: "source-next",
        }),
      }),
    },
    gills: [
      defineAppGill({
        id: "page",
        title: "Page",
        source: "list",
        limit: 200,
        input: ({ limit }) => ({ limit }),
        rows: (output) => {
          const page = z
            .strictObject({ labels: z.array(z.string()), next: z.string() })
            .parse(output);
          return {
            viewId: "page",
            title: "Page",
            state: "full",
            rows: page.labels.map((label, i) => ({
              id: String(i),
              title: label,
              open: { params: [{ key: "item", value: String(i) }] },
            })),
            next: page.next,
          };
        },
      }),
    ],
  });
  const page = await backend.gill({ id: "page" }, undefined, memberCaller);
  if (!("state" in page) || page.state !== "full")
    throw new Error("Expected a full source page");
  expect(page.rows).toHaveLength(200);
  expect(page.rows[0]?.id).toBe("0");
  expect(page.rows[199]?.id).toBe("199");
  expect(page.rows[199]?.open).toEqual({
    params: [{ key: "item", value: "199" }],
  });
  expect(page.next).toBe("source-next");
  expect(
    new TextEncoder().encode(JSON.stringify(page)).byteLength,
  ).toBeLessThanOrEqual(240 * 1024);
  expect(page.rows[0]?.title).toContain("…");
});

test("a Gill refuses an oversized source page or navigation without silently dropping records", async () => {
  const method = defineAppMethod({
    description: "List",
    effect: "read",
    requires: [],
    input: z.strictObject({ limit: z.number().int().min(1).max(200) }),
    output: z.null(),
    handler: () => null,
  });
  const create = (limit: number, count: number) =>
    defineAppBackend({
      methods: { list: method },
      gills: [
        defineAppGill({
          id: "records",
          title: "Records",
          source: "list",
          limit,
          input: ({ limit }) => ({ limit }),
          rows: () => ({
            viewId: "records",
            title: "Records",
            state: "full",
            rows: Array.from({ length: count }, (_, i) => ({
              id: String(i),
              title: "Record",
              open: {
                params: Array.from({ length: 16 }, (_, j) => ({
                  key: String(j),
                  value: "x".repeat(1024),
                })),
              },
            })),
            next: "source-next",
          }),
        }),
      ],
    });
  await expect(
    create(1, 2).gill({ id: "records" }, undefined, memberCaller),
  ).rejects.toThrow(/page size/);
  await expect(
    create(200, 200).gill({ id: "records" }, undefined, memberCaller),
  ).rejects.toThrow(/navigation.*byte budget/);
});

test("a required placement key must be supplied even when its name exists on Object.prototype", async () => {
  const backend = defineAppBackend({
    methods: {
      list: defineAppMethod({
        description: "List",
        effect: "read",
        requires: [],
        input: z.strictObject({ limit: z.number().int().min(1).max(200) }),
        output: z.null(),
        handler: () => null,
      }),
    },
    gills: [
      defineAppGill({
        id: "entries",
        title: "Entries",
        source: "list",
        limit: 1,
        params: [
          {
            key: "constructor",
            label: "Repository",
            kind: "repository",
            required: true,
          },
        ],
        input: ({ limit }) => ({ limit }),
        rows: () => ({
          viewId: "entries",
          title: "Entries",
          state: "empty",
          rows: [],
        }),
      }),
    ],
  });
  await expect(
    backend.gill({ id: "entries", params: {} }, undefined, memberCaller),
  ).resolves.toMatchObject({ reason: "params_required" });
  await expect(
    backend.gill(
      { id: "entries", params: { constructor: "notes" } },
      undefined,
      memberCaller,
    ),
  ).resolves.toMatchObject({ state: "empty" });
});

test("a picker reads its declared options method with partial placement context and its own policy", async () => {
  const backend = defineAppBackend({
    methods: {
      list: defineAppMethod({
        description: "List rows",
        effect: "read",
        requires: [],
        input: z.strictObject({ limit: z.number() }),
        output: z.null(),
        handler: (_input, context: { title: string }) => {
          expect(context).toEqual({ title: " Main " });
          throw new Error("Rows source must not run for a picker");
        },
      }),
      "branches.options": defineAppMethod({
        description: "Choose branches",
        effect: "read",
        requires: ["git.repository"],
        input: z.strictObject({
          limit: z.number().int(),
          after: z.string().optional(),
          params: z.strictObject({ repository: z.string() }),
        }),
        output: z.strictObject({
          options: z.array(
            z.strictObject({ value: z.string(), label: z.string().trim() }),
          ),
          next: z.string(),
        }),
        handler: (input, context: { title: string }, caller) => {
          expect(input).toEqual({
            limit: 20,
            after: "before",
            params: { repository: "notes" },
          });
          expect(caller).toEqual(memberCaller);
          return {
            options: [{ value: "main", label: context.title }],
            next: "after",
          };
        },
      }),
    },
    gills: [
      defineAppGill({
        id: "entries",
        title: "Entries",
        source: "list",
        limit: 20,
        params: [
          {
            key: "repository",
            label: "Repository",
            kind: "repository",
            required: true,
          },
          {
            key: "branch",
            label: "Branch",
            kind: "branch",
            required: true,
            options: "branches.options",
          },
        ],
        input: ({ limit }) => ({ limit }),
        rows: () => ({
          viewId: "entries",
          title: "Entries",
          state: "empty",
          rows: [],
        }),
      }),
    ],
  });
  expect(
    buildAppDeclaration(backend, {
      capabilities: ["git.repository"],
      handlers: [],
      roles: [],
    }).gills?.[0]?.params?.[1]?.options,
  ).toBe("branches.options");
  await expect(
    backend.gill(
      {
        id: "entries",
        options: "branch",
        params: { repository: "notes" },
        after: "before",
      },
      { title: " Main " },
      memberCaller,
    ),
  ).resolves.toEqual({
    options: [{ value: "main", label: "Main" }],
    next: "after",
  });
});

test("a picker cannot declare a write or undeclared options source", () => {
  const method = (effect: "read" | "write") =>
    defineAppMethod({
      description: "Read",
      effect,
      requires: [],
      input: z.strictObject({ limit: z.number() }),
      output: z.null(),
      handler: () => null,
    });
  const view = defineAppGill({
    id: "entries",
    title: "Entries",
    source: "list",
    limit: 20,
    params: [
      {
        key: "repository",
        label: "Repository",
        kind: "repository",
        required: true,
        options: "repos.options",
      },
    ],
    input: ({ limit }) => ({ limit }),
    rows: () => ({
      viewId: "entries",
      title: "Entries",
      state: "empty",
      rows: [],
    }),
  });
  const candidates: Readonly<Record<string, AppBackendMethod>>[] = [
    { list: method("read") },
    { list: method("read"), "repos.options": method("write") },
  ];
  for (const methods of candidates)
    expect(() =>
      buildAppDeclaration(defineAppBackend({ methods, gills: [view] }), {
        capabilities: [],
        handlers: [],
        roles: [],
      }),
    ).toThrow(/options.*read method/);
});

test("background continuation is generated from one backend definition", () => {
  const write = defineAppMethod({
    description: "Write",
    effect: "write",
    requires: ["computer.writeFile"],
    input: z.object({}),
    output: z.object({ more: z.boolean() }),
    handler: () => ({ more: false }),
  });
  const backend = defineAppBackend({
    methods: { save: write, continueWrites: write },
    sync: { method: "continueWrites" },
  });
  expect(backend.sync).toEqual({ method: "continueWrites" });
  expect(
    buildAppDeclaration(backend, {
      capabilities: ["computer.writeFile"],
      handlers: [],
      roles: [],
      backend: { bindings: [] },
    }).backend?.sync,
  ).toEqual({ method: "continueWrites" });
});

test("a Gill projection retains its placement repository when the read result omits it", async () => {
  const backend = defineAppBackend({
    methods: {
      commits: defineAppMethod({
        description: "Read the saved commit",
        effect: "read",
        requires: [],
        input: z.strictObject({ repo: z.string(), limit: z.literal(1) }),
        output: z.string(),
        handler: () => "a".repeat(40),
      }),
    },
    gills: [
      defineAppGill({
        id: "commits",
        title: "Commits",
        source: "commits",
        limit: 1,
        params: [
          {
            key: "repo",
            label: "Repository",
            kind: "repository",
            required: true,
          },
        ],
        input: ({ params, limit }) => ({
          repo: z.string().parse(params.repo),
          limit,
        }),
        rows: (output, { params }) => ({
          viewId: "commits",
          title: "Commits",
          state: "full",
          rows: [
            {
              id: z.string().parse(output),
              title: "Saved commit",
              open: {
                params: [
                  { key: "repo", value: z.string().parse(params.repo) },
                  { key: "hash", value: z.string().parse(output) },
                ],
              },
            },
          ],
        }),
      }),
    ],
  });
  for (const repo of ["pond", "garden"]) {
    const page = await backend.gill(
      { id: "commits", params: { repo } },
      undefined,
      memberCaller,
    );
    if ("options" in page) throw new Error("Expected commit rows");
    expect(page.rows[0]?.open?.params).toEqual([
      { key: "repo", value: repo },
      { key: "hash", value: "a".repeat(40) },
    ]);
  }
});
