import * as Schema from "effect/Schema";

/** What a `SETUP_REQUIRED` failure names, in plain words such as "a model". */
export const setupNeedSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(80)),
);
