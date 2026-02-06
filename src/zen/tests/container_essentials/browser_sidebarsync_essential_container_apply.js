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

add_task(async function test_positionTabs_uses_remote_essential_container_when_separated() {
  const storeProto = getSidebarSyncStorePrototype();
  const store = Object.create(storeProto);

  const initialWorkspaces = gZenWorkspaces.getWorkspaces();
  const knownWorkspaceIds = new Set(initialWorkspaces.map((ws) => ws.uuid));
  const originalContainerSpecific = gZenWorkspaces.containerSpecificEssentials;

  let createdWorkspaceId = null;
  let tab = null;
  try {
    gZenWorkspaces.containerSpecificEssentials = true;
    await gZenWorkspaces.createAndSaveWorkspace("SidebarSync Container 1", undefined, false, 1);

    const createdWorkspace = gZenWorkspaces
      .getWorkspaces()
      .find((ws) => !knownWorkspaceIds.has(ws.uuid));
    Assert.ok(createdWorkspace, "Should create a container workspace for userContextId=1");
    createdWorkspaceId = createdWorkspace?.uuid || null;

    tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/sidebarsync-pr4-a", {
      skipAnimation: true,
      userContextId: 1,
    });
    tab.setAttribute("zen-essential", "true");
    const remoteId = `sidebarsync-essential-remote-${Date.now()}`;
    tab.id = remoteId;

    storeProto.positionTabs.call(
      store,
      [
        {
          id: remoteId,
          isEssential: true,
          essentialContainerId: 1,
          position: 0,
        },
      ],
      new Map([[remoteId, tab]]),
      window,
      new Map()
    );

    const essentialsContainerOne = gZenWorkspaces.getEssentialsSection(1);
    const essentialsContainerZero = gZenWorkspaces.getEssentialsSection(0);
    Assert.equal(
      tab.parentElement,
      essentialsContainerOne,
      "Essential tab should be positioned in essentials container 1"
    );
    Assert.notEqual(
      tab.parentElement,
      essentialsContainerZero,
      "Essential tab should not be positioned in essentials container 0"
    );
  } finally {
    if (tab && !tab.closing) {
      gBrowser.removeTab(tab, { animate: false });
    }
    if (createdWorkspaceId) {
      await gZenWorkspaces.removeWorkspace(createdWorkspaceId);
    }
    gZenWorkspaces.containerSpecificEssentials = originalContainerSpecific;
  }
});

add_task(async function test_positionTabs_defaults_to_container_zero_when_not_separated() {
  const storeProto = getSidebarSyncStorePrototype();
  const store = Object.create(storeProto);

  const originalContainerSpecific = gZenWorkspaces.containerSpecificEssentials;
  let tab = null;
  try {
    gZenWorkspaces.containerSpecificEssentials = false;

    tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/sidebarsync-pr4-b", {
      skipAnimation: true,
      userContextId: 1,
    });
    tab.setAttribute("zen-essential", "true");
    const remoteId = `sidebarsync-essential-remote-${Date.now()}-fallback`;
    tab.id = remoteId;

    storeProto.positionTabs.call(
      store,
      [
        {
          id: remoteId,
          isEssential: true,
          essentialContainerId: 1,
          position: 0,
        },
      ],
      new Map([[remoteId, tab]]),
      window,
      new Map()
    );

    const essentialsContainerZero = gZenWorkspaces.getEssentialsSection(0);
    Assert.equal(
      tab.parentElement,
      essentialsContainerZero,
      "When container-specific essentials are disabled, tab should be positioned in container 0"
    );
  } finally {
    if (tab && !tab.closing) {
      gBrowser.removeTab(tab, { animate: false });
    }
    gZenWorkspaces.containerSpecificEssentials = originalContainerSpecific;
  }
});
