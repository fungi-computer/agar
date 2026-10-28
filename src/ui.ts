/** Deliberately narrow shell affordances; domain work belongs to capabilities. */
export type HostUi = {
  /** Open the host-owned Computer picker; selection arrives through App context. */
  requestComputerChoice(): Promise<void>;
  /** Request a host browser action from a fresh user click in this App. */
  requestBrowserAction(
    input: AppBrowserAction,
  ): Promise<AppBrowserActionOutcome>;
  /**
   * Ask the trusted host for App rights. The host, never the App, renders the
   * consent and writes any grant; an empty request opens App permissions.
   */
  requestAppPermissions(
    input: AppPermissionRequest,
  ): Promise<AppPermissionOutcome>;
  /** Ask the host to open an already admitted Computer file. */
  openNavigation(input: FileNavigationInput): Promise<void>;
  /**
   * Declare this window's status bar items, such as "2 documents" or a Ports
   * button. The host renders them beside the Computer it owns; the newest
   * report wins and an empty list clears them.
   */
  reportStatus(items: readonly AppStatusItem[]): Promise<void>;
  /**
   * Hear the person use one of this window's declared status items. One
   * owner at a time; the host never renders App UI in its chrome.
   */
  onStatusAction(handler: AppStatusActionHandler): () => void;
  /** Leave the App for the host's Billing page for this Team. */
  openTeamBilling(): Promise<void>;
  /** Suggest this App's desktop Gills while focused with browser activation.
   * The host shows a notice; the member must choose Review to open Settings.
   * The App receives no layout or placement authority. */
  openDesktopSettings(): Promise<void>;
  /** Tell the host which Agent conversation this App currently has
   * selected, or null when none is selected. */
  reportAgentSessionSelection(
    selection: AgentSessionSelection | null,
  ): Promise<void>;
  /** Ask the host to show a transient toast notification. */
  showToast(input: ToastInput): Promise<void>;
};

/** The most readouts one App window's status bar shows. */
export const APP_STATUS_ITEMS_MAX = 6;
/** The longest readout a window's status bar shows. */
export const APP_STATUS_TEXT_MAX = 80;

/** The most choices one status menu offers. */
export const APP_STATUS_OPTIONS_MAX = 16;

/** The marks a host can draw before a status button's label. */
export type AppStatusIcon = "folder" | "ports" | "processes" | "access";

/** A readout's live state, shown as a small light before its text. */
export type AppStatusTone = "neutral" | "success" | "warning" | "error";

/** One choice in a status menu, such as a folder or a port. */
export type AppStatusOption = Readonly<{
  id: string;
  text: string;
  /** Marks the current choice in a picker-style menu. */
  checked?: boolean;
  disabled?: boolean;
}>;

/**
 * One item an App declares for its window's status bar, as data: a readout,
 * a button, a toggle, or a menu of choices. Using one delivers an
 * {@link AppStatusAction} back to the App.
 */
export type AppStatusItem =
  | Readonly<{
      id: string;
      text: string;
      /** Hold this item at the bar's far end, like a save state. */
      end?: boolean;
      kind: "text";
      tone?: AppStatusTone;
    }>
  | Readonly<{
      id: string;
      text: string;
      /** Hold this item at the bar's far end, like a save state. */
      end?: boolean;
      kind: "button";
      /** A host-drawn mark before the label. */
      icon?: AppStatusIcon;
      /** A positive count after the label; zero is hidden. */
      count?: number;
      /** A small status light before the label; omitted draws none. */
      tone?: AppStatusTone;
      /** Work is under way: the light pulses (neutral tone when none is set). */
      busy?: boolean;
      /** A longer description, such as a full folder path. */
      title?: string;
      disabled?: boolean;
      /** The button opens App UI: a tray or a dialog. */
      opens?: "dialog";
      /** Whether the UI this button opens is open now. */
      expanded?: boolean;
    }>
  | Readonly<{
      id: string;
      text: string;
      /** Hold this item at the bar's far end, like a save state. */
      end?: boolean;
      kind: "toggle";
      pressed: boolean;
    }>
  | Readonly<{
      id: string;
      text: string;
      /** Hold this item at the bar's far end, like a save state. */
      end?: boolean;
      kind: "menu";
      count?: number;
      title?: string;
      options: readonly AppStatusOption[];
    }>;

/**
 * The person used a status item; `optionId` names a chosen menu option.
 * `anchor` is where the item sits along the App's surface, in CSS pixels from
 * its inline start, so App UI it opens can sit above it.
 */
export type AppStatusAction = Readonly<{
  itemId: string;
  optionId?: string;
  anchor?: Readonly<{ start: number; width: number }>;
}>;

/** Handles one status action; `true` when the App acted on it. */
export type AppStatusActionHandler = (
  action: AppStatusAction,
) => boolean | Promise<boolean>;

/** Exact Agent conversation selected by an App for the authenticated shell. */
export type AgentSessionSelection = Readonly<{
  agentId: string;
  sessionId: string;
}>;
/** A presentation-neutral request to open an already admitted Computer file. */
export type FileNavigationInput = {
  readonly computerId: string;
  readonly path: string;
};

/** A transient notification an App asks its host to show. */
export type ToastInput = {
  readonly message: string;
  readonly tone?: "error" | "info" | "success" | "warning";
};

/** Agent rights an App may ask its host to grant through consent. */
export type AgentAccessOperation =
  "agent.list" | "agent.manage" | "agent.read" | "agent.send";

/** Computer rights an App may ask its host to grant through consent. */
export type ComputerAccessOperation =
  | "computer.list"
  | "computer.readFile"
  | "computer.writeFile"
  | "computer.execute";

/** The rights an App asks for; the host bounds them by its declared ceiling. */
export type AppPermissionRequest = Readonly<{
  agents?: readonly AgentAccessOperation[];
  computers?: readonly ComputerAccessOperation[];
}>;

/**
 * `granted`: the host saved a grant covering the request. `declined`: the user
 * said not now. `customize`: the host opened its full permission settings.
 */
export type AppPermissionOutcome = "granted" | "declined" | "customize";

/** Maximum file size sent through the user-initiated host browser door. */
export const APP_BROWSER_SAVE_MAX_BYTES = 32 * 1024 * 1024;
/** Maximum UTF-8 text size sent to the host clipboard. */
export const APP_BROWSER_COPY_MAX_BYTES = 1024 * 1024;

/** Data only; browser authority and the gesture check belong to the host. */
export type AppBrowserAction =
  | Readonly<{
      kind: "saveFile";
      name: string;
      mime: string;
      bytes: Uint8Array;
    }>
  | Readonly<{ kind: "copyText"; text: string }>;

/** A browser action can be refused without disconnecting the App. */
export type AppBrowserActionRefusal = Readonly<{
  kind: "refused";
  reason:
    | "no-user-gesture"
    | "too-large"
    | "invalid-request"
    | "unavailable"
    | "denied"
    | "busy";
}>;

/** Saved means a browser download was initiated, not a confirmed disk write. */
export type AppBrowserActionOutcome =
  | Readonly<{ kind: "saved" }>
  | Readonly<{ kind: "copied" }>
  | AppBrowserActionRefusal;
