# Agar API overview

| Import                                     | Export                                                              | Purpose                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@fungi.computer/agar`                     | `connectApp`                                                        | Connect a host-mounted App frontend and receive its context and grants.                             |
| `@fungi.computer/agar`                     | `defineCapability`, `AppError`                                      | Declare a typed host capability; the SDK's one typed failure.                                       |
| `@fungi.computer/agar/host`                | `connectAppHost`                                                    | Mount an App in an author-owned iframe test or standalone page.                                     |
| `@fungi.computer/agar/react`               | `mountApp`, `useAppContext`                                         | Mount a React App and read its host context.                                                        |
| `@fungi.computer/agar/query`               | `queryKeys`                                                         | TanStack Query keys and live feeds for host data.                                                   |
| `@fungi.computer/agar/errors`              | `describeAppError`                                                  | Turn a failure into approved, action-hinted UI copy.                                                |
| `@fungi.computer/agar/backend-definition`  | `defineAppBackend`, `defineAppMethod`                               | Define typed backend methods once, with Zod input and output.                                       |
| `@fungi.computer/agar/backend-declaration` | `buildAppApi`, `buildAppDeclaration`                                | Project the backend definition to the JSON Schema App API at build time.                            |
| `@fungi.computer/agar/backend`             | `appBackend`                                                        | Call the App's own backend from its frontend.                                                       |
| `@fungi.computer/agar/rpc`                 | `rpcHandleSchema`, `rpcMethod`                                      | Validate object-capability handles received over Cap'n Web.                                         |
| `@fungi.computer/agar/files`               | `readAppFile`, `writeAppFile`                                       | Turn a host-owned file read or write handle into a `File` or an upload.                             |
| `@fungi.computer/agar/storage`             | `appStorage`                                                        | Read, write and watch the App's own member and Team data.                                           |
| `@fungi.computer/agar/computer-contracts`  | `appComputerAdmissionRefusalSchema`, `appComputerExecTimeoutSchema` | Validate public Computer admission, dispatch and budget outcomes without exposing host credentials. |

A host decides what an App may do: the frontend asks for a capability and the
host grants, denies or revokes it. The backend definition is runtime-neutral;
the same methods back the App's own UI and, through the generated App API, the
tools a host offers to Agents. The generated module pages below list every type.

## Host side of the contract

The sections below document what hosts and advanced Apps rely on. An App built
from the README's backend methods, connection and capabilities does not need
them.

### Git pushes

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

#### Resumable writes

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

### Dynamic tool discovery

`defineAppBackend` accepts an optional
`toolFamily: { name: "flows", list: "listWorkflowTools", call: "runWorkflow" }`.
`buildAppApi` copies this descriptor into the signed API without executing the
listing or call handlers. The host reads inventory through the declared method
and keeps ordinary invocation admission; the descriptor grants no access.

### How the build uses the backend definition

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

### Website channels

The `@fungi.computer/agar/channels` subpath supplies `channelsRead` and
`channelsPersonalManage`. Both are off until a member approves the declared
capability for that App installation. Read access lists websites and up to 100
recent conversation summaries without visitor credentials or site keys. Manage
access holds, releases and replies through the website takeover owner; it does
not expose direct Session prompting. Every call checks current App consent and
the member's Team permissions. These are frontend capabilities, not Agent
backend bindings.

### Capability descriptors and Computer helpers

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

### Opening other Apps and App roles

`apps.open` is a declared presentation handoff. Compose intent supplies a
bounded draft, not an instruction to send it. Each App keeps its own identity
and granted capabilities.

Agar owns each App role's wire format; Puffball's App vocabulary owns the role
names. `@fungi.computer/agar/roles/files` is the `files` role contract. A caller
opens `{ role: filesRole, intent: filesNavigateIntent(location) }`, where the
location is a repository file at a branch or a Computer file, and the Team's
files App decodes it with `readFilesLocation`. The same module owns the file
browsing, edit and snapshot payloads that Files Apps and their callers exchange.

### Agent message metadata

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

### Gills in detail

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

### Media JSON transport

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

`@fungi.computer/agar/computer-contracts` is the runtime-neutral public home for
Computer admission, input, dispatch, timeout and attachment-budget outcomes. App
backend definitions can validate these outcomes without importing the Computer
RPC client. Apps request ordinary Computer execution; Workflow Git credential
issuance, carriage, renewal and revocation stay inside the trusted host and
native execution boundary, not the App contract.

### App Session sends

App Session sends are follow-ups: they cannot steer or interrupt a running turn.
The receiving Agent durably allows ten send attempts per rolling minute for each
installation and Session. A refused send returns
`{ error: "send_budget_exceeded", retryAfterMs }`; no message is dispatched.
Stored messages identify the calling App installation and whether it acts for an
Agent or Team member.

### Error copy in detail

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

### Files and the App backend

The browser gets capability handles, not Team cookies, namespace bindings or
provider keys. File reads consume a native response and create the browser File
locally. They dispose returned RPC values and per-read handles. Read
cancellation and mount disposal release the host request.

appBackend invokes this App's admitted backend. Its JSON request/result grammar
belongs to the App. The host supplies authenticated actor identity. A backend is
separately declared in an immutable App artifact. Importing the frontend SDK
does not create one or grant arbitrary egress.
