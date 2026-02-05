/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_KNOWN_REMOTE_IDS = "services.sync.engine.sidebarsync.knownRemoteIds";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

add_setup(async function () {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;
});

add_task(async function test_legacy_knownRemoteIds_never_authorize_deletions() {
  const storeProto = getSidebarSyncStorePrototype();

  const hadKnownPref = Services.prefs.prefHasUserValue(PREF_KNOWN_REMOTE_IDS);
  const previousKnownPref = hadKnownPref
    ? Services.prefs.getStringPref(PREF_KNOWN_REMOTE_IDS)
    : null;
  registerCleanupFunction(() => {
    if (hadKnownPref) {
      Services.prefs.setStringPref(PREF_KNOWN_REMOTE_IDS, previousKnownPref);
    } else {
      Services.prefs.clearUserPref(PREF_KNOWN_REMOTE_IDS);
    }
  });

  const legacyKnown = {
    workspaces: ["ws-legacy"],
    folders: ["folder-legacy"],
    tabs: ["tab-legacy"],
  };
  Services.prefs.setStringPref(PREF_KNOWN_REMOTE_IDS, JSON.stringify(legacyKnown));

  const observedPolicies = {};
  const store = Object.create(storeProto);
  store.engine = {
    _tracker: {
      ignoreAll: false,
    },
  };

  store._getLocalWorkspaceCount = () => 2;
  store._getLocalFolderCount = () => 2;
  store._getLocalSidebarTabCount = () => 2;

  store.applyWorkspaces = async (_remote, _win, policy) => {
    observedPolicies.workspaces = policy;
    return true;
  };
  store.applyFolders = async (_remote, _win, policy) => {
    observedPolicies.folders = policy;
    return { folderMap: new Map(), success: true };
  };
  store.applyTabs = async (_remote, _win, policy) => {
    observedPolicies.tabs = policy;
    return true;
  };

  await storeProto.applyRemoteData.call(store, {
    workspaces: [{ id: "ws-remote", name: "Remote Workspace", position: 0 }],
    folders: [{ id: "folder-remote", name: "Remote Folder", position: 0 }],
    tabs: [{ id: "tab-remote", url: "https://example.com/", position: 0 }],
  });

  Assert.ok(observedPolicies.workspaces, "Workspace policy should be computed");
  Assert.ok(observedPolicies.folders, "Folder policy should be computed");
  Assert.ok(observedPolicies.tabs, "Tab policy should be computed");

  Assert.equal(
    observedPolicies.workspaces.knownSource,
    "legacy",
    "Legacy pref shape should be treated as legacy source"
  );
  Assert.equal(
    observedPolicies.folders.knownSource,
    "legacy",
    "Legacy pref shape should be treated as legacy source"
  );
  Assert.equal(
    observedPolicies.tabs.knownSource,
    "legacy",
    "Legacy pref shape should be treated as legacy source"
  );

  Assert.equal(
    observedPolicies.workspaces.allowDeletion,
    false,
    "Legacy known IDs must not authorize workspace deletions"
  );
  Assert.equal(
    observedPolicies.folders.allowDeletion,
    false,
    "Legacy known IDs must not authorize folder deletions"
  );
  Assert.equal(
    observedPolicies.tabs.allowDeletion,
    false,
    "Legacy known IDs must not authorize tab deletions"
  );

  const knownAfter = JSON.parse(Services.prefs.getStringPref(PREF_KNOWN_REMOTE_IDS));
  Assert.equal(
    knownAfter.source,
    "remote",
    "Successful non-suspicious apply should rewrite known IDs as remote snapshot"
  );
  Assert.deepEqual(
    knownAfter.workspaces,
    ["ws-remote"],
    "Known workspace IDs should update after apply"
  );
  Assert.deepEqual(
    knownAfter.folders,
    ["folder-remote"],
    "Known folder IDs should update after apply"
  );
  Assert.deepEqual(knownAfter.tabs, ["tab-remote"], "Known tab IDs should update after apply");
});
