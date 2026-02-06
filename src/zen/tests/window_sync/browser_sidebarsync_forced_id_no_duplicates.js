/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

function countTabsWithId(win, id) {
  let count = 0;
  for (const tab of win.gBrowser.tabs) {
    if (tab.id === id && !tab.closing) {
      count++;
    }
  }
  return count;
}

function findTabBySyncId(win, id) {
  return win.gBrowser.tabs.find((tab) => tab.id === id && !tab.closing) || null;
}

add_task(async function test_sidebarsync_forced_remote_id_is_stable_across_windows() {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;

  const storeProto = getSidebarSyncStorePrototype();
  const store = Object.create(storeProto);

  const remoteId = `sidebarsync-pr7-remote-${Date.now()}`;
  const workspaceId = gZenWorkspaces.activeWorkspace;
  const payloadTab = {
    id: remoteId,
    url: `https://example.com/sidebarsync-pr7-${Date.now()}`,
    workspaceId,
    folderId: null,
    isEssential: false,
    isPinned: true,
    position: 0,
    label: null,
    icon: null,
  };

  try {
    await withNewSyncedWindow(async (otherWin) => {
      await storeProto.applyTabs.call(
        store,
        [payloadTab],
        window,
        { allowDeletion: false, knownIds: [] },
        new Map()
      );

      await BrowserTestUtils.waitForCondition(
        () => countTabsWithId(otherWin, remoteId) === 1,
        "Secondary synced window should receive the forced SidebarSync ID"
      );

      Assert.equal(
        countTabsWithId(window, remoteId),
        1,
        "Source window should have exactly one tab with the remote ID"
      );
      Assert.equal(
        countTabsWithId(otherWin, remoteId),
        1,
        "Secondary window should have exactly one tab with the remote ID"
      );

      await storeProto.applyTabs.call(
        store,
        [payloadTab],
        window,
        { allowDeletion: false, knownIds: [] },
        new Map()
      );

      Assert.equal(
        countTabsWithId(window, remoteId),
        1,
        "Reapplying payload should stay idempotent in source window"
      );
      Assert.equal(
        countTabsWithId(otherWin, remoteId),
        1,
        "Reapplying payload should stay idempotent in secondary window"
      );
    });
  } finally {
    const tab = findTabBySyncId(window, remoteId);
    if (tab && !tab.closing) {
      gBrowser.removeTab(tab, { animate: false });
    }
  }
});
