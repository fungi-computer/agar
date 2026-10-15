import { expect, it } from "vitest";
import * as z from "zod";
import {
  mediaRequestIds,
  mediaRequestIdSchema,
} from "../src/media-request-id.js";

it("publishes the same canonical grammar used by the durable Media identity", () => {
  const generated = mediaRequestIds.request.generate();
  expect(mediaRequestIdSchema.parse(generated)).toBe(generated);
  expect(
    mediaRequestIdSchema.parse("media_request_111111111111111111111"),
  ).toBe("media_request_111111111111111111111");
  expect(z.toJSONSchema(mediaRequestIdSchema)).toMatchObject({
    type: "string",
    minLength: 35,
    maxLength: 35,
    pattern: "^media_request_[a-z0-9]{21}$",
  });
  for (const value of [
    "logo-1",
    "media_request_abc",
    "media_request_11111111111111111111A",
    "media_request_11111111111111111111!",
    "media_request_1111111111111111111111",
    " media_request_111111111111111111111",
    "media_request_111111111111111111111\n",
  ]) {
    expect(mediaRequestIdSchema.safeParse(value).success).toBe(false);
    expect(mediaRequestIds.request.parse(value).ok).toBe(false);
  }
});
