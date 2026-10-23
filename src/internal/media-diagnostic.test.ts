import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import * as ts from "typescript";
import {
  decodeMediaProviderDiagnostic,
  mediaProviderDiagnosticWireSchema,
} from "../errors.js";
import { mediaGenerationFailureSchema } from "../media.js";

describe("safe Media provider facts", () => {
  it.each([
    { category: "InferenceUpstreamError", code: 3031 },
    { category: "Error", code: null },
    { category: "AiInternalError", code: 0 },
    { category: "TypeError", code: 99_999 },
    { category: "AbortError", code: null },
    { category: "TimeoutError", code: null },
    { category: "result_download", status: 503 },
    { category: "result_download", status: 0 },
    { category: "result_download", status: 599 },
  ])("round-trips bounded facts: $category", (diagnostic) => {
    const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      JSON.stringify(diagnostic),
    );
    expect(decodeMediaProviderDiagnostic(json)).toEqual(diagnostic);
    expect(mediaProviderDiagnosticWireSchema.parse(json)).toEqual(diagnostic);
  });

  it.each([
    { category: "arbitrary-upstream-name", code: 3031 },
    { category: "Error", code: 100_000 },
    { category: "Error", code: -1 },
    { category: "Error", code: 3031.5 },
    { category: "result_download", status: 600 },
    { category: "result_download", status: -1 },
    { category: "result_download", status: 503.5 },
    { category: "Error", code: null, message: "synthetic-private-marker" },
    {
      category: "result_download",
      status: 503,
      body: "synthetic-private-marker",
    },
  ])("rejects private or unbounded facts: %j", (diagnostic) => {
    expect(() => decodeMediaProviderDiagnostic(diagnostic)).toThrow();
    expect(
      mediaProviderDiagnosticWireSchema.safeParse(diagnostic).success,
    ).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(mediaGenerationFailureSchema, {
        onExcessProperty: "error",
      })({
        message: "Media failed",
        code: "HOST_FAILURE",
        retryable: false,
        provider: diagnostic,
      }),
    ).toThrow();
  });

  it("keeps the built Promise diagnostic declaration free of Effect references", async () => {
    const text = await readFile(
      new URL("../../dist/errors.d.ts", import.meta.url),
      "utf8",
    );
    const source = ts.createSourceFile(
      "errors.d.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const references: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isStringLiteral(node) &&
        (node.text === "effect" || node.text.startsWith("effect/"))
      )
        references.push(node.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(references).toEqual([]);
  });
});
