import { describe, expect, it } from "vitest";
import { appErrorData, appErrorFromData } from "./internal/app-error.js";
import * as Schema from "effect/Schema";
import * as z from "zod";
import { MediaGenerationError, mediaGenerationFailureSchema } from "./media.js";
import {
  AppError,
  describeAppError,
  failureCause,
  failureMessage,
  typedFailureMessage,
  NetworkRequestError,
  readAppFailure,
  type AppErrorCode,
  type ErrorDescription,
} from "./errors.js";
import { appFailureReasons } from "./backend-refusal.js";

describe("describeAppError", () => {
  it.each([
    {
      code: "APP_CONFIGURATION_FAILED",
      retryable: true,
      description: {
        title: "Couldn't load the App",
        message:
          "The App's configuration could not be loaded. Try opening it again.",
        retryable: true,
        action: "retry",
      },
    },
    {
      code: "SELECTION_CHANGED",
      retryable: false,
      description: {
        title: "Selection changed",
        message:
          "The selection changed during this request. Reopen the App to continue.",
        retryable: false,
        action: "reconnect",
      },
    },
    {
      code: "DESKTOP_OBSERVATION_LIMIT_REACHED",
      retryable: false,
      description: {
        title: "Desktop observation limit reached",
        message:
          "This desktop already has 24 active observations. Close one before adding another.",
        retryable: false,
      },
    },
  ] as const)(
    "keeps $code causes across the host error boundary",
    ({ code, retryable, description }) => {
      const crossed = appErrorFromData(
        appErrorData(new AppError("private diagnostic", { code, retryable })),
      );
      expect(describeAppError(crossed)).toEqual(description);
      expect(failureCause(crossed)).not.toContain("host doesn't offer");
    },
  );
  it("describes unsupported host features without offering permission grants", () => {
    const fromHost = new AppError("Computer choice is unavailable", {
      code: "HOST_UNSUPPORTED",
      retryable: false,
    });
    const crossed = appErrorFromData(appErrorData(fromHost));
    expect(crossed).toMatchObject({ code: "HOST_UNSUPPORTED" });
    expect(describeAppError(crossed)).toEqual({
      title: "Not available here",
      message: "This host doesn't offer that.",
      retryable: false,
    });
  });
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
    { code: "SETUP_REQUIRED", action: "setup" },
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

  it("names what a missing setup needs and sends the person to setup", () => {
    const missing = new AppError("private provider binding", {
      code: "SETUP_REQUIRED",
      retryable: false,
      need: "a model",
    });
    expect(describeAppError(missing)).toEqual({
      title: "Setup needed",
      message: "This needs a model first.",
      action: "setup",
      retryable: false,
    });
    // The need crosses the host RPC boundary with the code.
    const crossed = appErrorFromData(appErrorData(missing));
    expect(crossed).toMatchObject({ code: "SETUP_REQUIRED", need: "a model" });
    expect(describeAppError(crossed).message).toBe("This needs a model first.");
  });

  it("falls back to plain setup copy when the need is absent or out of contract", () => {
    for (const need of [undefined, "", "x".repeat(81)]) {
      const error = new AppError("x", {
        code: "SETUP_REQUIRED",
        retryable: false,
        ...(need !== undefined && { need }),
      });
      expect(describeAppError(error).message).toBe("This needs setup first.");
    }
    // A malformed need on the wire is refused, never half-trusted.
    expect(
      appErrorFromData({
        code: "SETUP_REQUIRED",
        message: "x",
        retryable: false,
        need: "x".repeat(81),
      }),
    ).toMatchObject({ code: "PROTOCOL" });
  });

  it("accepts SETUP_REQUIRED from Media hosts and keeps the need", () => {
    const failure = Schema.decodeUnknownSync(mediaGenerationFailureSchema)({
      message: "private binding name",
      stage: "admission",
      code: "SETUP_REQUIRED",
      need: "an image provider",
      retryable: false,
    });
    const error = new MediaGenerationError(failure);
    expect(error.need).toBe("an image provider");
    expect(describeAppError(error)).toEqual({
      title: "Setup needed",
      message: "This needs an image provider first.",
      action: "setup",
      retryable: false,
    });
  });

  it("offers Billing for typed credit exhaustion and names the credit cause", () => {
    expect(
      describeAppError(
        new AppError("private balance", {
          code: "INSUFFICIENT_CREDIT",
          retryable: false,
        }),
      ),
    ).toEqual({
      title: "Out of credit",
      message:
        "Your Team doesn't have enough credit for this. Add credit to continue.",
      action: "billing",
      retryable: false,
    });
  });

  it("describes a refused generation without claiming the prompt alone caused it", () => {
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
      title: "Generation refused",
      message:
        "The model refused this generation. Change the prompt or reference image and send again.",
      retryable: false,
    });
  });

  it.each([
    [
      "MEDIA_PROVIDER_FAILURE",
      "The model couldn't complete this generation. Change the prompt or model and send again.",
    ],
    [
      "MEDIA_PROVIDER_FAILURE_UNCHARGED",
      "The model couldn't complete this generation. You weren't charged. Change the prompt or model and send again.",
    ],
  ] as const)(
    "decodes %s without guessing billing or transience from 3030",
    (code, message) => {
      const failure = Schema.decodeUnknownSync(mediaGenerationFailureSchema)({
        message: "private provider diagnostics",
        stage: "provider",
        code,
        retryable: false,
        provider: { category: "Error", code: 3030 },
      });
      expect(describeAppError(new MediaGenerationError(failure))).toEqual({
        title: "Generation failed",
        message,
        retryable: false,
      });
    },
  );

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

describe("a host's stated failure reason", () => {
  const stated = (body: Readonly<Record<string, string>>, status = 503) =>
    readAppFailure(Response.json(body, { status }));

  it("words every reason with its own plain cause, never the code's generic line", () => {
    const generic = describeAppError(
      new AppError("x", { code: "HOST_FAILURE", retryable: true }),
    ).message;
    const seen = new Set<string>();
    for (const reason of appFailureReasons) {
      const described = describeAppError(
        new AppError("x", {
          code: "HOST_FAILURE",
          retryable: false,
          reason,
          ref: "ab12cd34",
        }),
      );
      expect(described.message).not.toBe(generic);
      expect(described.message).not.toContain("stopped answering");
      seen.add(described.message);
    }
    expect(seen.size).toBe(appFailureReasons.length);
  });

  it("says a Team being restored is coming back and offers a retry", () => {
    const described = describeAppError(
      new AppError("x", {
        code: "HOST_FAILURE",
        retryable: true,
        reason: "restoring",
      }),
    );
    expect(described.message).toBe(
      "This Team's Apps are being restored from storage. Try again in a minute.",
    );
    expect(described.action).toBe("retry");
  });

  it("shows the ref only for causes that are ours, once", () => {
    const worded = (reason: (typeof appFailureReasons)[number]) =>
      describeAppError(
        new AppError("x", {
          code: "HOST_FAILURE",
          retryable: false,
          reason,
          ref: "ab12cd34",
        }),
      ).message;
    expect(worded("binding_reply_invalid")).toBe(
      "One of the App's connections returned an answer we couldn't read. That's our bug (ref ab12cd34).",
    );
    expect(worded("backend_error")).toBe(
      "The App's own code failed on this request (ref ab12cd34).",
    );
    expect(worded("internal")).toBe(
      "An internal error stopped the App from running this request (ref ab12cd34).",
    );
    expect(worded("timed_out")).toBe(
      "The App took too long to answer. Its result isn't known; check before you retry.",
    );
  });

  it("falls back to the code's copy for a reason this SDK does not know", () => {
    const fromNewerHost = Object.assign(new Error("private"), {
      name: "AppError",
      code: "HOST_FAILURE",
      retryable: true,
      reason: "something_a_newer_host_invented",
      ref: "ab12cd34",
    });
    expect(describeAppError(fromNewerHost).message).toBe(
      describeAppError(
        new AppError("x", { code: "HOST_FAILURE", retryable: true }),
      ).message,
    );
  });

  it("reads a timed out refusal as a non-retryable timeout with its words", async () => {
    const error = await stated({
      error: "App execution unavailable",
      reason: "timed_out",
      ref: "ab12cd34",
    });
    expect(error).toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      reason: "timed_out",
      ref: "ab12cd34",
    });
    expect(describeAppError(error).message).toBe(
      "The App took too long to answer. Its result isn't known; check before you retry.",
    );
  });

  it("reads a cancelled request as a cancellation, not a failure", async () => {
    const error = await stated(
      { error: "App execution unavailable", reason: "cancelled" },
      499,
    );
    expect(error).toMatchObject({ code: "CANCELLED", retryable: false });
    expect(describeAppError(error).message).toBe(
      "This request was cancelled before it finished. Start it again if you still want it.",
    );
  });

  it("reads permission and internal causes", async () => {
    expect(
      await stated({
        error: "App execution unavailable",
        reason: "permission_changed",
      }),
    ).toMatchObject({
      code: "CAPABILITY_REVOKED",
      reason: "permission_changed",
    });
    const internal = await stated({
      error: "App execution unavailable",
      reason: "internal",
      ref: "zz99",
    });
    expect(internal).toMatchObject({ code: "HOST_FAILURE", retryable: true });
    expect(describeAppError(internal).message).toBe(
      "An internal error stopped the App from running this request (ref zz99).",
    );
  });

  it("names the status when the body states no reason, and survives non-JSON", async () => {
    for (const response of [
      Response.json({ error: "nope" }, { status: 502 }),
      Response.json(
        { error: "App execution unavailable", reason: "made_up" },
        { status: 502 },
      ),
      new Response("<html>private upstream</html>", { status: 502 }),
    ]) {
      const error = await readAppFailure(response);
      expect(error.message).toBe("The App backend answered HTTP 502");
      expect(error.reason).toBeUndefined();
      expect(error.message).not.toContain("private");
    }
  });
});

describe("failureCause", () => {
  it("words an App error's stated cause without a final period", () => {
    expect(
      failureCause(
        new AppError("private", {
          code: "TIMEOUT",
          retryable: true,
        }),
      ),
    ).toBe("The request didn't respond in time. Its outcome isn't known yet");
    expect(
      failureCause(
        new AppError("private balance", {
          code: "INSUFFICIENT_CREDIT",
          retryable: false,
        }),
      ),
    ).toBe(
      "Your Team doesn't have enough credit for this. Add credit to continue",
    );
  });
  it("says a request that never arrived failed on the network", () => {
    expect(failureCause(new NetworkRequestError())).toBe(
      "The network request failed. Check your connection",
    );
  });
  it("does not blame the network for a programming TypeError", () => {
    expect(failureCause(new TypeError("x is not a function"))).toBe(
      "x is not a function",
    );
  });
  it("never prints a schema failure's issue list", () => {
    const failure = z.object({ state: z.literal("open") }).safeParse({});
    expect(failure.success).toBe(false);
    expect(failureCause(failure.error)).toBe(
      "The response was not in the expected shape",
    );
  });
  it("states a plain error's own message, bounded", () => {
    expect(failureCause(new Error("Agent store is read-only."))).toBe(
      "Agent store is read-only",
    );
    expect(failureCause(new Error("x".repeat(500)))).toHaveLength(201);
  });
  it("says so when no reason was given, never something went wrong", () => {
    for (const cause of [undefined, "boom", new Error("  ")])
      expect(failureCause(cause)).toBe("No reason was given");
  });
  it("punctuates once when a caller appends a sentence", () => {
    for (const cause of [
      new AppError("private", { code: "TIMEOUT", retryable: true }),
      new NetworkRequestError(),
    ])
      expect(
        `${failureMessage("Could not open this Session", cause)} Try again.`,
      ).not.toContain("..");
  });
  it("puts what failed before why", () => {
    expect(
      failureMessage(
        "The conversation could not be started",
        new Error("No model is connected"),
      ),
    ).toBe("The conversation could not be started: No model is connected.");
  });
});

describe("typedFailureMessage", () => {
  it("states a typed App error's cause", () => {
    expect(
      typedFailureMessage(
        "That action did not finish",
        new AppError("private", { code: "TIMEOUT", retryable: true }),
      ),
    ).toBe(
      "That action did not finish: The request didn't respond in time. Its outcome isn't known yet.",
    );
  });
  it("never prints an untyped error's private text", () => {
    const message = typedFailureMessage(
      "That action did not finish",
      new Error("EACCES /secret/path"),
    );
    expect(message).toBe(
      "That action did not finish: the host returned an error it did not describe.",
    );
    expect(message).not.toContain("secret");
  });
});
