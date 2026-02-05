/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Store, SyncEngine, Tracker } from "resource://services-sync/engines.sys.mjs";
import { CryptoWrapper } from "resource://services-sync/record.sys.mjs";
import { Svc, Utils } from "resource://services-sync/util.sys.mjs";
import { SCORE_INCREMENT_XLARGE } from "resource://services-sync/constants.sys.mjs";
import { CommonUtils } from "resource://services-common/utils.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "SIDEBAR_SYNC_GUID", () =>
  CommonUtils.encodeBase64URL("zen-sidebar-sync-v1")
);

// ============== LOGGING ==============

const LOG_PREFIX = "[ZenSidebarSync]";
const PREF_KNOWN_REMOTE_IDS = "engine.sidebarsync.knownRemoteIds";
const PREF_DEBUG_LOG = "zen.sidebarsync.debug";
const PREF_TESTONLY = "zen.sidebarsync.testonly";

const COLLECT_READY_TIMEOUT_MS = 2000;
const APPLY_READY_TIMEOUT_MS = 5000;
const KNOWN_REMOTE_IDS_VERSION = 1;
const KNOWN_REMOTE_SOURCE_REMOTE = "remote";
const KNOWN_REMOTE_SOURCE_LEGACY = "legacy";
const MIN_KNOWN_FOR_SHRINK_GUARD = 4;
const SHRINK_RATIO = 0.25;

// Module-level flag to prevent tracker from marking changes during apply
// This is needed because this.engine._tracker may not be accessible from Store
let isApplyingRemoteData = false;

const logger = {
  _format(msg) {
    return `${LOG_PREFIX} ${msg}`;
  },

  info(msg) {
    // eslint-disable-next-line no-console
    console.log(this._format(msg));
  },

  warn(msg) {
    console.warn(this._format(msg));
  },

  error(msg) {
    console.error(this._format(msg));
  },
};

function shouldLogGating() {
  return Services.prefs.getBoolPref(PREF_DEBUG_LOG, false);
}

function logGating(msg) {
  if (shouldLogGating()) {
    logger.info(msg);
  }
}

function logDeletionGuard(msg) {
  if (shouldLogGating()) {
    logger.info(msg);
  }
}

function isEligibleWindow(win) {
  try {
    return (
      !!win &&
      !win.closed &&
      !!win.gBrowser &&
      !!win.gZenWorkspaces &&
      !win.gZenWorkspaces.privateWindowOrDisabled &&
      !!win.gZenWorkspaces.workspaceEnabled
    );
  } catch {
    return false;
  }
}

async function waitForZenReady(win, timeoutMs) {
  const workspaces = win?.gZenWorkspaces;
  if (!workspaces?.promisePinnedInitialized || !workspaces?.promiseInitialized) {
    logGating("waitForZenReady: missing readiness promises");
    return false;
  }

  if (!win || win.closed) {
    return false;
  }

  let timerId;
  try {
    return await new Promise((resolve) => {
      let resolved = false;

      const delayMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;

      const finish = (value) => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (timerId != null && win?.clearTimeout) {
          try {
            win.clearTimeout(timerId);
          } catch {
            // Best effort only.
          }
        }
        resolve(value);
      };

      timerId = win.setTimeout(() => finish(false), delayMs);

      Promise.all([workspaces.promisePinnedInitialized, workspaces.promiseInitialized]).then(
        () => finish(true),
        () => finish(false)
      );
    });
  } catch {
    return false;
  }
}

async function getEligibleSyncWindow({ timeoutMs = 0 } = {}) {
  const candidates = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (isEligibleWindow(win)) {
      candidates.push(win);
    }
  }

  // Prefer windows that completed startup.
  candidates.sort((a, b) => (b.gZenStartup?.isReady ? 1 : 0) - (a.gZenStartup?.isReady ? 1 : 0));

  for (const win of candidates) {
    if (await waitForZenReady(win, timeoutMs)) {
      logGating("getEligibleSyncWindow: selected eligible ready window");
      return win;
    }
    logGating("getEligibleSyncWindow: window not ready, skipping");
  }

  logGating("getEligibleSyncWindow: no eligible ready window available");
  return null;
}

export const __testOnly = {
  getEligibleSyncWindow(options) {
    if (!Services.prefs.getBoolPref(PREF_TESTONLY, false)) {
      throw new Error(
        "ZenSidebarSync __testOnly is disabled. Set zen.sidebarsync.testonly=true to enable."
      );
    }
    return getEligibleSyncWindow(options);
  },
  isEligibleWindow(win) {
    if (!Services.prefs.getBoolPref(PREF_TESTONLY, false)) {
      throw new Error(
        "ZenSidebarSync __testOnly is disabled. Set zen.sidebarsync.testonly=true to enable."
      );
    }
    return isEligibleWindow(win);
  },
  waitForZenReady(win, timeoutMs) {
    if (!Services.prefs.getBoolPref(PREF_TESTONLY, false)) {
      throw new Error(
        "ZenSidebarSync __testOnly is disabled. Set zen.sidebarsync.testonly=true to enable."
      );
    }
    return waitForZenReady(win, timeoutMs);
  },
};

// ============== RECORD ==============

export function SidebarSyncRec(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
SidebarSyncRec.prototype = { _logName: "Sync.Record.SidebarSync" };
Object.setPrototypeOf(SidebarSyncRec.prototype, CryptoWrapper.prototype);
Utils.deferGetSet(SidebarSyncRec, "cleartext", ["value"]);

// ============== ENGINE ==============

export function SidebarSyncEngine(service) {
  SyncEngine.call(this, "SidebarSync", service);
  logger.info("Engine initialized");
}

SidebarSyncEngine.prototype = {
  _storeObj: SidebarSyncStore,
  _trackerObj: SidebarSyncTracker,
  _recordObj: SidebarSyncRec,
  version: 4,
  syncPriority: 6,
  allowSkippedRecord: false,

  async getChangedIDs() {
    const changedIDs = {};
    if (!this._tracker.modified) {
      return changedIDs;
    }

    // Defer upload until we have an eligible, fully initialized window.
    const win = await getEligibleSyncWindow({ timeoutMs: COLLECT_READY_TIMEOUT_MS });
    if (!win) {
      logGating("getChangedIDs: deferring upload (no eligible ready window)");
      return changedIDs;
    }

    changedIDs[lazy.SIDEBAR_SYNC_GUID] = 0;
    return changedIDs;
  },

  async _syncStartup() {
    logger.info("--- Sync started ---");
    return SyncEngine.prototype._syncStartup.call(this);
  },

  async _processIncoming() {
    logger.info("Processing incoming records...");
    const result = await SyncEngine.prototype._processIncoming.call(this);
    logger.info(
      `Processed incoming: ${this.lastSync ? "lastSync=" + this.lastSync : "no lastSync"}`
    );
    return result;
  },

  async _uploadOutgoing() {
    return SyncEngine.prototype._uploadOutgoing.call(this);
  },

  async _syncFinish() {
    logger.info("--- Sync finished ---");
    return SyncEngine.prototype._syncFinish.call(this);
  },

  async _wipeClient() {
    logger.warn("Wipe client requested");
    await SyncEngine.prototype._wipeClient.call(this);
    this.justWiped = true;
  },

  async _reconcile(item) {
    const win = await getEligibleSyncWindow({ timeoutMs: APPLY_READY_TIMEOUT_MS });
    if (!win) {
      // Reject record so Firefox Sync will retry on next sync.
      logGating(`Reconcile: rejecting record ${item.id} (no eligible ready window)`);
      return false;
    }
    logGating(`Reconcile: accepting record ${item.id}`);
    return true;
  },

  async trackRemainingChanges() {
    if (this._modified.count() > 0) {
      this._tracker.modified = true;
    }
  },
};
Object.setPrototypeOf(SidebarSyncEngine.prototype, SyncEngine.prototype);

// ============== STORE ==============

function SidebarSyncStore(name, engine) {
  Store.call(this, name, engine);
}

SidebarSyncStore.prototype = {
  // ==========================================
  // KNOWN REMOTE IDS - Track what exists on server
  // Used to distinguish "new locally" vs "deleted remotely"
  // ==========================================

  _normalizeKnownIdList(ids) {
    if (!Array.isArray(ids)) {
      return [];
    }
    const normalized = [];
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== "string" || !id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  },

  _extractEntityIds(entries) {
    if (!Array.isArray(entries)) {
      return [];
    }

    const ids = [];
    const seen = new Set();
    for (const entry of entries) {
      const id = entry?.id;
      if (typeof id !== "string" || !id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  },

  _normalizeKnownRemoteIds(raw) {
    const fallback = {
      version: KNOWN_REMOTE_IDS_VERSION,
      source: KNOWN_REMOTE_SOURCE_LEGACY,
      appliedAt: 0,
      workspaces: [],
      folders: [],
      tabs: [],
    };

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fallback;
    }

    const sourceIsRemote =
      raw.source === KNOWN_REMOTE_SOURCE_REMOTE && raw.version === KNOWN_REMOTE_IDS_VERSION;

    return {
      version: KNOWN_REMOTE_IDS_VERSION,
      source: sourceIsRemote ? KNOWN_REMOTE_SOURCE_REMOTE : KNOWN_REMOTE_SOURCE_LEGACY,
      appliedAt: Number.isFinite(raw.appliedAt) ? raw.appliedAt : 0,
      workspaces: this._normalizeKnownIdList(raw.workspaces),
      folders: this._normalizeKnownIdList(raw.folders),
      tabs: this._normalizeKnownIdList(raw.tabs),
    };
  },

  _getKnownRemoteIds() {
    try {
      const json = Svc.PrefBranch.getStringPref(PREF_KNOWN_REMOTE_IDS, "{}");
      return this._normalizeKnownRemoteIds(JSON.parse(json));
    } catch {
      return this._normalizeKnownRemoteIds(null);
    }
  },

  _setKnownRemoteIds(ids) {
    const normalized = this._normalizeKnownRemoteIds(ids);
    Svc.PrefBranch.setStringPref(PREF_KNOWN_REMOTE_IDS, JSON.stringify(normalized));
    return normalized;
  },

  _updateKnownRemoteIds(remoteData, options = {}) {
    const previousKnown = this._normalizeKnownRemoteIds(
      options.previousKnown ?? this._getKnownRemoteIds()
    );
    const updateTypes = {
      workspaces: options.updateTypes?.workspaces !== false,
      folders: options.updateTypes?.folders !== false,
      tabs: options.updateTypes?.tabs !== false,
    };

    return this._setKnownRemoteIds({
      version: KNOWN_REMOTE_IDS_VERSION,
      source: KNOWN_REMOTE_SOURCE_REMOTE,
      appliedAt: Date.now(),
      workspaces: updateTypes.workspaces
        ? this._extractEntityIds(remoteData.workspaces)
        : previousKnown.workspaces,
      folders: updateTypes.folders
        ? this._extractEntityIds(remoteData.folders)
        : previousKnown.folders,
      tabs: updateTypes.tabs ? this._extractEntityIds(remoteData.tabs) : previousKnown.tabs,
    });
  },

  _getValidRemoteWorkspaces(remoteWorkspaces = []) {
    if (!Array.isArray(remoteWorkspaces)) {
      logger.warn("Skipping invalid workspaces payload: expected array");
      return [];
    }

    return remoteWorkspaces.filter((ws) => {
      if (!ws?.id || !ws?.name) {
        logger.warn(`Skipping invalid workspace: missing id or name`);
        return false;
      }
      return true;
    });
  },

  _getValidRemoteFolders(remoteFolders = []) {
    if (!Array.isArray(remoteFolders)) {
      logger.warn("Skipping invalid folders payload: expected array");
      return [];
    }

    return remoteFolders.filter((folder) => {
      if (!folder?.id) {
        logger.warn("Skipping invalid folder: missing id");
        return false;
      }
      return true;
    });
  },

  _getValidRemoteTabs(remoteTabs = []) {
    if (!Array.isArray(remoteTabs)) {
      logger.warn("Skipping invalid tabs payload: expected array");
      return [];
    }

    return remoteTabs.filter((tab) => {
      if (!tab?.id || !tab?.url) {
        logger.warn(`Skipping invalid tab: missing id or url`);
        return false;
      }
      return true;
    });
  },

  _getLocalWorkspaceCount() {
    try {
      const { ZenSessionStore } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenSessionManager.sys.mjs"
      );
      return (ZenSessionStore.getClonedSpaces() || []).length;
    } catch {
      return 0;
    }
  },

  _getLocalFolderCount(win) {
    return win?.document?.querySelectorAll("zen-folder")?.length || 0;
  },

  _getLocalSidebarTabCount(win) {
    if (!win?.gBrowser?.tabs) {
      return 0;
    }

    let count = 0;
    for (const tab of win.gBrowser.tabs) {
      if (!tab?.id || tab.hasAttribute("zen-empty-tab")) {
        continue;
      }
      if (tab.pinned || tab.hasAttribute("zen-essential") || tab.group?.isZenFolder) {
        count++;
      }
    }
    return count;
  },

  _buildTypeApplyPolicy(type, knownRemoteIds, localCount, remoteCount) {
    const knownSource =
      knownRemoteIds?.source === KNOWN_REMOTE_SOURCE_REMOTE
        ? KNOWN_REMOTE_SOURCE_REMOTE
        : KNOWN_REMOTE_SOURCE_LEGACY;
    const knownIds = this._normalizeKnownIdList(knownRemoteIds?.[type]);
    const knownCount = knownSource === KNOWN_REMOTE_SOURCE_REMOTE ? knownIds.length : 0;

    const suspiciousEmpty =
      knownSource === KNOWN_REMOTE_SOURCE_REMOTE &&
      remoteCount === 0 &&
      knownCount > 0 &&
      localCount > 0;

    const suspiciousShrink =
      knownSource === KNOWN_REMOTE_SOURCE_REMOTE &&
      knownCount >= MIN_KNOWN_FOR_SHRINK_GUARD &&
      remoteCount <= Math.floor(knownCount * SHRINK_RATIO) &&
      localCount > remoteCount;

    if (suspiciousEmpty) {
      logDeletionGuard(
        `${type}: suspicious empty payload (local=${localCount}, remote=${remoteCount}, known=${knownCount})`
      );
    } else if (suspiciousShrink) {
      logDeletionGuard(
        `${type}: suspicious shrink payload (local=${localCount}, remote=${remoteCount}, known=${knownCount}, threshold=${Math.floor(
          knownCount * SHRINK_RATIO
        )})`
      );
    }

    return {
      type,
      knownSource,
      knownIds,
      suspiciousEmpty,
      suspiciousShrink,
      allowDeletion:
        knownSource === KNOWN_REMOTE_SOURCE_REMOTE && !suspiciousEmpty && !suspiciousShrink,
      updateKnown: !suspiciousEmpty && (!suspiciousShrink || remoteCount > 0),
    };
  },

  _describeDeletionBlockReason(policy) {
    if (policy?.suspiciousEmpty) {
      return "suspicious-empty";
    }
    if (policy?.suspiciousShrink) {
      return "suspicious-shrink";
    }
    if (policy?.knownSource !== KNOWN_REMOTE_SOURCE_REMOTE) {
      return `known-source=${policy?.knownSource || KNOWN_REMOTE_SOURCE_LEGACY}`;
    }
    return "deletion-not-authorized";
  },

  // ==========================================
  // MAIN SYNC METHODS
  // ==========================================

  /**
   * Collect all local sidebar data for syncing to the server.
   * This is called when uploading local changes.
   */
  async collectSyncData() {
    const win = await getEligibleSyncWindow({ timeoutMs: COLLECT_READY_TIMEOUT_MS });
    if (!win) {
      logGating("collectSyncData: skipping upload (no eligible ready window)");
      return null;
    }

    const now = Date.now();

    const data = {
      schemaVersion: 1,
      lastModified: now,
      workspaces: this.syncWorkspaces(win, now),
      folders: this.syncFolders(win, now),
      tabs: this.syncTabs(win, now),
    };

    logger.info(
      `Upload: ${data.workspaces.length} workspaces, ${data.folders.length} folders, ${data.tabs.length} tabs`
    );

    return data;
  },

  /**
   * Apply remote data received from the server to the local browser.
   * This is called when downloading remote changes.
   */
  async applyRemoteData(remoteData) {
    logger.info("applyRemoteData called");

    if (!remoteData) {
      logger.warn("No remote data to apply");
      return;
    }

    const win = await getEligibleSyncWindow({ timeoutMs: APPLY_READY_TIMEOUT_MS });
    if (!win) {
      logGating("applyRemoteData: skipping apply (no eligible ready window)");
      return;
    }

    // Get last successfully applied remote snapshot.
    const knownRemoteIds = this._getKnownRemoteIds();

    const validRemoteData = {
      workspaces: this._getValidRemoteWorkspaces(remoteData.workspaces || []),
      folders: this._getValidRemoteFolders(remoteData.folders || []),
      tabs: this._getValidRemoteTabs(remoteData.tabs || []),
    };

    const localCounts = {
      workspaces: this._getLocalWorkspaceCount(),
      folders: this._getLocalFolderCount(win),
      tabs: this._getLocalSidebarTabCount(win),
    };

    const applyPolicies = {
      workspaces: this._buildTypeApplyPolicy(
        "workspaces",
        knownRemoteIds,
        localCounts.workspaces,
        validRemoteData.workspaces.length
      ),
      folders: this._buildTypeApplyPolicy(
        "folders",
        knownRemoteIds,
        localCounts.folders,
        validRemoteData.folders.length
      ),
      tabs: this._buildTypeApplyPolicy(
        "tabs",
        knownRemoteIds,
        localCounts.tabs,
        validRemoteData.tabs.length
      ),
    };

    logger.info(
      `Download: ${validRemoteData.workspaces.length} workspaces, ` +
        `${validRemoteData.folders.length} folders, ${validRemoteData.tabs.length} tabs`
    );

    // IMPORTANT: Ignore tracker changes during apply to prevent immediate re-upload
    // Use both module-level flag and tracker's ignoreAll for safety
    isApplyingRemoteData = true;
    const tracker = this.engine?._tracker;
    const wasIgnoring = tracker?.ignoreAll;
    if (tracker) {
      tracker.ignoreAll = true;
    }

    try {
      // Apply in order: workspaces first, then folders, then tabs
      // applyFolders returns a map of folder elements so applyTabs can use it
      const workspacesApplied =
        (await this.applyWorkspaces(validRemoteData.workspaces, win, applyPolicies.workspaces)) !==
        false;

      let folderMap = new Map();
      let foldersApplied = true;
      const folderResult = await this.applyFolders(
        validRemoteData.folders,
        win,
        applyPolicies.folders
      );
      if (folderResult instanceof Map) {
        folderMap = folderResult;
      } else if (folderResult === false) {
        foldersApplied = false;
      } else if (folderResult && typeof folderResult === "object") {
        if (folderResult.folderMap instanceof Map) {
          folderMap = folderResult.folderMap;
        }
        foldersApplied = folderResult.success !== false;
      }

      const tabsApplied =
        (await this.applyTabs(validRemoteData.tabs, win, applyPolicies.tabs, folderMap)) !== false;

      this._updateKnownRemoteIds(validRemoteData, {
        previousKnown: knownRemoteIds,
        updateTypes: {
          workspaces: applyPolicies.workspaces.updateKnown && workspacesApplied,
          folders: applyPolicies.folders.updateKnown && foldersApplied,
          tabs: applyPolicies.tabs.updateKnown && tabsApplied,
        },
      });
    } catch (e) {
      logger.error(`Failed to apply remote data: ${e.message}`);
      console.error(e);
    } finally {
      // Restore tracker state
      isApplyingRemoteData = false;
      if (tracker) {
        tracker.ignoreAll = wasIgnoring;
      }
    }
  },

  // ==========================================
  // SYNC METHODS - Collect local data for upload
  // ==========================================

  /**
   * Collect all workspace data for sync.
   * Returns array of workspace objects with all properties.
   */
  syncWorkspaces(win, timestamp) {
    const { ZenSessionStore } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenSessionManager.sys.mjs"
    );
    const rawWorkspaces = ZenSessionStore.getClonedSpaces() || [];

    return rawWorkspaces.map((ws, index) => this.syncWorkspace(ws, index, timestamp));
  },

  /**
   * Collect data for a single workspace.
   */
  syncWorkspace(workspace, position, timestamp) {
    // containerTabId must always be a number - 0 is the default container
    // This is required for ZenWorkspaces animation code to work correctly
    const containerTabId =
      typeof workspace.containerTabId === "number" ? workspace.containerTabId : 0;

    return {
      // Identity
      id: workspace.uuid,
      // Properties
      name: workspace.name,
      icon: workspace.icon || null,
      theme: workspace.theme || null,
      containerTabId,
      isDefault: workspace.default || false,
      // Position & metadata
      position,
      lastModified: workspace.lastModified || timestamp,
    };
  },

  /**
   * Collect all folder data for sync.
   * Returns array of folder objects with all properties.
   */
  syncFolders(win, timestamp) {
    const folders = [];
    const seenIds = new Set();

    const processFolder = (folder, position, parentId = null) => {
      if (!folder?.id || seenIds.has(folder.id)) {
        return;
      }
      seenIds.add(folder.id);

      folders.push(this.syncFolder(folder, position, parentId, timestamp));

      // Process nested folders
      let childPosition = 0;
      for (const item of folder.allItems || []) {
        if (item.isZenFolder) {
          processFolder(item, childPosition++, folder.id);
        }
      }
    };

    // Process all workspace pinned containers
    const workspaceElements = win.document.querySelectorAll("zen-workspace");
    for (const wsElem of workspaceElements) {
      const container = wsElem.pinnedTabsContainer;
      if (!container) {
        continue;
      }

      let position = 0;
      for (const child of container.children) {
        if (child.isZenFolder) {
          processFolder(child, position++);
        } else if (win.gBrowser.isTab(child) && !child.hasAttribute("zen-empty-tab")) {
          position++; // Count tabs for position tracking
        }
      }
    }

    return folders;
  },

  /**
   * Collect data for a single folder.
   */
  syncFolder(folder, position, parentId, timestamp) {
    return {
      // Identity
      id: folder.id,
      // Properties
      name: folder.label || "",
      icon: folder.iconURL || null,
      collapsed: folder.collapsed || false,
      // Relationships
      workspaceId: folder.getAttribute("zen-workspace-id") || null,
      parentId,
      // Position & metadata
      position,
      lastModified: timestamp,
    };
  },

  /**
   * Collect all pinned/essential tab data for sync.
   * Returns array of tab objects with all properties.
   */
  syncTabs(win, timestamp) {
    const tabs = [];
    const seenIds = new Set();

    const processTab = (tab, position, folderId = null) => {
      if (!tab?.id || seenIds.has(tab.id)) {
        return;
      }
      if (tab.hasAttribute("zen-empty-tab")) {
        return;
      }

      const url = tab.linkedBrowser?.currentURI?.spec;
      if (!url || url.startsWith("about:")) {
        return;
      }

      const isEssential = tab.hasAttribute("zen-essential");
      const isPinned = tab.pinned;
      const isInFolder = !!folderId || tab.group?.isZenFolder;

      // Only sync pinned, essential, or in-folder tabs
      if (!isEssential && !isPinned && !isInFolder) {
        return;
      }

      seenIds.add(tab.id);
      tabs.push(this.syncTab(tab, position, folderId, timestamp));
    };

    // Helper to recursively collect tabs from folders
    const processFolderTabs = (folder) => {
      let position = 0;
      for (const item of folder.allItems || []) {
        if (win.gBrowser.isTab(item)) {
          processTab(item, position++, folder.id);
        } else if (item.isZenFolder) {
          // Recursively process nested folder's tabs
          processFolderTabs(item);
        }
      }
    };

    // Collect from workspace pinned containers
    const workspaceElements = win.document.querySelectorAll("zen-workspace");
    for (const wsElem of workspaceElements) {
      const container = wsElem.pinnedTabsContainer;
      if (!container) {
        continue;
      }

      let position = 0;
      for (const child of container.children) {
        if (child.classList?.contains("pinned-tabs-container-separator")) {
          continue;
        }
        if (child.isZenFolder) {
          // Recursively collect tabs inside folder and nested folders
          processFolderTabs(child);
          position++;
        } else if (win.gBrowser.isTab(child)) {
          processTab(child, position++);
        }
      }
    }

    // Collect essential tabs
    const essentialsContainers = win.document.querySelectorAll(".zen-essentials-container");
    for (const container of essentialsContainers) {
      let position = 0;
      for (const child of container.children) {
        if (win.gBrowser.isTab(child)) {
          processTab(child, position++);
        }
      }
    }

    return tabs;
  },

  /**
   * Collect data for a single tab.
   */
  syncTab(tab, position, folderId, timestamp) {
    const isEssential = tab.hasAttribute("zen-essential");

    return {
      // Identity
      id: tab.id,
      // Properties
      url: tab.linkedBrowser?.currentURI?.spec,
      label: tab.zenStaticLabel || null,
      icon: tab.getAttribute("image") || null,
      isEssential,
      isPinned: tab.pinned,
      // Relationships
      workspaceId: isEssential ? null : tab.getAttribute("zen-workspace-id") || null,
      folderId: folderId || (tab.group?.isZenFolder ? tab.group.id : null),
      // Position & metadata
      position,
      lastModified: timestamp,
    };
  },

  // ==========================================
  // APPLY METHODS - Apply remote data locally
  // Rules:
  // 1. New entity (ID not found locally) -> CREATE
  // 2. Existing entity -> UPDATE all properties (remote is authoritative)
  // 3. Local entity not in remote -> DELETE (was deleted on another client)
  // ==========================================

  /**
   * Apply remote workspace data.
   * Creates, updates, and deletes workspaces as needed.
   *
   * @param {Array} remoteWorkspaces - Remote workspace data from server
   * @param {Window} win - Browser window
   * @param {object} deletionPolicy - Deletion guard policy for workspace IDs
   */
  async applyWorkspaces(remoteWorkspaces, win, deletionPolicy = {}) {
    try {
      const { ZenSessionStore } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenSessionManager.sys.mjs"
      );

      // Get local workspaces
      const localWorkspaces = ZenSessionStore.getClonedSpaces() || [];
      if (!localWorkspaces.length && !remoteWorkspaces.length) {
        logger.warn("No workspaces to process");
        return true;
      }

      const localById = new Map(localWorkspaces.map((ws) => [ws.uuid, ws]));
      const validRemote = this._getValidRemoteWorkspaces(remoteWorkspaces);
      const remoteById = new Map(validRemote.map((ws) => [ws.id, ws]));
      const knownRemoteSet = new Set(this._normalizeKnownIdList(deletionPolicy.knownIds));

      // Sort remote by position
      const sortedRemote = [...validRemote].sort((a, b) => a.position - b.position);

      // Build new workspace list
      const newWorkspaces = [];
      const changes = { created: [], updated: [], deleted: [], kept: [] };

      for (const remote of sortedRemote) {
        const local = localById.get(remote.id);
        const workspace = this.applyWorkspace(remote, local);
        newWorkspaces.push(workspace);

        if (!local) {
          changes.created.push(remote.name);
        } else {
          changes.updated.push(remote.name);
        }
      }

      // Process local workspaces not in remote
      for (const local of localWorkspaces) {
        if (!remoteById.has(local.uuid)) {
          if (deletionPolicy.allowDeletion && knownRemoteSet.has(local.uuid)) {
            // Was on server before, now gone → deleted remotely
            changes.deleted.push(local.name);
            logDeletionGuard(`workspaces: delete id=${local.uuid}`);
          } else {
            // Never was on server → new locally, keep it
            newWorkspaces.push(local);
            changes.kept.push(local.name);
            const reason = deletionPolicy.allowDeletion
              ? "id-not-known-remote"
              : this._describeDeletionBlockReason(deletionPolicy);
            logDeletionGuard(`workspaces: keep id=${local.uuid} (${reason})`);
          }
        }
      }

      // Safety: Never leave with zero workspaces
      if (newWorkspaces.length === 0) {
        logger.warn("Would result in zero workspaces, keeping all local");
        newWorkspaces.push(...localWorkspaces);
        changes.kept.push(...localWorkspaces.map((ws) => ws.name));
      }

      // Apply changes
      await win.gZenWorkspaces.propagateWorkspaces(newWorkspaces);

      // Update UI
      for (const ws of newWorkspaces) {
        const wsElem = win.gZenWorkspaces.workspaceElement(ws.uuid);
        if (wsElem?.indicator) {
          win.gZenWorkspaces.updateWorkspaceIndicator(ws, wsElem.indicator);
        }
        if (win.gZenWorkspaces.isWorkspaceActive(ws) && win.gZenThemePicker && ws.theme) {
          win.gZenThemePicker.onWorkspaceChange(ws);
        }
      }

      const parts = [];
      if (changes.created.length) {
        parts.push(`created: ${changes.created.join(", ")}`);
      }
      if (changes.updated.length) {
        parts.push(`updated: ${changes.updated.join(", ")}`);
      }
      if (changes.deleted.length) {
        parts.push(`deleted: ${changes.deleted.join(", ")}`);
      }
      if (changes.kept.length) {
        parts.push(`kept: ${changes.kept.join(", ")}`);
      }
      if (parts.length) {
        logger.info(`Workspaces - ${parts.join("; ")}`);
      }
      return true;
    } catch (e) {
      logger.error(`Failed to apply workspaces: ${e.message}`);
      console.error(e);
      return false;
    }
  },

  /**
   * Apply a single workspace's data.
   * Returns workspace object in local format.
   */
  applyWorkspace(remote, _local) {
    // containerTabId must always be a number - 0 is the default container
    // This is required for ZenWorkspaces animation code to work correctly
    const containerTabId = typeof remote.containerTabId === "number" ? remote.containerTabId : 0;

    // Remote is always authoritative - return workspace with all remote properties
    return {
      uuid: remote.id,
      name: remote.name,
      icon: remote.icon,
      theme: remote.theme,
      containerTabId,
      default: remote.isDefault,
      lastModified: remote.lastModified,
    };
  },

  /**
   * Topological sort of folders - ensures parents come before children.
   *
   * @param {Array} folders - Array of folder objects with id and parentId
   * @returns {Array} Sorted array with parents before children
   */
  _topologicalSortFolders(folders) {
    const result = [];
    const added = new Set();
    const folderMap = new Map(folders.map((f) => [f.id, f]));

    // Helper to add folder and all its ancestors first
    const addWithAncestors = (folder) => {
      if (added.has(folder.id)) {
        return;
      }
      // If has parent, add parent first
      if (folder.parentId && folderMap.has(folder.parentId)) {
        addWithAncestors(folderMap.get(folder.parentId));
      }
      added.add(folder.id);
      result.push(folder);
    };

    // Sort by position first for stable ordering within same level
    const sortedByPosition = [...folders].sort((a, b) => a.position - b.position);

    // Add all folders (ancestors will be added first)
    for (const folder of sortedByPosition) {
      addWithAncestors(folder);
    }

    return result;
  },

  /**
   * Apply remote folder data.
   * Creates, updates, and deletes folders as needed.
   *
   * @param {Array} remoteFolders - Remote folder data from server
   * @param {Window} win - Browser window
   * @param {object} deletionPolicy - Deletion guard policy for folder IDs
   * @returns {Map} Map of folder ID to folder element (for use by applyTabs)
   */
  async applyFolders(remoteFolders, win, deletionPolicy = {}) {
    if (!win.gZenFolders) {
      return { folderMap: new Map(), success: false };
    }

    try {
      // Get local folders (zen-folder elements)
      const localFolderElements = win.document.querySelectorAll("zen-folder");
      const localById = new Map();
      for (const elem of localFolderElements) {
        if (elem.id) {
          localById.set(elem.id, elem);
        }
      }

      // Validate remote data
      const validRemote = this._getValidRemoteFolders(remoteFolders);
      const remoteById = new Map(validRemote.map((f) => [f.id, f]));
      const knownRemoteSet = new Set(this._normalizeKnownIdList(deletionPolicy.knownIds));

      // Topological sort: parents before children
      // This ensures nested folders are created in the right order
      const sortedRemote = this._topologicalSortFolders(validRemote);

      const changes = { created: [], updated: [], deleted: [], kept: [] };

      // CREATE or UPDATE folders
      for (const remote of sortedRemote) {
        let folder = localById.get(remote.id);

        if (!folder) {
          folder = this.createFolder(remote, win, localById);
          if (folder) {
            changes.created.push(remote.name || remote.id);
          }
        } else {
          this.applyFolder(remote, folder, win);
          changes.updated.push(remote.name || remote.id);
        }

        if (folder) {
          localById.set(remote.id, folder);
        }
      }

      // DELETE local folders not in remote - but only if they were previously known
      for (const [id, elem] of localById) {
        if (!remoteById.has(id)) {
          if (deletionPolicy.allowDeletion && knownRemoteSet.has(id)) {
            // Was on server before, now gone → deleted remotely
            changes.deleted.push(elem.label || id);
            elem.delete?.();
            logDeletionGuard(`folders: delete id=${id}`);
          } else {
            // Never was on server → new locally, keep it
            changes.kept.push(elem.label || id);
            const reason = deletionPolicy.allowDeletion
              ? "id-not-known-remote"
              : this._describeDeletionBlockReason(deletionPolicy);
            logDeletionGuard(`folders: keep id=${id} (${reason})`);
          }
        }
      }

      // Position folders
      this.positionFolders(validRemote, localById, win);

      const parts = [];
      if (changes.created.length) {
        parts.push(`created: ${changes.created.join(", ")}`);
      }
      if (changes.updated.length) {
        parts.push(`updated: ${changes.updated.join(", ")}`);
      }
      if (changes.deleted.length) {
        parts.push(`deleted: ${changes.deleted.join(", ")}`);
      }
      if (changes.kept.length) {
        parts.push(`kept: ${changes.kept.join(", ")}`);
      }
      if (parts.length) {
        logger.info(`Folders - ${parts.join("; ")}`);
      }

      return { folderMap: localById, success: true };
    } catch (e) {
      logger.error(`Failed to apply folders: ${e.message}`);
      console.error(e);
      return { folderMap: new Map(), success: false };
    }
  },

  /**
   * Create a new folder from remote data.
   *
   * @param {object} remote - Remote folder data
   * @param {Window} win - Browser window
   * @param {Map} localById - Map of local folders by ID (for finding parent)
   */
  createFolder(remote, win, localById) {
    // Build options for folder creation
    const options = {
      id: remote.id,
      label: remote.name || "Folder",
      collapsed: remote.collapsed,
      renameFolder: false,
      workspaceId: remote.workspaceId,
    };

    // For nested folders, find insertion point in parent
    if (remote.parentId && localById?.has(remote.parentId)) {
      const parentFolder = localById.get(remote.parentId);
      // Insert after parent's start element (empty tab) - this is how ZenFolders does it
      const insertPoint = parentFolder.groupStartElement?.nextElementSibling;
      if (insertPoint) {
        options.insertAfter = insertPoint;
      }
    }

    // Create folder using ZenFolders API (it creates its own empty tab)
    const folder = win.gZenFolders.createFolder([], options);

    if (!folder) {
      logger.warn(`Failed to create folder ${remote.id}`);
      return null;
    }

    // Set workspace ID attribute
    if (remote.workspaceId) {
      folder.setAttribute("zen-workspace-id", remote.workspaceId);
    }

    // Apply icon if present
    if (remote.icon) {
      win.gZenFolders.setFolderUserIcon(folder, remote.icon);
    }

    return folder;
  },

  /**
   * Apply remote data to an existing folder.
   */
  applyFolder(remote, folder, win) {
    folder.label = remote.name;
    folder.collapsed = remote.collapsed;
    if (remote.workspaceId) {
      folder.setAttribute("zen-workspace-id", remote.workspaceId);
    }
    if (remote.icon) {
      win.gZenFolders.setFolderUserIcon(folder, remote.icon);
    }
  },

  /**
   * Position top-level folders according to remote positions.
   * Note: Nested folders are positioned during creation via insertAfter.
   */
  positionFolders(remoteFolders, localById, win) {
    // Only position top-level folders (no parentId)
    // Nested folders are already positioned correctly during creation
    const topLevelFolders = remoteFolders.filter((f) => !f.parentId);

    // Group by workspace
    const byWorkspace = new Map();
    for (const remote of topLevelFolders) {
      const key = remote.workspaceId || "default";
      if (!byWorkspace.has(key)) {
        byWorkspace.set(key, []);
      }
      byWorkspace.get(key).push(remote);
    }

    // Position each workspace's folders
    for (const [workspaceId, folders] of byWorkspace) {
      folders.sort((a, b) => a.position - b.position);

      // Get workspace container
      const wsElem = win.gZenWorkspaces.workspaceElement(workspaceId);
      const container = wsElem?.pinnedTabsContainer || win.gZenWorkspaces.pinnedTabsContainer;

      if (!container) {
        continue;
      }

      // Build array of folder elements in correct order
      const orderedFolders = [];
      for (const remote of folders) {
        const folder = localById.get(remote.id);
        if (folder) {
          orderedFolders.push(folder);
        }
      }

      if (orderedFolders.length === 0) {
        continue;
      }

      // Move first folder to the correct container and position
      const firstFolder = orderedFolders[0];
      container.insertBefore(firstFolder, container.firstChild);

      // Position subsequent folders after the previous one
      for (let i = 1; i < orderedFolders.length; i++) {
        const folder = orderedFolders[i];
        const prevFolder = orderedFolders[i - 1];
        // Ensure folder is in correct container and position
        prevFolder.after(folder);
      }
    }
  },

  /**
   * Apply remote tab data.
   * Creates, updates, and deletes tabs as needed.
   *
   * @param {Array} remoteTabs - Remote tab data from server
   * @param {Window} win - Browser window
   * @param {object} deletionPolicy - Deletion guard policy for tab IDs
   * @param {Map} folderMap - Map of folder ID to folder element (from applyFolders)
   */
  async applyTabs(remoteTabs, win, deletionPolicy = {}, folderMap = new Map()) {
    try {
      // Get local tabs
      const localById = new Map();
      for (const tab of win.gBrowser.tabs) {
        if (tab.id && !tab.hasAttribute("zen-empty-tab")) {
          localById.set(tab.id, tab);
        }
      }

      // Validate remote data
      const validRemote = this._getValidRemoteTabs(remoteTabs);

      const remoteById = new Map(validRemote.map((t) => [t.id, t]));
      const knownRemoteSet = new Set(this._normalizeKnownIdList(deletionPolicy.knownIds));

      const changes = { created: [], updated: [], deleted: [], kept: [] };

      // CREATE or UPDATE tabs
      for (const remote of validRemote) {
        let tab = localById.get(remote.id);

        // URL fallback match
        if (!tab) {
          for (const t of win.gBrowser.tabs) {
            if (t.linkedBrowser?.currentURI?.spec === remote.url && !localById.has(t.id)) {
              tab = t;
              break;
            }
          }
        }

        if (!tab) {
          tab = this.createTab(remote, win);
          if (tab) {
            changes.created.push(remote.label || remote.url);
          }
        } else {
          this.applyTab(remote, tab, win);
          changes.updated.push(remote.label || remote.url);
        }

        if (tab) {
          localById.set(remote.id, tab);
        }
      }

      // DELETE local tabs not in remote - but only if they were previously known
      for (const [id, tab] of localById) {
        if (!remoteById.has(id) && (tab.pinned || tab.hasAttribute("zen-essential"))) {
          if (deletionPolicy.allowDeletion && knownRemoteSet.has(id)) {
            // Was on server before, now gone → deleted remotely
            changes.deleted.push(tab.linkedBrowser?.currentURI?.spec || id);
            win.gBrowser.removeTab(tab, { animate: false });
            logDeletionGuard(`tabs: delete id=${id}`);
          } else {
            // Never was on server → new locally, keep it
            changes.kept.push(tab.linkedBrowser?.currentURI?.spec || id);
            const reason = deletionPolicy.allowDeletion
              ? "id-not-known-remote"
              : this._describeDeletionBlockReason(deletionPolicy);
            logDeletionGuard(`tabs: keep id=${id} (${reason})`);
          }
        }
      }

      // Position tabs (pass folderMap to look up folders directly)
      this.positionTabs(validRemote, localById, win, folderMap);

      const parts = [];
      if (changes.created.length) {
        parts.push(`created: ${changes.created.join(", ")}`);
      }
      if (changes.updated.length) {
        parts.push(`updated: ${changes.updated.join(", ")}`);
      }
      if (changes.deleted.length) {
        parts.push(`deleted: ${changes.deleted.join(", ")}`);
      }
      if (changes.kept.length) {
        parts.push(`kept: ${changes.kept.join(", ")}`);
      }
      if (parts.length) {
        logger.info(`Tabs - ${parts.join("; ")}`);
      }

      // Refresh tab system cache (required after modifying tab structure)
      win.gBrowser.tabContainer._invalidateCachedTabs?.();
      return true;
    } catch (e) {
      logger.error(`Failed to apply tabs: ${e.message}`);
      console.error(e);
      return false;
    }
  },

  /**
   * Create a new tab from remote data.
   */
  createTab(remote, win) {
    // Build options for tab creation
    const options = {
      skipAnimation: true,
      pinned: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      createLazyBrowser: true,
    };

    // Set workspace for the tab if not essential
    if (!remote.isEssential && remote.workspaceId) {
      options.workspaceId = remote.workspaceId;
    }

    const tab = win.gBrowser.addTab(remote.url, options);
    win.gBrowser.pinTab(tab);

    // Set the ID to match remote
    tab.id = remote.id;

    // Apply other properties
    this.applyTab(remote, tab, win);

    return tab;
  },

  /**
   * Apply remote data to an existing tab.
   */
  applyTab(remote, tab, win) {
    // Essential state
    if (remote.isEssential) {
      tab.setAttribute("zen-essential", "true");
      tab.removeAttribute("zen-workspace-id");
    } else {
      tab.removeAttribute("zen-essential");
      if (remote.workspaceId) {
        tab.setAttribute("zen-workspace-id", remote.workspaceId);
      }
    }

    // Label
    if (remote.label) {
      tab._zenChangeLabelFlag = true;
      tab.zenStaticLabel = remote.label;
      win.gBrowser._setTabLabel(tab, remote.label);
      delete tab._zenChangeLabelFlag;
    }
  },

  /**
   * Position all tabs according to remote positions.
   * This handles moving tabs to correct containers (folders, workspaces, essentials).
   */
  positionTabs(remoteTabs, localById, win, folderMap = new Map()) {
    // Group by container
    const byContainer = new Map();
    for (const remote of remoteTabs) {
      let key;
      if (remote.isEssential) {
        key = "essentials";
      } else if (remote.folderId) {
        key = `folder:${remote.folderId}`;
      } else {
        key = `workspace:${remote.workspaceId || "default"}`;
      }

      if (!byContainer.has(key)) {
        byContainer.set(key, []);
      }
      byContainer.get(key).push(remote);
    }

    // Position each container's tabs
    for (const [containerId, tabs] of byContainer) {
      tabs.sort((a, b) => a.position - b.position);

      // Get container element
      let container;
      let isFolder = false;
      if (containerId === "essentials") {
        container = win.gZenWorkspaces?.getEssentialsSection?.(0);
      } else if (containerId.startsWith("folder:")) {
        const folderId = containerId.replace("folder:", "");
        // Use folderMap first (more reliable), fallback to getElementById
        container = folderMap.get(folderId) || win.document.getElementById(folderId);
        isFolder = true;
        if (!container) {
          logger.warn(`Folder ${folderId} not found for tab positioning`);
        }
      } else {
        const wsId = containerId.replace("workspace:", "");
        const wsElem = win.gZenWorkspaces.workspaceElement(wsId);
        container = wsElem?.pinnedTabsContainer || win.gZenWorkspaces.pinnedTabsContainer;
      }

      if (!container) {
        continue;
      }

      // Collect tab elements in correct order
      const orderedTabs = [];
      for (const remote of tabs) {
        const tab = localById.get(remote.id);
        if (tab) {
          orderedTabs.push(tab);
        }
      }

      if (orderedTabs.length === 0) {
        continue;
      }

      // For folders, add all tabs to the folder first
      if (isFolder && container.addTabs) {
        // Filter to tabs not already in this folder
        const tabsToAdd = orderedTabs.filter((tab) => tab.group !== container);
        if (tabsToAdd.length) {
          container.addTabs(tabsToAdd);
        }
      }

      // Now position all tabs in order
      // Find insert point (after empty tab for folders, or at start)
      let insertPoint = null;
      let positionContainer = container;

      if (isFolder) {
        // For folders, tabs are inside groupContainer
        positionContainer = container.groupContainer;
        const emptyTab = container.tabs?.find((t) => t.hasAttribute("zen-empty-tab"));
        insertPoint = emptyTab || null;
      }

      // Position first tab
      const firstTab = orderedTabs[0];
      if (insertPoint) {
        insertPoint.after(firstTab);
      } else {
        positionContainer.insertBefore(firstTab, positionContainer.firstChild);
      }

      // Position subsequent tabs after the previous one
      for (let i = 1; i < orderedTabs.length; i++) {
        const tab = orderedTabs[i];
        const prevTab = orderedTabs[i - 1];
        prevTab.after(tab);
      }
    }
  },

  // ==========================================
  // SYNC ENGINE INTERFACE
  // ==========================================

  async getAllIDs() {
    return { [lazy.SIDEBAR_SYNC_GUID]: true };
  },

  async changeItemID() {},

  async itemExists(id) {
    return id === lazy.SIDEBAR_SYNC_GUID;
  },

  async createRecord(id, collection) {
    let record = new SidebarSyncRec(collection, id);

    if (id === lazy.SIDEBAR_SYNC_GUID) {
      const data = await this.collectSyncData();
      if (data && data.workspaces.length) {
        record.value = data;
      } else {
        logger.warn("No data to sync");
        record.value = null;
      }
    } else {
      record.deleted = true;
    }

    return record;
  },

  async create(record) {
    logger.info(`Store.create called for record: ${record.id}, has value: ${!!record.value}`);
    if (record.id === lazy.SIDEBAR_SYNC_GUID && record.value) {
      logger.info(
        `Record value: ${record.value.workspaces?.length} ws, ${record.value.folders?.length} folders, ${record.value.tabs?.length} tabs`
      );
      await this.applyRemoteData(record.value);
    } else {
      logger.warn(`Store.create: no value in record or wrong id`);
    }
  },

  async remove(record) {
    logger.info(`Store.remove called for record: ${record?.id}`);
  },

  async update(record) {
    logger.info(`Store.update called for record: ${record.id}, has value: ${!!record.value}`);
    if (record.id === lazy.SIDEBAR_SYNC_GUID && record.value) {
      logger.info(
        `Record value: ${record.value.workspaces?.length} ws, ${record.value.folders?.length} folders, ${record.value.tabs?.length} tabs`
      );
      await this.applyRemoteData(record.value);
    } else {
      logger.warn(`Store.update: no value in record or wrong id`);
    }
  },

  async wipe() {
    logger.warn("wipe() called - preserving local data");
  },
};
Object.setPrototypeOf(SidebarSyncStore.prototype, Store.prototype);

// ============== TRACKER ==============

function SidebarSyncTracker(name, engine) {
  Tracker.call(this, name, engine);
  this._ignoreAll = false;
  Svc.Obs.add("profile-before-change", this.asyncObserver);
}

SidebarSyncTracker.prototype = {
  get ignoreAll() {
    return this._ignoreAll;
  },
  set ignoreAll(value) {
    this._ignoreAll = value;
  },

  get modified() {
    return Svc.PrefBranch.getBoolPref("engine.sidebarsync.modified", false);
  },
  set modified(value) {
    Svc.PrefBranch.setBoolPref("engine.sidebarsync.modified", value);
  },

  clearChangedIDs() {
    this.modified = false;
  },

  _markModified(reason) {
    // Check both instance flag and module-level flag
    if (this.ignoreAll || isApplyingRemoteData) {
      return;
    }
    this.score += SCORE_INCREMENT_XLARGE;
    this.modified = true;
    logger.info(`Change: ${reason}`);
  },

  _onTabMove(event) {
    const tab = event.target;
    if (tab.pinned || tab.group?.isZenFolder) {
      this._markModified("TabMove");
    }
  },

  _onTabGroupMoved() {
    this._markModified("TabGroupMoved");
  },

  _onTabGroupUpdate(event) {
    if (event.target?.isZenFolder) {
      this._markModified("TabGroupUpdate");
    }
  },

  _addWindowListeners(win) {
    if (!win.gBrowser || win._zenSidebarSyncListeners) {
      return;
    }
    win._zenSidebarSyncListeners = true;
    win.addEventListener("TabMove", this._boundOnTabMove, true);
    win.addEventListener("TabGroupMoved", this._boundOnTabGroupMoved, true);
    win.addEventListener("TabGroupUpdate", this._boundOnTabGroupUpdate, true);
  },

  _removeWindowListeners(win) {
    if (!win._zenSidebarSyncListeners) {
      return;
    }
    delete win._zenSidebarSyncListeners;
    win.removeEventListener("TabMove", this._boundOnTabMove, true);
    win.removeEventListener("TabGroupMoved", this._boundOnTabGroupMoved, true);
    win.removeEventListener("TabGroupUpdate", this._boundOnTabGroupUpdate, true);
  },

  onStart() {
    Svc.Obs.add("zen-workspaces-changed", this.asyncObserver);
    Svc.Obs.add("zen-folders-changed", this.asyncObserver);
    Svc.Obs.add("zen-pinned-tabs-changed", this.asyncObserver);

    this._boundOnTabMove = this._onTabMove.bind(this);
    this._boundOnTabGroupMoved = this._onTabGroupMoved.bind(this);
    this._boundOnTabGroupUpdate = this._onTabGroupUpdate.bind(this);

    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this._addWindowListeners(win);
    }

    this._windowObserver = {
      tracker: this,
      observe(subject, topic) {
        if (topic === "domwindowopened") {
          subject.addEventListener(
            "load",
            () => {
              if (
                subject.document.documentElement.getAttribute("windowtype") === "navigator:browser"
              ) {
                this.tracker._addWindowListeners(subject);
              }
            },
            { once: true }
          );
        }
      },
    };
    Services.ww.registerNotification(this._windowObserver);
  },

  onStop() {
    Svc.Obs.remove("zen-workspaces-changed", this.asyncObserver);
    Svc.Obs.remove("zen-folders-changed", this.asyncObserver);
    Svc.Obs.remove("zen-pinned-tabs-changed", this.asyncObserver);

    if (this._windowObserver) {
      Services.ww.unregisterNotification(this._windowObserver);
      this._windowObserver = null;
    }

    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this._removeWindowListeners(win);
    }
  },

  async observe(subject, topic) {
    switch (topic) {
      case "profile-before-change":
        await this.stop();
        break;
      case "zen-workspaces-changed":
      case "zen-folders-changed":
      case "zen-pinned-tabs-changed":
        this._markModified(topic);
        break;
    }
  },
};
Object.setPrototypeOf(SidebarSyncTracker.prototype, Tracker.prototype);
