/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_ENGINE_ENABLED = "services.sync.engine.sidebarsync";
const PREF_ENGINE_MODIFIED = "services.sync.engine.sidebarsync.modified";
const PREF_BOOTSTRAP_COMPLETE = "services.sync.engine.sidebarsync.bootstrapComplete";
const PREF_RESTORE_SKIP_INCOMING_ONCE = "services.sync.engine.sidebarsync.restoreSkipIncomingOnce";

function getSidebarSyncStorePrototype() {
  const { SidebarSyncEngine } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSidebarSync.sys.mjs"
  );
  return SidebarSyncEngine.prototype._storeObj.prototype;
}

function snapshotSidebarSyncPrefs() {
  return [
    PREF_ENGINE_ENABLED,
    PREF_ENGINE_MODIFIED,
    PREF_BOOTSTRAP_COMPLETE,
    PREF_RESTORE_SKIP_INCOMING_ONCE,
  ].map((pref) => ({
    pref,
    hadUserValue: Services.prefs.prefHasUserValue(pref),
    value: Services.prefs.getBoolPref(pref, false),
  }));
}

function restoreSidebarSyncPrefs(snapshot) {
  for (const { pref, hadUserValue, value } of snapshot) {
    if (hadUserValue) {
      Services.prefs.setBoolPref(pref, value);
    } else {
      Services.prefs.clearUserPref(pref);
    }
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

add_setup(async function () {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;
});

add_task(async function test_pre_apply_snapshot_is_captured_before_apply_mutation() {
  await withSidebarSyncPrefSnapshot(async () => {
    Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, true);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_COMPLETE, true);
    Services.prefs.setBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, false);

    const callOrder = [];
    const storeProto = getSidebarSyncStorePrototype();
    const store = Object.create(storeProto);
    store.engine = {
      _tracker: {
        ignoreAll: false,
      },
    };

    store._getKnownRemoteIds = () => ({
      version: 1,
      source: "remote",
      appliedAt: 0,
      workspaces: [],
      folders: [],
      tabs: [],
    });

    store._getLocalWorkspaceCount = () => 0;
    store._getLocalFolderCount = () => 0;
    store._getLocalSidebarTabCount = () => 0;

    store._capturePreApplyLocalSnapshot = async () => {
      callOrder.push("capture-pre-apply");
    };

    store.applyWorkspaces = async () => {
      callOrder.push("apply-workspaces");
      return true;
    };

    store.applyFolders = async () => {
      callOrder.push("apply-folders");
      return { folderMap: new Map(), success: true };
    };

    store.applyTabs = async () => {
      callOrder.push("apply-tabs");
      return true;
    };

    store._updateKnownRemoteIds = () => {
      callOrder.push("update-known-remote-ids");
    };

    await storeProto.applyRemoteData.call(store, {
      schemaVersion: 2,
      workspaces: [{ id: "ws-remote", name: "Remote Workspace", position: 0 }],
      folders: [],
      tabs: [],
    });

    Assert.equal(
      callOrder[0],
      "capture-pre-apply",
      "Snapshot capture should run before all apply calls"
    );
    Assert.ok(
      callOrder.includes("apply-workspaces"),
      "Workspace apply should run after snapshot capture"
    );
    Assert.ok(
      callOrder.includes("apply-folders"),
      "Folder apply should run after snapshot capture"
    );
    Assert.ok(callOrder.includes("apply-tabs"), "Tab apply should run after snapshot capture");
    Assert.ok(
      callOrder.includes("update-known-remote-ids"),
      "Known remote IDs should update after successful apply"
    );
  });
});

add_task(async function test_restore_from_snapshot_applies_locally_and_pauses_sync() {
  await withSidebarSyncPrefSnapshot(async () => {
    Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, true);

    const storeProto = getSidebarSyncStorePrototype();
    const snapshot = {
      schemaVersion: 2,
      workspaces: [{ id: "ws-1", name: "Workspace 1", position: 0 }],
      folders: [{ id: "folder-1", name: "Folder 1", workspaceId: "ws-1", position: 0 }],
      tabs: [
        {
          id: "tab-1",
          url: "https://example.com/",
          workspaceId: "ws-1",
          position: 0,
          isEssential: false,
          isPinned: true,
        },
      ],
    };

    let appliedSnapshot = null;
    const store = {
      async getRecoverySnapshotPayload(source, index) {
        Assert.equal(source, "preApplyLocal", "Restore should read pre-apply local snapshots");
        Assert.equal(index, 0, "Restore should read latest pre-apply local snapshot");
        return snapshot;
      },
      async _applyRecoverySnapshotLocally(payload, win) {
        Assert.equal(win, window, "Restore should apply using the eligible browser window");
        appliedSnapshot = payload;
        return true;
      },
    };

    const result = await storeProto.restoreFromLastGoodSnapshot.call(store);
    Assert.ok(appliedSnapshot, "Restore should pass snapshot payload into local apply path");
    Assert.equal(result.ok, true, "Restore should report success when snapshot apply succeeds");
    Assert.equal(result.paused, true, "Restore should pause SidebarSync after local restore");
    Assert.equal(
      result.counts.workspaces,
      1,
      "Restore result should include restored workspace count"
    );
    Assert.equal(result.counts.folders, 1, "Restore result should include restored folder count");
    Assert.equal(result.counts.tabs, 1, "Restore result should include restored tab count");
    Assert.equal(
      Services.prefs.getBoolPref(PREF_ENGINE_ENABLED, true),
      false,
      "Restore should disable SidebarSync engine to prevent immediate overwrite"
    );
  });
});

add_task(async function test_resume_after_restore_sets_skip_once_and_forces_upload_path() {
  await withSidebarSyncPrefSnapshot(async () => {
    Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, false);
    Services.prefs.setBoolPref(PREF_ENGINE_MODIFIED, false);
    Services.prefs.setBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, false);

    const storeProto = getSidebarSyncStorePrototype();
    const result = await storeProto.resumeSyncWithRestoredState.call({});

    Assert.equal(result.ok, true, "Resume should report success");
    Assert.equal(
      result.armedSkipIncomingOnce,
      true,
      "Resume result should report one-shot skip-incoming guard is armed"
    );
    Assert.equal(result.markedModified, true, "Resume result should report upload path is marked");
    Assert.equal(result.enabled, true, "Resume result should report engine enabled");

    Assert.equal(
      Services.prefs.getBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, false),
      true,
      "Resume should arm restoreSkipIncomingOnce"
    );
    Assert.equal(
      Services.prefs.getBoolPref(PREF_ENGINE_MODIFIED, false),
      true,
      "Resume should mark engine modified so next sync uploads restored local state"
    );
    Assert.equal(
      Services.prefs.getBoolPref(PREF_ENGINE_ENABLED, false),
      true,
      "Resume should re-enable SidebarSync engine"
    );
  });
});
