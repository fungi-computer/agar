import { describe, expect, expectTypeOf, it } from "vitest";

import {
  authorMeta,
  type AuthorMeta,
  type FungiAuthor,
  FungiMessageMetaSchema,
  messageAuthor,
  type MessageMetaValue,
} from "./agents.js";

describe("Fungi message metadata", () => {
  it("retains a translated request's original identity without obscuring its author", () => {
    const meta = {
      ...authorMeta({ id: "visitor_one", name: "Visitor" }),
      sourceRequestId: "composer-original",
    };
    expect(FungiMessageMetaSchema.parse(meta)).toEqual(meta);
    expect(messageAuthor(meta)).toEqual(meta.author);
    expect(
      FungiMessageMetaSchema.safeParse({ ...meta, sourceRequestId: "" })
        .success,
    ).toBe(false);
    expect(
      FungiMessageMetaSchema.safeParse({
        ...meta,
        sourceRequestId: "x".repeat(257),
      }).success,
    ).toBe(false);
  });

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

  it("round-trips the agent kind the host stamped (another Agent's message)", () => {
    const meta = authorMeta({
      id: "agent_a",
      name: "Research agent",
      kind: "agent",
    });
    expect(messageAuthor(meta)).toEqual({
      id: "agent_a",
      name: "Research agent",
      kind: "agent",
    });
  });

  it("gives a human author no kind (human lines unchanged)", () => {
    const meta = authorMeta({ id: "user_ada", name: "Ada" });
    expect(meta).toEqual({ author: { id: "user_ada", name: "Ada" } });
    expect("kind" in (messageAuthor(meta) ?? {})).toBe(false);
  });

  it("refuses any kind but agent", () => {
    expect(
      messageAuthor({ author: { id: "x", name: "X", kind: "operator" } }),
    ).toBeUndefined();
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

  it("derives the metadata author from the one FungiAuthor shape, with the same keys", () => {
    expectTypeOf<AuthorMeta["author"]>().toExtend<Readonly<FungiAuthor>>();
    expectTypeOf<keyof AuthorMeta["author"]>().toEqualTypeOf<
      keyof FungiAuthor
    >();
  });
});
