/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_ENGINE_ENABLED = "services.sync.engine.sidebarsync";
const PREF_ENGINE_MODIFIED = "services.sync.engine.sidebarsync.modified";
const PREF_BOOTSTRAP_COMPLETE = "services.sync.engine.sidebarsync.bootstrapComplete";
const PREF_BOOTSTRAP_FORCE_UPLOAD = "services.sync.engine.sidebarsync.bootstrapForceUpload";
const PREF_RESTORE_SKIP_INCOMING_ONCE = "services.sync.engine.sidebarsync.restoreSkipIncomingOnce";
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
    PREF_RESTORE_SKIP_INCOMING_ONCE,
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

add_setup(async function () {
  await gZenWorkspaces.promisePinnedInitialized;
  await gZenWorkspaces.promiseInitialized;
});

add_task(
  async function test_disabling_sidebarsync_resets_bookkeeping_without_wiping_local_sidebar() {
    const prefSnapshot = snapshotSidebarSyncPrefs();
    registerCleanupFunction(() => restoreSidebarSyncPrefs(prefSnapshot));

    Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, true);
    Services.prefs.setBoolPref(PREF_ENGINE_MODIFIED, true);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_COMPLETE, true);
    Services.prefs.setBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, true);
    Services.prefs.setBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, true);
    Services.prefs.setStringPref(
      PREF_KNOWN_REMOTE_IDS,
      JSON.stringify({
        version: 1,
        source: "remote",
        appliedAt: 1,
        workspaces: ["ws-1"],
        folders: ["folder-1"],
        tabs: ["tab-1"],
      })
    );

    const markerTab = BrowserTestUtils.addTab(
      gBrowser,
      `https://example.com/sidebarsync-disable-${Date.now()}`
    );
    gBrowser.pinTab(markerTab);

    try {
      const storeProto = getSidebarSyncStorePrototype();
      const store = Object.create(storeProto);

      const workspaceCountBefore = storeProto._getLocalWorkspaceCount.call(store);
      const folderCountBefore = storeProto._getLocalFolderCount.call(store, window);
      const tabCountBefore = storeProto._getLocalSidebarTabCount.call(store, window);

      Services.prefs.setBoolPref(PREF_ENGINE_ENABLED, false);

      await TestUtils.waitForCondition(
        () =>
          Services.prefs.getBoolPref(PREF_ENGINE_MODIFIED, true) === false &&
          Services.prefs.getBoolPref(PREF_BOOTSTRAP_COMPLETE, true) === false &&
          Services.prefs.getBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, true) === false &&
          Services.prefs.getBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, true) === false &&
          !Services.prefs.prefHasUserValue(PREF_KNOWN_REMOTE_IDS),
        "Disabling engine should reset all SidebarSync bookkeeping prefs"
      );

      const workspaceCountAfter = storeProto._getLocalWorkspaceCount.call(store);
      const folderCountAfter = storeProto._getLocalFolderCount.call(store, window);
      const tabCountAfter = storeProto._getLocalSidebarTabCount.call(store, window);

      Assert.equal(
        workspaceCountAfter,
        workspaceCountBefore,
        "Disabling engine should not wipe workspaces"
      );
      Assert.equal(folderCountAfter, folderCountBefore, "Disabling engine should not wipe folders");
      Assert.ok(
        tabCountAfter >= tabCountBefore,
        "Disabling engine should not reduce synced sidebar tab count"
      );
      Assert.ok(!markerTab.closing, "Pinned marker tab should remain open after engine disable");
      Assert.ok(markerTab.pinned, "Pinned marker tab should remain pinned after engine disable");

      Assert.equal(
        Services.prefs.getBoolPref(PREF_ENGINE_MODIFIED, true),
        false,
        "Engine disable should clear modified bookkeeping"
      );
      Assert.equal(
        Services.prefs.getBoolPref(PREF_BOOTSTRAP_COMPLETE, true),
        false,
        "Engine disable should clear bootstrap-complete bookkeeping"
      );
      Assert.equal(
        Services.prefs.getBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, true),
        false,
        "Engine disable should clear bootstrap force-upload bookkeeping"
      );
      Assert.equal(
        Services.prefs.getBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, true),
        false,
        "Engine disable should clear restore skip-incoming-once bookkeeping"
      );
      Assert.equal(
        Services.prefs.prefHasUserValue(PREF_KNOWN_REMOTE_IDS),
        false,
        "Engine disable should clear known remote IDs bookkeeping"
      );
    } finally {
      if (!markerTab.closing) {
        gBrowser.removeTab(markerTab, { animate: false });
      }
    }
  }
);
