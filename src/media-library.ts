import * as Schema from "effect/Schema";

/** A Media-role App exposes the selected library for one Computer to other granted Apps. */
export const mediaLibraryRequestSchema = Schema.Struct({
  operation: Schema.Literal("read-library"),
  computerId: Schema.NonEmptyString,
});
/** A bounded Computer directory shared by folder selection and library reads. */
export const mediaLibraryPathSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4096)),
  Schema.check(
    Schema.makeFilter(
      (path) =>
        path.startsWith("/") &&
        path !== "/" &&
        !path.includes("\0") &&
        !path.endsWith("/") &&
        !path.split("/").some((segment) => segment === "." || segment === ".."),
    ),
  ),
);
export const mediaLibraryResponseSchema = Schema.Struct({
  path: Schema.NullOr(mediaLibraryPathSchema),
});
