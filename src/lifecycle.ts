import type { AppPermissions } from "./ui.js";

/** Whether one thing an App needs is available: `unknown` means the host has not checked. */
export type SetupState = "ready" | "missing" | "unknown";

/** The host's up-front answer to "can this App work here?". Absent on hosts
 * that do not publish it; Apps treat absence as `unknown` for every field. */
export type AppSetup = Readonly<{
  /** A language model is connected. */
  models: SetupState;
  /** An image or video provider is connected. */
  media: SetupState;
  /** Git repositories can be created and cloned. */
  git: SetupState;
  /** `exec-only` means commands run but there is no interactive terminal. */
  terminal: "ready" | "exec-only" | "missing" | "unknown";
  /** Why command execution is unavailable, when the host has checked. */
  terminalReason?: string | undefined;
}>;

/** What an App can ask its host to help the person set up. */
export type SetupNeed = "model" | "media" | "git" | "computer";

/** Whether the host opened its setup surface for the need. */
export type SetupOutcome = "opened" | "unavailable";

/** The host-published state surrounding a connected App: its Computer
 * selection, focus, visibility, and any pending open request. */
export type AppContext = {
  /** Host-selected Computer backing this App's admitted resource capabilities. */
  readonly computerId: string | null;
  /** Whether the Team has Computers, when this host owns its Team directory. */
  readonly teamHasComputers?: boolean | null | undefined;
  /** Whether this App has execute access across the Team, when known. */
  readonly computerAccessGranted?: boolean | undefined;
  /** Setup facts the host publishes and updates live; absent on older hosts. */
  readonly setup?: AppSetup | undefined;
  /**
   * Which declared rights this App holds, so it can offer "Approve access" up
   * front instead of discovering a refusal. Updated after a permission request;
   * absent on hosts that do not publish it (treat as unknown).
   */
  readonly permissions?: AppPermissions | undefined;
  readonly focus: FocusState;
  /** One host-issued App open action, present only on the launch/reconfigure. */
  readonly openRequest: AppOpenRequest | null;
  readonly visibility: "hidden" | "visible";
};
/** One host-issued action an App must act on when it opens or reconfigures:
 * start composing given text, or navigate
 * to the given params. Each carries a `requestId` so the App can tell a
 * repeated open from a fresh one. */
export type AppOpenRequest =
  | Readonly<{
      kind: "compose";
      requestId: string;
      text: string;
    }>
  | Readonly<{
      kind: "navigate";
      requestId: string;
      params: readonly Readonly<{ key: string; value: string }>[];
    }>;
/** The App's own identity, as admitted by its host. */
export type AppIdentity = {
  readonly appId: string;
  readonly releaseId: string;
  readonly surfaceId: string;
};
/** The connection state of this App's session with its host. */
export type AppLifecycle =
  | "connected"
  | "connecting"
  | "disconnected"
  | "disposed"
  | "disposing"
  | "suspended";
/** Whether the App's own surface is being edited and which surface, if
 * any, the host considers focused. */
export type FocusState = {
  readonly editing: boolean;
  readonly surface: null | string;
};
