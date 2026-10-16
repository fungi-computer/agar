import * as z from "zod";
import * as Schema from "effect/Schema";
import { resultRowSchemaV1 } from "@fungi.computer/gills";
import type { ResultRowCodec } from "./backend-definition.js";

/**
 * The shared result row's decoder and JSON boundary, for
 * `defineAppMethod({ present: { verb, row, rows: resultRows } })`. Only
 * backends that present import this module, so the rest carry no decoder.
 */
export const resultRows: ResultRowCodec = Object.freeze({
  decode: Schema.decodeUnknownSync(resultRowSchemaV1, {
    onExcessProperty: "error",
  }),
  schema: z.fromJSONSchema(
    Schema.toJsonSchemaDocument(resultRowSchemaV1).schema,
  ),
});
