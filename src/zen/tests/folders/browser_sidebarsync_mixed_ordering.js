/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

function getPinnedOrderByIds(container, ids) {
  const targetIds = new Set(ids);
  return Array.from(container.children)
    .map((node) => node.id)
    .filter((id) => targetIds.has(id));
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;
});

add_task(async function test_applyRemoteData_mixed_ordering_single_pass() {
  const storeProto = getSidebarSyncStorePrototype();
  const store = Object.create(storeProto);
  store.engine = {
    _tracker: {
      ignoreAll: false,
    },
  };
  store._getKnownRemoteIds = () => ({
    version: 1,
    source: "legacy",
    appliedAt: 0,
    workspaces: [],
    folders: [],
    tabs: [],
  });
  store._updateKnownRemoteIds = () => {};

  const workspaceId = gZenWorkspaces.activeWorkspace;
  Assert.ok(workspaceId, "Expected an active workspace for SidebarSync mixed-ordering apply");

  const tabIdA = `sidebarsync-pr5-tab-a-${Date.now()}`;
  const folderId = `sidebarsync-pr5-folder-${Date.now()}`;
  const tabIdB = `sidebarsync-pr5-tab-b-${Date.now()}`;

  const payload = {
    schemaVersion: 2,
    workspaces: [],
    folders: [
      {
        id: folderId,
        name: "PR5 Folder",
        workspaceId,
        parentId: null,
        position: 1,
      },
    ],
    tabs: [
      {
        id: tabIdA,
        url: "https://example.com/sidebarsync-pr5-a",
        workspaceId,
        folderId: null,
        isEssential: false,
        isPinned: true,
        position: 0,
      },
      {
        id: tabIdB,
        url: "https://example.com/sidebarsync-pr5-b",
        workspaceId,
        folderId: null,
        isEssential: false,
        isPinned: true,
        position: 2,
      },
    ],
  };

  try {
    await storeProto.applyRemoteData.call(store, payload);

    const wsElem = gZenWorkspaces.workspaceElement(workspaceId);
    const pinnedContainer = wsElem?.pinnedTabsContainer || gZenWorkspaces.pinnedTabsContainer;
    Assert.ok(pinnedContainer, "Expected pinned container for mixed-ordering assertions");

    const expectedOrder = [tabIdA, folderId, tabIdB];
    Assert.deepEqual(
      getPinnedOrderByIds(pinnedContainer, expectedOrder),
      expectedOrder,
      "Mixed top-level order should interleave tabs and folders by remote position"
    );

    await storeProto.applyRemoteData.call(store, payload);

    Assert.deepEqual(
      getPinnedOrderByIds(pinnedContainer, expectedOrder),
      expectedOrder,
      "Reapplying identical payload should keep mixed order stable"
    );

    Assert.equal(
      gBrowser.tabs.filter((tab) => tab.id === tabIdA).length,
      1,
      "Reapplying should not duplicate tab A"
    );
    Assert.equal(
      gBrowser.tabs.filter((tab) => tab.id === tabIdB).length,
      1,
      "Reapplying should not duplicate tab B"
    );
  } finally {
    const folder = document.getElementById(folderId);
    await removeFolder(folder);

    for (const id of [tabIdA, tabIdB]) {
      const tab = document.getElementById(id);
      if (tab && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});
