/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.sidebarsync.testonly", true]],
  });
});

function getSidebarSyncModule() {
  return ChromeUtils.importESModule("resource:///modules/zen/ZenSidebarSync.sys.mjs");
}

function getSidebarSyncTestOnly() {
  return getSidebarSyncModule().__testOnly;
}

async function withAllBrowserWindowsMarkedUnsynced(task) {
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
    await task();
  } finally {
    for (const docEl of changedDocEls) {
      docEl.removeAttribute("zen-unsynced-window");
    }
  }
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

  await withAllBrowserWindowsMarkedUnsynced(async () => {
    const selected = await testOnly.getEligibleSyncWindow({ timeoutMs: 0 });
    Assert.equal(selected, null, "Should return null when no eligible windows exist");
  });
});

add_task(async function test_reconcile_rejects_when_no_eligible_windows() {
  const { SidebarSyncEngine } = getSidebarSyncModule();

  await withAllBrowserWindowsMarkedUnsynced(async () => {
    const accepted = await SidebarSyncEngine.prototype._reconcile.call({}, { id: "gating-test" });
    Assert.equal(
      accepted,
      false,
      "_reconcile should reject records when no eligible window exists"
    );
  });
});

add_task(async function test_getChangedIDs_defers_without_eligible_window() {
  const { SidebarSyncEngine } = getSidebarSyncModule();

  await withAllBrowserWindowsMarkedUnsynced(async () => {
    const changedIDs = await SidebarSyncEngine.prototype.getChangedIDs.call({
      _tracker: { modified: true },
    });
    Assert.deepEqual(
      changedIDs,
      {},
      "getChangedIDs should defer uploads when no eligible window exists"
    );
  });
});

add_task(async function test_collectSyncData_skips_without_eligible_window() {
  const { SidebarSyncEngine } = getSidebarSyncModule();
  const SidebarSyncStore = SidebarSyncEngine.prototype._storeObj;

  let syncMethodCalls = 0;
  const store = {
    syncWorkspaces() {
      syncMethodCalls++;
      return [];
    },
    syncFolders() {
      syncMethodCalls++;
      return [];
    },
    syncTabs() {
      syncMethodCalls++;
      return [];
    },
    _updateKnownRemoteIds() {
      syncMethodCalls++;
    },
  };

  await withAllBrowserWindowsMarkedUnsynced(async () => {
    const data = await SidebarSyncStore.prototype.collectSyncData.call(store);
    Assert.equal(data, null, "collectSyncData should return null when no eligible window exists");
    Assert.equal(syncMethodCalls, 0, "collectSyncData should not read DOM data when gating fails");
  });
});

add_task(async function test_applyRemoteData_skips_without_eligible_window() {
  const { SidebarSyncEngine } = getSidebarSyncModule();
  const SidebarSyncStore = SidebarSyncEngine.prototype._storeObj;

  let applyCalls = 0;
  const store = {
    engine: {
      _tracker: {
        ignoreAll: false,
      },
    },
    _getKnownRemoteIds() {
      applyCalls++;
      return { workspaces: [], folders: [], tabs: [] };
    },
    _updateKnownRemoteIds() {
      applyCalls++;
    },
    async applyWorkspaces() {
      applyCalls++;
    },
    async applyFolders() {
      applyCalls++;
      return new Map();
    },
    async applyTabs() {
      applyCalls++;
    },
  };

  await withAllBrowserWindowsMarkedUnsynced(async () => {
    await SidebarSyncStore.prototype.applyRemoteData.call(store, {
      workspaces: [],
      folders: [],
      tabs: [],
    });
    Assert.equal(applyCalls, 0, "applyRemoteData should not mutate data when gating fails");
  });
});
