/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

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

add_task(async function test_sidebarsync_apply_icon_and_label_for_essential_tab() {
  const storeProto = getSidebarSyncStorePrototype();
  const store = Object.create(storeProto);

  const tabId = `sidebarsync-pr7-essential-${Date.now()}`;
  const label = "SidebarSync PR7 Label";
  const icon = "https://example.com/sidebarsync-pr7-icon.ico";
  let tab = null;

  try {
    const result = await storeProto.applyTabs.call(
      store,
      [
        {
          id: tabId,
          url: "https://example.com/sidebarsync-pr7-essential",
          workspaceId: null,
          folderId: null,
          isEssential: true,
          isPinned: true,
          position: 0,
          label,
          icon,
        },
      ],
      window,
      { allowDeletion: false, knownIds: [] },
      new Map()
    );

    tab = result?.tabMap?.get(tabId) || null;
    Assert.ok(tab, "SidebarSync should create the remote tab");
    Assert.ok(tab.pinned, "Essential tab should remain pinned");
    Assert.ok(tab.hasAttribute("zen-essential"), "Essential tab should keep zen-essential state");

    Assert.equal(tab.zenStaticLabel, label, "Tab should store remote static label");
    Assert.equal(tab.label, label, "Tab should apply remote label");

    Assert.equal(tab.zenStaticIcon, icon, "Tab should store remote static icon");
    Assert.equal(tab.getAttribute("image"), icon, "Tab should apply remote icon attribute");
    Assert.ok(
      tab.style.getPropertyValue("--zen-essential-tab-icon").includes(icon),
      "Essential tab icon style should be updated from remote icon"
    );
  } finally {
    if (tab && !tab.closing) {
      gBrowser.removeTab(tab, { animate: false });
    }
  }
});
