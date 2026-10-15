/** Git smart-HTTP packet grammar shared by host doors and CAS writers. */
import type { GitPushVerdict, GitRefUpdate } from "./git.js";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const ZERO = "0".repeat(40);
const pushDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
class InvalidPushRequest extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
    readonly reason: "unparsable" | "push-cert" | "too-many" = "unparsable",
  ) {
    super(message, options);
  }
}

/** Strict client headers must be hexadecimal; provider status retains tolerant decoding. */
function packetHeader(
  bytes: Uint8Array,
  offset: number,
  strict: boolean,
): number {
  const header = decoder.decode(bytes.subarray(offset, offset + 4));
  if (strict && !/^[0-9a-f]{4}$/iu.test(header))
    throw new InvalidPushRequest("Invalid Git push packet");
  return Number.parseInt(header, 16);
}

/** Decode one packet's framing without consuming payload or a following pack. */
function packetLength(
  bytes: Uint8Array,
  offset: number,
  strict: boolean,
): number | null {
  const length = packetHeader(bytes, offset, strict);
  if (Number.isNaN(length)) return null;
  if (strict && length === 1)
    throw new InvalidPushRequest("Unsupported Git push delimiter");
  if (length <= 1) return length;
  if (length < 4 || offset + length > bytes.length) {
    if (strict) throw new InvalidPushRequest("Truncated Git push packet");
    return null;
  }
  return length;
}

/** Command bounds apply before decoding; provider status packets remain tolerant. */
function packetContent(
  bytes: Uint8Array,
  offset: number,
  length: number,
  count: number,
  strict: boolean,
): Uint8Array {
  if (strict && count >= 256)
    throw new InvalidPushRequest(
      "Too many Git push commands",
      undefined,
      "too-many",
    );
  return bytes.subarray(offset + 4, offset + length);
}

/** Split pkt-lines from the start of `bytes`; stops at the first flush when asked. */
export function readPacketLines(
  bytes: Uint8Array,
  stopAtFlush: boolean,
  strict = false,
): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let offset = 0;
  let flushed = false;
  while (offset + 4 <= bytes.length) {
    const length = packetLength(bytes, offset, strict);
    if (length === null) break;
    if (length <= 1) {
      offset += 4;
      if (stopAtFlush && length === 0) {
        flushed = true;
        break;
      }
      continue;
    }
    lines.push(packetContent(bytes, offset, length, lines.length, strict));
    offset += length;
  }
  if (strict && !flushed)
    throw new InvalidPushRequest("Git push command section has no flush");
  return lines;
}

/** Encode one UTF-8 text packet with its byte-counted four-byte Git header. */
export function pktLine(text: string): string {
  return (encoder.encode(text).length + 4).toString(16).padStart(4, "0") + text;
}

const COMMAND = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)$/iu;
/** A shallow client's graft boundary, sent before its commands
 * (pack-protocol `update-request = *shallow command-list`). */
const SHALLOW = /^shallow [0-9a-f]{40}\n?$/iu;

/** What a client sends before its pack. */
type PushRequest = Readonly<{
  commands: readonly GitRefUpdate[];
  capabilities: readonly string[];
}>;

/** Decode exactly the command and optional capability fields supplied by the client. */
function pushFields(raw: Uint8Array): readonly string[] {
  let text: string;
  try {
    text = pushDecoder.decode(raw);
  } catch (cause) {
    throw new InvalidPushRequest("Invalid Git push command encoding", {
      cause,
    });
  }
  const fields = text.replace(/\n$/u, "").split("\0");
  if (fields.length > 2)
    throw new InvalidPushRequest("Invalid Git push command capabilities");
  return fields;
}

function refCommand(line: string): GitRefUpdate {
  const match = COMMAND.exec(line);
  if (!match) {
    const signed = line.startsWith("push-cert");
    throw new InvalidPushRequest(
      signed ? "Unsupported push-cert command" : "Unsupported Git push command",
      undefined,
      signed ? "push-cert" : "unparsable",
    );
  }
  const [, before = ZERO, after = ZERO, ref = ""] = match;
  return { before: before.toLowerCase(), after: after.toLowerCase(), ref };
}

function pushCapabilities(
  caps: string | undefined,
  commandIndex: number,
): string[] | undefined {
  if (caps === undefined) return undefined;
  if (commandIndex !== 0)
    throw new InvalidPushRequest(
      "Git push capabilities must accompany the first command",
    );
  const capabilities = caps.split(" ").filter(Boolean);
  if (
    capabilities.some(
      (capability) =>
        capability === "push-cert" || capability.startsWith("push-cert="),
    )
  )
    throw new InvalidPushRequest(
      "Signed Git pushes (push-cert) are not supported",
      undefined,
      "push-cert",
    );
  return capabilities;
}

/** The ref commands a client sends before its pack, and its capabilities. */
function pushRequest(body: Uint8Array): PushRequest {
  const commands: GitRefUpdate[] = [];
  let capabilities: string[] = [];
  const lines = readPacketLines(body, true, true);
  // A push from a shallow repository (for example a `--depth 1` clone)
  // names its graft boundaries first; the server only needs the commands.
  const first = lines.findIndex((line) => !SHALLOW.test(decoder.decode(line)));
  for (const raw of first === -1 ? [] : lines.slice(first)) {
    const [line = "", caps] = pushFields(raw);
    const command = refCommand(line);
    const nextCapabilities = pushCapabilities(caps, commands.length);
    commands.push(command);
    if (nextCapabilities !== undefined) capabilities = nextCapabilities;
  }
  if (commands.length === 0)
    throw new InvalidPushRequest("Empty Git push command section");
  return { commands, capabilities };
}

/** Refs the provider accepted, read from report-status (with or without side-band). */
export function acceptedRefs(
  response: Uint8Array,
  sideBand: boolean,
): ReadonlySet<string> {
  let status = response;
  if (sideBand) {
    const parts = readPacketLines(response, false)
      .filter((line) => line[0] === 1)
      .map((line) => line.subarray(1));
    status = new Uint8Array(
      parts.reduce((size, part) => size + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      status.set(part, offset);
      offset += part.length;
    }
  }
  const accepted = new Set<string>();
  for (const raw of readPacketLines(status, false)) {
    const text = decoder.decode(raw).replace(/\n$/u, "");
    if (text.startsWith("ok ")) accepted.add(text.slice(3));
  }
  return accepted;
}

/** The decoded receive-pack command section; pack bytes remain unopened. */
export type ReceivePack =
  | Readonly<{
      kind: "ok";
      updates: readonly GitRefUpdate[];
      capabilities: readonly string[];
    }>
  | Readonly<{
      /** A lone flush: the probe Git sends before a chunked (large) push to
       * check authentication; it updates nothing. */
      kind: "probe";
    }>
  | Readonly<{
      kind: "invalid";
      reason: "unparsable" | "push-cert" | "too-many";
    }>;
/** Fail closed on any command the maintained Git wire contract does not support. */
export function parseReceivePack(body: Uint8Array): ReceivePack {
  if (body.byteLength === 4 && decoder.decode(body) === "0000")
    return { kind: "probe" };
  try {
    const push = pushRequest(body);
    return {
      kind: "ok",
      updates: push.commands,
      capabilities: push.capabilities,
    };
  } catch (cause) {
    if (!(cause instanceof InvalidPushRequest)) throw cause;
    return { kind: "invalid", reason: cause.reason };
  }
}

/** Whole-push refusal in report-status, including the negotiated side-band framing. */
export function refusalReport(
  verdict: GitPushVerdict & { allowed: false },
  updates: readonly GitRefUpdate[],
  capabilities: readonly string[],
): Uint8Array {
  const messages = new Map(
    verdict.refused.map(({ ref, message }) => [ref, message]),
  );
  const report =
    pktLine("unpack ok\n") +
    updates
      .map(({ ref }) =>
        pktLine(
          `ng ${ref} ${(messages.get(ref) ?? "another ref in this push was refused").replace(/[\r\n\0]/gu, " ")}\n`,
        ),
      )
      .join("") +
    "0000";
  if (
    !capabilities.includes("side-band") &&
    !capabilities.includes("side-band-64k")
  )
    return encoder.encode(report);
  const bytes = encoder.encode(report);
  const chunkSize = capabilities.includes("side-band-64k") ? 65515 : 995;
  const chunks = Math.ceil(bytes.byteLength / chunkSize);
  const output = new Uint8Array(bytes.byteLength + chunks * 5 + 4);
  let offset = 0;
  for (let start = 0; start < bytes.byteLength; start += chunkSize) {
    const chunk = bytes.subarray(start, start + chunkSize);
    output.set(
      encoder.encode((chunk.byteLength + 5).toString(16).padStart(4, "0")),
      offset,
    );
    output[offset + 4] = 1;
    output.set(chunk, offset + 5);
    offset += chunk.byteLength + 5;
  }
  output.set(encoder.encode("0000"), offset);
  return output;
}

/** Data channel of an upload-pack side-band reply; fatal server messages refuse. */
export function sideBandData(body: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const packet of readPacketLines(body, false)) {
    if (packet[0] === 3) throw new Error(decoder.decode(packet.subarray(1)));
    if (packet[0] === 1) chunks.push(packet.subarray(1));
    else if (decoder.decode(packet).startsWith("ERR "))
      throw new Error(decoder.decode(packet));
  }
  const result = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Ref names and object IDs from the maintained smart-HTTP advertisement framing. */
export function advertisedRefs(body: Uint8Array): ReadonlyMap<string, string> {
  const refs = new Map<string, string>();
  for (const raw of readPacketLines(body, false)) {
    const line = decoder.decode(raw).replace(/\n$/u, "");
    if (line.startsWith("#")) continue;
    const [entry = ""] = line.split("\0");
    const [oid = "", name = ""] = entry.split(" ");
    if (/^[0-9a-f]{40}$/u.test(oid) && name.startsWith("refs/"))
      refs.set(name, oid);
  }
  return refs;
}

/** Capabilities from the ref advertisement's first NUL-delimited capability list. */
export function advertisedCapabilities(body: Uint8Array): ReadonlySet<string> {
  for (const raw of readPacketLines(body, false)) {
    const line = decoder.decode(raw);
    const separator = line.indexOf("\0");
    if (separator >= 0)
      return new Set(
        line
          .slice(separator + 1)
          .trim()
          .split(" ")
          .filter(Boolean),
      );
  }
  return new Set();
}
