/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_KNOWN_REMOTE_IDS = "services.sync.engine.sidebarsync.knownRemoteIds";
const PREF_BOOTSTRAP_COMPLETE = "services.sync.engine.sidebarsync.bootstrapComplete";
const PREF_BOOTSTRAP_FORCE_UPLOAD = "services.sync.engine.sidebarsync.bootstrapForceUpload";
const PREF_ENGINE_MODIFIED = "services.sync.engine.sidebarsync.modified";

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

add_task(async function test_suspicious_empty_tabs_and_folders_skip_delete() {
  const storeProto = getSidebarSyncStorePrototype();

  const hadKnownPref = Services.prefs.prefHasUserValue(PREF_KNOWN_REMOTE_IDS);
  const previousKnownPref = hadKnownPref
    ? Services.prefs.getStringPref(PREF_KNOWN_REMOTE_IDS)
    : null;
  const trackedBoolPrefs = [
    PREF_BOOTSTRAP_COMPLETE,
    PREF_BOOTSTRAP_FORCE_UPLOAD,
    PREF_ENGINE_MODIFIED,
  ].map((pref) => ({
    pref,
    hadUserValue: Services.prefs.prefHasUserValue(pref),
    value: Services.prefs.getBoolPref(pref, false),
  }));

  registerCleanupFunction(() => {
    if (hadKnownPref) {
      Services.prefs.setStringPref(PREF_KNOWN_REMOTE_IDS, previousKnownPref);
    } else {
      Services.prefs.clearUserPref(PREF_KNOWN_REMOTE_IDS);
    }

    for (const { pref, hadUserValue, value } of trackedBoolPrefs) {
      if (hadUserValue) {
        Services.prefs.setBoolPref(pref, value);
      } else {
        Services.prefs.clearUserPref(pref);
      }
    }
  });

  const knownBefore = {
    version: 1,
    source: "remote",
    appliedAt: 111,
    workspaces: ["ws-old-1", "ws-old-2", "ws-old-3", "ws-old-4"],
    folders: ["folder-1", "folder-2"],
    tabs: ["tab-1", "tab-2", "tab-3"],
  };
  Services.prefs.setStringPref(PREF_KNOWN_REMOTE_IDS, JSON.stringify(knownBefore));

  const observedPolicies = {};
  const store = Object.create(storeProto);
  store.engine = {
    _tracker: {
      ignoreAll: false,
    },
  };

  store._getLocalWorkspaceCount = () => 1;
  store._getLocalFolderCount = () => 3;
  store._getLocalSidebarTabCount = () => 5;

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
    workspaces: [{ id: "ws-1", name: "Workspace 1", position: 0 }],
    folders: [],
    tabs: [],
  });

  Assert.ok(observedPolicies.workspaces, "Workspace policy should be computed");
  Assert.ok(observedPolicies.folders, "Folder policy should be computed");
  Assert.ok(observedPolicies.tabs, "Tab policy should be computed");

  Assert.equal(
    observedPolicies.folders.allowDeletion,
    false,
    "Folder deletions should be blocked for suspicious empty payload"
  );
  Assert.equal(
    observedPolicies.tabs.allowDeletion,
    false,
    "Tab deletions should be blocked for suspicious empty payload"
  );
  Assert.ok(
    observedPolicies.folders.suspiciousEmpty,
    "Folder policy should mark suspicious empty payload"
  );
  Assert.ok(
    observedPolicies.tabs.suspiciousEmpty,
    "Tab policy should mark suspicious empty payload"
  );

  const knownAfter = JSON.parse(Services.prefs.getStringPref(PREF_KNOWN_REMOTE_IDS));
  Assert.equal(knownAfter.version, 1, "Known snapshot should use versioned schema");
  Assert.equal(knownAfter.source, "remote", "Known snapshot should remain remote-sourced");
  Assert.deepEqual(
    knownAfter.workspaces,
    ["ws-1"],
    "Non-suspicious workspace IDs should update to the received remote IDs"
  );
  Assert.deepEqual(
    knownAfter.folders,
    knownBefore.folders,
    "Suspicious empty folders should keep previous known folder IDs"
  );
  Assert.deepEqual(
    knownAfter.tabs,
    knownBefore.tabs,
    "Suspicious empty tabs should keep previous known tab IDs"
  );
});
