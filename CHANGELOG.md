# @fungi.computer/agar

## 0.27.2

### Patch Changes

- Changes since 0.27.1:

  - fix(agar): distinguish unsupported host features from permission denials
  - fix(prints): enable proof bindings and explain generation refusals

- Updated dependencies
  - @fungi.computer/approvals@0.2.6

## 0.27.1

### Patch Changes

- Changes since 0.27.0:

  - fix(shed): let the port change result carry its failure through the stories
    and tests
  - fix(hub): show sign-in and account failures as toasts that name their cause
  - fix(agar): end a failure message with a period
  - fix(hub): name the cause on the pages the first pass left, and never print a
    schema's issue list
  - fix(agar): one source of failure wording that punctuates once and names a
    dropped request
  - fix(grove): every launch App failure toast names its real cause

## 0.27.0

### Minor Changes

- Changes since 0.26.0:

  - fix(agar): reject invisible label characters and drop the unbacked undo
    claim
  - feat(agar): approval cards read a method's own short label
  - fix(hub): refuse a widget placement that cannot work before asking anyone to
    approve it

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.15.0

## 0.26.0

### Minor Changes

- Changes since 0.25.1:

  - feat(agar): add the agent.extensions capability for attaching hosted
    extensions

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.14.0

## 0.25.1

### Patch Changes

- @fungi.computer/approvals@0.2.5
  - @fungi.computer/puffball@0.13.1

## 0.25.0

### Minor Changes

- Changes since 0.24.0:

  - fix(agar): say which Agents may still be running and why
  - fix(hub): stop four Agents at once and count helpers a key may not stop
  - feat(agar): add the agent.stop capability for stop all

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.13.0

## 0.24.0

### Minor Changes

- Changes since 0.23.2:

  - fix(agar): export the focus window type
  - fix(agar,hub,oyster): keep one pending focus check per mount and require
    page focus
  - fix(hub): keep released computer refusal shapes on the wire
  - fix(apps): send named Computer refusals only to Apps that opt in
  - fix(agar): accept any host window for the frame focus check
  - fix(agar,hub,oyster): do not hold an App's focus call and wire its browser
    proof
  - fix(agar,hub,oyster): raise an App window only for focus the host sees
  - feat(agar): name the connection and field of an unreadable reply
  - fix(apps): name each Computer refusal in plain words
  - fix(agar): keep an App focused while focus is in its child frame
  - feat(agar): say when an App request was cancelled, too large or not offered
  - fix(agar): report an App window gaining focus after a stale blur
  - feat(agar): word a failed App request by the cause its host states

## 0.23.2

### Patch Changes

- Changes since 0.23.1:

  - fix(hub): send a failed start's reason only to readers that decode it
  - fix(hub): keep the reason a start failed on the alarm path

## 0.23.1

### Patch Changes

- Changes since 0.23.0:

  - fix(prints): name media service failures and say what the share prompt
    switch does

## 0.23.0

### Minor Changes

- Changes since 0.22.1:

  - fix(test): keep agar and Oyster source out of foreign type programs
  - feat(agar): claim an absent App storage layer in every host

## 0.22.1

### Patch Changes

- Changes since 0.22.0:

  - fix(agar): stop minting host-set X-Agar identity headers

## 0.22.0

### Minor Changes

- Changes since 0.21.0:

  - fix(apps): keep the Region grammar and host off App backend bundles
  - fix(apps): satisfy lint and type surfaces for the Region profile
  - fix(agents): own the Agent name shape in Agar, where Oyster core can reach
    it
  - feat(shed): observe and listProcesses report processes as RunObservation
  - fix(prints): serve every operation through declared App methods
  - feat(agar): connect an App to its Region through the host page
  - feat(puffball): reserve the onRegion entry on every host
  - feat(agar): let a region backend handle its supervisor events

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.12.0

## 0.21.0

### Minor Changes

- Changes since 0.20.0:

  - feat(gills): declare surface Gills beside row Gills

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/gills@0.4.0
  - @fungi.computer/puffball@0.11.0

## 0.20.0

### Minor Changes

- Changes since 0.19.0:

  - feat(apps): require one host-derived caller scope

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.10.0

## 0.19.0

### Minor Changes

- Changes since 0.18.2:

  - fix(agar): negotiate new Apps down to published protocol-2 hosts
  - fix(agar): serve published protocol-2 Apps without new context fields
  - feat(agar): expose the host-selected Computer name in App context

## 0.18.2

### Patch Changes

- Changes since 0.18.1:

  - fix(oyster): open reusable preview links through owner admission

- Updated dependencies
  - @fungi.computer/approvals@0.2.4
  - @fungi.computer/puffball@0.9.1

## 0.18.1

### Patch Changes

- Changes since 0.18.0:

  - fix(darkroom): export the provider reason type from agar
  - fix(agar): keep the provider reason list private to its schema
  - fix(prints): say why a generation failed and keep the library order stable

## 0.18.0

### Minor Changes

- Changes since 0.17.0:

  - fix(darkroom): make erasure durable, scoped and safe for reused destination
    paths
  - fix(darkroom): regenerate agar docs and template pins for guidance
  - feat(darkroom): carry per-model guidance for workers ai image models

## 0.17.0

### Minor Changes

- Changes since 0.16.0:

  - feat(prints): remove background and upscale from Image info
  - fix(prints): keep source-image operations out of the generator picker
  - feat(darkroom): add background removal and upscale as catalog operations
  - feat(darkroom): expose each model's billing unit in the public model list

## 0.16.0

### Minor Changes

- Changes since 0.15.0:

  - feat(oyster): app callers carry owner, admin or member from the shared role
  - feat(oyster): carry the shared TeamRole through Apps and Oyster

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.9.0

## 0.15.0

### Minor Changes

- Changes since 0.14.0:

  - fix(prints): regenerate Agar docs and raise the Prints backend budget for
    audio
  - feat(agar,prints): carry audio models, voices and MP3 results through the
    Media contract

## 0.14.0

### Minor Changes

- Changes since 0.13.0:

  - fix(darkroom): repair the gate after merging integration
  - feat(darkroom): generate speech and music through ElevenLabs on Unified
    Billing

## 0.13.0

### Minor Changes

- Changes since 0.12.1:

  - fix(hub): fill the agents instructionsUrl in the quote test host; regenerate
    API docs
  - fix(media): split the quote request out of the Hub JSON caller
  - feat(media): price one exact generation through the host
  - fix(darkroom): document the daily meter and regenerate API docs
  - feat(agents): an Agent's instructions are AGENTS.md on its Home Computer
  - feat(prints): add the Library UI
  - feat(prints): add the Library backend and share the Computer tree model
  - feat(oyster): daily media hard stop with a plain spending-limit message
  - feat(prints): add the Library backend and share the Computer tree model

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.8.0

## 0.12.1

### Patch Changes

- Changes since 0.12.0:

  - fix(agar): keep the transient read check internal
  - fix(agar): retry a read that failed in transit

- Updated dependencies
  - @fungi.computer/puffball@0.7.0

## 0.12.0

### Minor Changes

- Changes since 0.11.0:

  - feat(oyster): give each Agent standing owner instructions, set from Grove

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.6.0

## 0.11.0

### Minor Changes

- Changes since 0.10.1:

  - feat(computer): say a command ended because the Computer went to sleep

## 0.10.1

### Patch Changes

- Changes since 0.10.0:

  - fix(darkroom): regenerate API docs and the Prints catalog pin for reference
    fields
  - fix(darkroom): fit GPT Image 2 references at 1024 px as WebP with a body
    bound

## 0.10.0

### Minor Changes

- Changes since 0.9.1:

  - fix(inkcap): keep the window alive on Save As and keep the File menu across
    tabs
  - feat(window): add in-App Forward to the window contract and title bar

## 0.9.1

### Patch Changes

- Changes since 0.9.0:

  - fix(oyster): run trial Computers in a workspace sandbox

## 0.9.0

### Minor Changes

- Changes since 0.8.0:

  - feat(agar): publish which declared rights an App holds, and sharpen error
    copy
  - fix(agar): keep the setup open schema apart from the setup need schema
  - feat(computer): retain process output and serve the last lines
  - feat(agar): first-run setup facts, openSetup, more permission families

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/gills@0.3.0
  - @fungi.computer/sprite@0.2.2
  - @fungi.computer/puffball@0.5.5

## 0.8.0

### Minor Changes

- Changes since 0.7.3:

  - feat(agar): classify a Computer readout refusal with its cause and fix
  - feat(agar): add a setup-required error that names what to set up
  - fix(docs): build each package before its own docs check
  - fix(docs): build agar before its docs check

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/sprite@0.2.1
  - @fungi.computer/stipe@0.1.1
  - @fungi.computer/approvals@0.2.3
  - @fungi.computer/puffball@0.5.4

## 0.7.3

### Patch Changes

- @fungi.computer/approvals@0.2.2
  - @fungi.computer/puffball@0.5.3

## 0.7.2

### Patch Changes

- Changes since 0.7.1:

  - fix(apps): preserve disabled foreground outcomes
  - fix(agar): cancel keyboard commands with their registration

- Updated dependencies
  - @fungi.computer/gills@0.2.2
  - @fungi.computer/puffball@0.5.2
  - @fungi.computer/approvals@0.2.1

## 0.7.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/gills@0.2.1
  - @fungi.computer/puffball@0.5.1

## 0.7.0

### Minor Changes

- Changes since 0.6.1:

  - feat(prints): share one Print with a public, read-only link
  - fix(docs): remove the Oyster public demo from public docs; correct landing
    subscription claims
  - feat(grove): choose the new Agent's Computer in New Agent
  - fix(hub): keep a queued Computer start until it runs or visibly fails
  - perf(agar): read a real-git log page in one git process

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.5.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.4.0

## 0.6.0

### Minor Changes

- Changes since 0.5.0:

  - fix(prints): map provider failures to one error toast
  - fix(forage): retain load-on-request App catalogs on current Integration
  - fix(oyster): close window bridge qualification gaps
  - fix(oyster)!: remove owner consent for anonymous App methods
  - fix(oyster): report new Sessions and release cancelled RPC streams
  - feat(prints): add authorized Agent media parity
  - feat(agents): adopt delegated goals on recipient admission
  - fix(darkroom): retain a typed provider credits exhaustion reason
  - fix(prints): merge video recovery and charge-safe failures
  - fix(prints): reconcile Agent media parity with integration

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.3.0

## 0.5.0

### Minor Changes

- Changes since 0.4.0:

  - feat(agar): status buttons carry a status light
  - feat(shiitake): route a child's waiting items to the Agent that sent the
    work
  - fix(delegation): every idle Session reports to whoever sent it work

### Patch Changes

- Updated dependencies
  - @fungi.computer/whistle@0.3.0

## 0.4.0

### Minor Changes

- Changes since 0.3.1:

  - feat(prints): choose video frame roles and audio from the model's documented
    capabilities
  - feat(prints): widescreen presets within a documented maximum
  - feat(prints): reference images per model, GPT Image 2 takes up to 16
  - feat(approval): carry bounded denial feedback and optional rule coverage
  - feat(prints): enforce a documented prompt limit per model
  - fix(mesh): reply after carrier dead letters

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/approvals@0.2.0
  - @fungi.computer/whistle@0.2.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/approvals@0.1.0

## 0.3.0

### Minor Changes

- Changes since 0.2.0:

  - feat(stranger): typecheck each public entry in its own environment
  - test(agar): align packed inventory with shipped modules
  - fix(agar): keep Promise error declarations schema-independent
  - test: migrate Workflow capture examples and declare Agar artifact dependency
  - fix(tourtois): wait for pending delivery during preparation
  - refactor(apps): remove public Workflow Git credential issuance
  - fix(apps): stop in-flight App work on disable
  - feat(docs): consolidate package documentation under one site
  - fix(trellis): offer header variant A with status beads and icon Run
  - test(agar): prove missing hosts and forbidden ancestors in Chromium
  - fix(agar): discover the parent host without a referrer
  - fix(stranger): unblock B4 machine-link package closure
  - feat(agar): expose member-bound approval capability
  - fix(media): expose diagnostic grammar to API document consumers
  - fix(media): preserve safe provider diagnostics through replay
  - docs(agar): refresh current public API contracts
  - fix(hub): preserve caller identity through request withdrawal
  - fix(agent-message): one author shape, agent wording for a failed Agent
    message
  - feat(session): show another Agent's message as a compact block
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/approvals@0.0.2
  - @fungi.computer/cairn@0.1.0
  - @fungi.computer/gills@0.2.0
  - @fungi.computer/puffball@0.2.0
  - @fungi.computer/sprite@0.2.0
  - @fungi.computer/stipe@0.1.0
  - @fungi.computer/whistle@0.1.0

## 0.2.0

### Minor Changes

- Changes since 0.1.0:

  - fix(agar): keep the result-row decoder out of Apps that do not present
  - feat(agents): make the avatar a property of the Agent, not the conversation
  - fix(caps): keep header status as beads on a phone and space it from commands
  - test(bonsai): cheaper real-git tests and a real-git vitest project
  - perf(agar): build schemas on first use, not at import
  - feat(agar): carry crumbs, header commands and status in the navigation
    contract
  - feat(agar): let App methods declare how a finished call reads
  - feat(oyster): public release 0.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/gills@0.1.0
  - @fungi.computer/puffball@0.1.0
  - @fungi.computer/sprite@0.1.0
  - @fungi.computer/whistle@0.0.2

## 0.1.0

### Minor Changes

- Changes since 0.0.1:

  - feat(trellis): rename the Workflows App to Trellis
  - fix(oyster): clear the post-move fallow findings
  - docs(agar): clarify storage absence preconditions

### Patch Changes

- Updated dependencies
  - @fungi.computer/puffball@0.0.2

## 0.0.1

### Patch Changes

- Inaugural public release of @fungi.computer/agar.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/cairn@0.0.1
  - @fungi.computer/gills@0.0.1
  - @fungi.computer/puffball@0.0.1
  - @fungi.computer/stipe@0.0.1
  - @fungi.computer/whistle@0.0.1
