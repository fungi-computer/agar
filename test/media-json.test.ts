import { afterEach, describe, expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import { AppError } from "../src/errors.js";
import { mediaRequestIds } from "../src/media-request-id.js";
import { parseMediaGenerationInput } from "../src/media.js";
import {
  MediaGeneration,
  MediaGenerationAttempt,
  type MediaGenerationJsonCaller,
} from "../src/media-json.js";

const settings = parseMediaGenerationInput({
  destination: { path: "/prints/fern.png" },
  settings: {
    model: "@cf/black-forest-labs/flux-1-schnell",
    prompt: "a quiet greenhouse",
    width: 1024,
    height: 768,
  },
}).settings;
const input = { destination: { path: "/prints/fern.png" }, settings };
const completed = {
  bytes: 12,
  costMilliunits: 1000,
  destination: { computerId: "computer-a", path: input.destination.path },
  format: "png",
  height: 768,
  model: settings.model,
  width: 1024,
};
const description = {
  computerId: "computer-a",
  canGenerate: true,
  models: [],
};
const call: MediaGenerationJsonCaller = (method) =>
  Promise.resolve(
    method === "describe"
      ? Schema.decodeUnknownSync(Schema.Json)(description)
      : method === "cancelAttempt"
        ? null
        : { kind: "succeeded", result: completed },
  );
const create = (caller = call, signal?: AbortSignal) =>
  new MediaGeneration(caller, "computer-a", signal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("public Media browser handle", () => {
  it("describes Media through the page's generic JSON method caller", async () => {
    const caller = vi.fn(call);
    await expect(create(caller).describe()).resolves.toEqual(description);
    expect(caller.mock.calls[0]?.[0]).toBe("describe");
    expect(caller.mock.calls[0]?.[1]).toBeUndefined();
    expect(caller.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("keeps the canonical replay identity with only path destinations on the wire", async () => {
    const caller = vi.fn(call);
    const attempt = await create(caller).createAttempt();
    expect(attempt).toBeInstanceOf(MediaGenerationAttempt);
    const reference = await attempt.reference();
    expect(mediaRequestIds.request.parse(reference.requestId).ok).toBe(true);
    await attempt.generate(input);
    await (await create(caller).restoreAttempt(reference)).generate(input);
    expect(caller.mock.calls[0]?.[1]).toEqual({
      requestId: reference.requestId,
      ...input,
    });
    expect(caller.mock.calls[1]?.[1]).toEqual(caller.mock.calls[0]?.[1]);
    expect(() =>
      create().restoreAttempt({ ...reference, computerId: "other" }),
    ).toThrow(AppError);
    expect(() =>
      create().restoreAttempt({ ...reference, requestId: "not-canonical" }),
    ).toThrow(AppError);
  });
  it("forwards first and last frame roles without Computer authority in JSON", async () => {
    const result = {
      ...completed,
      destination: { computerId: "computer-a", path: "/prints/fern.mp4" },
      format: "mp4",
      model: "bytedance/seedance-2.0",
    };
    const caller = vi.fn<MediaGenerationJsonCaller>(() =>
      Promise.resolve({ kind: "succeeded", result }),
    );
    await (
      await create(caller).createAttempt()
    ).generate({
      destination: { path: result.destination.path },
      settings: {
        model: result.model,
        prompt: "fronds moving in a breeze",
        width: 1280,
        height: 720,
        resolution: "720p",
        aspectRatio: "16:9",
        durationSeconds: 5,
        references: [
          { path: "first.png", role: "first-frame" },
          { path: "last.png", role: "last-frame" },
        ],
      },
    });
    expect(caller.mock.calls[0]?.[1]).toMatchObject({
      destination: { path: result.destination.path },
      settings: {
        references: [
          { path: "first.png", role: "first-frame" },
          { path: "last.png", role: "last-frame" },
        ],
      },
    });
  });
  it("refuses a catalog for a different Computer", async () => {
    const caller = vi.fn<MediaGenerationJsonCaller>(() =>
      Promise.resolve(
        Schema.decodeUnknownSync(Schema.Json)({
          ...description,
          computerId: "computer-b",
        }),
      ),
    );
    await expect(create(caller).describe()).rejects.toMatchObject({
      code: "IDENTITY",
      retryable: false,
    });
  });
  it("polls Agar Pending with exactly the same request and settings", async () => {
    vi.useFakeTimers();
    const caller = vi
      .fn<MediaGenerationJsonCaller>()
      .mockResolvedValueOnce({ kind: "pending", retryAfterMs: 1000 })
      .mockResolvedValueOnce({ kind: "succeeded", result: completed });
    const outcome = (await create(caller).createAttempt()).generate(input);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toEqual({
      kind: "succeeded",
      result: completed,
    });
    expect(caller).toHaveBeenCalledTimes(2);
    expect(caller.mock.calls[1]?.[1]).toEqual(caller.mock.calls[0]?.[1]);
  });
  it.each([999, 60001, 1000.5])(
    "refuses Pending delay %s outside Agar bounds",
    async (retryAfterMs) => {
      const caller: MediaGenerationJsonCaller = () =>
        Promise.resolve({ kind: "pending", retryAfterMs });
      await expect(
        (await create(caller).createAttempt()).generate(input),
      ).rejects.toMatchObject({
        code: "PROTOCOL",
        retryable: false,
      });
    },
  );
  it("accepts Agar's maximum Pending delay without changing the replay identity", async () => {
    vi.useFakeTimers();
    const caller = vi
      .fn<MediaGenerationJsonCaller>()
      .mockResolvedValueOnce({ kind: "pending", retryAfterMs: 60000 })
      .mockResolvedValueOnce({ kind: "succeeded", result: completed });
    const outcome = (await create(caller).createAttempt()).generate(input);
    await vi.advanceTimersByTimeAsync(59999);
    expect(caller).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({
      kind: "succeeded",
      result: completed,
    });
    expect(caller.mock.calls[1]?.[1]).toEqual(caller.mock.calls[0]?.[1]);
  });
  it("cancels the local JSON request and identifies the same attempt to the caller", async () => {
    const dispatched = Promise.withResolvers<undefined>();
    const caller = vi.fn<MediaGenerationJsonCaller>(
      (method, _input, options) => {
        if (method === "cancelAttempt") return Promise.resolve(null);
        dispatched.resolve(undefined);
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      },
    );
    const handle = create(caller);
    const attempt = await handle.createAttempt();
    const outcome = attempt.generate(input);
    const rejected = expect(outcome).rejects.toThrow("cancelled");
    await dispatched.promise;
    const reference = await attempt.reference();
    await handle.cancelAttempt(reference);
    await rejected;
    expect(caller.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(caller.mock.calls[1]?.[0]).toBe("cancelAttempt");
    expect(caller.mock.calls[1]?.[1]).toEqual(reference);
    expect(caller.mock.calls[1]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("preserves sanitized failure stage, code and retry truth", async () => {
    const failure = {
      message: "Save the retained result again.",
      stage: "destination-write",
      code: "HOST_FAILURE",
      retryable: true,
    };
    await expect(
      (
        await create(() =>
          Promise.resolve({ kind: "failed", failure }),
        ).createAttempt()
      ).generate(input),
    ).resolves.toEqual({ kind: "failed", failure });
  });
});
