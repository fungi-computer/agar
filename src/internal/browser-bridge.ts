import { reportCatchFailure } from "../failure.js";
/**
 * WHY: focused iframe input must report focus and forward only host-declared
 * reserved chords while retaining local event precedence (2026-08-27).
 */
import { type CommandContext, Keymap } from "@opentui/keymap";
import * as addons from "@opentui/keymap/addons";
import {
  createHtmlKeymapHost,
  htmlEventMatchResolver,
  type HtmlKeymapEvent,
  normalizeHtmlKeyName,
} from "@opentui/keymap/html";

import type { AppIdentity, FocusState } from "../lifecycle.js";
import type { AppHostRpc, ReservedChord } from "./protocol.js";

import { type RpcResult, callRpc } from "./result.js";
import { parseFocus, parseReservedChords } from "./schemas.js";
import { parseVoidResult } from "./schemas.js";

export type ReservedChordState = {
  get(): readonly Readonly<ReservedChord>[];
  subscribe(listener: () => void): () => void;
  update(value: readonly ReservedChord[]): void;
};

/** One of the App's own command bindings, run locally inside the iframe. */
export type LocalBinding = Readonly<{
  /** Keymap binding string, e.g. `mod+s`. */
  key: string;
  /** Run the command's own handler with keyboard origin. */
  run: () => void;
}>;

/** The App's current single-chord command bindings. */
export type LocalBindingState = {
  get(): readonly LocalBinding[];
  subscribe(listener: () => void): () => void;
  update(value: readonly LocalBinding[]): void;
};

export function createLocalBindingState(): LocalBindingState {
  let bindings: readonly LocalBinding[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => bindings,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (next) => {
      bindings = next;
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (cause) {
          console.warn("App binding subscriber failed", cause);
        }
      }
    },
  };
}

export function createReservedChordState(
  initial: readonly ReservedChord[],
): ReservedChordState {
  let chords = parseReservedChords(initial);
  const listeners = new Set<() => void>();
  return {
    get: () => chords,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (next) => {
      chords = parseReservedChords(next);
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (cause) {
          console.warn("Reserved chord subscriber failed", cause);
        }
      }
    },
  };
}

export function installBrowserBridge(options: {
  readonly bindings?: LocalBindingState;
  readonly chords: ReservedChordState;
  readonly identity: AppIdentity;
  readonly onBroken: (cause?: unknown) => void;
  readonly remote: Pick<AppHostRpc, "reportFocus" | "invokeReservedChord">;
  readonly window: Window;
}): () => void {
  let active = true;
  let previous: Readonly<FocusState> | undefined;
  const documentElement = options.window.document.querySelector("html");
  if (!documentElement)
    return () => {
      active = false;
    };
  const htmlHost = createHtmlKeymapHost(documentElement);
  const keymap = new Keymap<HTMLElement, HtmlKeymapEvent>(htmlHost);
  addons.registerDefaultKeys(keymap);
  addons.registerModBindings(keymap);
  keymap.prependEventMatchResolver(htmlEventMatchResolver);
  const supervise = createSupervisor(options.onBroken);
  let offReserved = registerReservedLayer(
    keymap,
    options.chords,
    options.remote,
    supervise,
  );
  const report = createFocusReporter(
    options,
    supervise,
    () => active,
    (focus) => {
      previous = focus;
    },
    () => previous,
  );
  const offFocus = htmlHost.onFocusChange(() => {
    queueMicrotask(report);
  });
  // A click on non-focusable App content focuses this document without a
  // focusin, and the host cannot see a pointer inside the App's frame. The
  // document's own focus changes are what tell the host the App is in use.
  const reportDocumentFocus = () => {
    queueMicrotask(report);
  };
  options.window.addEventListener("focus", reportDocumentFocus);
  options.window.addEventListener("blur", reportDocumentFocus);
  const bindings = options.bindings;
  const editing = () =>
    currentFocus(options.window.document, options.identity.surfaceId).editing;
  let offLocal =
    bindings === undefined
      ? () => undefined
      : registerLocalLayer(keymap, bindings, editing);
  const offBindingSubscription =
    bindings === undefined
      ? () => undefined
      : bindings.subscribe(() => {
          offLocal();
          offLocal = registerLocalLayer(keymap, bindings, editing);
        });
  const offChordSubscription = options.chords.subscribe(() => {
    offReserved();
    offReserved = registerReservedLayer(
      keymap,
      options.chords,
      options.remote,
      supervise,
    );
  });
  queueMicrotask(report);
  return () => {
    if (!active) return;
    active = false;
    offFocus();
    options.window.removeEventListener("focus", reportDocumentFocus);
    options.window.removeEventListener("blur", reportDocumentFocus);
    offChordSubscription();
    offReserved();
    offBindingSubscription();
    offLocal();
  };
}

function createFocusReporter(
  options: {
    readonly identity: AppIdentity;
    readonly remote: Pick<AppHostRpc, "reportFocus" | "invokeReservedChord">;
    readonly window: Window;
  },
  supervise: (operation: () => PromiseLike<RpcResult<void>>) => void,
  isActive: () => boolean,
  setPrevious: (focus: Readonly<FocusState>) => void,
  getPrevious: () => Readonly<FocusState> | undefined,
): () => void {
  return () => {
    if (!isActive()) return;
    const focus = currentFocus(
      options.window.document,
      options.identity.surfaceId,
    );
    const previous = getPrevious();
    if (
      focus.editing === previous?.editing &&
      focus.surface === previous.surface
    )
      return;
    setPrevious(focus);
    supervise(() => options.remote.reportFocus(focus));
  };
}

function createSupervisor(onBroken: (cause?: unknown) => void) {
  return (operation: () => PromiseLike<RpcResult<void>>): void => {
    try {
      void callRpc(operation(), parseVoidResult).catch((cause: unknown) => {
        reportCatchFailure("browser-bridge.host-call", cause);
        onBroken(cause);
      });
    } catch (cause) {
      reportCatchFailure("browser-bridge.host-call", cause);
      onBroken(cause);
    }
  };
}

function currentFocus(
  document: Document,
  surfaceId: string,
): Readonly<FocusState> {
  const active = document.activeElement;
  return parseFocus({
    editing: Boolean(
      active?.matches("input, textarea, select, [contenteditable='true']") ===
        true || active?.closest("[contenteditable='true']"),
    ),
    surface: document.hasFocus() ? surfaceId : null,
  });
}

/**
 * The App layer: its own registered bindings, below the reserved layer.
 * Text entry is a mode; bare keys yield to typing, modifier chords still run.
 */
function registerLocalLayer(
  keymap: Keymap<HTMLElement, HtmlKeymapEvent>,
  bindings: LocalBindingState,
  editing: () => boolean,
): () => void {
  const values = bindings.get();
  return keymap.registerLayer({
    bindings: values.map((binding, index) => ({
      cmd: `app/${String(index)}`,
      key: binding.key,
    })),
    commands: values.map((binding, index) => ({
      name: `app/${String(index)}`,
      run: (context: CommandContext<HTMLElement, HtmlKeymapEvent>) => {
        const event = context.event.originalEvent;
        if (event?.defaultPrevented || event?.isComposing) return false;
        if (isBareKey(binding.key) && editing()) return false;
        binding.run();
        return undefined;
      },
    })),
    priority: 500,
  });
}

function isBareKey(binding: string): boolean {
  return !/(?:^|\+)(?:ctrl|control|super|meta|cmd|alt|option|mod)\+/iu.test(
    binding,
  );
}

function registerReservedLayer(
  keymap: Keymap<HTMLElement, HtmlKeymapEvent>,
  chords: ReservedChordState,
  remote: Pick<AppHostRpc, "reportFocus" | "invokeReservedChord">,
  supervise: (operation: () => PromiseLike<RpcResult<void>>) => void,
): () => void {
  const values = chords.get();
  return keymap.registerLayer({
    bindings: values.map((chord) => ({
      cmd: `reserved/${chord.id}`,
      key: {
        ctrl: chord.ctrlKey,
        meta: chord.altKey,
        name: normalizeHtmlKeyName(chord.key),
        shift: chord.shiftKey,
        super: chord.metaKey,
      },
    })),
    commands: values.map((chord) => ({
      name: `reserved/${chord.id}`,
      run: (context: CommandContext<HTMLElement, HtmlKeymapEvent>) => {
        const event = context.event.originalEvent;
        if (event?.defaultPrevented || event?.isComposing) return false;
        supervise(() =>
          remote.invokeReservedChord(chord.id, event?.repeat ?? false),
        );
        return undefined;
      },
    })),
    priority: 1000,
  });
}
