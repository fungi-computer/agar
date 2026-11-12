/**
 * WHY: an App iframe shares the tab's history with the Hub page, so the
 * browser's own back inputs pressed inside an App would navigate the whole
 * workspace away. They mean App Back here, or nothing (Levi, 2026-10-07).
 */

import * as Predicate from "effect/Predicate";

type Direction = "back" | "forward";

export type BackInputOptions = Readonly<{
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  /** macOS uses ⌘[ / ⌘] and ⌘← / ⌘→; other platforms use Alt+←. */
  mac: boolean;
  /** Whether the App last reported it can go back. */
  canGoBack: () => boolean;
  /** Ask the App's own Back handler to move. */
  back: () => void;
  /** Whether the App last reported it can go forward. */
  canGoForward: () => boolean;
  /** Ask the App's own Forward handler to move. */
  forward: () => void;
}>;

/**
 * Turn the browser's back and forward keys and mouse buttons into App Back
 * and Forward while the App can move that way, and keep every back or forward
 * input from leaving the page. Input the App already handled (`defaultPrevented`) is left alone.
 */
export function installBackInputs(options: BackInputOptions): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const direction = keyDirection(event, options.mac);
    if (direction === null) return;
    event.preventDefault();
    if (event.repeat) return;
    if (direction === "back" && options.canGoBack()) options.back();
    if (direction === "forward" && options.canGoForward()) options.forward();
  };
  const onMouse = (event: MouseEvent): void => {
    const direction = mouseDirection(event.button);
    if (direction === null) return;
    const handled = event.defaultPrevented;
    event.preventDefault();
    if (event.type !== "mouseup" || handled) return;
    if (direction === "back" && options.canGoBack()) options.back();
    if (direction === "forward" && options.canGoForward()) options.forward();
  };
  options.window.addEventListener("keydown", onKeyDown);
  for (const type of mouseEvents)
    options.window.addEventListener(type, onMouse);
  return () => {
    options.window.removeEventListener("keydown", onKeyDown);
    for (const type of mouseEvents)
      options.window.removeEventListener(type, onMouse);
  };
}

/** Browsers navigate on one of these; all are cancelled, the App moves once. */
const mouseEvents = ["mousedown", "mouseup", "auxclick"] as const;

function mouseDirection(button: number): Direction | null {
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}

function keyDirection(event: KeyboardEvent, mac: boolean): Direction | null {
  if (event.shiftKey || event.ctrlKey) return null;
  if (mac) {
    if (!event.metaKey || event.altKey) return null;
    if (event.key === "[") return "back";
    if (event.key === "]") return "forward";
    // ⌘← and ⌘→ move the caret in text; only elsewhere are they history keys.
    if (editable(event.target)) return null;
    if (event.key === "ArrowLeft") return "back";
    if (event.key === "ArrowRight") return "forward";
    return null;
  }
  if (!event.altKey || event.metaKey) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}

// Only a DOM keyboard event reaches this, so the DOM classes exist.
function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** Whether this browser uses the macOS history keys. */
export function macHistoryKeys(): boolean {
  return (
    !Predicate.isUndefined(globalThis.navigator) &&
    /Mac|iPhone|iPad/u.test(globalThis.navigator.userAgent)
  );
}
