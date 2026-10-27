import { describe, expect, it, vi } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import * as Schema from "effect/Schema";

import { createCapabilityDirectory } from "./internal/capabilities.js";
import {
  openMediaGeneration,
  mediaLibraryPathSchema,
  mediaLibraryResponseSchema,
  mediaGeneration,
  mediaGenerationReferenceSchema,
  type MediaGenerationInput,
  type MediaGenerationFailure,
  type MediaGenerationOutcome,
  type MediaGenerationResult,
  type MediaModel,
} from "./media.js";

const model = "@cf/black-forest-labs/flux-2-klein-4b";
const knownModel: MediaModel = {
  kind: "image",
  sizes: null,
  video: null,
  outputFormats: [],
  id: model,
  tier: "balanced",
  maxPromptLength: 2_048,
  label: "Flux 2 Klein 4b — balanced default",
  input: {
    transport: "multipart",
    dimensions: "own",
    maxDimension: 1_920,
    maxDimensionDocumented: false,
    defaultWidth: 1_024,
    defaultHeight: 768,
    steps: "fixed",
    maxSteps: null,
    defaultSteps: 4,
    referenceField: "input_image_",
    maxReferences: 4,
  },
};
const gptModel: MediaModel = {
  kind: "image",
  sizes: ["1024x1024", "1024x1536", "1536x1024"],
  video: null,
  outputFormats: ["png", "jpeg", "webp"],
  id: "openai/gpt-image-2",
  tier: "premium",
  maxPromptLength: 2_048,
  label: "GPT Image 2 — strong text and layout, premium",
  input: {
    transport: "json",
    dimensions: "own",
    maxDimension: 1_536,
    maxDimensionDocumented: false,
    defaultWidth: 1_024,
    defaultHeight: 1_024,
    steps: "fixed",
    maxSteps: null,
    defaultSteps: null,
    referenceField: null,
    maxReferences: 0,
  },
};
const input: MediaGenerationInput = {
  destination: { path: "media/quiet.png" },
  settings: {
    height: 768,
    model,
    prompt: " a quiet greenhouse ",
    width: 1_024,
  },
};

function succeeded(result: MediaGenerationResult): MediaGenerationOutcome {
  return { kind: "succeeded", result };
}

function directory(owner: RpcTarget) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, owner);
  const controller = createCapabilityDirectory([
    {
      handle: client,
      id: mediaGeneration.id,
      version: mediaGeneration.version,
    },
  ]);
  return {
    controller,
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

async function generateOnce(
  capabilities: Parameters<typeof openMediaGeneration>[0],
  request: MediaGenerationInput,
  options: { readonly signal?: AbortSignal } = {},
) {
  const session = await openMediaGeneration(capabilities);
  const attempt = await session.createAttempt();
  try {
    return await attempt.generate(request, options);
  } finally {
    attempt[Symbol.dispose]();
  }
}

describe("Media Agar capability", () => {
  it("preserves the verified output formats through describe", async () => {
    class Owner extends RpcTarget {
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [gptModel],
        });
      }
    }
    const connection = directory(new Owner());
    try {
      const session = await openMediaGeneration(connection.directory);
      expect(session.models[0]?.outputFormats).toEqual(["png", "jpeg", "webp"]);
    } finally {
      connection.close();
    }
  });

  it("restores the serialized reference through a fresh capability connection", async () => {
    const requests: MediaGenerationInput[] = [];
    class Owner extends RpcTarget {
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [knownModel],
        });
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      restoreAttempt(reference: { requestId: string; computerId: string }) {
        expect(reference).toEqual({
          requestId: "request-a",
          computerId: "computer-a",
        });
        return Promise.resolve(this);
      }
      generate(request: MediaGenerationInput) {
        requests.push(request);
        return Promise.resolve(
          succeeded({
            bytes: 3,
            costMilliunits: 0,
            destination: {
              computerId: "computer-a",
              path: request.destination.path,
            },
            format: "png",
            height: 768,
            model,
            width: 1_024,
          }),
        );
      }
    }
    const first = directory(new Owner());
    const session = await openMediaGeneration(first.directory);
    const issued = await session.createAttempt();
    const serialized = JSON.stringify(issued.reference);
    issued[Symbol.dispose]();
    first.close();
    const second = directory(new Owner());
    try {
      const reopened = await openMediaGeneration(second.directory);
      const reference = Schema.decodeUnknownSync(
        Schema.fromJsonString(mediaGenerationReferenceSchema),
      )(serialized);
      const attempt = await reopened.restoreAttempt(reference);
      await expect(attempt.generate(input)).resolves.toMatchObject({
        destination: { computerId: "computer-a", path: input.destination.path },
      });
      attempt[Symbol.dispose]();
      expect(requests).toHaveLength(1);
      await expect(
        reopened.restoreAttempt({
          requestId: "request-a",
          computerId: "computer-b",
        }),
      ).rejects.toMatchObject({ code: "IDENTITY" });
    } finally {
      second.close();
    }
  });

  it("routes model discovery through the granted owner and decodes it", async () => {
    class Owner extends RpcTarget {
      readonly generateSpy = vi.fn<() => Promise<MediaGenerationOutcome>>(() =>
        Promise.reject(new Error("unused")),
      );
      readonly listModelsSpy = vi.fn<() => Promise<readonly MediaModel[]>>(() =>
        Promise.resolve([
          {
            id: model,
            label: "Klein",
            kind: "image",
            tier: "balanced",
            maxPromptLength: 2_048,
            outputFormats: [],
            sizes: null,
            video: null,
            input: {
              transport: "multipart",
              dimensions: "own",
              maxDimension: 1_920,
              maxDimensionDocumented: false,
              defaultWidth: 1_024,
              defaultHeight: 768,
              steps: "fixed",
              maxSteps: null,
              defaultSteps: 4,
              referenceField: "input_image_",
              maxReferences: 4,
            },
          },
        ]),
      );
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        return this.generateSpy();
      }
      async describe() {
        return {
          computerId: "computer-a",
          canGenerate: true,
          models: await this.listModelsSpy(),
        };
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    try {
      await expect(
        openMediaGeneration(granted.directory),
      ).resolves.toMatchObject({
        computerId: "computer-a",
        canGenerate: true,
        models: [{ ...knownModel, label: "Klein" }],
      });
      expect(owner.listModelsSpy).toHaveBeenCalledOnce();
      expect(owner.generateSpy).not.toHaveBeenCalled();
    } finally {
      granted.close();
    }
  });

  it.each([0, 2])(
    "preserves the host reference limit of %i",
    async (maxReferences) => {
      class Owner extends RpcTarget {
        describe() {
          return Promise.resolve({
            computerId: "computer-a",
            canGenerate: true,
            models: [
              {
                ...knownModel,
                input: {
                  ...knownModel.input,
                  maxReferences,
                  referenceField:
                    maxReferences === 0
                      ? null
                      : knownModel.input.referenceField,
                },
              },
            ],
          });
        }
      }
      const granted = directory(new Owner());
      try {
        const session = await openMediaGeneration(granted.directory);
        expect(session.models[0]?.input.maxReferences).toBe(maxReferences);
        expect(session.models[0]?.input.referenceField).toBe(
          maxReferences === 0 ? null : knownModel.input.referenceField,
        );
      } finally {
        granted.close();
      }
    },
  );

  it.each([undefined, [{ path: " /media/reference.png " }]])(
    "normalizes path-only selections %j and decodes the result",
    async (references) => {
      const calls: unknown[] = [];
      class Owner extends RpcTarget {
        readonly listModelsSpy = vi.fn<() => Promise<readonly MediaModel[]>>(
          () => Promise.resolve([knownModel]),
        );
        readonly generateSpy = vi.fn<
          (request: MediaGenerationInput) => Promise<MediaGenerationOutcome>
        >((request: MediaGenerationInput) => {
          calls.push(request);
          return Promise.resolve(
            succeeded({
              bytes: 3,
              costMilliunits: 125,
              destination: {
                computerId: "computer-a",
                path: "media/quiet.png",
              },
              format: "png",
              height: 768,
              model,
              width: 1_024,
            }),
          );
        });
        async describe() {
          return {
            computerId: "computer-a",
            canGenerate: true,
            models: await this.listModelsSpy(),
          };
        }
        reference() {
          return Promise.resolve({
            requestId: "request-a",
            computerId: "computer-a",
          });
        }
        createAttempt() {
          return Promise.resolve(this);
        }
        generate(
          request: MediaGenerationInput,
        ): Promise<MediaGenerationOutcome> {
          return this.generateSpy(request);
        }
      }
      const owner = new Owner();
      const granted = directory(owner);
      try {
        await expect(
          generateOnce(granted.directory, {
            ...input,
            settings: { ...input.settings, references },
          }),
        ).resolves.toMatchObject({
          bytes: 3,
          costMilliunits: 125,
          destination: {
            computerId: "computer-a",
            path: input.destination.path,
          },
          format: "png",
          model,
        });
        expect(calls).toEqual([
          {
            destination: input.destination,
            settings: {
              height: 768,
              model,
              prompt: "a quiet greenhouse",
              width: 1_024,
              references: references?.map(() => ({
                path: "/media/reference.png",
              })),
            },
          },
        ]);
      } finally {
        granted.close();
      }
    },
  );

  it.each<MediaGenerationFailure>([
    {
      code: "HOST_FAILURE",
      retryable: true,
      message: "Media host unavailable",
    },
    {
      code: "HOST_FAILURE",
      stage: "destination-write",
      retryable: true,
      message:
        "Media generated an image but could not save it; retry this request to save the retained result.",
    },
    {
      code: "INSUFFICIENT_CREDIT",
      stage: "billing",
      retryable: false,
      message:
        "Media generation needs Team credits. Add credits in Billing, then retry.",
    },
    {
      code: "CAPABILITY_DENIED",
      stage: "generation-authorization",
      retryable: false,
      message:
        "Media generation is not permitted to spend this Team's credits.",
    },
    {
      code: "HOST_FAILURE",
      stage: "provider",
      retryable: false,
      message: "Media generation failed",
      provider: { category: "InferenceUpstreamError", code: 3031 },
    },
    {
      code: "HOST_FAILURE",
      stage: "normalization",
      retryable: false,
      message: "Media generation failed",
      provider: { category: "result_download", status: 503 },
    },
    {
      code: "HOST_FAILURE",
      stage: "artifact",
      retryable: true,
      message: "Media generation failed",
    },
  ])("preserves $code across the RPC boundary", async (failure) => {
    class Owner extends RpcTarget {
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [knownModel],
        });
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        return Promise.resolve({
          kind: "failed",
          failure,
        });
      }
    }
    const granted = directory(new Owner());
    try {
      await expect(
        generateOnce(granted.directory, input),
      ).rejects.toMatchObject({
        name: "AppError",
        ...failure,
        stage: failure.stage ?? null,
      });
    } finally {
      granted.close();
    }
  });

  it("rejects an arbitrary stage before exposing an App diagnostic", async () => {
    class Owner extends RpcTarget {
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [knownModel],
        });
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate() {
        return Promise.resolve({
          kind: "failed",
          failure: {
            code: "HOST_FAILURE",
            stage: "synthetic-private-stage",
            message: "Media failed",
            retryable: true,
          },
        });
      }
    }
    const granted = directory(new Owner());
    try {
      await expect(
        generateOnce(granted.directory, input),
      ).rejects.toMatchObject({
        code: "PROTOCOL",
        retryable: false,
      });
    } finally {
      granted.close();
    }
  });

  it("rejects an already-cancelled caller before admitting owner work", async () => {
    class Owner extends RpcTarget {
      readonly listModelsSpy = vi.fn<() => Promise<readonly MediaModel[]>>(() =>
        Promise.resolve([knownModel]),
      );
      readonly generateSpy = vi.fn<() => Promise<MediaGenerationOutcome>>(() =>
        Promise.reject(new Error("unused")),
      );
      async describe() {
        return {
          computerId: "computer-a",
          canGenerate: true,
          models: await this.listModelsSpy(),
        };
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        return this.generateSpy();
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        generateOnce(granted.directory, input, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "CANCELLED", retryable: false });
      expect(owner.generateSpy).not.toHaveBeenCalled();
    } finally {
      granted.close();
    }
  });

  it("waits for backend cancellation acknowledgement before settling the caller", async () => {
    let finishGeneration!: (outcome: MediaGenerationOutcome) => void;
    let acknowledgeCancellation!: () => void;
    class Owner extends RpcTarget {
      readonly cancelSpy = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            acknowledgeCancellation = resolve;
          }),
      );
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [knownModel],
        });
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      cancelAttempt(reference: { requestId: string; computerId: string }) {
        expect(reference).toEqual({
          requestId: "request-a",
          computerId: "computer-a",
        });
        return this.cancelSpy();
      }
      generate(): Promise<MediaGenerationOutcome> {
        return new Promise((resolve) => {
          finishGeneration = resolve;
        });
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    const controller = new AbortController();
    try {
      const generation = generateOnce(granted.directory, input, {
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(finishGeneration).toBeTypeOf("function");
      });
      controller.abort();
      await vi.waitFor(() => {
        expect(owner.cancelSpy).toHaveBeenCalledOnce();
      });
      acknowledgeCancellation();
      await expect(generation).rejects.toMatchObject({
        code: "CANCELLED",
        retryable: false,
      });
      expect(owner.cancelSpy).toHaveBeenCalledOnce();
      // The remote operation can still have provider work in flight after the
      // acknowledgement; settlement does not assert that the provider stopped.
      finishGeneration(
        succeeded({
          bytes: 3,
          costMilliunits: 125,
          destination: {
            computerId: "computer-a",
            path: input.destination.path,
          },
          format: "png",
          height: 768,
          model,
          width: 1_024,
        }),
      );
    } finally {
      granted.close();
    }
  });

  it("rejects malformed owner results at the capability boundary", async () => {
    class Owner extends RpcTarget {
      readonly listModelsSpy = vi.fn<() => Promise<readonly MediaModel[]>>(() =>
        Promise.resolve([knownModel]),
      );
      readonly generateSpy = vi.fn<() => Promise<MediaGenerationOutcome>>(() =>
        // SAFETY: The extra field intentionally simulates a malformed remote wire result.
        Promise.resolve({
          kind: "succeeded",
          result: {
            bytes: 3,
            costMilliunits: 125,
            destination: { computerId: "computer-a", path: "media/quiet.png" },
            format: "png",
            height: 768,
            model,
            providerOperationId: "must-stay-private",
            width: 1_024,
          },
        } as MediaGenerationOutcome),
      );
      async describe() {
        return {
          computerId: "computer-a",
          canGenerate: true,
          models: await this.listModelsSpy(),
        };
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        return this.generateSpy();
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    try {
      await expect(
        generateOnce(granted.directory, input),
      ).rejects.toMatchObject({ code: "PROTOCOL", retryable: false });
    } finally {
      granted.close();
    }
  });

  it("passes through a model the host adds to its catalog", async () => {
    class Owner extends RpcTarget {
      readonly generateSpy = vi.fn<() => Promise<MediaGenerationOutcome>>(() =>
        Promise.reject(new Error("unused")),
      );
      readonly listModelsSpy = vi.fn<() => Promise<readonly MediaModel[]>>(() =>
        Promise.resolve([
          {
            id: "provider/new-model",
            label: "New model",
            kind: "image",
            tier: "balanced",
            maxPromptLength: 2_048,
            outputFormats: [],
            sizes: null,
            video: null,
            input: {
              transport: "json",
              dimensions: "none",
              maxDimension: null,
              maxDimensionDocumented: false,
              defaultWidth: 1,
              defaultHeight: 1,
              steps: "fixed",
              maxSteps: null,
              defaultSteps: null,
              referenceField: null,
              maxReferences: 0,
            },
          },
        ]),
      );
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        return this.generateSpy();
      }
      async describe() {
        return {
          computerId: "computer-a",
          canGenerate: true,
          models: await this.listModelsSpy(),
        };
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    try {
      await expect(
        openMediaGeneration(granted.directory).then(
          (session) => session.models,
        ),
      ).resolves.toMatchObject([{ id: "provider/new-model" }]);
    } finally {
      granted.close();
    }
  });

  it("rejects a catalog that repeats a model", async () => {
    class Owner extends RpcTarget {
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [knownModel, knownModel],
        });
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        return Promise.reject(new Error("unused"));
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    try {
      await expect(
        openMediaGeneration(granted.directory).then(
          (session) => session.models,
        ),
      ).rejects.toMatchObject({ code: "PROTOCOL", retryable: false });
    } finally {
      granted.close();
    }
  });

  it("rejects a result whose output dimensions do not match the submitted selection", async () => {
    class Owner extends RpcTarget {
      describe() {
        return Promise.resolve({
          computerId: "computer-a",
          canGenerate: true,
          models: [knownModel],
        });
      }
      reference() {
        return Promise.resolve({
          requestId: "request-a",
          computerId: "computer-a",
        });
      }
      createAttempt() {
        return Promise.resolve(this);
      }
      generate(): Promise<MediaGenerationOutcome> {
        // SAFETY: The dimensions intentionally simulate an unrelated owner result.
        return Promise.resolve(
          succeeded({
            bytes: 3,
            costMilliunits: 125,
            destination: { computerId: "computer-a", path: "media/quiet.png" },
            format: "png",
            height: 1_024,
            model,
            width: 1_024,
          }),
        );
      }
    }
    const owner = new Owner();
    const granted = directory(owner);
    try {
      await expect(
        generateOnce(granted.directory, input),
      ).rejects.toMatchObject({ code: "PROTOCOL", retryable: false });
    } finally {
      granted.close();
    }
  });

  it("does not make a default App's absent Grant look like Media authority", async () => {
    const controller = createCapabilityDirectory([]);
    await expect(
      openMediaGeneration(controller.directory),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED", retryable: false });
    controller.disconnect();
  });
});

describe("Media library path contract", () => {
  it.each([
    "relative",
    "/",
    "/a\0b",
    "/a/../b",
    "/a/./b",
    "/a/",
    "/" + "a".repeat(4096),
  ])("refuses %j at selection and response boundaries", (path) => {
    expect(Schema.is(mediaLibraryPathSchema)(path)).toBe(false);
    expect(Schema.is(mediaLibraryResponseSchema)({ path })).toBe(false);
  });
  it("accepts the 4096-character limit and an unselected library", () => {
    const path = "/" + "a".repeat(4095);
    expect(Schema.is(mediaLibraryPathSchema)(path)).toBe(true);
    expect(Schema.is(mediaLibraryResponseSchema)({ path })).toBe(true);
    expect(Schema.is(mediaLibraryResponseSchema)({ path: null })).toBe(true);
  });
});
