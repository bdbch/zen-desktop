/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_ENGINE_ENABLED = "services.sync.engine.sidebarsync";
const PREF_ENGINE_MODIFIED = "services.sync.engine.sidebarsync.modified";
const PREF_BOOTSTRAP_COMPLETE = "services.sync.engine.sidebarsync.bootstrapComplete";
const PREF_BOOTSTRAP_FORCE_UPLOAD = "services.sync.engine.sidebarsync.bootstrapForceUpload";
const PREF_KNOWN_REMOTE_IDS = "services.sync.engine.sidebarsync.knownRemoteIds";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

function snapshotSidebarSyncPrefs() {
  const boolPrefs = [
    PREF_ENGINE_ENABLED,
    PREF_ENGINE_MODIFIED,
    PREF_BOOTSTRAP_COMPLETE,
    PREF_BOOTSTRAP_FORCE_UPLOAD,
  ].map((pref) => ({
    pref,
    hadUserValue: Services.prefs.prefHasUserValue(pref),
    value: Services.prefs.getBoolPref(pref, false),
  }));

  const hadKnownRemoteIds = Services.prefs.prefHasUserValue(PREF_KNOWN_REMOTE_IDS);
  const knownRemoteIdsValue = hadKnownRemoteIds
    ? Services.prefs.getStringPref(PREF_KNOWN_REMOTE_IDS)
    : null;

  return {
    boolPrefs,
    hadKnownRemoteIds,
    knownRemoteIdsValue,
  };
}

function restoreSidebarSyncPrefs(snapshot) {
  for (const { pref, hadUserValue, value } of snapshot.boolPrefs) {
    if (hadUserValue) {
      Services.prefs.setBoolPref(pref, value);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  }

  if (snapshot.hadKnownRemoteIds) {
    Services.prefs.setStringPref(PREF_KNOWN_REMOTE_IDS, snapshot.knownRemoteIdsValue);
  } else {
    Services.prefs.clearUserPref(PREF_KNOWN_REMOTE_IDS);
  }
}

async function withSidebarSyncPrefSnapshot(task) {
  const snapshot = snapshotSidebarSyncPrefs();
  try {
    await task();
  } finally {
    restoreSidebarSyncPrefs(snapshot);
  }
}

function createBootstrapStore(storeProto, localCounts, calls) {
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

  store._getLocalWorkspaceCount = () => localCounts.workspaces;
  store._getLocalFolderCount = () => localCounts.folders;
  store._getLocalSidebarTabCount = () => localCounts.tabs;

  store._capturePreApplyLocalSnapshot = async () => {
    calls.capturePreApplyLocalSnapshot++;
  };

  store.applyWorkspaces = async () => {
    calls.applyWorkspaces++;
    return true;
  };

  store.applyFolders = async () => {
    calls.applyFolders++;
    return { folderMap: new Map(), success: true };
  };

  store.applyTabs = async () => {
    calls.applyTabs++;
    return true;
  };

  store._updateKnownRemoteIds = () => {
    calls.updateKnownRemoteIds++;
  };

  return store;
}

add_setup(async function () {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;
});

add_task(async function test_bootstrap_local_non_empty_remote_empty_schedules_upload() {
  await withSidebarSyncPrefSnapshot(async () => {
    Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, true);
    Services.prefs.setBoolPref(PREF_ENGINE_MODIFIED, false);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_COMPLETE, false);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, false);
    Services.prefs.clearUserPref(PREF_KNOWN_REMOTE_IDS);

    const storeProto = getSidebarSyncStorePrototype();
    const calls = {
      capturePreApplyLocalSnapshot: 0,
      applyWorkspaces: 0,
      applyFolders: 0,
      applyTabs: 0,
      updateKnownRemoteIds: 0,
    };

    const store = createBootstrapStore(storeProto, { workspaces: 2, folders: 2, tabs: 3 }, calls);

    await storeProto.applyRemoteData.call(store, {
      schemaVersion: 2,
      workspaces: [],
      folders: [],
      tabs: [],
    });

    Assert.equal(
      calls.capturePreApplyLocalSnapshot,
      0,
      "Scenario L>0,R=0 should not capture pre-apply snapshot because it must not mutate local data"
    );
    Assert.equal(calls.applyWorkspaces, 0, "Scenario L>0,R=0 should not apply workspaces");
    Assert.equal(calls.applyFolders, 0, "Scenario L>0,R=0 should not apply folders");
    Assert.equal(calls.applyTabs, 0, "Scenario L>0,R=0 should not apply tabs");
    Assert.equal(calls.updateKnownRemoteIds, 0, "Scenario L>0,R=0 should not update known IDs");

    Assert.equal(
      Services.prefs.getBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, false),
      true,
      "Scenario L>0,R=0 should schedule bootstrap force-upload"
    );
    Assert.equal(
      Services.prefs.getBoolPref(PREF_ENGINE_MODIFIED, false),
      true,
      "Scenario L>0,R=0 should mark engine modified for upload path"
    );
    Assert.equal(
      Services.prefs.getBoolPref(PREF_BOOTSTRAP_COMPLETE, false),
      false,
      "Bootstrap should remain incomplete until data is uploaded"
    );
  });
});

add_task(async function test_bootstrap_local_empty_remote_non_empty_applies_remote() {
  await withSidebarSyncPrefSnapshot(async () => {
    Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, true);
    Services.prefs.setBoolPref(PREF_ENGINE_MODIFIED, false);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_COMPLETE, false);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, false);
    Services.prefs.clearUserPref(PREF_KNOWN_REMOTE_IDS);

    const storeProto = getSidebarSyncStorePrototype();
    const calls = {
      capturePreApplyLocalSnapshot: 0,
      applyWorkspaces: 0,
      applyFolders: 0,
      applyTabs: 0,
      updateKnownRemoteIds: 0,
    };

    const store = createBootstrapStore(storeProto, { workspaces: 0, folders: 0, tabs: 0 }, calls);

    await storeProto.applyRemoteData.call(store, {
      schemaVersion: 2,
      workspaces: [{ id: "ws-remote", name: "Remote Workspace", position: 0 }],
      folders: [],
      tabs: [],
    });

    Assert.equal(
      calls.capturePreApplyLocalSnapshot,
      1,
      "Scenario L=0,R>0 should capture a pre-apply local snapshot"
    );
    Assert.equal(calls.applyWorkspaces, 1, "Scenario L=0,R>0 should apply remote workspaces");
    Assert.equal(calls.applyFolders, 1, "Scenario L=0,R>0 should apply remote folders");
    Assert.equal(calls.applyTabs, 1, "Scenario L=0,R>0 should apply remote tabs");
    Assert.equal(
      calls.updateKnownRemoteIds,
      1,
      "Scenario L=0,R>0 should snapshot known remote IDs after successful apply"
    );

    Assert.equal(
      Services.prefs.getBoolPref(PREF_BOOTSTRAP_COMPLETE, false),
      true,
      "Scenario L=0,R>0 should mark bootstrap complete after apply"
    );
    Assert.equal(
      Services.prefs.getBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, false),
      false,
      "Scenario L=0,R>0 should not arm force-upload"
    );
  });
});
