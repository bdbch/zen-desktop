/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.sidebarsync.testonly", true]],
  });
});

function getSidebarSyncTestOnly() {
  return ChromeUtils.importESModule("resource:///modules/zen/ZenSidebarSync.sys.mjs").__testOnly;
}

add_task(async function test_getEligibleSyncWindow_skips_unready_window() {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;

  const testOnly = getSidebarSyncTestOnly();

  const originalIsReady = gZenStartup?.isReady;
  const unsyncedDocEls = [];
  const otherWin = await BrowserTestUtils.openNewBrowserWindow();

  try {
    // Ensure only `window` and `otherWin` are eligible for selection.
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win || win.closed || win === window || win === otherWin) {
        continue;
      }
      const docEl = win.document?.documentElement;
      if (!docEl || docEl.hasAttribute("zen-unsynced-window")) {
        continue;
      }
      docEl.setAttribute("zen-unsynced-window", "true");
      unsyncedDocEls.push(docEl);
    }

    // Sort `otherWin` first in the candidate list.
    if (gZenStartup) {
      gZenStartup.isReady = false;
    }
    if (otherWin.gZenStartup) {
      otherWin.gZenStartup.isReady = true;
    }

    // Make `otherWin` look eligible but never "ready".
    otherWin.gZenWorkspaces.promisePinnedInitialized = new Promise(() => {});
    otherWin.gZenWorkspaces.promiseInitialized = new Promise(() => {});

    const selected = await testOnly.getEligibleSyncWindow({ timeoutMs: 50 });
    Assert.equal(
      selected,
      window,
      "Should pick a ready eligible window, not the newest unready one"
    );
  } finally {
    if (gZenStartup) {
      gZenStartup.isReady = originalIsReady;
    }
    for (const docEl of unsyncedDocEls) {
      docEl.removeAttribute("zen-unsynced-window");
    }
    await BrowserTestUtils.closeWindow(otherWin);
  }
});

add_task(async function test_getEligibleSyncWindow_returns_null_when_no_eligible_windows() {
  const testOnly = getSidebarSyncTestOnly();

  const changedDocEls = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win || win.closed) {
      continue;
    }
    const docEl = win.document?.documentElement;
    if (!docEl || docEl.hasAttribute("zen-unsynced-window")) {
      continue;
    }
    docEl.setAttribute("zen-unsynced-window", "true");
    changedDocEls.push(docEl);
  }

  try {
    const selected = await testOnly.getEligibleSyncWindow({ timeoutMs: 0 });
    Assert.equal(selected, null, "Should return null when no eligible windows exist");
  } finally {
    for (const docEl of changedDocEls) {
      docEl.removeAttribute("zen-unsynced-window");
    }
  }
});
