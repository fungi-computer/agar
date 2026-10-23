# Agar (`@fungi.computer/agar`)

Agar defines typed App backends and host capabilities. Most people want
[Oyster](https://docs.fungi.computer/oyster/) to run Apps or
[Shiitake](https://docs.fungi.computer/shiitake/) to run Agents.

Agar is the App contract for fungi.computer. It defines an App's typed backend
methods, connects its frontend to a host through typed capabilities, and gives
App builders selected context, host-rendered permission requests and explicit
cleanup. The host and resource owners authorize the work; the same App runs on
Fungi's hosted Teams or on any host that composes
[Oyster](https://oyster.shiit.app).

## Install or set up

Use Node 24 or newer.

Agar is a public package qualified with packed npm consumers. Qualification does
not publish an npm release; check the registry before choosing a released
version. To build the source workspace and check its tarball:

```sh
pnpm install --frozen-lockfile
pnpm turbo:run run build --filter=@fungi.computer/agar
pnpm --filter @fungi.computer/agar test
pnpm --filter @fungi.computer/agar run pack
pnpm --filter @fungi.computer/agar run stranger
```

The React entrypoint takes `react`, `react-dom` and `@tanstack/react-query` as
optional peers; the semantic SDK and backend entrypoints need none of them.

## Quick start

Define an App backend once. Its Zod schemas give the handler its TypeScript
contract and produce the JSON Schema API a host shows to Agents as tools. This
example runs in plain Node; no host is needed to define or call a method.

```ts
import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { buildAppApi } from "@fungi.computer/agar/backend-declaration";

const notes = new Map<string, string>();
const appBackend = defineAppBackend({
  methods: {
    saveNote: defineAppMethod({
      description: "Save a note under a title",
      effect: "write",
      requires: [],
      input: z.object({ title: z.string().min(1), text: z.string() }),
      output: z.object({ saved: z.boolean() }),
      handler: ({ title, text }) => {
        notes.set(title, text);
        return { saved: true };
      },
    }),
  },
});

const api = buildAppApi(appBackend);
console.log(Object.keys(api.methods)); // ["saveNote"]

const result = await appBackend.call(
  "saveNote",
  { title: "hello", text: "from Agar" },
  undefined,
  { computerId: null, actor: { kind: "member", memberId: "member_example" } },
);
console.log(result); // { saved: true }
```

An App imports `connectApp` from `@fungi.computer/agar` and operation helpers
from the declared subpaths. A plain top-level page has no Fungi parent to
connect to. Use a host-mounted App or the existing host fixtures for
development.

## Git pushes

An App requests `git.repository` in `fungi.app.capabilities` and declares
`fungi.app.receives: ["git.push"]`. The request is not approval: the host checks
the installation's live grant and repository ownership before delivery.
Repositories are local to that installation; another installation's repository
and the Team-fork source repository are outside this scope.

`@fungi.computer/agar/git` owns `GitBinding`, `GitWriter`, `GitPushQuestion`,
`GitPushVerdict`, `AppGitPushFact` and `AppGitLifecycle`. An App can implement
`authorizeGitPush(question): Promise<GitPushVerdict>` and
`onGitPush(fact): Promise<void>` as lifecycle handlers. Neither is an ordinary
callable App method. The question covers every ref update in one push; any
refusal refuses the whole push. An absent authorization handler refuses external
pushes.

`GitWriter` uses Puffball's canonical `HostActor` and `WorkflowAttestation`.
Actor writers carry a member, Agent or Team-key identity, an optional
host-attested Team role and optional Workflow attribution with its exact branch
list. Installation writers carry `installationId` and
`onBehalfOf: HostActor | null`. These schemas decode data; the host still owns
identity, grants and admission.

`dispatchAppGitPush` decodes a fact before invoking its handler and preserves
rejection. Facts contain the local repository, canonical writer, accepted ref
updates and stable `eventId`; they contain no provider URL or credential.
Optional `unexplained` entries identify refs whose previous head differs from
the host journal. Delivery is at least once: the handler records `eventId`
atomically with its own effects. The parser does not deduplicate App effects.

`@fungi.computer/agar/git-rpc` owns the native Git argument tuples, result
codecs and frame method descriptors used by hosts. `nativeGitFrameMethods`
checks the approved operations, including both `exchange` and `write` for
receive-pack. The codecs preserve positional arguments and binary results; they
perform no I/O and grant no authority. `invokeNativeGit` dispatches those
decoded tuples to a host-admitted `GitBinding`, preserving native results.

`@fungi.computer/agar/git-wire` parses receive-pack commands and report-status,
and encodes whole-push refusals. It performs no I/O. Unsupported pre-flush
lines, including signed push certificates, refuse instead of disappearing from
the host's authorization question.

`@fungi.computer/agar/git-commit` writes through that binding without a
credential:
`commitFiles(git, { repository, branch, expectedHead, startFrom?, changes, message, author })`
commits file writes and deletions to a branch, and
`moveRef(git, { repository, ref, expected, commit, source })` points a branch or
tag at an existing commit.
`moveRefs(git, { repository, source, commit, updates: [{ ref, expected }, ...] })`
fetches the source once and pushes the ref moves in order from the same memory
repository. Each push checks its own expected ref head. It returns
`{ kind: "stale", ref, head }` at the first conflict; earlier accepted moves
remain accepted. The ref moves are separate pushes, with no rollback.
`mergeBranch(git, { target, source, branch, sourceBranch, expectedSource, message, author })`
merges one repository's branch (such as a fork's) into another's with a merge
commit, reporting `conflict` with paths. The required `expectedSource` is the
reviewed commit: a different fetched source head returns
`{ kind: "source-moved", head }` without writing the target. The merge commit's
second parent is that checked source snapshot. Optional `expectedTarget` and
`behind: 0` from the same copy let the helper fetch only the source when its
complete history proves the copied target is an ancestor. The target push still
uses compare-and-swap; drop both hints on a stale retry. Without both hints, the
two remotes fetch in separate bounded steps. An inaccurate hint falls back to
fetching the target. No-op merges read the current target before reporting
`up-to-date`. These helpers run isomorphic-git in memory over `exchange` and are
compare-and-swap. A single-ref write that is not at the expected head returns
`{ kind: "stale", head }` without changing that ref. An unchanged tree returns
`unchanged` without a commit. A push that loses a race after its advertisement
is also `stale`, with the fresh head. Commits edit trees directly, so every
entry a change does not name keeps its object and mode (executables, symlinks);
an edited file keeps its mode unless the change sets `mode`.

### Resumable writes

`@fungi.computer/agar/git-steps` exposes the same commit and merge engine to
background jobs. `await begin(operation, material)` fixes the timestamp and
stores file bytes before returning a strict JSON checkpoint. Each
`await runStep(checkpoint, { git, material }, signal)` performs at most one Git
exchange and returns `{ next }`, `{ done }`, or `{ yield: true }`. An aborted
signal yields before transport. A checkpoint contains Git data, never
credentials, roles or grants.

Use `sqliteGitStepMaterial(sql)` with the existing facet SQLite owner. Material
rows are at most 1 MiB; input and new push packs are bounded to 8 MiB, and merge
material to 16 MiB. The 8 MiB input bound includes JSON/base64 overhead (about 6
MiB of raw files); these bounds also apply to the foreground drivers, which
throw `RangeError` for `too_large`. Oversize work returns `too_large` before a
push. Exchange responses are buffered before checking this bound; it limits
retained material, not peak transport memory. Reopening SQLite between steps
restores the objects in a fresh memory repository. The foreground `commitFiles`
and `mergeBranch` drivers loop these same steps with volatile material.

The App must freshly admit the member and check its domain policy each frame,
then persist the next checkpoint and idempotent successor in its existing
Watchdog owner transaction. An intermediate checkpoint is not Synced. After
durably recording a terminal outcome, call `dropMaterial(checkpoint, material)`;
dropping it before settlement would break uncertain-push recovery. The owner
must durably retain the operation identity before `begin` and replay `begin`
with the same request key if it dies before checkpointing. Cleanup can remove
build/fetch orphans only when that owner reaches terminal settlement.

`GitStepMaterialError` identifies permanent missing, conflicting, or
digest-mismatched material. Catch it inside the background executor and settle
the existing failed job/domain projection; retrying it cannot restore the lost
material. Do not treat ordinary transport or database errors as this permanent
material classification.

A normal existing-branch commit uses a ref check, one fetch POST, one push POST
and final ref confirmation. A same-repository merge uses five steps; a
cross-repository merge can use seven. Explicit source and target checks preserve
stale-head and source-moved outcomes. Every push, including an accepted
report-status, gets a separate ref confirmation before terminal settlement. An
uncertain push retries the same built pack; merge retries recheck the reviewed
source. A bounded permanent push refusal throws instead of reporting an unmoved
head as stale. Optional commit `tags` add a receive-pack capability check before
moving main and tags in one atomic push (five steps for an existing branch). A
server without `atomic` is refused before the push. An unchanged tree still
publishes missing tags using the existing commit, without another commit. If all
requested tags already name that selected commit, final confirmation returns
`committed` idempotently even when a tag's expected value was null. This means
the desired refs are confirmed, not that a new commit was created; consumers use
the returned commit ID. A tag naming a different commit remains `stale` and is
not overwritten.

Foreground cross-repository fetches now run serially through the same bounded
step engine rather than overlapping. This preserves the data/parent/CAS laws but
adds source checks and final confirmation round trips. Superseded branch-only
writes need a full-history ancestry fetch, currently limited to 16 MiB; an
oversize confirmation throws rather than claiming success.

The optional third `commitFiles` argument, `beforeWrite: () => Promise<void>`,
runs a caller's validation alongside the fetch. Both settle before the helper
returns or writes; rejecting validation prevents every receive-pack request.

The GIT binding's approved operations bound every call. Receive-pack requires
both `exchange` and `write`. For an Agent caller, the host also checks the
Agent's live Team Git grant. Hosts keep all provider credentials; the binding
returns only credential-free repository and Git object data. Smart-HTTP exchange
uses RPC-safe bytes: a `Uint8Array | null` request body and a
`{ status, headers, body: Uint8Array }` response. Stream and `Response`
conversion belongs inside the host adapter. Oyster and Hub consume this one
contract.

Apps request `EVENTS` with the `emit` operation to emit their declared events.
It requires no additional host capability; declaration approval and the event
catalog bound emission. Event schema and routing are owned by the event host.

## Dynamic tool discovery

`defineAppBackend` accepts an optional
`toolFamily: { name: "flows", list: "listWorkflowTools", call: "runWorkflow" }`.
`buildAppApi` copies this descriptor into the signed API without executing the
listing or call handlers. The host reads inventory through the declared method
and keeps ordinary invocation admission; the descriptor grants no access.

## Backend method declarations

Declare `fungi.backendDefinition` in the App package manifest, pointing to a
runtime-neutral module such as `backend/methods.ts`. Export
`appBackend = defineAppBackend({ methods })` there. The platform derives the
App's API and declaration from that definition with
`buildAppDeclaration(appBackend, fungi.app)` from
`@fungi.computer/agar/backend-declaration`; the manifest's `fungi.app` supplies
capabilities, commands, storage and `backend.bindings`. Authors write no
declaration module. Workers import only the definition; JSON Schema projection
and declaration validation never run on the call path. Each entry uses
`defineAppMethod` from `@fungi.computer/agar/backend-definition`: Zod `input`
and `output` schemas, a description, `effect`, `requires`, and a typed
`handler`. The schemas produce both the handler's TypeScript contract and its
JSON Schema declaration. `effect` describes the work but does not promise an
approval queue; the Hub broker owns approval and consent.

The build emits the API from this definition; do not write a `fungi.app.api`
method table in the manifest. It rejects methods requiring capabilities absent
from the App declaration. The API and policy are covered by the immutable
Release root's digest; metadata alone grants no access.
`appBackend.call(name, input, context, caller)` admits only defined methods and
parses both JSON input and output. Schema generation never executes a handler.
The exercised build and refusal proof is backend-definition.test.ts.

Declare `hidden: true` for maintenance methods used by the App itself. The
signed API retains the method and its validators, while Workflows and Agent/MCP
discovery omit it. This marker changes discovery; existing call permissions
still apply to direct requests.

An App may also supply `events` to `defineAppBackend`. Each named entry has a
`description` and a Zod `payload` schema. `buildAppApi` projects those schemas
into the optional `api.events` catalog, with no handlers or call authority. The
payload schema describes the whole `EVENTS.emit` payload
(`{ type, timestamp, data }`), not only its `data` field. For example:

```ts
const appBackend = defineAppBackend({
  methods: {},
  events: {
    "git.push": {
      description: "A repository accepted a push",
      payload: z.strictObject({
        type: z.literal("git.push"),
        timestamp: z.string(),
        data: z.strictObject({ branch: z.string() }),
      }),
    },
  },
});
```

Hosts validate emission against the selected Release's declaration. Defining an
event does not emit it or install a trigger. Apps that do not declare events
omit `api.events`; event metadata and payload changes are covered by the
immutable Release root, like method metadata.

A long-running method declares `pending: true` alongside its policy and returns
`pending(5000)` from `@fungi.computer/agar/backend-definition` while it is
working. This runtime-neutral entry also exports `pendingSchema` and the
`Pending` type. Its handler, runtime output parser and generated API accept
`Output | Pending`; methods without the opt-in keep their declared output.
`Pending` is `{ kind: "pending", retryAfterMs }`, where the delay is an integer
from 1000 to 60000 milliseconds. `pendingSchema` validates the same shape. The
opt-in lets a Workflow host poll this method with the same idempotency key.

Export the facet class through `appBackend.implement(YourFacetClass)`. This
generates declared methods through `appBackend.call` when the module loads.
Hand-written API methods, undeclared methods and accessors refuse registration,
including inherited ones. Host lifecycle methods (`fetch`, `alarm` and the
WebSocket handlers) remain outside the API. Handlers receive the calling
instance's context as their second argument; they do not keep Team state in the
exported definition. The Worker entry imports this same definition and supplies
its runtime class; keep `cloudflare:workers`, Node builtins and evaluation-time
network calls out of the definition module. Network work belongs inside method
handlers. The builder refuses offending imports with a message naming the import
and where to move it.

Customer builds run the emitter inside their Computer VM. Operator builds run
only reviewed repository source on the deploy host; the operator preparer
refuses foreign repositories. The backend bundle includes the exact compiled
definition that the emitter evaluates. Publisher reads the emitted file after
the build, strict-parses its bounded data and checks the source and backend
digests. For Team candidates this read happens in the Computer builder; the Hub
strictly decodes and verifies the submitted Release at its trust boundary. The
emitted declaration requests authority; it does not grant it. A load-time export
handshake is deferred; method calls still refuse undeclared or unimplemented
methods.

App Session sends are follow-ups: they cannot steer or interrupt a running turn.
The receiving Agent durably allows ten send attempts per rolling minute for each
installation and Session. A refused send returns
`{ error: "send_budget_exceeded", retryAfterMs }`; no message is dispatched.
Stored messages identify the calling App installation and whether it acts for an
Agent or Team member.

This authoring contract does not introduce Apps to Agents or change the current
browser `app.backend.request` transport. The invocation and UI migrations join
the declared methods separately.

## Connect and release

`connectApp({ host: "parent", signal })` discovers the host through the existing
parent handshake, without reading a referrer or accepting an origin parameter.
Serve the App document with CSP `frame-ancestors` pinned to its allowed host.
The browser checks the entire ancestor chain; without that policy an unrelated
site embedding the App could become its host. Hub and Oyster supply this policy
on their App document routes. Only the public, secret-free ready announcement
uses `"*"`; connection acceptance checks the actual parent Window, its
non-opaque origin, protocol and single transferred port before returning an
AppRoot. It permits one live connection per frontend page.

The root supplies:

| Surface                         | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `identity`                      | Host-issued App, Release and Surface IDs.               |
| `context`, `theme`, `lifecycle` | Current snapshots and subscriptions to host facts.      |
| `capabilities`                  | Handles to currently admitted operations.               |
| `ui`                            | Host-rendered consent, navigation, billing and notices. |
| `commands`, `window`            | Command registration, close consultation and Back.      |
| `dispose()`                     | Release the mount connection and its handles.           |

Abort a pending handshake when the caller unmounts. Dispose the root and every
subscription or command lease when that caller ends. A failed connection can be
retried after cleanup. Disposing a handle does not roll back work already
admitted by its resource owner.

## Request one operation

The `@fungi.computer/agar/channels` subpath supplies `channelsRead` and
`channelsPersonalManage`. Both are off until a member approves the declared
capability for that App installation. Read access lists websites and up to 100
recent conversation summaries without visitor credentials or site keys. Manage
access holds, releases and replies through the website takeover owner; it does
not expose direct Session prompting. Every call checks current App consent and
the member's Team permissions. These are frontend capabilities, not Agent
backend bindings.

Capability owners use `defineCapability(id, version, schema)` to decode their
live RPC interface and its results. `require` uses that owner schema after the
exact grant lookup. Schema functions stay local; only the descriptor's ID and
version travel with a grant. Data results are copied and their RPC envelopes
released; returned file, Fetch and terminal handles retain their own lifetime.
Local implementations register through the same typed descriptor.

Computer helpers expose bounded listing, file streams, terminal, process and
port operations. For example, `listComputerFiles` takes the root's capabilities
and `{ path, limit, offset }`, then decodes the listing. Its handles are bound
to the host-selected Computer. The frontend does not retarget one by submitting
another Computer ID. For an edited text file, `replaceComputerFileIfUnchanged`
accepts the opened `expectedContent` and new `content`. The Computer compares
and replaces them atomically; a changed file raises `AppError` with code
`CONFLICT` instead of acknowledging a stale save. `writeComputerFile` remains an
unconditional write for an explicit overwrite action.

The Computer instrument has separate `computer.instrument.read` and
`computer.instrument.control` handles. `readComputerInstrument` returns the
selected Computer's runtime, attached backends and resolved Internet state;
`startInstrumentComputer`, `setInstrumentInternetAccess` and
`detachInstrumentLocalBackend` require control. The host exposes those handles
only with the corresponding Computer grant and rechecks the member, App and
Computer owner on each operation.

First ask `root.ui.requestAppPermissions({ computers: ["computer.list"] })`.
Only a `granted` outcome warrants attempting the listing. `declined` and
`customize` are ordinary outcomes. The host bounds consent by the App's Release
declaration and the resource rechecks authority on each request. Connection,
declaration and grant are different facts.

The permission boundary proof crosses the actual host/client port with decoded
consent requests. The Computer tests and file tests cover data decoding, native
streams and disposal. These are local proofs, not customer authorization or a
hosted-provider qualification.

## Frontend and backend

The browser gets capability handles, not Team cookies, namespace bindings or
provider keys. File reads consume a native response and create the browser File
locally. They dispose returned RPC values and per-read handles. Read
cancellation and mount disposal release the host request.

appBackend invokes this App's admitted backend. Its JSON request/result grammar
belongs to the App. The host supplies authenticated actor identity. A backend is
separately declared in an immutable App artifact. Importing the frontend SDK
does not create one or grant arbitrary egress.

`apps.open` is a declared presentation handoff. Compose intent supplies a
bounded draft, not an instruction to send it. Each App keeps its own identity
and granted capabilities.

Agar owns each App role's wire format; Puffball's App vocabulary owns the role
names. `@fungi.computer/agar/roles/files` is the `files` role contract. A caller
opens `{ role: filesRole, intent: filesNavigateIntent(location) }`, where the
location is a repository file at a branch or a Computer file, and the Team's
files App decodes it with `readFilesLocation`. The same module owns the file
browsing, edit and snapshot payloads that Files Apps and their callers exchange.

## Back in the window chrome

An App keeps its own history. Route on memory history so the browser's history
never moves, because a host shows several App windows at once. The host shows
Back in the focused window's title bar while the App reports it can go back.

`root.window.navigation.publish({ canGoBack, title })` reports the latest state.
`title` is the current page, from 1 to 80 characters after trimming. An empty
title is dropped. `root.window.navigation.onBack(handler)` owns the host's Back
requests, one owner at a time. The handler answers `true` when it moved. The
report crosses as version 1 of the navigation contract, and a host rejects any
other version. Hosts without window chrome ignore reports.

`useHostNavigation` from `./react` does both for a React App and withdraws Back
on unmount. With TanStack Router:

```ts
const router = useRouter();
const canGoBack = useCanGoBack();
useHostNavigation(app?.window.navigation, {
  canGoBack,
  title: currentPageTitle,
  onBack: () => {
    if (!router.history.canGoBack()) return false;
    router.history.back();
    return true;
  },
});
```

The Tourtois workbench's `Desktop / App Back` story runs this recipe in a
two-page App.

The connection also turns the browser's own back inputs inside the App into App
Back. These are `Alt+←`, `⌘` and `⌘←` on a Mac (outside text fields), and the
mouse back button. It cancels them, together with the matching forward inputs,
even while the App cannot go back. A stray press therefore never navigates the
workspace page away. Input the App already handled (`defaultPrevented`) is left
alone.

The browser toolbar's Back button, trackpad swipes and the history menu stay
outside an App's reach.

`./agents` also exports `FungiMessageMetaSchema`, `authorMeta` and
`messageAuthor` for the author metadata attached by an admitting host. Shiitake
stores that metadata opaquely. Apps display the authenticated author without
importing Hub policy; absent, foreign or malformed metadata names no author.

A delegated Agent's reply carries `meta.delegation.reply`
(`FungiDelegationReplySchema`): the replying `agentId` and `sessionId`, the
`commandId` that equals the sender's `agents.send` receipt, the exact `outcome`
(`completed`, `failed`, `interrupted`, `cancelled` or `outcome_unknown`) and,
for `failed`, `interrupted` and `outcome_unknown`, a bounded one-line
`diagnostic`. The admitting host attaches it only after authenticating the reply
against the mail it sent, and the line's `author` is then the replying Agent.
`messageDelegationReply(meta)` reads it; a line whose text merely looks like a
reply has none.

Agent creation through `./agents` accepts `computer: "new" | "none"` alongside
`name` and `requestId`. Omission keeps the Hub's new-Computer default. The host
still admits Team membership, App permission and funding; the Computer choice is
bound to the creation receipt and does not grant attachment authority.

## Errors and reference

[AppError carries a typed `code` and explicit `retryable` flag. Handle denial,
revocation, selection change and disconnect beside the affected operation.
Report unexpected failures with their cause. Do not convert a failed request to
an empty successful result or retry a mutation without reviewing its owner's
outcome.

Use `describeAppError` from `@fungi.computer/agar/errors` at the UI boundary:

```ts
import { describeAppError } from "@fungi.computer/agar/errors";

const description = describeAppError(cause);
// Render description.title and description.message beside the failed operation.
// Keep the original cause for diagnostics; it is never included in the copy.
```

The function returns `ErrorDescription`: `title`, `message`, the error owner's
`retryable` flag, and an optional `grant`, `retry`, `reconnect` or `billing`
action hint. Grant and reconnect describe prerequisites rather than retrying the
failed operation. The helper never performs an action or schedules a retry. The
caller still owns the operation and its recovery controls. `INSUFFICIENT_CREDIT`
offers `billing`; its caller opens the existing `app.ui.openTeamBilling()` host
action.

Media's `SAFETY_FILTER_REFUSED` outcome is non-retryable. Its typed copy
explains that the model's safety filter refused the prompt and asks you to
reword it; it offers no automatic retry action and never displays provider
diagnostics.

Only SDK-decoded `AppError` instances select typed copy. Other failures receive
a generic description with `retryable: false` and no action; exception messages,
nested causes and error-shaped objects are not interpreted as display text or
authority. The optional `Partial<Record<AppErrorCode, ErrorCopy>>` argument
replaces a code's title and message only. It cannot override retry truth or the
recovery hint.

The wording approved by Levi is collected in the `errorCopy` table in errors.ts.
Prints is the first consumer; other Apps remain Wave 2 work. Hub-specific error
descriptions and typed App backend RPC remain with their respective owners.

[package.json](package.json) owns the exports. The root supplies connection and
shared types. Operation subpaths include `./computer`, `./agents`,
`./inference`, `./media`, `./apps`, `./backend`, `./errors` and `./react`.
`./host` supports App-author iframe integration tests and standalone mounts.
Capability contract versions do not replace Installation authority versions.

Semantic tests and disposal laws are the nearest executable examples of
connection, live updates, commands and lifetime.

## React App mounting

`@fungi.computer/agar/react` owns the browser mount lifecycle. Its React
entrypoint uses React, React DOM and TanStack React Query peers; the semantic
SDK entrypoint has no React runtime dependency. Keep App CSS and root-element
selection in the App:

```tsx
import { mountApp } from "@fungi.computer/agar/react";

const dispose = mountApp(root, { name: "Bazaar" }, ({ app }) => (
  <MarketplaceApp app={app} />
));
import.meta.hot?.dispose(dispose);
```

`mountApp` discovers its actual parent through Agar's existing handshake,
independently of referrer policy. The parent must have a non-opaque origin and
transfer exactly one port for the validated epoch. Top-level launches remain
standalone; embedded pages without a valid handshake report `not-hosted` with an
`AppError` and a visible alert rather than silently becoming standalone. It
applies and subscribes to the host's theme, and restores the original theme on
disconnect or unmount. Its render callback receives `connecting`, `live`,
`standalone` (a top-level launch), `not-hosted` (an initial connection failure),
or `ended` (a closed live connection). Only `live` carries an AppRoot. The
returned disposer aborts a pending handshake, releases subscriptions, disposes
the connection and unmounts React. A late connection is disposed too. Existing
App-open React performance marks are emitted at root render and commits.

Supply `queryClient` to wrap the App in `QueryClientProvider`. The caller owns
that client, its cache policy and grant invalidation; mounting does not clear
it.

- `useStore(store)` tracks a `ReadonlyStore`, including replacement/removal.
- `useAppContext(app)` returns the current host context or `null`.
- `useComputerId(app)` returns its selected Computer ID or `null`.
- `useAppCommandCatalog(app, { sourceId, namespace }, build)` owns local Whistle
  contributions and host registration leases. It returns the local runtime for
  slash projections. Memoize `build` with `useCallback`; changed dependencies
  replace the catalog and its captured availability. Unmount releases both
  sides, including host registrations acknowledged after unmount.

Bazaar is the first bootstrap adopter. Other Apps keep their existing
entrypoints until their adoption slices; query/feed polling belongs to the query
integration.

## Store an App's own data

Declare bounded `storage` keys in the App Release. The host then offers
`app.storage` v1 without a resource permission grant. It exposes only the
current installation's data: the calling member's private override, otherwise
the Team default, otherwise `source: "none"`. The App supplies its own code
constant for that last case. Overrides replace the whole JSON value, including
null; they are not merged.

```ts
import { appStorage } from "@fungi.computer/agar/storage";

const storage = root.capabilities.require(appStorage);
const desktop = await storage.watch("desktop");
const initial = desktop.get();
```

`watch` resolves after subscribing and reading a real snapshot. Its synchronous
`get` and `subscribe` follow later changes, including writes in other windows.
Close the watch with `desktop.close()` or `Symbol.dispose` when the consumer
ends, and release each subscription. Reconnection re-reads the current value;
this is a snapshot store, not a history of every mutation.

`read(key)` returns `{ value, source, team, member, canWriteTeam }`; each layer
is null or `{ value, revision }`. `write({ key, scope, value, basedOn })` and
`reset({ key, scope, basedOn })` compare that layer's revision, or null when it
is absent, and return `{ revision }`. Values must be JSON within the declared
byte bound and depth 32. The Hub also enforces App and Team quotas and a
mutation rate limit.

Only the current Team owner can write or reset the Team layer. No method takes a
member ID, and owners cannot read another member's override. A fork starts with
empty stored layers; uninstall and membership removal purge the affected values.
A member who rejoins starts with a fresh private scope.

`AppStorageError.code` is one of `invalid`, `undeclared_key`,
`scope_not_declared`, `owner_required`, `too_large`, `quota_exceeded`,
`conflict` or `unavailable`. A conflict requires a fresh read and a new user
decision; never overwrite the newer layer by retrying with an invented revision.

## Suggest desktop Gills

The admitted dashboard callback reads only a selected Gill’s saved sizes and
handles member-consented Add and Remove through its existing arranger. Ordinary
Apps receive no callback or arrange endpoint.

While a mounted App is focused and browser activation is active,
`await app.ui.openDesktopSettings()` asks the Hub to show a desktop Gill
suggestion. The member clicks **Review** in that host-rendered notice to open
**Settings → Apps → this App → Desktop**. It takes no arguments and returns no
desktop data. The Hub identifies the caller from its admitted surface; an App
cannot select another App or supply a placement. Browser activation does not
prove that the member intended to open Settings. An App can still take keyboard
focus; the Hub does not claim focus protection.

The member chooses one of that App’s declared desktop Gills, selects a size, and
clicks **Add to desktop**. Only that click calls the admitted dashboard’s member
arranger. Opening Settings never changes the layout or the Team default. Hosts
without this handoff reject it with `CAPABILITY_DENIED`.

## API reference

The generated [API reference](docs/api/README.md) is included in the tarball. It
covers the App author's surface: the root connection and shared types,
`./react`, `./query`, `./errors`, `./rpc`, `./backend`, `./backend-definition`,
`./backend-declaration`, `./files` and `./storage`.

Capability clients (`./computer`, `./agents`, `./apps`, `./channels`, `./inbox`,
`./gills` (host refusal decoding), `./media`, `./media-library`,
`./marketplace`, `./inference`, `./game-servers`, `./world`) only work against a
host that grants them, such as a Fungi Team. These capability clients do not yet
have generated reference pages; treat them as unstable.

## App-author iframe adapter

`@fungi.computer/agar/host` is the counterpart to `connectApp`. App authors use
`connectAppHost` to exercise their App in an integration test or mount it in a
standalone iframe page. Pass the exact child window and expected origin, a
launch identity and context, explicitly supplied capability handles, and
callbacks for the UI operations the page supports. The adapter binds the
MessagePort to that window and origin and owns its connection lifetime.

The returned `AppHost` updates context and theme, requests Back or Close, and
releases the connection with `dispose()`. The embedding page owns admission and
must supply only capabilities it can grant. Importing this adapter gives no
Fungi account, Hub keys, Team admission, desktop policy or window manager.
Optional UI callbacks route requests to the embedding page; they do not
implement billing or desktop settings. This is part of the App-author
integration contract. Oyster supplies the public shell helpers; Fungi's signed
host protocol remains private.

## Examples

The Quick start above defines a backend, builds its App API and calls a method
without a host. The Back example shows an App-owned navigation handler. The
maintained packed-consumer proof covers backend calls and imports the iframe
adapter from the installed tarball; connection and disposal suites additionally
exercise both sides of a real MessagePort in the repository.

## Limits and errors

A plain top-level page has no host to connect to; `connectApp` needs a
host-mounted iframe. Capability operations fail with typed `AppError` codes when
the host denies, revokes or lacks the capability. Method schemas validate input
and output on every call; a handler cannot return data its output schema
rejects.

## Contribute and license

Run `pnpm --filter @fungi.computer/agar test` for the SDK suites and
`pnpm --filter @fungi.computer/agar build` to compile the package. The package
uses the MIT license in [`LICENSE`](LICENSE).

Shared Gill declarations, row codecs and clients live in
`@fungi.computer/gills`. Define an App's compact views with `defineAppGill` from
`@fungi.computer/agar/gills` next to its `defineAppMethod` exports, then pass
them as `gills` to `defineAppBackend`. `buildAppDeclaration` generates their
Release metadata; do not repeat it in `package.json`.

Each Gill names a declared read method and a page `limit` from 1 to 200. Its
input mapping receives `{params, after, limit}` and must forward that limit to
the source method. Source methods must accept the limit and return one page with
their own valid continuation. The rows projection receives the method's parsed
JSON output and a second `{ params }` argument containing the placement values,
so navigation can retain the repository or other selected App context even when
the source output does not repeat it. It must not filter away source rows:
shorten text while keeping each row's identity and navigation parameters. The
helper bounds display text and the 240 KiB reply while preserving all rows and
the source's `next`; it refuses a page whose navigation alone exceeds the
budget.

A Gill's source runs through the method's existing input/handler/output parsing
and trusted caller context. A write source or an undeclared method is refused.
Placement may declare up to four Computer/repository/branch parameters, and a
storage marker or binding change feed. Repository or branch parameters may name
`options: "<own read method>"`. An options request calls that read method with
`{limit, params, after?}`; `params` contains the values chosen so far. Its
output is `{options: [{value, label, detail?}], next?}`, and it retains its own
capability requirements. Computer choices are host-owned; there is no picker
registry. `backend.gill` and the client return `GillReply`, a row/error response
or an options page. A row's `open.params` is an intent within that App, with no
URL or recipient App ID.

Agent extension backends compose `agentExtensionMethods` from
`@fungi.computer/shiitake/agar-extension` with `defineAppBackend`. The extension
adapter belongs to Shiitake; Agar does not depend on the Agent runtime.

## Media JSON transport

`@fungi.computer/agar/media-json` exports the page-side `MediaGeneration` and
`MediaGenerationAttempt` capability handles. Construct
`new MediaGeneration(call, computerId, mountSignal)` with the page's admitted
generic JSON method caller. Its signature is
`call(method, input?: Schema.Json, { signal }?) => Promise<Schema.Json | undefined>`;
signals are local fetch options and never enter JSON or RPC. Hosts own routing,
admission and HTTP translation. The App continues to use Agar's
`media.generation` v5 handle API.

The JSON methods are `describe()` (Computer identity, permission and models),
`generate({ requestId, destination: { path }, settings })` (a typed
`succeeded`/`failed` outcome or Agar `Pending`) and
`cancelAttempt({ requestId, computerId })` (a null or undefined acknowledgment).
Destination and reference inputs contain paths; hosts supply their authority.
The exported `mediaGenerationDescriptionSchema`,
`mediaGenerationJsonRequestSchema`, `mediaGenerationJsonOutcomeSchema`,
`mediaGenerationJsonReplySchema` and `mediaGenerationReferenceSchema` decode
these boundaries with the existing Agar Media grammar.

Failures may include safe `provider` facts: an allowlisted category and bounded
code, or `result_download` and an HTTP status. JSON, RPC and
`MediaGenerationError.provider` preserve the same facts and retry truth.
`./errors` exposes declaration-safe diagnostic types and decoder helpers; one
internal Effect schema owns validation. Private provider messages, bodies, URLs
and causes are not diagnostic fields and are rejected at this boundary.

Attempts retain their canonical request ID when restored or when polling
Pending. The shared Agar Pending validator requires an integer `retryAfterMs`
from 1000 to 60000. Cancellation aborts the attempt's active local requests;
background generation retains its identity for later restoration. Malformed JSON
replies refuse with a typed `PROTOCOL` error. Browser TypeScript consumers use
the platform DOM types and `ESNext.Disposable`.

See the [generated API](docs/api/README.md) for signatures and host ports.

`@fungi.computer/agar/computer-contracts` is the runtime-neutral public home for
Computer admission, input, dispatch, timeout and attachment-budget outcomes. App
backend definitions can validate these outcomes without importing the Computer
RPC client. Apps request ordinary Computer execution; Workflow Git credential
issuance, carriage, renewal and revocation stay inside the trusted host and
native execution boundary, not the App contract.
