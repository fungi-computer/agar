import { describe, expect, it } from "vitest";
import { appErrorData, appErrorFromData } from "./internal/app-error.js";
import * as Schema from "effect/Schema";
import { MediaGenerationError, mediaGenerationFailureSchema } from "./media.js";
import {
  AppError,
  describeAppError,
  type AppErrorCode,
  type ErrorDescription,
} from "./errors.js";

describe("describeAppError", () => {
  it("round-trips pending delivery through the SDK's ordinary error decoder", () => {
    const original = new AppError("delivery pending", {
      code: "DELIVERY_PENDING",
      retryable: true,
    });
    expect(appErrorFromData(appErrorData(original))).toMatchObject({
      code: "DELIVERY_PENDING",
      retryable: true,
    });
  });
  it("describes pending delivery from the separately bundled shell without losing retry truth", () => {
    const fromHostBundle = Object.assign(new Error("private host detail"), {
      name: "AppError",
      code: "DELIVERY_PENDING",
      retryable: true,
    });
    expect(describeAppError(fromHostBundle)).toEqual({
      title: "App delivery pending",
      message: "The App hasn't finished getting ready. Try opening it again.",
      retryable: true,
      action: "retry",
    });
  });
  it("uses approved permission copy for a typed write denial, not the unknown fallback", () => {
    const diagnostic = "The Computer denied this write.";
    const denial = new AppError(diagnostic, {
      code: "CAPABILITY_DENIED",
      retryable: false,
    });

    expect(describeAppError(denial)).toEqual({
      title: "Access needed",
      message: "This App needs permission to do that.",
      retryable: false,
      action: "grant",
    });
    expect(describeAppError(new Error(diagnostic))).toEqual({
      title: "Something went wrong",
      message: "The App couldn't complete this request.",
      retryable: false,
    });
  });

  const recovery: readonly {
    code: AppErrorCode;
    action?: ErrorDescription["action"];
  }[] = [
    { code: "CANCELLED" },
    { code: "CAPABILITY_DENIED", action: "grant" },
    { code: "CAPABILITY_REVOKED", action: "grant" },
    { code: "COMMAND_NOT_DECLARED" },
    { code: "CONFLICT" },
    { code: "DISCONNECTED", action: "reconnect" },
    { code: "FILE_TOO_LARGE" },
    { code: "HOST_FAILURE" },
    { code: "IDENTITY", action: "reconnect" },
    { code: "INSUFFICIENT_CREDIT", action: "billing" },
    { code: "INVALID_ARGUMENT" },
    { code: "PROTOCOL" },
    { code: "SAFETY_FILTER_REFUSED" },
    { code: "SELECTION_CHANGED", action: "reconnect" },
    { code: "TIMEOUT" },
  ];

  it.each(recovery)(
    "replaces $code diagnostics with copy and preserves retry truth",
    ({ code, action }) => {
      for (const retryable of [false, true]) {
        const error = new AppError("private operation details", {
          code,
          retryable,
          cause: new Error("private nested details"),
        });
        const description = describeAppError(error);
        expect(description.title.length).toBeGreaterThan(0);
        expect(description.message.length).toBeGreaterThan(0);
        expect(JSON.stringify(description)).not.toContain("private");
        expect(description.retryable).toBe(retryable);
        expect(description.action).toBe(
          action ?? (retryable ? "retry" : undefined),
        );
        expect(error.message).toBe("private operation details");
        expect(error.cause).toEqual(new Error("private nested details"));
      }
    },
  );

  it("offers Billing for typed credit exhaustion with the existing generic fallback copy", () => {
    expect(
      describeAppError(
        new AppError("private balance", {
          code: "INSUFFICIENT_CREDIT",
          retryable: false,
        }),
      ),
    ).toEqual({
      title: "Something went wrong",
      message: "The App couldn't complete this request.",
      action: "billing",
      retryable: false,
    });
  });

  it("decodes a Media safety refusal and offers rewording without retry or private diagnostics", () => {
    const failure = Schema.decodeUnknownSync(mediaGenerationFailureSchema)({
      message: "private provider diagnostics",
      stage: "provider",
      code: "SAFETY_FILTER_REFUSED",
      retryable: false,
    });
    const error = new MediaGenerationError(failure);
    expect(error.code).toBe("SAFETY_FILTER_REFUSED");
    expect(error.stage).toBe("provider");
    expect(describeAppError(error)).toEqual({
      title: "Safety filter refused this prompt",
      message: "The model's safety filter refused this prompt — try rewording.",
      retryable: false,
    });
  });

  it("does not infer typed authority or retryability from unknown failures", () => {
    const unknownFailures: readonly unknown[] = [
      undefined,
      null,
      "private thrown details",
      42,
      new Error("private exception details"),
      new Error("private wrapper", {
        cause: new AppError("private nested denial", {
          code: "CAPABILITY_DENIED",
          retryable: true,
        }),
      }),
      {
        code: "CAPABILITY_DENIED",
        message: "private wire details",
        retryable: true,
      },
    ];
    const fallback = describeAppError(undefined);
    for (const cause of unknownFailures) {
      expect(describeAppError(cause)).toEqual(fallback);
    }
    expect(fallback.retryable).toBe(false);
    expect(fallback.action).toBeUndefined();
    expect(JSON.stringify(fallback)).not.toContain("private");
  });

  it("overrides copy for one code without changing recovery policy or other calls", () => {
    const error = new AppError("private denial", {
      code: "CAPABILITY_DENIED",
      retryable: false,
    });
    const original = describeAppError(error);
    const copy = {
      title: "Allow image access",
      message: "Allow this App to read images.",
    };
    expect(describeAppError(error, { CAPABILITY_DENIED: copy })).toEqual({
      ...copy,
      retryable: false,
      action: "grant",
    });
    expect(describeAppError(error)).toEqual(original);
    expect(describeAppError(error, { TIMEOUT: copy })).toEqual(original);
  });

  it("does not claim a timed out request failed or made no changes", () => {
    const result = describeAppError(
      new AppError("private timeout", { code: "TIMEOUT", retryable: false }),
    );
    expect(result.message).toContain("outcome isn't known");
    expect(result.action).toBeUndefined();
  });
});
