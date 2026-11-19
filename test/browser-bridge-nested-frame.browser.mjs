import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// A child iframe inside an App (a Shed tray, say) takes focus from the App's
// own document. The window blur that causes must not tell the host the App
// lost focus, or its window would drop its active state and flicker.
const entry = fileURLToPath(
  new globalThis.URL("../src/internal/browser-bridge.ts", import.meta.url),
);
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  globalName: "bridge",
  write: false,
  platform: "browser",
});
const script = bundle.outputFiles[0].text;
const page = `<!doctype html><title>nested</title>
<button id="outer">outer</button>
<iframe id="child" width="300" height="80" srcdoc="<input id='inner'>"></iframe>
<script>${script}</script>
<script>
globalThis.__reports = [];
const ok = () => ({ ok: true, value: undefined, [Symbol.dispose]() {} });
globalThis.bridge.installBrowserBridge({
  chords: globalThis.bridge.createReservedChordState([]),
  identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
  onBroken: () => {},
  remote: {
    invokeReservedChord: () => Promise.resolve(ok()),
    reportFocus: (focus) => {
      globalThis.__reports.push(focus.surface);
      return Promise.resolve(ok());
    },
  },
  window: globalThis,
});
</script>`;

const browser = await chromium.launch();

test("entering a child iframe never reports the App as unfocused", async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  try {
    await tab.setContent(page);
    await tab.bringToFront();
    await tab.click("#outer");
    await tab.waitForFunction(() => globalThis.__reports.at(-1) === "surface");
    const before = await tab.evaluate(() => globalThis.__reports.length);
    await tab.frameLocator("#child").locator("#inner").click();
    await tab.waitForFunction(
      () => globalThis.document.activeElement?.id === "child",
    );
    await tab.waitForTimeout(500);
    const after = await tab.evaluate(
      (from) => globalThis.__reports.slice(from),
      before,
    );
    assert.ok(
      !after.includes(null),
      `focus flipped off while entering the child frame: ${JSON.stringify(after)}`,
    );
    assert.equal(
      await tab.evaluate(() => globalThis.__reports.at(-1)),
      "surface",
    );
  } finally {
    await context.close();
  }
});

test.after(async () => {
  await browser.close();
});
