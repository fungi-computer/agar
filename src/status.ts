import type { AppStatusAction, AppStatusItem } from "./ui.js";
import { APP_STATUS_TEXT_MAX } from "./ui.js";

/**
 * Control, separator, zero-width and bidi characters: anything that could
 * break one line of host chrome or reorder what it says.
 */
export function isUnsafeStatusCodeUnit(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Make person- or Computer-supplied text fit one status item: drop unsafe
 * characters, collapse whitespace and shorten with an ellipsis.
 */
export function statusText(value: string, max = APP_STATUS_TEXT_MAX): string {
  let clean = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    clean += isUnsafeStatusCodeUnit(code) ? " " : value.charAt(index);
  }
  clean = clean.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Whether an action names something the App declares now: an enabled item,
 * and for a menu exactly one enabled option. Every hop that delivers an
 * action applies this rule against its own latest copy of the items.
 */
export function statusActionAllowed(
  items: readonly AppStatusItem[],
  action: AppStatusAction,
): boolean {
  const item = items.find((candidate) => candidate.id === action.itemId);
  if (item === undefined) return false;
  if (item.kind === "text") return false;
  if (item.kind === "menu") {
    const option = item.options.find(
      (candidate) => candidate.id === action.optionId,
    );
    return option !== undefined && option.disabled !== true;
  }
  if (action.optionId !== undefined) return false;
  return item.kind !== "button" || item.disabled !== true;
}
