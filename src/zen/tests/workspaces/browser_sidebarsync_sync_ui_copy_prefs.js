/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SIDEBAR_SYNC_ENGINE_PREF = "services.sync.engine.sidebarsync";
const SYNC_CHOOSE_DIALOG_URL =
  "chrome://browser/content/preferences/dialogs/syncChooseWhatToSync.xhtml";

async function openChooseWhatToSyncDialog() {
  const dialogWin = window.openDialog(
    SYNC_CHOOSE_DIALOG_URL,
    "",
    "chrome,dialog=no,resizable=no,centerscreen",
    { disconnectFun: null }
  );

  await BrowserTestUtils.waitForEvent(dialogWin, "load");
  await TestUtils.waitForCondition(
    () => dialogWin.document.readyState === "complete",
    "Choose-what-to-sync dialog should finish loading"
  );
  await dialogWin.document.l10n.translateRoots();

  return dialogWin;
}

async function setSidebarSyncCheckboxViaDialog(expectedChecked) {
  const dialogWin = await openChooseWhatToSyncDialog();
  try {
    const doc = dialogWin.document;
    const syncDialog = doc.getElementById("syncChooseOptions");
    const sidebarsyncCheckbox = doc.querySelector(
      'checkbox[preference="services.sync.engine.sidebarsync"]'
    );

    Assert.ok(syncDialog, "Choose-what-to-sync dialog should be present");
    Assert.ok(sidebarsyncCheckbox, "SidebarSync checkbox should be present in Sync UI");
    Assert.equal(
      sidebarsyncCheckbox.getAttribute("data-l10n-id"),
      "sync-engine-workspaces",
      "SidebarSync checkbox should use the Workspaces l10n key"
    );
    Assert.ok(
      sidebarsyncCheckbox.label.includes("Workspaces"),
      "SidebarSync checkbox label should render localized copy"
    );

    if (sidebarsyncCheckbox.checked !== expectedChecked) {
      sidebarsyncCheckbox.click();
    }
    Assert.equal(
      sidebarsyncCheckbox.checked,
      expectedChecked,
      "SidebarSync checkbox should toggle to the expected value"
    );

    const unloadPromise = BrowserTestUtils.waitForEvent(dialogWin, "unload");
    syncDialog.acceptDialog();
    await unloadPromise;
  } catch (error) {
    await BrowserTestUtils.closeWindow(dialogWin);
    throw error;
  }
}

add_task(async function test_sidebarsync_sync_ui_copy_and_pref_mapping() {
  const hadEnginePref = Services.prefs.prefHasUserValue(SIDEBAR_SYNC_ENGINE_PREF);
  const previousEnginePref = Services.prefs.getBoolPref(SIDEBAR_SYNC_ENGINE_PREF, true);

  registerCleanupFunction(() => {
    if (hadEnginePref) {
      Services.prefs.setBoolPref(SIDEBAR_SYNC_ENGINE_PREF, previousEnginePref);
    } else {
      Services.prefs.clearUserPref(SIDEBAR_SYNC_ENGINE_PREF);
    }
  });

  Services.prefs.setBoolPref(SIDEBAR_SYNC_ENGINE_PREF, true);

  await setSidebarSyncCheckboxViaDialog(false);
  Assert.equal(
    Services.prefs.getBoolPref(SIDEBAR_SYNC_ENGINE_PREF, true),
    false,
    "Accepting dialog with unchecked SidebarSync should disable engine pref"
  );

  await setSidebarSyncCheckboxViaDialog(true);
  Assert.equal(
    Services.prefs.getBoolPref(SIDEBAR_SYNC_ENGINE_PREF, false),
    true,
    "Accepting dialog with checked SidebarSync should enable engine pref"
  );
});
