/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

function createInstrumentedStore(storeProto) {
  const calls = {
    applyWorkspaces: 0,
    applyFolders: 0,
    applyTabs: 0,
    updateKnownRemoteIds: 0,
  };

  const observed = {
    workspaces: null,
    folders: null,
    tabs: null,
    updateKnownRemoteIds: null,
  };

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

  store._getLocalWorkspaceCount = () => 0;
  store._getLocalFolderCount = () => 0;
  store._getLocalSidebarTabCount = () => 0;

  store.applyWorkspaces = async (remoteWorkspaces) => {
    calls.applyWorkspaces++;
    observed.workspaces = remoteWorkspaces;
    return true;
  };
  store.applyFolders = async (remoteFolders) => {
    calls.applyFolders++;
    observed.folders = remoteFolders;
    return { folderMap: new Map(), success: true };
  };
  store.applyTabs = async (remoteTabs) => {
    calls.applyTabs++;
    observed.tabs = remoteTabs;
    return true;
  };

  store._updateKnownRemoteIds = (remote, options) => {
    calls.updateKnownRemoteIds++;
    observed.updateKnownRemoteIds = { remote, options };
  };

  return { store, calls, observed };
}

add_setup(async function () {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;
});

add_task(async function test_non_object_payload_is_ignored() {
  const storeProto = getSidebarSyncStorePrototype();
  const { store, calls } = createInstrumentedStore(storeProto);

  await storeProto.applyRemoteData.call(store, "invalid");

  Assert.equal(calls.applyWorkspaces, 0, "Workspaces should not be applied for non-object payload");
  Assert.equal(calls.applyFolders, 0, "Folders should not be applied for non-object payload");
  Assert.equal(calls.applyTabs, 0, "Tabs should not be applied for non-object payload");
  Assert.equal(
    calls.updateKnownRemoteIds,
    0,
    "Known remote snapshot should not update for non-object payload"
  );
});

add_task(async function test_unsupported_schema_is_skipped() {
  const storeProto = getSidebarSyncStorePrototype();
  const { store, calls } = createInstrumentedStore(storeProto);

  await storeProto.applyRemoteData.call(store, {
    schemaVersion: 999,
    workspaces: [{ id: "ws-1", name: "Workspace 1", position: 0 }],
    folders: [{ id: "folder-1", position: 0 }],
    tabs: [{ id: "tab-1", url: "https://example.com/", workspaceId: "ws-1", position: 0 }],
  });

  Assert.equal(calls.applyWorkspaces, 0, "Unsupported schema should skip workspace apply");
  Assert.equal(calls.applyFolders, 0, "Unsupported schema should skip folder apply");
  Assert.equal(calls.applyTabs, 0, "Unsupported schema should skip tab apply");
  Assert.equal(
    calls.updateKnownRemoteIds,
    0,
    "Known remote snapshot should not update for unsupported schema"
  );
});

add_task(async function test_invalid_cutoff_skips_only_invalid_type() {
  const storeProto = getSidebarSyncStorePrototype();
  const { store, calls, observed } = createInstrumentedStore(storeProto);

  await storeProto.applyRemoteData.call(store, {
    schemaVersion: 1,
    workspaces: [
      { id: "ws-valid-a", name: "Workspace A", position: 0 },
      { id: "", name: "Invalid workspace", position: 1 },
      { id: "ws-invalid-pos", name: "Invalid workspace", position: Infinity },
      { id: "ws-invalid-name", position: 3 },
      { id: "ws-valid-b", name: "Workspace B", position: 4, containerTabId: "x" },
    ],
    folders: [
      { id: "folder-valid", name: "Folder", workspaceId: "ws-valid-a" },
      { id: null, name: "Invalid folder" },
    ],
    tabs: [
      { id: "tab-valid-1", url: "https://example.com/a", workspaceId: "ws-valid-a", position: 2 },
      { id: "tab-invalid-about", url: "about:blank", workspaceId: "ws-valid-a", position: 3 },
      { id: "tab-invalid-workspace", url: "https://example.com/b", position: 4 },
      {
        id: "tab-valid-2",
        url: "https://example.com/c",
        workspaceId: "ws-valid-a",
        isPinned: false,
        isEssential: false,
        label: 7,
      },
    ],
  });

  Assert.equal(calls.applyWorkspaces, 0, "Workspace payload should be skipped by invalid cutoff");
  Assert.equal(calls.applyFolders, 1, "Folders should still apply when under cutoff");
  Assert.equal(calls.applyTabs, 1, "Tabs should still apply when under cutoff");
  Assert.equal(calls.updateKnownRemoteIds, 1, "Known IDs should still update for valid types");

  Assert.equal(observed.folders.length, 1, "Invalid folder entries should be filtered out");
  Assert.equal(observed.folders[0].position, 0, "Folder position should normalize to 0");
  Assert.equal(observed.folders[0].collapsed, false, "Folder collapsed should normalize to false");
  Assert.equal(observed.folders[0].parentId, null, "Folder parentId should normalize to null");

  Assert.equal(observed.tabs.length, 2, "Invalid tab entries should be filtered out");
  const normalizedTab = observed.tabs.find((tab) => tab.id === "tab-valid-1");
  Assert.ok(normalizedTab, "Expected first valid tab to be kept");
  Assert.equal(normalizedTab.isPinned, true, "Missing isPinned should normalize to true");
  Assert.equal(normalizedTab.workspaceId, "ws-valid-a", "Valid tab should preserve workspaceId");
  Assert.equal(
    normalizedTab.essentialContainerId,
    0,
    "schemaVersion=1 should default essentialContainerId to 0"
  );

  Assert.equal(
    observed.updateKnownRemoteIds.options.updateTypes.workspaces,
    false,
    "Known workspace IDs should not update when workspace payload is invalid"
  );
  Assert.equal(
    observed.updateKnownRemoteIds.options.updateTypes.folders,
    true,
    "Known folder IDs should update when folder payload is valid"
  );
  Assert.equal(
    observed.updateKnownRemoteIds.options.updateTypes.tabs,
    true,
    "Known tab IDs should update when tab payload is valid"
  );
});
