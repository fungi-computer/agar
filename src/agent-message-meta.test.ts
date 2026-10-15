import { describe, expect, it } from "vitest";

import {
  FungiMessageMetaSchema,
  messageAuthor,
  type MessageMetaValue,
} from "./agents.js";

describe("Fungi message metadata", () => {
  it("reads the author the host attached", () => {
    expect(messageAuthor({ author: { id: "user_ada", name: "Ada" } })).toEqual({
      id: "user_ada",
      name: "Ada",
    });
  });

  it("names no author for absent, foreign or malformed metadata", () => {
    const cases: readonly (MessageMetaValue | undefined)[] = [
      undefined,
      null,
      "Ada",
      { author: { id: "", name: "Ada" } },
      { author: { id: "user_ada", name: "Ada", role: "admin" } },
      { visitor: "x" },
    ];
    for (const meta of cases) expect(messageAuthor(meta)).toBeUndefined();
  });

  it("is a Standard Schema a Shiitake host can supply as its metadata schema", () => {
    const valid = FungiMessageMetaSchema["~standard"].validate({
      author: { id: "user_ada", name: "Ada" },
    });
    expect(valid).toEqual({
      value: { author: { id: "user_ada", name: "Ada" } },
    });
    const invalid = FungiMessageMetaSchema["~standard"].validate({ author: 1 });
    expect("issues" in invalid && invalid.issues !== undefined).toBe(true);
  });
});
