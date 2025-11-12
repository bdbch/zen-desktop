// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

window.gZenOperatingSystemCommonUtils = {
  kZenOSToSmallName: {
    WINNT: 'windows',
    Darwin: 'macos',
    Linux: 'linux',
  },

  get currentOperatingSystem() {
    let os = Services.appinfo.OS;
    return this.kZenOSToSmallName[os];
  },
};

/* eslint-disable no-unused-vars */
class nsZenMultiWindowFeature {
  constructor() {}

  static #windows = new Set();
  static #mainWindow = null;

  static registerWindow(browserWindow) {
    if (!browserWindow || browserWindow.closed) {
      return;
    }

    if (nsZenMultiWindowFeature.#windows.has(browserWindow)) {
      nsZenMultiWindowFeature.#ensureMainWindow();
      return;
    }

    nsZenMultiWindowFeature.#windows.add(browserWindow);

    const onUnload = () => {
      nsZenMultiWindowFeature.#windows.delete(browserWindow);
      if (nsZenMultiWindowFeature.#mainWindow === browserWindow) {
        nsZenMultiWindowFeature.#mainWindow = null;
        nsZenMultiWindowFeature.#promoteNewMainWindow();
      }
    };

    browserWindow.addEventListener('unload', onUnload, { once: true });

    nsZenMultiWindowFeature.#ensureMainWindow();

    if (!nsZenMultiWindowFeature.#mainWindow) {
      nsZenMultiWindowFeature.#setMainWindow(browserWindow);
      return;
    }

    if (nsZenMultiWindowFeature.#mainWindow !== browserWindow) {
      nsZenMultiWindowFeature.#setWindowMode(browserWindow, 'minimal');
    }
  }

  static #ensureMainWindow() {
    if (nsZenMultiWindowFeature.#mainWindow?.closed) {
      nsZenMultiWindowFeature.#mainWindow = null;
    }
    if (!nsZenMultiWindowFeature.#mainWindow && nsZenMultiWindowFeature.#windows.size) {
      nsZenMultiWindowFeature.#promoteNewMainWindow();
    }
  }

  static #promoteNewMainWindow() {
    const candidate = Services.wm.getMostRecentWindow('navigator:browser');
    if (candidate && !candidate.closed && nsZenMultiWindowFeature.#windows.has(candidate)) {
      nsZenMultiWindowFeature.#setMainWindow(candidate);
      return;
    }

    for (const browser of nsZenMultiWindowFeature.#windows) {
      if (!browser.closed) {
        nsZenMultiWindowFeature.#setMainWindow(browser);
        return;
      }
    }
  }

  static #setMainWindow(browserWindow) {
    if (!browserWindow || browserWindow.closed) {
      return;
    }

    if (nsZenMultiWindowFeature.#mainWindow && nsZenMultiWindowFeature.#mainWindow !== browserWindow) {
      nsZenMultiWindowFeature.#setWindowMode(nsZenMultiWindowFeature.#mainWindow, 'minimal');
    }

    nsZenMultiWindowFeature.#mainWindow = browserWindow;
    nsZenMultiWindowFeature.#setWindowMode(browserWindow, 'main');
  }

  static #setWindowMode(browserWindow, mode) {
    if (!browserWindow || browserWindow.closed) {
      return;
    }

    const docEl = browserWindow.document?.documentElement;
    if (!docEl) {
      return;
    }

    let shouldDispatch = false;

    if (mode === 'main') {
      if (docEl.getAttribute('zen-main-window') !== 'true') {
        shouldDispatch = true;
      }
      docEl.setAttribute('zen-main-window', 'true');
      docEl.removeAttribute('zen-minimal-window');
    } else {
      if (!docEl.hasAttribute('zen-minimal-window')) {
        shouldDispatch = true;
      }
      docEl.removeAttribute('zen-main-window');
      docEl.setAttribute('zen-minimal-window', 'true');
    }

    if (shouldDispatch) {
      browserWindow.dispatchEvent(
        new browserWindow.CustomEvent('ZenWindowModeChanged', {
          detail: { mode },
        })
      );
    }
  }

  static get browsers() {
    return Services.wm.getEnumerator('navigator:browser');
  }

  static get currentBrowser() {
    return Services.wm.getMostRecentWindow('navigator:browser');
  }

  static get mainBrowser() {
    nsZenMultiWindowFeature.#ensureMainWindow();
    return nsZenMultiWindowFeature.#mainWindow;
  }

  static get isActiveWindow() {
    return nsZenMultiWindowFeature.currentBrowser === window;
  }

  static isMainWindow(browserWindow = window) {
    nsZenMultiWindowFeature.#ensureMainWindow();
    return nsZenMultiWindowFeature.#mainWindow === browserWindow && !browserWindow.closed;
  }

  static isMinimalWindow(browserWindow = window) {
    if (!browserWindow || browserWindow.closed) {
      return false;
    }
    if (nsZenMultiWindowFeature.isMainWindow(browserWindow)) {
      return false;
    }
    return browserWindow.document?.documentElement?.hasAttribute('zen-minimal-window') ?? false;
  }

  windowIsActive(browser) {
    return browser === nsZenMultiWindowFeature.currentBrowser;
  }

  async foreachWindowAsActive(callback) {
    if (!nsZenMultiWindowFeature.isActiveWindow) {
      return;
    }
    for (const browser of nsZenMultiWindowFeature.browsers) {
      try {
        if (browser.closed) continue;
        await callback(browser);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

/* eslint-disable no-unused-vars */
class nsZenDOMOperatedFeature {
  constructor() {
    var initBound = this.init.bind(this);
    document.addEventListener('DOMContentLoaded', initBound, { once: true });
  }
}

/* eslint-disable no-unused-vars */
class nsZenPreloadedFeature {
  constructor() {
    var initBound = this.init.bind(this);
    document.addEventListener('MozBeforeInitialXULLayout', initBound, { once: true });
  }
}

var gZenCommonActions = {
  copyCurrentURLToClipboard() {
    const [currentUrl, ClipboardHelper] = gURLBar.zenStrippedURI;
    const displaySpec = currentUrl.displaySpec;
    ClipboardHelper.copyString(displaySpec);
    let button;
    if (Services.zen.canShare() && displaySpec.startsWith('http')) {
      button = {
        id: 'zen-copy-current-url-button',
        command: (event) => {
          const buttonRect = event.target.getBoundingClientRect();
          Services.zen.share(
            currentUrl,
            '',
            '',
            buttonRect.left,
            window.innerHeight - buttonRect.bottom,
            buttonRect.width,
            buttonRect.height
          );
        },
      };
    }
    gZenUIManager.showToast('zen-copy-current-url-confirmation', { button, timeout: 3000 });
  },

  copyCurrentURLAsMarkdownToClipboard() {
    const [currentUrl, ClipboardHelper] = gURLBar.zenStrippedURI;
    const tabTitle = gBrowser.selectedTab.label;
    const markdownLink = `[${tabTitle}](${currentUrl.displaySpec})`;
    ClipboardHelper.copyString(markdownLink);
    gZenUIManager.showToast('zen-copy-current-url-confirmation', { timeout: 3000 });
  },

  throttle(f, delay) {
    let timer = 0;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => f.apply(this, args), delay);
    };
  },

  /**
   * Determines if a tab should be closed when navigating back with no history.
   * Only tabs with an owner that are not pinned and not empty are eligible.
   * Respects the user preference zen.tabs.close-on-back-with-no-history.
   *
   * @return {boolean} True if the tab should be closed on back
   */
  shouldCloseTabOnBack() {
    if (!Services.prefs.getBoolPref('zen.tabs.close-on-back-with-no-history', true)) {
      return false;
    }
    const tab = gBrowser.selectedTab;
    return Boolean(tab.owner && !tab.pinned && !tab.hasAttribute('zen-empty-tab'));
  },
};
