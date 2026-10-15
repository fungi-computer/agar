import * as z from "zod";
import * as Schema from "effect/Schema";
import {
  appApiSchema,
  appDeclarationSchema,
} from "@fungi.computer/puffball/app";
import type { AppApi, AppDeclaration } from "@fungi.computer/puffball";
import type { AppBackendDefinition } from "./backend-definition.js";
/** Build-only API projection from the schemas used by runtime calls. */
export function buildAppApi<Context>(
  backend: Pick<
    AppBackendDefinition<Context>,
    "methods" | "events" | "toolFamily"
  >,
): AppApi {
  let api: AppApi = {
    methods: Object.fromEntries(
      Object.entries(backend.methods).map(([name, method]) => [
        name,
        {
          ...method.policy,
          input: z.toJSONSchema(method.input, { io: "input" }),
          output: z.toJSONSchema(method.output, { io: "output" }),
        },
      ]),
    ),
  };
  if (backend.events !== undefined)
    api = {
      ...api,
      events: Object.fromEntries(
        Object.entries(backend.events).map(([name, event]) => [
          name,
          {
            description: event.description,
            payload: z.toJSONSchema(event.payload, { io: "output" }),
          },
        ]),
      ),
    };
  if (backend.toolFamily !== undefined)
    api = { ...api, toolFamily: backend.toolFamily };
  return Schema.decodeUnknownSync(appApiSchema)(api);
}
/** Strict build-only declaration generation; Workers never import this module. */
export function buildAppDeclaration<Context>(
  backend: Pick<
    AppBackendDefinition<Context>,
    "methods" | "events" | "gills" | "sync" | "toolFamily"
  >,
  declaration: unknown,
): AppDeclaration {
  const metadata = Schema.decodeUnknownSync(appDeclarationSchema)(declaration);
  if (metadata.gills !== undefined)
    throw new Error(
      "App Gills must be generated from the backend, not a second catalog",
    );
  if (metadata.backend?.sync !== undefined)
    throw new Error("App sync continuation must be generated from the backend");
  const methods = new Map(Object.entries(backend.methods));
  for (const view of backend.gills ?? []) {
    const method = methods.get(view.declaration.source);
    if (method?.policy.effect !== "read")
      throw new Error(
        `App Gill source must be a declared read method: ${view.declaration.source}`,
      );
    for (const param of view.declaration.params ?? []) {
      if (
        param.options !== undefined &&
        methods.get(param.options)?.policy.effect !== "read"
      )
        throw new Error(
          `Gill options source must be a declared read method: ${param.options}`,
        );
    }
  }
  let generated: AppDeclaration = { ...metadata, api: buildAppApi(backend) };
  if (backend.sync !== undefined)
    generated = {
      ...generated,
      backend: {
        ...metadata.backend,
        bindings: metadata.backend?.bindings ?? [],
        sync: backend.sync,
      },
    };
  if (backend.gills !== undefined)
    generated = {
      ...generated,
      gills: backend.gills.map((view) => view.declaration),
    };
  return Schema.decodeUnknownSync(appDeclarationSchema)(generated);
}
