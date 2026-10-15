import * as z from "zod";
import { defineIdFamily } from "@fungi.computer/cairn/id";

/** One canonical identity for a retryable Media operation. */
export const mediaRequestIds = defineIdFamily({
  family: "hub-media-request",
  version: 1,
  kinds: {
    /** Canonical request identity for exact replay. */
    request: { prefix: "media_request" },
  },
});

/** Public wire grammar for the canonical retry identity, visible in App JSON schemas. */
export const mediaRequestIdSchema = z
  .string()
  .length(35)
  .regex(/^media_request_[a-z0-9]{21}$/);
