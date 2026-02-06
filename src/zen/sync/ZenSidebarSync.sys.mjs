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
const PREF_ENGINE_ENABLED = "services.sync.engine.sidebarsync";
const PREF_ENGINE_MODIFIED = "engine.sidebarsync.modified";
const PREF_KNOWN_REMOTE_IDS = "engine.sidebarsync.knownRemoteIds";
const PREF_BOOTSTRAP_COMPLETE = "engine.sidebarsync.bootstrapComplete";
const PREF_BOOTSTRAP_FORCE_UPLOAD = "engine.sidebarsync.bootstrapForceUpload";
const PREF_RESTORE_SKIP_INCOMING_ONCE = "engine.sidebarsync.restoreSkipIncomingOnce";
const PREF_DEBUG_LOG = "zen.sidebarsync.debug";
const PREF_TESTONLY = "zen.sidebarsync.testonly";

const COLLECT_READY_TIMEOUT_MS = 2000;
const APPLY_READY_TIMEOUT_MS = 5000;
const CURRENT_SCHEMA_VERSION = 2;
const KNOWN_REMOTE_IDS_VERSION = 1;
const KNOWN_REMOTE_SOURCE_REMOTE = "remote";
const KNOWN_REMOTE_SOURCE_LEGACY = "legacy";
const MIN_KNOWN_FOR_SHRINK_GUARD = 4;
const SHRINK_RATIO = 0.25;
const INVALID_CUTOFF_MIN_COUNT = 3;
const INVALID_CUTOFF_RATIO = 0.2;

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

function isSidebarSyncEngineEnabled() {
  return Services.prefs.getBoolPref(PREF_ENGINE_ENABLED, true);
}

function resetSidebarSyncBookkeepingOnDisable() {
  Svc.PrefBranch.setBoolPref(PREF_ENGINE_MODIFIED, false);
  Svc.PrefBranch.setBoolPref(PREF_BOOTSTRAP_COMPLETE, false);
  Svc.PrefBranch.setBoolPref(PREF_BOOTSTRAP_FORCE_UPLOAD, false);
  Svc.PrefBranch.setBoolPref(PREF_RESTORE_SKIP_INCOMING_ONCE, false);

  if (Svc.PrefBranch.prefHasUserValue(PREF_KNOWN_REMOTE_IDS)) {
    Svc.PrefBranch.clearUserPref(PREF_KNOWN_REMOTE_IDS);
  }

  logger.info("Engine disabled: local sidebar data preserved; bookkeeping reset");
}

const sidebarSyncPrefStateObserver = {
  _initialized: false,
  _lastEnabled: true,

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
    this._lastEnabled = isSidebarSyncEngineEnabled();
    Services.prefs.addObserver(PREF_ENGINE_ENABLED, this);
    Services.obs.addObserver(this, "profile-before-change");

    if (!this._lastEnabled) {
      resetSidebarSyncBookkeepingOnDisable();
    }
  },

  shutdown() {
    if (!this._initialized) {
      return;
    }

    this._initialized = false;
    Services.prefs.removeObserver(PREF_ENGINE_ENABLED, this);
    Services.obs.removeObserver(this, "profile-before-change");
  },

  observe(_subject, topic, data) {
    if (topic === "profile-before-change") {
      this.shutdown();
      return;
    }

    if (topic !== "nsPref:changed" || data !== PREF_ENGINE_ENABLED) {
      return;
    }

    const enabled = isSidebarSyncEngineEnabled();
    const wasEnabled = this._lastEnabled;
    if (enabled === wasEnabled) {
      return;
    }

    this._lastEnabled = enabled;
    if (!enabled && wasEnabled) {
      resetSidebarSyncBookkeepingOnDisable();
      return;
    }

    if (enabled && !wasEnabled) {
      logger.info("Engine enabled: waiting for bootstrap policy");
    }
  },
};

sidebarSyncPrefStateObserver.init();

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
    if (!isSidebarSyncEngineEnabled()) {
      logGating("getChangedIDs: skipping upload (engine disabled)");
      return changedIDs;
    }

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
    if (!isSidebarSyncEngineEnabled()) {
      logGating(`Reconcile: rejecting record ${item.id} (engine disabled)`);
      return false;
    }

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

  _isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
  },

  _normalizeNullableString(value) {
    return typeof value === "string" ? value : null;
  },

  _normalizeFiniteNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  },

  _normalizeBoolean(value, fallback = false) {
    return typeof value === "boolean" ? value : fallback;
  },

  _normalizeRemoteWorkspaceEntry(workspace) {
    if (!workspace || typeof workspace !== "object") {
      return null;
    }

    if (
      !this._isNonEmptyString(workspace.id) ||
      !this._isNonEmptyString(workspace.name) ||
      !Number.isFinite(workspace.position)
    ) {
      return null;
    }

    return {
      id: workspace.id,
      name: workspace.name,
      position: workspace.position,
      containerTabId: this._normalizeFiniteNumber(workspace.containerTabId, 0),
      icon: this._normalizeNullableString(workspace.icon),
      theme: this._normalizeNullableString(workspace.theme),
      isDefault: this._normalizeBoolean(workspace.isDefault, false),
      lastModified: Number.isFinite(workspace.lastModified) ? workspace.lastModified : 0,
    };
  },

  _normalizeRemoteFolderEntry(folder) {
    if (!folder || typeof folder !== "object") {
      return null;
    }

    if (!this._isNonEmptyString(folder.id)) {
      return null;
    }

    return {
      id: folder.id,
      name: typeof folder.name === "string" ? folder.name : "",
      position: this._normalizeFiniteNumber(folder.position, 0),
      workspaceId: this._normalizeNullableString(folder.workspaceId),
      parentId: this._normalizeNullableString(folder.parentId),
      collapsed: this._normalizeBoolean(folder.collapsed, false),
      icon: this._normalizeNullableString(folder.icon),
      lastModified: Number.isFinite(folder.lastModified) ? folder.lastModified : 0,
    };
  },

  _normalizeRemoteTabEntry(tab, schemaVersion = 1) {
    if (!tab || typeof tab !== "object") {
      return null;
    }

    if (!this._isNonEmptyString(tab.id) || !this._isNonEmptyString(tab.url)) {
      return null;
    }

    if (tab.url.startsWith("about:")) {
      return null;
    }

    const isEssential = this._normalizeBoolean(tab.isEssential, false);
    let workspaceId = null;
    if (!isEssential) {
      if (!this._isNonEmptyString(tab.workspaceId)) {
        return null;
      }
      workspaceId = tab.workspaceId;
    }

    const normalized = {
      id: tab.id,
      url: tab.url,
      position: this._normalizeFiniteNumber(tab.position, 0),
      isEssential,
      folderId: this._normalizeNullableString(tab.folderId),
      label: this._normalizeNullableString(tab.label),
      workspaceId,
      isPinned: this._normalizeBoolean(tab.isPinned, true),
      icon: this._normalizeNullableString(tab.icon),
      lastModified: Number.isFinite(tab.lastModified) ? tab.lastModified : 0,
      essentialContainerId: 0,
    };

    if (schemaVersion >= 2) {
      normalized.essentialContainerId = this._normalizeFiniteNumber(tab.essentialContainerId, 0);
    }

    return normalized;
  },

  _validateAndNormalizeRemoteType(type, entries, schemaVersion = 1) {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    const totalCount = normalizedEntries.length;
    const seenIds = new Set();
    const valid = [];
    let invalidCount = 0;
    let duplicateCount = 0;

    for (const entry of normalizedEntries) {
      let normalized = null;
      if (type === "workspaces") {
        normalized = this._normalizeRemoteWorkspaceEntry(entry);
      } else if (type === "folders") {
        normalized = this._normalizeRemoteFolderEntry(entry);
      } else {
        normalized = this._normalizeRemoteTabEntry(entry, schemaVersion);
      }

      if (!normalized) {
        invalidCount++;
        continue;
      }

      if (seenIds.has(normalized.id)) {
        duplicateCount++;
        continue;
      }

      seenIds.add(normalized.id);
      valid.push(normalized);
    }

    if (duplicateCount > 0) {
      logDeletionGuard(`${type}: dropped duplicate IDs=${duplicateCount}`);
    }

    if (invalidCount > 0) {
      logDeletionGuard(`${type}: dropped invalid entries=${invalidCount}/${totalCount}`);
    }

    const invalidRate = totalCount > 0 ? invalidCount / totalCount : 0;
    const skippedByInvalidCutoff =
      invalidCount >= INVALID_CUTOFF_MIN_COUNT && invalidRate > INVALID_CUTOFF_RATIO;

    if (skippedByInvalidCutoff) {
      logDeletionGuard(
        `${type}: invalid payload cutoff hit (invalid=${invalidCount}, total=${totalCount}, ratio=${invalidRate.toFixed(
          3
        )})`
      );
    }

    return {
      valid: skippedByInvalidCutoff ? [] : valid,
      invalidCount,
      duplicateCount,
      totalCount,
      skippedByInvalidCutoff,
    };
  },

  _getValidRemoteWorkspaces(remoteWorkspaces = []) {
    return this._validateAndNormalizeRemoteType("workspaces", remoteWorkspaces, 1).valid;
  },

  _getValidRemoteFolders(remoteFolders = []) {
    return this._validateAndNormalizeRemoteType("folders", remoteFolders, 1).valid;
  },

  _getValidRemoteTabs(remoteTabs = []) {
    return this._validateAndNormalizeRemoteType("tabs", remoteTabs, CURRENT_SCHEMA_VERSION).valid;
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
    if (!isSidebarSyncEngineEnabled()) {
      logGating("collectSyncData: skipping upload (engine disabled)");
      return null;
    }

    const win = await getEligibleSyncWindow({ timeoutMs: COLLECT_READY_TIMEOUT_MS });
    if (!win) {
      logGating("collectSyncData: skipping upload (no eligible ready window)");
      return null;
    }

    const now = Date.now();

    const data = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
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

    if (!isSidebarSyncEngineEnabled()) {
      logGating("applyRemoteData: skipping apply (engine disabled)");
      return;
    }

    if (!remoteData || typeof remoteData !== "object" || Array.isArray(remoteData)) {
      logger.warn("Skipping apply: invalid root payload (expected object)");
      return;
    }

    const schemaVersion = Number.isFinite(remoteData.schemaVersion) ? remoteData.schemaVersion : 1;
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      logDeletionGuard(
        `SCHEMA_UNSUPPORTED: schemaVersion=${schemaVersion} > current=${CURRENT_SCHEMA_VERSION}`
      );
      logger.warn(`Skipping apply: unsupported schemaVersion=${schemaVersion}`);
      return;
    }

    const normalizedRemoteData = {
      workspaces: Array.isArray(remoteData.workspaces) ? remoteData.workspaces : [],
      folders: Array.isArray(remoteData.folders) ? remoteData.folders : [],
      tabs: Array.isArray(remoteData.tabs) ? remoteData.tabs : [],
    };

    const win = await getEligibleSyncWindow({ timeoutMs: APPLY_READY_TIMEOUT_MS });
    if (!win) {
      logGating("applyRemoteData: skipping apply (no eligible ready window)");
      return;
    }

    // Get last successfully applied remote snapshot.
    const knownRemoteIds = this._getKnownRemoteIds();

    const workspaceValidation = this._validateAndNormalizeRemoteType(
      "workspaces",
      normalizedRemoteData.workspaces,
      schemaVersion
    );
    const folderValidation = this._validateAndNormalizeRemoteType(
      "folders",
      normalizedRemoteData.folders,
      schemaVersion
    );
    const tabValidation = this._validateAndNormalizeRemoteType(
      "tabs",
      normalizedRemoteData.tabs,
      schemaVersion
    );

    const validRemoteData = {
      workspaces: workspaceValidation.valid,
      folders: folderValidation.valid,
      tabs: tabValidation.valid,
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

    if (workspaceValidation.skippedByInvalidCutoff) {
      logDeletionGuard("workspaces: skipping apply due to invalid-rate cutoff");
      applyPolicies.workspaces = {
        ...applyPolicies.workspaces,
        allowDeletion: false,
        updateKnown: false,
        skipApply: true,
        invalidPayload: true,
      };
    }
    if (folderValidation.skippedByInvalidCutoff) {
      logDeletionGuard("folders: skipping apply due to invalid-rate cutoff");
      applyPolicies.folders = {
        ...applyPolicies.folders,
        allowDeletion: false,
        updateKnown: false,
        skipApply: true,
        invalidPayload: true,
      };
    }
    if (tabValidation.skippedByInvalidCutoff) {
      logDeletionGuard("tabs: skipping apply due to invalid-rate cutoff");
      applyPolicies.tabs = {
        ...applyPolicies.tabs,
        allowDeletion: false,
        updateKnown: false,
        skipApply: true,
        invalidPayload: true,
      };
    }

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
      let workspacesApplied = true;
      if (applyPolicies.workspaces.skipApply) {
        workspacesApplied = false;
      } else {
        workspacesApplied =
          (await this.applyWorkspaces(
            validRemoteData.workspaces,
            win,
            applyPolicies.workspaces
          )) !== false;
      }

      let folderMap = new Map();
      let remoteFoldersForLayout = validRemoteData.folders;
      let foldersApplied = true;
      if (applyPolicies.folders.skipApply) {
        foldersApplied = false;
      } else {
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
          if (Array.isArray(folderResult.remoteFolders)) {
            remoteFoldersForLayout = folderResult.remoteFolders;
          }
          foldersApplied = folderResult.success !== false;
        }
      }

      let tabMap = new Map();
      let tabsApplied = true;
      if (applyPolicies.tabs.skipApply) {
        tabsApplied = false;
      } else {
        const tabResult = await this.applyTabs(
          validRemoteData.tabs,
          win,
          applyPolicies.tabs,
          folderMap
        );
        if (tabResult instanceof Map) {
          tabMap = tabResult;
        } else if (tabResult === false) {
          tabsApplied = false;
        } else if (tabResult && typeof tabResult === "object") {
          if (tabResult.tabMap instanceof Map) {
            tabMap = tabResult.tabMap;
          }
          tabsApplied = tabResult.success !== false;
        }
      }

      const hasLayoutMaps = folderMap.size > 0 || tabMap.size > 0;
      if ((foldersApplied || tabsApplied) && hasLayoutMaps) {
        const layoutRemoteData = {
          ...validRemoteData,
          folders: remoteFoldersForLayout,
        };

        await this.positionMixedTopLevelItems(layoutRemoteData, win, folderMap, tabMap, {
          includeFolders: foldersApplied,
          includeTabs: tabsApplied,
        });

        this.positionMixedNestedFolderItems(layoutRemoteData, win, folderMap, tabMap, {
          includeFolders: foldersApplied,
          includeTabs: tabsApplied,
        });
      }

      const updateTypes = {
        workspaces: applyPolicies.workspaces.updateKnown && workspacesApplied,
        folders: applyPolicies.folders.updateKnown && foldersApplied,
        tabs: applyPolicies.tabs.updateKnown && tabsApplied,
      };

      if (updateTypes.workspaces || updateTypes.folders || updateTypes.tabs) {
        this._updateKnownRemoteIds(validRemoteData, {
          previousKnown: knownRemoteIds,
          updateTypes,
        });
      } else {
        logDeletionGuard("knownRemoteIds: skipping update (no types eligible)");
      }
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
          processFolder(item, childPosition, folder.id);
        }
        if (item.isZenFolder || win.gBrowser.isTab(item)) {
          childPosition++;
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
      tabs.push(this.syncTab(tab, position, folderId, timestamp, win));
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
  syncTab(tab, position, folderId, timestamp, win) {
    const isEssential = tab.hasAttribute("zen-essential");

    let essentialContainerId = 0;
    if (isEssential && win?.gZenWorkspaces?.containerSpecificEssentials) {
      const rawContainerId = tab.getAttribute("usercontextid") ?? tab.userContextId ?? 0;
      const parsedContainerId = Number(rawContainerId);
      essentialContainerId = Number.isFinite(parsedContainerId) ? parsedContainerId : 0;
    }

    const syncedTab = {
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

    if (isEssential) {
      syncedTab.essentialContainerId = essentialContainerId;
    }

    return syncedTab;
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
      const validRemote = Array.isArray(remoteWorkspaces) ? remoteWorkspaces : [];
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
    const compareFolders = (a, b) => {
      const byPosition =
        this._normalizeFiniteNumber(a.position, 0) - this._normalizeFiniteNumber(b.position, 0);
      if (byPosition !== 0) {
        return byPosition;
      }
      return a.id.localeCompare(b.id);
    };

    const allFolders = Array.isArray(folders) ? folders : [];
    const folderMap = new Map(allFolders.map((folder) => [folder.id, folder]));
    const childrenByParent = new Map();

    const pushChild = (parentId, folder) => {
      const key = parentId ?? null;
      if (!childrenByParent.has(key)) {
        childrenByParent.set(key, []);
      }
      childrenByParent.get(key).push(folder);
    };

    for (const folder of allFolders) {
      const parentId = folder.parentId && folderMap.has(folder.parentId) ? folder.parentId : null;
      pushChild(parentId, folder);
    }

    for (const children of childrenByParent.values()) {
      children.sort(compareFolders);
    }

    const result = [];
    const visited = new Set();
    const visit = (folder) => {
      if (!folder || visited.has(folder.id)) {
        return;
      }
      visited.add(folder.id);
      result.push(folder);

      const children = childrenByParent.get(folder.id) || [];
      for (const child of children) {
        visit(child);
      }
    };

    for (const root of childrenByParent.get(null) || []) {
      visit(root);
    }

    // Safety fallback for any disconnected/unreachable node.
    for (const folder of [...allFolders].sort(compareFolders)) {
      visit(folder);
    }

    return result;
  },

  _sanitizeRemoteFolderGraph(remoteFolders) {
    const sanitized = (Array.isArray(remoteFolders) ? remoteFolders : []).map((folder) => ({
      ...folder,
    }));
    const folderMap = new Map(sanitized.map((folder) => [folder.id, folder]));

    for (const folder of sanitized) {
      if (folder.parentId && !folderMap.has(folder.parentId)) {
        logGating(
          `folders: parent missing id=${folder.id} parentId=${folder.parentId}, promoting to top-level`
        );
        folder.parentId = null;
      }
    }

    const stateById = new Map();
    const stack = [];
    const stackIndexById = new Map();

    const breakCycle = (cycleIds) => {
      if (!cycleIds.length) {
        return;
      }

      let breakId = cycleIds[0];
      for (const id of cycleIds) {
        if (id.localeCompare(breakId) < 0) {
          breakId = id;
        }
      }

      const folderToPromote = folderMap.get(breakId);
      if (!folderToPromote || folderToPromote.parentId == null) {
        return;
      }

      logGating(`folders: cycle detected [${cycleIds.join(",")}] -> break id=${breakId}`);
      folderToPromote.parentId = null;
    };

    const visit = (folderId) => {
      const state = stateById.get(folderId) || 0;
      if (state === 2) {
        return;
      }
      if (state === 1) {
        const startIndex = stackIndexById.get(folderId);
        if (Number.isInteger(startIndex) && startIndex >= 0) {
          breakCycle(stack.slice(startIndex));
        }
        return;
      }

      stateById.set(folderId, 1);
      stackIndexById.set(folderId, stack.length);
      stack.push(folderId);

      const folder = folderMap.get(folderId);
      const parentId = folder?.parentId;
      if (parentId && folderMap.has(parentId)) {
        const parentState = stateById.get(parentId) || 0;
        if (parentState === 1) {
          const startIndex = stackIndexById.get(parentId);
          if (Number.isInteger(startIndex) && startIndex >= 0) {
            breakCycle(stack.slice(startIndex));
          }
        } else {
          visit(parentId);
        }
      }

      stack.pop();
      stackIndexById.delete(folderId);
      stateById.set(folderId, 2);
    };

    for (const folderId of [...folderMap.keys()].sort((a, b) => a.localeCompare(b))) {
      visit(folderId);
    }

    return sanitized;
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

      const validRemote = Array.isArray(remoteFolders) ? remoteFolders : [];
      const sanitizedRemote = this._sanitizeRemoteFolderGraph(validRemote);
      const remoteById = new Map(sanitizedRemote.map((f) => [f.id, f]));
      const knownRemoteSet = new Set(this._normalizeKnownIdList(deletionPolicy.knownIds));

      // Topological sort: parents before children
      // This ensures nested folders are created in the right order
      const sortedRemote = this._topologicalSortFolders(sanitizedRemote);

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

      return { folderMap: localById, remoteFolders: sanitizedRemote, success: true };
    } catch (e) {
      logger.error(`Failed to apply folders: ${e.message}`);
      console.error(e);
      return { folderMap: new Map(), remoteFolders: [], success: false };
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

      const validRemote = Array.isArray(remoteTabs) ? remoteTabs : [];

      const remoteById = new Map(validRemote.map((t) => [t.id, t]));
      const knownRemoteSet = new Set(this._normalizeKnownIdList(deletionPolicy.knownIds));

      const changes = { created: [], updated: [], deleted: [], kept: [] };

      // CREATE or UPDATE tabs
      for (const remote of validRemote) {
        let tab = localById.get(remote.id);
        let matchedByUrl = false;

        // URL fallback match
        if (!tab) {
          for (const t of win.gBrowser.tabs) {
            if (t.linkedBrowser?.currentURI?.spec === remote.url && !localById.has(t.id)) {
              tab = t;
              matchedByUrl = true;
              break;
            }
          }
        }

        if (tab && matchedByUrl) {
          const existingWithRemoteId = win.document.getElementById(remote.id);
          if (!existingWithRemoteId || existingWithRemoteId === tab) {
            const previousId = tab.id;
            if (previousId !== remote.id) {
              tab.id = remote.id;
              if (this._isNonEmptyString(previousId) && previousId !== remote.id) {
                localById.delete(previousId);
              }
            }
            logGating(`tabs: url fallback matched id=${remote.id}, reusing local tab`);
          } else {
            logGating(`tabs: url fallback collision id=${remote.id}, creating new tab`);
            tab = null;
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

      // Position non-top-level tabs (folder/essentials only).
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
      return { tabMap: localById, success: true };
    } catch (e) {
      logger.error(`Failed to apply tabs: ${e.message}`);
      console.error(e);
      return { tabMap: new Map(), success: false };
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
      zenForcedSyncId: remote.id,
      zenWorkspaceId: remote.workspaceId,
      essential: remote.isEssential,
    };

    const tab = win.gBrowser.addTab(remote.url, options);

    if (this._isNonEmptyString(remote.id)) {
      const existingWithRemoteId = win.document.getElementById(remote.id);
      if (!existingWithRemoteId || existingWithRemoteId === tab) {
        tab.id = remote.id;
      }
    }

    // Apply other properties
    this.applyTab(remote, tab, win);

    return tab;
  },

  /**
   * Apply remote data to an existing tab.
   */
  applyTab(remote, tab, win) {
    if (!tab.pinned) {
      win.gBrowser.pinTab(tab);
    }

    // Essential state
    if (remote.isEssential) {
      tab.setAttribute("zen-essential", "true");
      tab.removeAttribute("zen-workspace-id");
    } else {
      tab.removeAttribute("zen-essential");
      if (this._isNonEmptyString(remote.workspaceId)) {
        tab.setAttribute("zen-workspace-id", remote.workspaceId);
      } else {
        tab.removeAttribute("zen-workspace-id");
      }
    }

    // Label
    if (this._isNonEmptyString(remote.label)) {
      tab._zenChangeLabelFlag = true;
      try {
        tab.zenStaticLabel = remote.label;
        win.gBrowser._setTabLabel(tab, remote.label);
      } finally {
        delete tab._zenChangeLabelFlag;
      }
    }

    // Icon
    if (this._isNonEmptyString(remote.icon)) {
      tab.zenStaticIcon = remote.icon;
      tab.setAttribute("image", remote.icon);
      if (remote.isEssential) {
        win.gZenPinnedTabManager?.setEssentialTabIcon?.(tab, remote.icon);
      }
    }
  },

  _compareMixedLayoutItems(a, b) {
    const byPosition = a.position - b.position;
    if (byPosition !== 0) {
      return byPosition;
    }

    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }

    return a.id.localeCompare(b.id);
  },

  _buildMixedLayout(remoteData, workspaceId, options = {}) {
    const includeFolders = options.includeFolders !== false;
    const includeTabs = options.includeTabs !== false;
    const items = [];

    if (includeFolders) {
      for (const folder of remoteData.folders || []) {
        if (folder.workspaceId === workspaceId && folder.parentId == null) {
          items.push({
            kind: "folder",
            id: folder.id,
            workspaceId,
            position: this._normalizeFiniteNumber(folder.position, 0),
          });
        }
      }
    }

    if (includeTabs) {
      for (const tab of remoteData.tabs || []) {
        if (!tab.isEssential && tab.workspaceId === workspaceId && tab.folderId == null) {
          items.push({
            kind: "tab",
            id: tab.id,
            workspaceId,
            position: this._normalizeFiniteNumber(tab.position, 0),
          });
        }
      }
    }

    items.sort((a, b) => this._compareMixedLayoutItems(a, b));
    return items;
  },

  _ensureWorkspaceItemNode(item, win, remoteById, folderMap, tabMap) {
    if (item.kind === "folder") {
      let folder = folderMap.get(item.id) || win.document.getElementById(item.id);
      if (!folder) {
        const remoteFolder = remoteById.folders.get(item.id);
        if (!remoteFolder) {
          logGating(`mixed-ordering: missing remote folder id=${item.id}`);
          return null;
        }
        folder = this.createFolder(remoteFolder, win, folderMap);
      }
      if (folder) {
        folderMap.set(item.id, folder);
      }
      return folder;
    }

    let tab = tabMap.get(item.id) || win.document.getElementById(item.id);
    if (!tab) {
      const remoteTab = remoteById.tabs.get(item.id);
      if (!remoteTab) {
        logGating(`mixed-ordering: missing remote tab id=${item.id}`);
        return null;
      }
      tab = this.createTab(remoteTab, win);
    }

    if (tab) {
      tabMap.set(item.id, tab);
    }
    return tab;
  },

  async _applyMixedLayoutForWorkspace(win, container, layout, remoteById, folderMap, tabMap) {
    const separator = container.querySelector(".pinned-tabs-container-separator");
    const firstReference = separator || null;
    let previousNode = null;

    for (const item of layout) {
      const node = this._ensureWorkspaceItemNode(item, win, remoteById, folderMap, tabMap);
      if (!node) {
        logGating(`mixed-ordering: skipping unresolved ${item.kind} id=${item.id}`);
        continue;
      }

      if (previousNode) {
        previousNode.after(node);
      } else {
        container.insertBefore(node, firstReference);
      }

      previousNode = node;
    }
  },

  async positionMixedTopLevelItems(
    remoteData,
    win,
    folderMap = new Map(),
    tabMap = new Map(),
    options = {}
  ) {
    const includeFolders = options.includeFolders !== false;
    const includeTabs = options.includeTabs !== false;
    const workspaceIds = [];
    const seenWorkspaceIds = new Set();

    const sortedRemoteWorkspaces = [...(remoteData.workspaces || [])].sort((a, b) =>
      this._compareMixedLayoutItems(
        { kind: "folder", id: a.id, position: this._normalizeFiniteNumber(a.position, 0) },
        { kind: "folder", id: b.id, position: this._normalizeFiniteNumber(b.position, 0) }
      )
    );

    for (const workspace of sortedRemoteWorkspaces) {
      if (!this._isNonEmptyString(workspace.id) || seenWorkspaceIds.has(workspace.id)) {
        continue;
      }
      seenWorkspaceIds.add(workspace.id);
      workspaceIds.push(workspace.id);
    }

    if (includeFolders) {
      for (const folder of remoteData.folders || []) {
        if (
          !this._isNonEmptyString(folder.workspaceId) ||
          seenWorkspaceIds.has(folder.workspaceId)
        ) {
          continue;
        }
        seenWorkspaceIds.add(folder.workspaceId);
        workspaceIds.push(folder.workspaceId);
      }
    }

    if (includeTabs) {
      for (const tab of remoteData.tabs || []) {
        if (
          tab.isEssential ||
          tab.folderId != null ||
          !this._isNonEmptyString(tab.workspaceId) ||
          seenWorkspaceIds.has(tab.workspaceId)
        ) {
          continue;
        }
        seenWorkspaceIds.add(tab.workspaceId);
        workspaceIds.push(tab.workspaceId);
      }
    }

    const remoteById = {
      folders: new Map((remoteData.folders || []).map((folder) => [folder.id, folder])),
      tabs: new Map((remoteData.tabs || []).map((tab) => [tab.id, tab])),
    };

    for (const workspaceId of workspaceIds) {
      const wsElem = win.gZenWorkspaces.workspaceElement(workspaceId);
      const container = wsElem?.pinnedTabsContainer || win.gZenWorkspaces.pinnedTabsContainer;
      if (!container) {
        continue;
      }

      const layout = this._buildMixedLayout(remoteData, workspaceId, {
        includeFolders,
        includeTabs,
      });
      if (!layout.length) {
        continue;
      }

      await this._applyMixedLayoutForWorkspace(
        win,
        container,
        layout,
        remoteById,
        folderMap,
        tabMap
      );
    }

    win.gBrowser.tabContainer._invalidateCachedTabs?.();
  },

  _buildNestedFolderMixedLayout(remoteData, folderId, options = {}) {
    const includeFolders = options.includeFolders !== false;
    const includeTabs = options.includeTabs !== false;
    const items = [];

    if (includeFolders) {
      for (const folder of remoteData.folders || []) {
        if (folder.parentId === folderId) {
          items.push({
            kind: "folder",
            id: folder.id,
            position: this._normalizeFiniteNumber(folder.position, 0),
          });
        }
      }
    }

    if (includeTabs) {
      for (const tab of remoteData.tabs || []) {
        if (tab.folderId === folderId) {
          items.push({
            kind: "tab",
            id: tab.id,
            position: this._normalizeFiniteNumber(tab.position, 0),
          });
        }
      }
    }

    items.sort((a, b) => this._compareMixedLayoutItems(a, b));
    return items;
  },

  positionMixedNestedFolderItems(
    remoteData,
    win,
    folderMap = new Map(),
    tabMap = new Map(),
    options = {}
  ) {
    const sortedFolders = this._topologicalSortFolders(remoteData.folders || []);

    for (const remoteFolder of sortedFolders) {
      const folderElement =
        folderMap.get(remoteFolder.id) || win.document.getElementById(remoteFolder.id);
      if (!folderElement) {
        logGating(`nested-ordering: folder not found id=${remoteFolder.id}`);
        continue;
      }

      const layout = this._buildNestedFolderMixedLayout(remoteData, remoteFolder.id, options);
      if (!layout.length) {
        continue;
      }

      const groupContainer = folderElement.groupContainer;
      if (!groupContainer) {
        logGating(`nested-ordering: missing groupContainer id=${remoteFolder.id}`);
        continue;
      }

      const emptyTab = folderElement.tabs?.find((tab) => tab.hasAttribute("zen-empty-tab")) || null;
      if (!emptyTab) {
        logGating(`nested-ordering: missing empty tab id=${remoteFolder.id}`);
      }

      let previousNode = emptyTab;
      for (const item of layout) {
        const node =
          item.kind === "folder"
            ? folderMap.get(item.id) || win.document.getElementById(item.id)
            : tabMap.get(item.id) || win.document.getElementById(item.id);

        if (!node) {
          logGating(`nested-ordering: missing child ${item.kind} id=${item.id}`);
          continue;
        }

        if (previousNode) {
          previousNode.after(node);
        } else {
          groupContainer.insertBefore(node, groupContainer.firstChild);
        }
        previousNode = node;
      }
    }

    win.gBrowser.tabContainer._invalidateCachedTabs?.();
  },

  /**
   * Position non-top-level tabs according to remote positions.
   * This handles moving tabs to folder and essentials containers.
   */
  positionTabs(remoteTabs, localById, win, folderMap = new Map()) {
    // Group by non-top-level container only.
    const byContainer = new Map();
    for (const remote of remoteTabs) {
      if (!remote.isEssential && !remote.folderId) {
        continue;
      }

      let key;
      if (remote.isEssential) {
        const cid = Number.isFinite(remote.essentialContainerId) ? remote.essentialContainerId : 0;
        key = `essentials:${cid}`;
      } else {
        key = `folder:${remote.folderId}`;
      }

      if (!byContainer.has(key)) {
        byContainer.set(key, []);
      }
      byContainer.get(key).push(remote);
    }

    // Position each container's tabs.
    for (const [containerId, tabs] of byContainer) {
      tabs.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

      // Get container element.
      let container;
      let isFolder = false;
      if (containerId === "essentials" || containerId.startsWith("essentials:")) {
        const cid = containerId.startsWith("essentials:")
          ? Number(containerId.slice("essentials:".length))
          : 0;
        const normalizedContainerId = Number.isFinite(cid) ? cid : 0;
        container = win.gZenWorkspaces?.getEssentialsSection?.(normalizedContainerId);
      } else if (containerId.startsWith("folder:")) {
        const folderId = containerId.replace("folder:", "");
        // Use folderMap first (more reliable), fallback to getElementById.
        container = folderMap.get(folderId) || win.document.getElementById(folderId);
        isFolder = true;
        if (!container) {
          logger.warn(`Folder ${folderId} not found for tab positioning`);
        }
      }

      if (!container) {
        continue;
      }

      // Collect tab elements in correct order.
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

      // For folders, add all tabs to the folder first.
      if (isFolder && container.addTabs) {
        // Filter to tabs not already in this folder.
        const tabsToAdd = orderedTabs.filter((tab) => tab.group !== container);
        if (tabsToAdd.length) {
          container.addTabs(tabsToAdd);
        }
      }

      // Find insert point (after empty tab for folders, or at start).
      let insertPoint = null;
      let positionContainer = container;

      if (isFolder) {
        // For folders, tabs are inside groupContainer.
        positionContainer = container.groupContainer;
        const emptyTab = container.tabs?.find((t) => t.hasAttribute("zen-empty-tab"));
        insertPoint = emptyTab || null;
      }

      // Position first tab.
      const firstTab = orderedTabs[0];
      if (insertPoint) {
        insertPoint.after(firstTab);
      } else {
        positionContainer.insertBefore(firstTab, positionContainer.firstChild);
      }

      // Position subsequent tabs after the previous one.
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
    return Svc.PrefBranch.getBoolPref(PREF_ENGINE_MODIFIED, false);
  },
  set modified(value) {
    Svc.PrefBranch.setBoolPref(PREF_ENGINE_MODIFIED, value);
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
