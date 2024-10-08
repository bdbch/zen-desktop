
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

 "use strict";

/* INCLUDE THIS FILE AS:
 *   <script src="chrome://browser/content/zenThemeModifier.js"></script>
 *
 * FOR ANY WEBSITE THAT WOULD NEED TO USE THE ACCENT COLOR, ETC
 */

const kZenThemeAccentColorPref = "zen.theme.accent-color";
const kZenThemeBorderRadiusPref = "zen.theme.border-radius";

/**
* ZenThemeModifier controls the application of theme data to the browser,
* for examplem, it injects the accent color to the document. This is used
* because we need a way to apply the accent color without having to worry about
* shadow roots not inheriting the accent color.
* 
* note: It must be a firefox builtin page with access to the browser's configuration
*  and services.
*/
var ZenThemeModifier = {
  _inMainBrowserWindow: false,

  /**
  * Listen for theming updates from the LightweightThemeChild actor, and
  * begin listening to changes in preferred color scheme.
  */
  init() {
    this._inMainBrowserWindow = window.location.href == "chrome://browser/content/browser.xhtml";
    this.listenForEvents();
    this.updateAllThemeBasics();
    this._onPrefersColorSchemeChange();
  },

  listenForEvents() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this._onPrefersColorSchemeChange.bind(this));

    Services.prefs.addObserver(kZenThemeAccentColorPref, this.handleEvent.bind(this));
    Services.prefs.addObserver(kZenThemeBorderRadiusPref, this.handleEvent.bind(this));
  },

  handleEvent(event) {
    // note: even might be undefined, but we shoudnt use it!
    this.updateAllThemeBasics();
  },

  /**
    * Update all theme basics, like the accent color.
    */
  updateAllThemeBasics() {
    this.updateAccentColor();
    this.updateBorderRadius();
  },

  updateBorderRadius() {
    const borderRadius = Services.prefs.getIntPref(kZenThemeBorderRadiusPref, 4);
    document.documentElement.style.setProperty("--zen-border-radius", borderRadius + "px");
  },

  /**
   * Update the accent color.
   */
  updateAccentColor() {
    const accentColor = Services.prefs.getStringPref(kZenThemeAccentColorPref, "#0b57d0");
    document.documentElement.style.setProperty("--zen-primary-color", accentColor);
    // Notify the page that the accent color has changed, only if a function
    // handler is defined.
    if (typeof window.zenPageAccentColorChanged === "function") {
      window.zenPageAccentColorChanged(accentColor);
    }
  },

  _onPrefersColorSchemeChange() {
    this._updateZenAvatar();
  },

  _updateZenAvatar() {
    if (typeof ProfileService === "undefined") {
      return;
    }
    const mainWindowEl = document.documentElement;
    // Dont override the sync avatar if it's already set
    if (mainWindowEl.style.hasOwnProperty("--avatar-image-url")) {
      return;
    }
    let profile = ProfileService.currentProfile;
    if (!profile || profile.zenAvatarPath == "") return;
    // TODO: actually use profile data to generate the avatar, instead of just using the name
    let avatarUrl = this._getThemedAvatar(profile.zenAvatarPath);
    if (document.documentElement.hasAttribute("privatebrowsingmode")) {
      avatarUrl = "chrome://global/skin/icons/indicator-private-browsing.svg";
    }
    mainWindowEl.style.setProperty("--zen-avatar-image-url", `url(${avatarUrl})`);
    mainWindowEl.style.setProperty("--avatar-image-url", `var(--zen-avatar-image-url)`, "important");
  },

  _getThemedAvatar(avatarPath) {
    if (!avatarPath.startsWith("chrome://browser/content/zen-avatars/avatar-")
      || !avatarPath.endsWith(".svg")) {
      return avatarPath;
    }
    let withoutExtension = avatarPath.slice(0, -4);
    let scheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? "dark" : "light";
    return `${withoutExtension}-${scheme}.svg`;
  },
};

if (typeof Services !== "undefined")
  ZenThemeModifier.init();
