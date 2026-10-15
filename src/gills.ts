import * as z from "zod";
import * as Schema from "effect/Schema";
import {
  appDeclaredGillSchema,
  decodeDeclaredGillResponse,
  decodeGillOptionsResponse,
  gillCallSchema,
  type AppDeclaredGill,
  type AppGillDesktopSize,
  type AppGillParam,
  type AppGillWatch,
  type GillCall,
  type GillReply,
  type GillOptionsResponse,
} from "@fungi.computer/gills";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { appBackendRefusalSchema } from "./backend-refusal.js";
import { decodeGillResponse, type GillResponse } from "@fungi.computer/gills";

/** Decode the App host's strict isolation refusal into its permanent Gill state. */
export function decodeGillRefusal(
  raw: unknown,
  declaration: Readonly<{ id: string; title: string }>,
): GillResponse | undefined {
  const refusal = appBackendRefusalSchema.safeParse(raw);
  if (!refusal.success || refusal.data.reason !== "exec_isolation_required")
    return undefined;
  return decodeGillResponse({
    viewId: declaration.id,
    title: declaration.title,
    state: "error",
    rows: [],
    reason: refusal.data.reason,
    error: `${declaration.title} isn't available on this preview.`,
  });
}

/** App-owned projection; methods keep their ordinary domain-shaped output. */
export type AppBackendGill = Readonly<{
  declaration: AppDeclaredGill;
  /** Page size passed to the source; projection never discards rows. */
  limit: number;
  /** Map placement and continuation to the source method, forwarding its limit. */
  input: (
    selection: Readonly<{
      params: Readonly<Partial<Record<string, string>>>;
      limit: number;
      after?: string | undefined;
    }>,
  ) => Readonly<{ limit: number; [key: string]: WhistleJsonValue }>;
  /** Decode the maintained call wire only for a backend declaring Gills. */
  parseCall: (raw: GillCall) => GillCall;
  /** Project through the backend's admitted read method callback. */
  call: (
    selection: GillCall,
    read: (
      name: string,
      input: WhistleJsonValue,
      kind: "rows" | "options",
    ) => Promise<WhistleJsonValue>,
  ) => Promise<GillReply>;
  /** Project parsed source output into text rows without dropping records. */
  rows: (
    output: WhistleJsonValue,
    context: Readonly<{ params: Readonly<Record<string, string>> }>,
  ) => GillResponse;
}>;
/** Define a compact view of one of this App's declared read methods. */
export function defineAppGill(
  options: Readonly<{
    id: string;
    title: string;
    source: string;
    limit: number;
    sizes?: readonly AppGillDesktopSize[];
    params?: readonly AppGillParam[];
    watch?: AppGillWatch;
    input: AppBackendGill["input"];
    rows: AppBackendGill["rows"];
  }>,
): AppBackendGill {
  let declaration: AppDeclaredGill = {
    id: options.id,
    title: options.title,
    source: options.source,
  };
  if (options.sizes !== undefined)
    declaration = { ...declaration, desktop: { sizes: options.sizes } };
  if (options.params !== undefined)
    declaration = { ...declaration, params: options.params };
  if (options.watch !== undefined)
    declaration = { ...declaration, watch: options.watch };
  declaration = Schema.decodeUnknownSync(appDeclaredGillSchema, {
    onExcessProperty: "error",
  })(declaration);
  return Object.freeze({
    declaration,
    limit: z.number().int().min(1).max(200).parse(options.limit),
    input: options.input,
    rows: options.rows,
    parseCall: Schema.decodeUnknownSync(gillCallSchema, {
      onExcessProperty: "error",
    }),
    call: async (selection, read) => {
      const params = selection.params ?? {};
      const declared = declaration.params ?? [];
      if (
        Object.keys(params).some(
          (key) => !declared.some((param) => param.key === key),
        )
      )
        throw new Error("Undeclared Gill parameter");
      if (selection.options !== undefined) {
        const param = declared.find(
          (candidate) => candidate.key === selection.options,
        );
        const source = param?.options;
        if (source === undefined)
          throw new Error("Gill options source must be a declared read method");
        let input: WhistleJsonValue = { limit: options.limit, params };
        if (selection.after !== undefined)
          input = { ...input, after: selection.after };
        return fitGillOptionsText(
          await read(source, input, "options"),
          options.limit,
        );
      }
      const missing = declared.find(
        (param) =>
          param.required &&
          (!Object.hasOwn(params, param.key) || !params[param.key]),
      );
      if (missing)
        return {
          viewId: selection.id,
          title: declaration.title,
          state: "error",
          rows: [],
          reason: "params_required",
          error: `Choose ${missing.label.toLowerCase()}`,
          recovery: { kind: "configure", param: missing.key },
        };
      const input = options.input({
        params,
        after: selection.after,
        limit: options.limit,
      });
      if (input.limit !== options.limit)
        throw new Error("Gill input must preserve its page size");
      const result = await read(declaration.source, input, "rows");
      return decodeDeclaredGillResponse(
        fitGillText(options.rows(result, { params }), options.limit),
        declaration,
      );
    },
  });
}

// The App-shard reply bound is 240 KiB. Navigation and cursors are never shortened.
const gillReplyByteLimit = 240 * 1024;
const utf8 = new TextEncoder();
function shortenText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  let prefix = text.slice(0, limit - 1);
  // Keep a surrogate pair intact when shortening Unicode display text.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}
function fitGillText(raw: GillResponse, pageSize: number): GillResponse {
  if (raw.rows.length > pageSize)
    throw new Error("Gill source exceeded its page size");
  let titleLimit = 4096;
  let detailLimit = 1024;
  for (;;) {
    let page: GillResponse;
    if (raw.state === "full")
      page = {
        ...raw,
        title: shortenText(raw.title, titleLimit),
        rows: raw.rows.map((row) => {
          let text = { ...row, title: shortenText(row.title, titleLimit) };
          if (row.detail !== undefined)
            text = { ...text, detail: shortenText(row.detail, detailLimit) };
          if (row.status !== undefined)
            text = {
              ...text,
              status: {
                ...row.status,
                label: shortenText(row.status.label, titleLimit),
              },
            };
          return text;
        }),
      };
    else if (raw.state === "error")
      page = {
        ...raw,
        title: shortenText(raw.title, titleLimit),
        error: shortenText(raw.error, 512),
      };
    else page = { ...raw, title: shortenText(raw.title, titleLimit) };
    const decoded = decodeGillResponse(page);
    if (utf8.encode(JSON.stringify(decoded)).byteLength <= gillReplyByteLimit)
      return decoded;
    if (titleLimit === 1 && detailLimit === 0)
      throw new Error("Gill navigation exceeds the reply byte budget");
    titleLimit = Math.max(1, Math.floor(titleLimit / 2));
    detailLimit = Math.floor(detailLimit / 2);
  }
}

function fitGillOptionsText(
  raw: WhistleJsonValue,
  pageSize: number,
): GillOptionsResponse {
  // The method's own output parse has already run. Bound display text before
  // decoding the shared choice wire; values and continuation are preserved.
  const projected = z
    .strictObject({
      options: z
        .array(
          z.strictObject({
            value: z.string().max(256),
            label: z.string().min(1),
            detail: z.string().optional(),
          }),
        )
        .max(pageSize),
      next: z.string().max(1024).optional(),
    })
    .parse(raw);
  let labelLimit = 4096;
  let detailLimit = 1024;
  for (;;) {
    const choices = decodeGillOptionsResponse({
      ...projected,
      options: projected.options.map((option) => {
        let text = { ...option, label: shortenText(option.label, labelLimit) };
        if (option.detail !== undefined)
          text = { ...text, detail: shortenText(option.detail, detailLimit) };
        return text;
      }),
    });
    if (utf8.encode(JSON.stringify(choices)).byteLength <= gillReplyByteLimit)
      return choices;
    if (labelLimit === 1 && detailLimit === 0)
      throw new Error("Gill option values exceed the reply byte budget");
    labelLimit = Math.max(1, Math.floor(labelLimit / 2));
    detailLimit = Math.floor(detailLimit / 2);
  }
}
