# Agar (`@fungi.computer/agar`)

Agar is the contract for building an App that runs on Fungi or on your own
[Oyster](https://github.com/fungi-computer/oyster). You define the App's backend
methods once with Zod; the same methods back the App's own UI and become the
typed tools a host offers to Agents. The App's frontend connects to its host and
asks for what it needs, such as files on a Computer, Agents or image generation,
and the host grants, denies or revokes each capability.

To run Apps rather than build them, start with
[Oyster](https://docs.fungi.computer/oyster/). To run Agents, start with
[Shiitake](https://docs.fungi.computer/shiitake/).

## Install

```sh
npm install @fungi.computer/agar zod
```

Agar is ESM and needs Node 24 or newer to build an App. The React entrypoint
takes `react`, `react-dom` and `@tanstack/react-query` as optional peers; the
core SDK and backend entrypoints need none of them.

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

To turn this into an installable App, copy the
[Notes example App](https://github.com/fungi-computer/oyster/tree/main/examples/notes-app)
or run `npm create fungi-app@latest my-app`, and install it on an Oyster.

## Backend methods

Point `fungi.backendDefinition` in the App's `package.json` at a runtime-neutral
module such as `backend/methods.ts` that exports
`appBackend = defineAppBackend({ methods })`. The build derives the App's API
and declaration from that definition and the manifest's `fungi.app`
(capabilities, commands, storage and `backend.bindings`); you write no
declaration module and no `fungi.app.api` table. A method that requires a
capability the App does not declare is refused at build time.

Each method declares Zod `input` and `output`, a `description`, an `effect`, the
capabilities it `requires` and a typed `handler`. Calls parse both input and
output, so a handler cannot return data its schema rejects. Other options:

- `hidden: true` keeps a maintenance method out of Workflow and Agent discovery;
  direct calls still need their permissions.
- `pending: true` lets a long-running method return `pending(5000)` from
  `@fungi.computer/agar/backend-definition` while it works, so a host polls it
  with the same idempotency key. The delay is 1,000 to 60,000 ms.
- `events` on `defineAppBackend` names the events the App emits through
  `EVENTS.emit`, each with a `description` and a Zod schema of the whole
  `{ type, timestamp, data }` payload.

Export the backend's Durable Object facet class through
`appBackend.implement(YourFacetClass)`, which generates the declared methods.
Hand-written or undeclared methods are refused. Keep `cloudflare:workers`, Node
built-ins and network calls at evaluation time out of the definition module;
network work belongs inside handlers.

## Connect the frontend

`connectApp({ host: "parent", signal })` from `@fungi.computer/agar` connects an
App page to its host through the parent frame's handshake. It returns an
AppRoot:

| Surface                         | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `identity`                      | Host-issued App, Release and Surface IDs.               |
| `context`, `theme`, `lifecycle` | Current snapshots and subscriptions to host facts.      |
| `capabilities`                  | Handles to currently admitted operations.               |
| `ui`                            | Host-rendered consent, navigation, billing and notices. |
| `commands`, `window`            | Command registration, close consultation and Back.      |
| `dispose()`                     | Release the mount connection and its handles.           |

A React App mounts with `mountApp` from `@fungi.computer/agar/react`, which runs
the handshake, applies the host's theme and cleans up on unmount:

```tsx
import { mountApp } from "@fungi.computer/agar/react";

const dispose = mountApp(root, { name: "Bazaar" }, ({ app }) => (
  <MarketplaceApp app={app} />
));
import.meta.hot?.dispose(dispose);
```

Its render callback receives `connecting`, `live`, `standalone` (a top-level
launch), `not-hosted` (an initial connection failure) or `ended`; only `live`
carries an AppRoot. Pass `queryClient` to wrap the App in `QueryClientProvider`.
`useAppContext(app)`, `useComputerId(app)`, `useStore(store)` and
`useAppCommandCatalog` read host state and register commands.

Serve the App document with a CSP `frame-ancestors` pinned to its host; Fungi
and Oyster do this on their App routes. A plain top-level page has no host to
connect to. To exercise an App in an integration test or a standalone iframe
page, `connectAppHost` from `@fungi.computer/agar/host` is the counterpart: you
pass the child window, its origin, a launch context and only the capabilities
your page can grant.

## Ask for a capability

First ask the member, then use the handle:

```ts
import { listComputerFiles } from "@fungi.computer/agar/computer";

const outcome = await root.ui.requestAppPermissions({
  computers: ["computer.list"],
});
if (outcome === "granted") {
  const files = await listComputerFiles(root.capabilities, {
    path: "/workspace",
    limit: 50,
    offset: 0,
  });
}
```

A request may also name `git` (`git.repository`), `workflows`
(`workflow.publish`, `workflow.arm`, `workflow.run`), `events`
(`app.events.emit`) and `generation` (`llm.generation`, `media.generation`,
`media.share`) rights, using the grant catalog's own names.

`declined` and `customize` are ordinary outcomes. The host bounds consent by the
App's Release declaration, and the resource rechecks authority on every request.
The browser gets capability handles, never Team cookies, namespace bindings or
provider keys.

Capability clients live in their own subpaths: `./computer` (files, terminal,
processes and ports on the host-selected Computer), `./agents`, `./apps`,
`./media`, `./media-library`, `./inference`, `./channels`, `./inbox`,
`./marketplace`, `./game-servers` and `./world`. They only work against a host
that grants them, such as a Fungi Team. `appBackend` from `./backend` calls the
App's own admitted backend.

## Check setup first

A host that knows what is installed publishes `context.setup` (`models`,
`media`, `git`: `ready | missing | unknown`; `terminal`:
`ready | exec-only | missing | unknown`) and updates it live. A host that does
not publish it omits the field, so treat absence as `unknown` and still try.
When something is `missing`, call
`root.ui.openSetup("model" | "media" | "git" | "computer")`. It resolves
`opened` or `unavailable` (a host with no such surface); the App keeps its own
plain explanation in the second case.

`context.permissions` says which of its declared rights this App holds now
(`granted` or `missing`, keyed by the catalog's own names such as
`git.repository`), so it can offer "Approve access" up front. A host updates it
after `requestAppPermissions`; a right the App does not declare, or a host that
does not publish it, leaves the key absent (treat as unknown).

An App may mark a status item `priority: "low"`; the host drops those first when
the window is too narrow for the whole bar.

## Store an App's own data

Declare bounded `storage` keys in the App Release, and the host offers
`app.storage` without a permission prompt. Each key resolves to the calling
member's private override, otherwise the Team default, otherwise
`source: "none"`.

```ts
import { appStorage } from "@fungi.computer/agar/storage";

const storage = root.capabilities.require(appStorage);
const desktop = await storage.watch("desktop");
const initial = desktop.get();
```

`watch` resolves after reading a real snapshot and follows later changes,
including writes in other windows; close it with `desktop.close()`. `read(key)`
returns both layers with their revisions, and `write` and `reset` compare the
layer's revision (`basedOn`). Only the Team owner writes the Team layer.
`AppStorageError.code` is `invalid`, `undeclared_key`, `scope_not_declared`,
`owner_required`, `too_large`, `quota_exceeded`, `conflict` or `unavailable`. On
a conflict, read again and let the member decide; never retry with an invented
revision.

## Back in the window chrome

A host shows several App windows at once, so an App routes on memory history and
reports Back to the host, which shows it in the window's title bar.
`useHostNavigation` from `./react` does this for a React App. With TanStack
Router:

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

Without React, call `root.window.navigation.publish({ canGoBack, title })` and
`root.window.navigation.onBack(handler)`. The connection also turns the
browser's back keys and mouse button inside the App into App Back, so a stray
press never navigates the workspace page away.

## Desktop Gills

Gills are an App's compact views for the desktop and terminal. Define them with
`defineAppGill` from `@fungi.computer/agar/gills` next to the `defineAppMethod`
they read, and pass them as `gills` to `defineAppBackend`; the build generates
their Release metadata. Each Gill names a declared read method and a page
`limit` from 1 to 200, forwards that limit to the method, and projects its rows
without dropping any. While a mounted App is focused,
`await app.ui.openDesktopSettings()` asks the host to suggest adding one; only
the member's click changes the desktop.

## Errors

Capability operations fail with `AppError`, which carries a typed `code` and an
explicit `retryable` flag. Handle denial, revocation, selection change and
disconnect beside the affected operation, and never turn a failed request into
an empty success. `describeAppError` turns a failure into approved UI copy:

```ts
import { describeAppError } from "@fungi.computer/agar/errors";

const description = describeAppError(cause);
// Render description.title and description.message beside the failed operation.
// Keep the original cause for diagnostics; it is never included in the copy.
```

The result has a `title`, `message`, `retryable` and an optional `grant`,
`retry`, `reconnect` or `billing` hint; the caller performs any action. Only
SDK-decoded `AppError` instances select typed copy. `INSUFFICIENT_CREDIT` offers
`billing`, which opens `app.ui.openTeamBilling()`.

## API reference

The generated [API reference](docs/api/README.md) ships in the package. It
covers the App author's surface: the root connection and shared types,
`./react`, `./query`, `./errors`, `./rpc`, `./backend`, `./backend-definition`,
`./backend-declaration`, `./files` and `./storage`, and documents the host side
of the contract: git pushes and git helpers, Media JSON transport, Agent
metadata and Computer outcomes. The capability clients do not yet have generated
reference pages; treat them as unstable.

## Examples

The quick start defines a backend, builds its App API and calls a method without
a host. The
[Notes example App](https://github.com/fungi-computer/oyster/tree/main/examples/notes-app)
is a complete App with a UI, backend methods and SQLite. In the repository, the
connection and disposal suites exercise both sides of a real MessagePort.

## Limits and errors

A plain top-level page has no host to connect to; `connectApp` needs a
host-mounted iframe. Capability operations fail with typed `AppError` codes when
the host denies, revokes or lacks the capability. Method schemas validate input
and output on every call. Stored values must be JSON within the declared byte
bound and depth 32.

## Contribute and license

Run `pnpm --filter @fungi.computer/agar test` for the SDK suites and
`pnpm --filter @fungi.computer/agar build` to compile the package. The package
uses the MIT license in [`LICENSE`](LICENSE).
