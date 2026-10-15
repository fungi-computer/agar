/** The host-published state surrounding a connected App: its Computer
 * selection, focus, visibility, and any pending open request. */
export type AppContext = {
  /** Host-selected Computer backing this App's admitted resource capabilities. */
  readonly computerId: string | null;
  /** Whether the Team has Computers, when this host owns its Team directory. */
  readonly teamHasComputers?: boolean | null | undefined;
  /** Whether this App has execute access across the Team, when known. */
  readonly computerAccessGranted?: boolean | undefined;
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
