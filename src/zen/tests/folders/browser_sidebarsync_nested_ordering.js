/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

function getFolderItemOrderByIds(folder, ids) {
  const targetIds = new Set(ids);
  return Array.from(folder.groupContainer?.children || [])
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

add_task(async function test_applyRemoteData_nested_ordering_and_cycle_break() {
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
  Assert.ok(workspaceId, "Expected an active workspace for SidebarSync nested-ordering apply");

  const rootFolderId = `sidebarsync-pr6-root-${Date.now()}`;
  const nestedFolderId = `sidebarsync-pr6-nested-${Date.now()}`;
  const tabAId = `sidebarsync-pr6-tab-a-${Date.now()}`;
  const tabBId = `sidebarsync-pr6-tab-b-${Date.now()}`;
  const cycleAId = `sidebarsync-pr6-cycle-a-${Date.now()}`;
  const cycleBId = `sidebarsync-pr6-cycle-b-${Date.now()}`;

  const payload = {
    schemaVersion: 2,
    workspaces: [],
    folders: [
      {
        id: rootFolderId,
        name: "PR6 Root",
        workspaceId,
        parentId: null,
        position: 0,
      },
      {
        id: nestedFolderId,
        name: "PR6 Nested",
        workspaceId,
        parentId: rootFolderId,
        position: 1,
      },
      {
        id: cycleAId,
        name: "PR6 Cycle A",
        workspaceId,
        parentId: cycleBId,
        position: 5,
      },
      {
        id: cycleBId,
        name: "PR6 Cycle B",
        workspaceId,
        parentId: cycleAId,
        position: 6,
      },
    ],
    tabs: [
      {
        id: tabAId,
        url: "https://example.com/sidebarsync-pr6-a",
        workspaceId,
        folderId: rootFolderId,
        isEssential: false,
        isPinned: true,
        position: 0,
      },
      {
        id: tabBId,
        url: "https://example.com/sidebarsync-pr6-b",
        workspaceId,
        folderId: rootFolderId,
        isEssential: false,
        isPinned: true,
        position: 2,
      },
    ],
  };

  try {
    await storeProto.applyRemoteData.call(store, payload);

    const rootFolder = document.getElementById(rootFolderId);
    const nestedFolder = document.getElementById(nestedFolderId);
    Assert.ok(rootFolder, "Root folder should be created from remote payload");
    Assert.ok(nestedFolder, "Nested folder should be created from remote payload");

    Assert.deepEqual(
      getFolderItemOrderByIds(rootFolder, [tabAId, nestedFolderId, tabBId]),
      [tabAId, nestedFolderId, tabBId],
      "Nested folder contents should keep remote mixed ordering of tabs and subfolders"
    );

    const cycleBreakId = cycleAId.localeCompare(cycleBId) < 0 ? cycleAId : cycleBId;
    const cycleChildId = cycleBreakId === cycleAId ? cycleBId : cycleAId;

    const cycleBreakFolder = document.getElementById(cycleBreakId);
    const cycleChildFolder = document.getElementById(cycleChildId);
    Assert.ok(cycleBreakFolder, "Cycle break folder should exist after apply");
    Assert.ok(cycleChildFolder, "Cycle child folder should exist after apply");
    Assert.equal(
      cycleBreakFolder.group,
      null,
      "Cycle break rule should promote lexicographically smallest ID to top-level"
    );
    Assert.equal(
      cycleChildFolder.group?.id,
      cycleBreakId,
      "Other cycle folder should remain nested under promoted folder"
    );
  } finally {
    for (const tabId of [tabAId, tabBId]) {
      const tab = document.getElementById(tabId);
      if (tab && !tab.closing) {
        gBrowser.removeTab(tab, { animate: false });
      }
    }

    const cleanupFolders = [rootFolderId, cycleAId, cycleBId, nestedFolderId];
    for (const folderId of cleanupFolders) {
      const folder = document.getElementById(folderId);
      folder?.remove();
    }
  }
});
