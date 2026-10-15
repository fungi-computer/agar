import { URL } from "node:url";
import { expect, it } from "vitest";
import { build } from "esbuild";
import * as Schema from "effect/Schema";
import {
  mediaLibraryPathSchema,
  mediaLibraryRequestSchema,
  mediaLibraryResponseSchema,
} from "./media-library.js";
import * as media from "./media.js";

it("keeps the library contracts identical for browser and backend consumers", () => {
  expect(media.mediaLibraryPathSchema).toBe(mediaLibraryPathSchema);
  expect(media.mediaLibraryRequestSchema).toBe(mediaLibraryRequestSchema);
  expect(media.mediaLibraryResponseSchema).toBe(mediaLibraryResponseSchema);
  expect(
    Schema.decodeUnknownSync(mediaLibraryResponseSchema)({ path: "/images" }),
  ).toEqual({ path: "/images" });
  for (const path of [
    "relative",
    "/",
    "/a\0b",
    "/a/..",
    "/a/.",
    "/images/",
    `/${"x".repeat(4096)}`,
  ]) {
    expect(Schema.decodeUnknownOption(mediaLibraryPathSchema)(path)._tag).toBe(
      "None",
    );
  }
});

it("bundles the maintained library schemas under the definition emitter's neutral conditions", async () => {
  const result = await build({
    entryPoints: [new URL("./media-library.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    metafile: true,
    plugins: [
      {
        name: "neutral-library-law",
        setup(builder) {
          builder.onResolve(
            { filter: /^(cloudflare:|node:|capnweb$)/ },
            (args) => ({
              errors: [
                { text: `Library data imported runtime code: ${args.path}` },
              ],
            }),
          );
        },
      },
    ],
  });
  expect(result.outputFiles[0].text).toContain("mediaLibraryResponseSchema");
  expect(
    Object.keys(result.metafile.inputs).some(
      (path) =>
        path.includes("rpc-contract") ||
        path.includes("@fungi.computer/capnweb"),
    ),
  ).toBe(false);
});
