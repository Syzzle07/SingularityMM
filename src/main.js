import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { basename, join, resolveResource, appDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

// --- IMPORT ASSETS ---
import iconSteam from './assets/icon-steam.png';
import iconGog from './assets/icon-gog.png';
import iconXbox from './assets/icon-xbox.png';
import iconNexus from './assets/icon-nexus.png';

// Get the window instance for listener attachment
const appWindow = getCurrentWindow();

// --- Global State & Constants ---
let NEXUS_API_KEY = "";
const CURATED_LIST_URL = "https://raw.githubusercontent.com/Syzzle07/SingularityMM/refs/heads/data/curated/curated_list.json";
let curatedData = [];
let downloadHistory = [];
const nexusFileCache = new Map();

const DEFAULT_WIDTH = 950;
const PANEL_OPEN_WIDTH = 1300;
let isPanelOpen = false;
const SCROLL_SPEED = 5;
const CACHE_DURATION_MS = 60 * 60 * 1000;

document.addEventListener('DOMContentLoaded', () => {

  // --- Application & UI State ---
  const appState = {
    gamePath: null,
    settingsPath: null,
    versionType: null,
    currentFilePath: null,
    activeProfile: 'Default',
    selectedProfileView: 'Default',
    currentPage: 1,
    modsPerPage: 20,
    nexusUsername: null,
    isProfileSwitching: false,
    xmlDoc: null,
    isPopulating: false,
    currentTranslations: {},
    selectedModRow: null,
    installedModsMap: new Map(),
    modDataCache: new Map(),
    selectedModNames: new Set(),
    selectedDownloadIds: new Set(),
  };

  const dragState = {
    draggedElement: null,
    ghostElement: null,
    placeholder: null,
    offsetX: 0,
    offsetY: 0,
    originalNextSibling: null,
    dragTimer: null,
    selectedModNameBeforeDrag: null,
  };

  const scrollState = {
    isScrollingUp: false,
    isScrollingDown: false,
    animationFrameId: null
  };

  let contextMenu = null;

  const downloadSortState = {
    key: 'date',
    direction: 'desc'
  };

  // --- UI Element References ---
  const loadFileBtn = document.getElementById('loadFileBtn'),
    openModsFolderBtn = document.getElementById('openModsFolderBtn'),
    filePathLabel = document.getElementById('filePathLabel'),
    disableAllSwitch = document.getElementById('disableAllSwitch'),
    modListContainer = document.getElementById('modListContainer'),
    settingsBtn = document.getElementById('settingsBtn'),
    settingsModalOverlay = document.getElementById('settingsModalOverlay'),
    closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn'),
    rowPaddingSlider = document.getElementById('rowPaddingSlider'),
    rowPaddingValue = document.getElementById('rowPaddingValue'),
    deleteSettingsBtn = document.getElementById('deleteSettingsBtn'),
    dropZone = document.getElementById('dropZone'),
    searchModsInput = document.getElementById('searchModsInput'),
    languageSelector = document.getElementById('languageSelector'),
    enableAllBtn = document.getElementById('enableAllBtn'),
    disableAllBtn = document.getElementById('disableAllBtn'),
    customCloseBtn = document.getElementById('customCloseBtn'),
    modInfoPanel = document.getElementById('modInfoPanel'),
    infoModName = document.getElementById('infoModName'),
    infoAuthor = document.getElementById('infoAuthor'),
    infoInstalledVersion = document.getElementById('infoInstalledVersion'),
    infoLatestVersion = document.getElementById('infoLatestVersion'),
    infoDescription = document.getElementById('infoDescription'),
    infoNexusLink = document.getElementById('infoNexusLink'),
    updateCheckBtn = document.getElementById('updateCheckBtn'),
    updateModalOverlay = document.getElementById('updateModalOverlay'),
    updateListContainer = document.getElementById('updateListContainer'),
    closeUpdateModalBtn = document.getElementById('closeUpdateModalBtn'),
    navMyMods = document.getElementById('navMyMods'),
    navBrowse = document.getElementById('navBrowse'),
    myModsView = document.getElementById('myModsView'),
    browseView = document.getElementById('browseView'),
    browseGridContainer = document.getElementById('browseGridContainer'),
    fileSelectionModalOverlay = document.getElementById('fileSelectionModalOverlay'),
    fileSelectionModalTitle = document.getElementById('fileSelectionModalTitle'),
    fileSelectionListContainer = document.getElementById('fileSelectionListContainer'),
    closeFileSelectionModalBtn = document.getElementById('closeFileSelectionModalBtn'),
    browseSearchInput = document.getElementById('browseSearchInput'),
    browseSortSelect = document.getElementById('browseSortSelect'),
    browseFilterSelect = document.getElementById('browseFilterSelect'),
    modDetailPanel = document.getElementById('modDetailPanel'),
    modDetailCloseBtn = document.getElementById('modDetailCloseBtn'),
    modDetailName = document.getElementById('modDetailName'),
    modDetailAuthor = document.getElementById('modDetailAuthor'),
    modDetailImage = document.getElementById('modDetailImage'),
    modDetailVersion = document.getElementById('modDetailVersion'),
    modDetailUpdated = document.getElementById('modDetailUpdated'),
    modDetailDescription = document.getElementById('modDetailDescription'),
    modDetailInstallBtnContainer = document.getElementById('modDetailInstallBtnContainer'),
    modDetailSecondaryActions = document.getElementById('modDetailSecondaryActions'),
    modDetailInstalled = document.getElementById('modDetailInstalled'),
    modDetailCreated = document.getElementById('modDetailCreated'),
    changelogModalOverlay = document.getElementById('changelogModalOverlay'),
    changelogModalTitle = document.getElementById('changelogModalTitle'),
    changelogListContainer = document.getElementById('changelogListContainer'),
    closeChangelogModalBtn = document.getElementById('closeChangelogModalBtn'),
    priorityModalOverlay = document.getElementById('priorityModalOverlay'),
    priorityModalTitle = document.getElementById('priorityModalTitle'),
    priorityModalDescription = document.getElementById('priorityModalDescription'),
    priorityInput = document.getElementById('priorityInput'),
    confirmPriorityBtn = document.getElementById('confirmPriorityBtn'),
    cancelPriorityBtn = document.getElementById('cancelPriorityBtn'),
    downloadHistoryBtn = document.getElementById('downloadHistoryBtn'),
    downloadHistoryModalOverlay = document.getElementById('downloadHistoryModalOverlay'),
    downloadListContainer = document.getElementById('downloadListContainer'),
    closeDownloadHistoryBtn = document.getElementById('closeDownloadHistoryBtn'),
    clearDownloadHistoryBtn = document.getElementById('clearDownloadHistoryBtn'),
    nxmHandlerBtn = document.getElementById('nxmHandlerBtn'),
    gridGapSlider = document.getElementById('gridGapSlider'),
    gridGapValue = document.getElementById('gridGapValue');

  // --- Core Application Logic ---

  // --- LOGGING SYSTEM ---
  window.addAppLog = async (message, level = 'INFO') => {
    try {
      // Print to DevTools
      if (level === 'ERROR') console.error(message);
      else console.log(message);

      // Send to Rust to write to disk
      await invoke('write_to_log', { level, message: String(message) });
    } catch (e) {
      console.error("Failed to write log:", e);
    }
  };

  // Log startup
  window.addAppLog("Singularity Manager Started", "INFO");

  // --- GLOBAL HOTKEYS & INPUT HANDLING ---
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      // 1. Handle Input/Dialog Modals (Highest Priority)
      if (!document.getElementById('inputDialogModal').classList.contains('hidden')) {
        document.getElementById('inputDialogCancelBtn').click();
        return;
      }
      if (!document.getElementById('genericDialogModal').classList.contains('hidden')) {
        document.querySelector('#genericDialogActions button')?.click();
        return;
      }

      // 2. Handle Overlay Modals
      const modals = [
        'profileProgressModal', 'profileManagerModal', 'folderSelectionModal',
        'downloadHistoryModalOverlay', 'fileSelectionModalOverlay',
        'updateModalOverlay', 'priorityModalOverlay', 'changelogModalOverlay',
        'settingsModalOverlay', 'modDetailPanel'
      ];

      for (const id of modals) {
        const el = document.getElementById(id);
        // Check if visible
        if (el && !el.classList.contains('hidden')) {
          // Special case for Detail Panel (slide out)
          if (id === 'modDetailPanel' && el.classList.contains('open')) {
            document.getElementById('modDetailCloseBtn').click();
            return;
          }
          // Special case: If closing Download History, clear its selection
          if (id === 'downloadHistoryModalOverlay') {
            appState.selectedDownloadIds.clear();
            // Visual cleanup not strictly needed here as render handles it on open, but good practice
          }

          if (id !== 'modDetailPanel') {
            el.classList.add('hidden');
            return;
          }
        }
      }

      // 3. Clear Selections (If no modals were closed)
      // Clear Mod List Selection
      if (appState.selectedModNames.size > 0) {
        appState.selectedModNames.clear();
        appState.selectedModRow = null;
        modListContainer.querySelectorAll('.mod-row.selected').forEach(el => el.classList.remove('selected'));
        modInfoPanel.classList.add('hidden');
      }

      // Clear Download List Selection (Visuals only, usually modal is closed by now)
      if (appState.selectedDownloadIds.size > 0) {
        appState.selectedDownloadIds.clear();
        downloadListContainer.querySelectorAll('.download-item.selected').forEach(el => el.classList.remove('selected'));
      }
    }

    if (e.key === 'Enter') {
      if (!document.getElementById('inputDialogModal').classList.contains('hidden')) {
        document.getElementById('inputDialogOkBtn').click();
        return;
      }
      if (!document.getElementById('genericDialogModal').classList.contains('hidden')) {
        const confirmBtn = document.querySelector('.modal-gen-btn-confirm');
        if (confirmBtn) confirmBtn.click();
        return;
      }
    }
  });

  // --- AUTO-REFRESH ON FOCUS ---
  // If the user deletes a mod in Explorer and tabs back, this updates everything.
  window.addEventListener('focus', async () => {
    // Only run if we are fully initialized and on the "My Mods" view
    if (appState.activeProfile && !appState.isPopulating && !myModsView.classList.contains('hidden')) {

      console.log("App focused. Syncing with disk...");

      try {
        // 1. Call Rust: This cleans the file on disk and returns the correct list
        const cleanList = await invoke('get_all_mods_for_render');

        // 2. Reload the in-memory XML from the disk
        if (appState.currentFilePath) {
          const freshContent = await readTextFile(appState.currentFilePath);
          appState.xmlDoc = new DOMParser().parseFromString(freshContent, "application/xml");
        }

        // 3. Update the UI with the clean list
        await renderModList(cleanList);

        // 4. Update Profile JSON to match the new reality
        await saveCurrentProfile();

        // 5. Sync Download History visuals if the modal happens to be open
        if (!downloadHistoryModalOverlay.classList.contains('hidden')) {
          await syncDownloadHistoryWithProfile(appState.activeProfile);
          renderDownloadHistory();
        }
      } catch (e) {
        console.warn("Auto-refresh failed:", e);
      }
    }
  });

  // --- Monitor Window Resizing ---
  // This debounces the event so it only logs once when the resizing STOPS.
  let resizeLogTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeLogTimeout);
    resizeLogTimeout = setTimeout(async () => {
      try {
        const size = await appWindow.innerSize();
        const pos = await appWindow.outerPosition();
        window.addAppLog(`Window Resized to: ${size.width}x${size.height} at (${pos.x}, ${pos.y})`, "INFO");
      } catch (e) { /* ignore */ }
    }, 500);
  });

  // --- CUSTOM DIALOG HELPERS ---
  const inputModal = document.getElementById('inputDialogModal');
  const inputTitle = document.getElementById('inputDialogTitle');
  const inputMessage = document.getElementById('inputDialogMessage');
  const inputField = document.getElementById('inputDialogField');
  const inputCancel = document.getElementById('inputDialogCancelBtn');
  const inputOk = document.getElementById('inputDialogOkBtn');

  window.customPrompt = (message, title, defaultValue = "") => {
    return new Promise((resolve) => {
      inputTitle.textContent = title || 'Singularity';
      inputMessage.textContent = message;
      inputField.value = defaultValue;

      // Handlers
      const cleanup = () => {
        inputModal.classList.add('hidden');
        inputOk.onclick = null;
        inputCancel.onclick = null;
        inputField.onkeydown = null;
      };

      const confirm = () => {
        const val = inputField.value;
        cleanup();
        resolve(val);
      };

      const cancel = () => {
        cleanup();
        resolve(null);
      };

      inputOk.onclick = confirm;
      inputCancel.onclick = cancel;

      // Allow pressing ENTER to confirm
      inputField.onkeydown = (e) => {
        if (e.key === 'Enter') confirm();
        if (e.key === 'Escape') cancel();
      };

      inputModal.classList.remove('hidden');
      // Focus the input automatically
      setTimeout(() => inputField.focus(), 50);
    });
  };

  // --- CUSTOM DIALOG HELPERS ---
  const genericDialogModal = document.getElementById('genericDialogModal');
  const genericDialogTitle = document.getElementById('genericDialogTitle');
  const genericDialogMessage = document.getElementById('genericDialogMessage');
  const genericDialogActions = document.getElementById('genericDialogActions');

  function showDialog(title, message, type = 'alert', confirmText = null, cancelText = null) {
    // 1. Calculate the final text values (Fallback to i18n if null)
    const finalConfirmText = confirmText || i18n.get('okBtn');
    const finalCancelText = cancelText || i18n.get('cancelBtn');

    return new Promise((resolve) => {
      genericDialogTitle.textContent = title || 'Singularity';
      genericDialogMessage.textContent = message;
      genericDialogActions.innerHTML = '';

      if (type === 'confirm') {
        // --- Cancel Button ---
        const btnCancel = document.createElement('button');
        btnCancel.className = 'modal-gen-btn-cancel';
        btnCancel.textContent = finalCancelText;

        // Auto-expand width if text is long (like "Don't Show Again")
        if (finalCancelText.length > 8) {
          btnCancel.style.width = 'auto';
          btnCancel.style.paddingLeft = '15px';
          btnCancel.style.paddingRight = '15px';
        }

        btnCancel.onclick = () => {
          genericDialogModal.classList.add('hidden');
          resolve(false);
        };
        genericDialogActions.appendChild(btnCancel);

        // --- Confirm Button ---
        const btnOk = document.createElement('button');
        btnOk.className = 'modal-gen-btn-confirm';
        btnOk.textContent = finalConfirmText;

        btnOk.onclick = () => {
          genericDialogModal.classList.add('hidden');
          resolve(true);
        };
        genericDialogActions.appendChild(btnOk);
      } else {
        // --- Alert (OK Only) ---
        const btnOk = document.createElement('button');
        btnOk.className = 'modal-gen-btn-confirm';
        btnOk.textContent = finalConfirmText;

        btnOk.onclick = () => {
          genericDialogModal.classList.add('hidden');
          resolve(true);
        };
        genericDialogActions.appendChild(btnOk);
      }

      genericDialogModal.classList.remove('hidden');
    });
  }

  // --- WRAPPERS (Defined OUTSIDE showDialog) ---

  window.customAlert = async (msg, title) => {
    await showDialog(title, msg, 'alert');
  };

  // Default params to null so showDialog uses i18n fallbacks
  window.customConfirm = async (msg, title, confirmBtnText = null, cancelBtnText = null) => {
    return await showDialog(title, msg, 'confirm', confirmBtnText, cancelBtnText);
  };

  window.customConflictDialog = (message, title, btnReplaceText, btnKeepText, btnCancelText) => {
    return new Promise((resolve) => {
      const genericDialogModal = document.getElementById('genericDialogModal');
      const genericDialogTitle = document.getElementById('genericDialogTitle');
      const genericDialogMessage = document.getElementById('genericDialogMessage');
      const genericDialogActions = document.getElementById('genericDialogActions');

      genericDialogTitle.textContent = title || 'Conflict';
      genericDialogMessage.textContent = message;
      genericDialogActions.innerHTML = '';

      // 1. Cancel Button (Left)
      const btnCancel = document.createElement('button');
      btnCancel.className = 'modal-gen-btn-cancel';
      btnCancel.textContent = btnCancelText || "Cancel";
      btnCancel.onclick = () => {
        genericDialogModal.classList.add('hidden');
        resolve('cancel');
      };
      genericDialogActions.appendChild(btnCancel);

      // 2. Keep Both Button (Middle)
      const btnKeep = document.createElement('button');
      // Use 'modal-btn-nxm' or similar for a neutral look, or reuse confirm style
      btnKeep.className = 'modal-gen-btn-confirm';
      btnKeep.textContent = btnKeepText || "Keep Both";
      btnKeep.onclick = () => {
        genericDialogModal.classList.add('hidden');
        resolve('keep');
      };
      genericDialogActions.appendChild(btnKeep);

      // 3. Replace Button (Right - Primary Action)
      const btnReplace = document.createElement('button');
      btnReplace.className = 'modal-gen-btn-confirm';
      btnReplace.textContent = btnReplaceText || "Replace";
      btnReplace.onclick = () => {
        genericDialogModal.classList.add('hidden');
        resolve('replace');
      };
      genericDialogActions.appendChild(btnReplace);

      genericDialogModal.classList.remove('hidden');
    });
  };

  const i18n = {
    async loadLanguage(lang) {
      try {
        // 1. Load English Base
        const enPath = await resolveResource(`locales/en.json`);
        const enContent = await readTextFile(enPath);
        const enData = JSON.parse(enContent);

        if (lang === 'en') {
          appState.currentTranslations = enData;
        } else {
          // 2. Load Target & Merge
          const resourcePath = await resolveResource(`locales/${lang}.json`);
          const content = await readTextFile(resourcePath);
          const targetData = JSON.parse(content);
          appState.currentTranslations = { ...enData, ...targetData };
        }

        localStorage.setItem('selectedLanguage', lang);

        // 3. Refresh UI
        this.updateUI();

      } catch (e) {
        console.error(`Failed to load language file for ${lang}`, e);
        if (lang !== 'en') await this.loadLanguage('en');
      }
    },
    updateUI() {
      // 1. Sync Dropdown Value (FIXES THE DROPDOWN RESET BUG)
      const currentLang = localStorage.getItem('selectedLanguage') || 'en';
      if (languageSelector) {
        languageSelector.value = currentLang;
      }

      // 2. Auto-translate static elements
      document.querySelectorAll('[data-i18n]').forEach(el => {
        // SKIP the NXM button here to prevent it from flickering/resetting incorrectly
        if (el.id === 'nxmHandlerBtn') return;

        const key = el.getAttribute('data-i18n');
        const attributeName = el.getAttribute('data-i18n-attr');
        if (appState.currentTranslations[key]) {
          const translatedText = appState.currentTranslations[key];
          if (attributeName) {
            el.setAttribute(attributeName, translatedText);
          } else {
            el.textContent = translatedText;
          }
        }
      });

      // 3. Handle Nexus Login Status
      const nexusStatus = document.getElementById('nexusAccountStatus');
      const nexusBtn = document.getElementById('nexusAuthBtn');

      if (appState.nexusUsername) {
        if (nexusStatus) nexusStatus.textContent = this.get('statusConnectedAs', { name: appState.nexusUsername });
        if (nexusBtn) nexusBtn.textContent = this.get('disconnectBtn');
      } else {
        if (nexusStatus) nexusStatus.textContent = this.get('statusNotLoggedIn');
        if (nexusBtn) nexusBtn.textContent = this.get('connectBtn');
      }

      // 4. Handle NXM Button State (FIXES THE BUTTON RESET BUG)
      // We explicitly call this logic *after* translations are applied
      // to ensure the button text reflects the actual logic (Registered vs Not Registered)
      if (typeof updateNXMButtonState === 'function') {
        updateNXMButtonState();
      }

      // 5. Update File Path Label
      if (appState.currentFilePath) {
        basename(appState.currentFilePath).then(fileNameWithExt => {
          const fileNameWithoutExt = fileNameWithExt.slice(0, fileNameWithExt.lastIndexOf('.'));
          filePathLabel.textContent = this.get('editingFile', { fileName: fileNameWithoutExt });
        });
      } else {
        filePathLabel.textContent = this.get('noFileLoaded');
      }

      this.adjustBannerWidths();
    },
    get(key, placeholders = {}) {
      let text = appState.currentTranslations[key] || key;
      for (const [placeholder, value] of Object.entries(placeholders)) {
        text = text.replace(`{{${placeholder}}}`, value);
      }
      return text;
    },
    adjustBannerWidths() {
      requestAnimationFrame(() => {
        const HORIZONTAL_PADDING = 60;
        const bannerConfigs = [
          { id: 'globalBanner', minWidth: 240 },
          { id: 'individualBanner', minWidth: 310 }
        ];
        bannerConfigs.forEach(config => {
          const banner = document.getElementById(config.id);
          if (banner) {
            const textElement = banner.querySelector('.banner-text');
            if (textElement) {
              const calculatedWidth = textElement.scrollWidth + HORIZONTAL_PADDING;
              const finalWidth = Math.max(config.minWidth, calculatedWidth);
              banner.style.width = `${finalWidth}px`;
            }
          }
        });
      });
    }
  };

  async function loadCuratedListFromCache() {
    try {
      const dataDir = await appDataDir();
      const cacheFilePath = await join(dataDir, 'curated_list_cache.json');
      const content = await readTextFile(cacheFilePath);
      const cachedData = JSON.parse(content);

      console.log("Successfully loaded curated list from local cache.");
      return cachedData;
    } catch (error) {
      // This is expected if the file doesn't exist yet
      console.log("No local cache found.");
      return null;
    }
  }

  async function saveCuratedListToCache(data, etag = null) {
    try {
      const dataToCache = {
        timestamp: Date.now(),
        etag: etag, // Save the ETag
        data: data
      };

      const dataDir = await appDataDir();
      await mkdir(dataDir, { recursive: true });
      const cacheFilePath = await join(dataDir, 'curated_list_cache.json');
      await writeTextFile(cacheFilePath, JSON.stringify(dataToCache));
      console.log("Saved fresh curated list to local cache.");
    } catch (error) {
      console.error("Failed to save curated list to cache:", error);
    }
  }

  async function fetchCuratedData() {
    // 1. Load local cache
    const cachedObj = await loadCuratedListFromCache();

    // 2. Check if cache is valid time-wise
    if (cachedObj) {
      const isStale = (Date.now() - cachedObj.timestamp) > CACHE_DURATION_MS;

      // If it's NOT stale, just use the data and stop.
      if (!isStale) {
        curatedData = cachedObj.data;
        return;
      }
    }

    // 3. It is stale (older than 1 hour). Ask GitHub if it changed.
    try {
      console.log("Checking for curated list updates...");

      const headers = {};
      // If it has an ETag from last time, send it
      if (cachedObj && cachedObj.etag) {
        headers['If-None-Match'] = cachedObj.etag;
      }

      const response = await fetch(CURATED_LIST_URL, { headers });

      // CASE A: 304 NOT MODIFIED (Server says: "You have the latest version")
      if (response.status === 304 && cachedObj) {
        console.log("Remote list hasn't changed. Extending cache duration.");
        curatedData = cachedObj.data;
        // Save it again just to update the 'timestamp' so it doesn't check again for another hour
        await saveCuratedListToCache(cachedObj.data, cachedObj.etag);
        return;
      }

      // CASE B: 200 OK (Server sent new data)
      if (!response.ok) throw new Error("Could not fetch remote curated list.");

      const freshData = await response.json();
      const newEtag = response.headers.get('etag'); // Get the new ETag

      curatedData = freshData;
      console.log(`Successfully loaded ${curatedData.length} mods from network.`);

      // Save new data + new ETag
      await saveCuratedListToCache(freshData, newEtag);

    } catch (error) {
      console.error("CRITICAL: Could not load curated mod data:", error);
      // Fallback: If network fails, try to use old cache even if stale
      if (cachedObj) {
        console.warn("Using stale cache due to network error.");
        curatedData = cachedObj.data;
      } else {
        await window.customAlert("Failed to load mod data from the server. Update checks and the browse tab will not work.", "Network Error");
      }
    }
  }

  // --- NEXUS LOGIN LOGIC ---
  const nexusAuthBtn = document.getElementById('nexusAuthBtn');
  const nexusAccountStatus = document.getElementById('nexusAccountStatus');

  async function validateLoginState(preloadedKey = null) {
    try {
      if (preloadedKey) {
        NEXUS_API_KEY = preloadedKey;
      } else {
        NEXUS_API_KEY = await invoke('get_nexus_api_key');
      }

      const headers = { "apikey": NEXUS_API_KEY };
      const response = await fetch("https://api.nexusmods.com/v1/users/validate.json", { headers });

      if (response.ok) {
        const userData = await response.json();

        appState.nexusUsername = userData.name;

        nexusAccountStatus.textContent = i18n.get('statusConnectedAs', { name: userData.name });
        nexusAccountStatus.classList.add('logged-in');

        nexusAuthBtn.textContent = i18n.get('disconnectBtn');
        nexusAuthBtn.className = "modal-btn-delete";
        nexusAuthBtn.style.width = "100px";
        nexusAuthBtn.style.padding = "5px";

        return true;
      } else {
        throw new Error("Key validation failed with Nexus.");
      }
    } catch (e) {
      // Clean handling: Don't spam console if it's just a missing key
      const errorStr = String(e);
      if (!errorStr.includes("No API Key found")) {
        console.warn("Login check:", e);
      }

      appState.nexusUsername = null;
      nexusAccountStatus.textContent = i18n.get('statusNotLoggedIn');
      nexusAccountStatus.classList.remove('logged-in');

      nexusAuthBtn.textContent = i18n.get('connectBtn');
      nexusAuthBtn.className = "modal-btn-confirm";
      nexusAuthBtn.style.width = "100px";
      nexusAuthBtn.style.padding = "5px";

      NEXUS_API_KEY = "";
      return false;
    }
  }

  const initializeApp = async () => {
    const savedLang = localStorage.getItem('selectedLanguage') || 'en';

    // --- 1. START TASKS IN PARALLEL ---

    // Network Tasks (Background - Don't await immediately)
    const loginPromise = validateLoginState();
    const curatedDataPromise = fetchCuratedData();

    // Local I/O Tasks (Critical - Await group)
    const langPromise = i18n.loadLanguage(savedLang);
    const historyPromise = loadDownloadHistory();

    // Migration (Must finish before reading XML to ensure data integrity)
    const migrationPromise = invoke('run_legacy_migration').catch(e => console.error("Migration error:", e));

    // Game Detection
    const gameDetectPromise = invoke('detect_game_installation');

    // --- 2. AWAIT CRITICAL SETUP ---
    // We block UI rendering only for these essentials
    await Promise.all([langPromise, historyPromise, migrationPromise]);

    // --- 3. INITIALIZE UI COMPONENTS ---

    // Set up Sliders
    const savedPadding = localStorage.getItem('modRowPadding') || '5';
    document.documentElement.style.setProperty('--mod-row-vertical-padding', `${savedPadding}px`);
    rowPaddingSlider.value = savedPadding;
    rowPaddingValue.textContent = savedPadding;
    updateSliderFill(rowPaddingSlider);

    const savedGridGap = localStorage.getItem('browseGridGap') || '10';
    document.documentElement.style.setProperty('--browse-grid-gap', `${savedGridGap}px`);
    gridGapSlider.value = savedGridGap;
    gridGapValue.textContent = savedGridGap;
    updateSliderFill(gridGapSlider);

    const savedModsPerPage = localStorage.getItem('modsPerPage') || '20';
    appState.modsPerPage = parseInt(savedModsPerPage, 10);
    if (modsPerPageSlider) {
      modsPerPageSlider.value = appState.modsPerPage;
      modsPerPageValue.textContent = appState.modsPerPage;
      updateSliderFill(modsPerPageSlider);
    }

    // --- 4. HANDLE GAME PATH ---
    const gamePaths = await gameDetectPromise;

    if (gamePaths) {
      console.log(`Detected ${gamePaths.version_type} version of No Man's Sky.`);

      appState.gamePath = gamePaths.game_root_path;
      appState.settingsPath = gamePaths.settings_root_path;
      appState.versionType = gamePaths.version_type;

      // UI Updates for Game Found
      const launchBtn = document.getElementById('launchGameBtn');
      const launchIcon = document.getElementById('launchIcon');

      launchBtn.classList.remove('disabled');
      launchBtn.dataset.platform = appState.versionType;

      if (appState.versionType === 'Steam') launchIcon.src = iconSteam;
      else if (appState.versionType === 'GOG') launchIcon.src = iconGog;
      else if (appState.versionType === 'GamePass') launchIcon.src = iconXbox;
    }

    // Enable/Disable UI based on Game Path
    const hasGamePath = !!appState.gamePath;
    openModsFolderBtn.disabled = !hasGamePath;
    settingsBtn.classList.toggle('disabled', !hasGamePath);
    updateCheckBtn.classList.toggle('disabled', !hasGamePath);
    enableAllBtn.classList.toggle('disabled', !hasGamePath);
    disableAllBtn.classList.toggle('disabled', !hasGamePath);
    dropZone.classList.toggle('hidden', !hasGamePath);

    if (!hasGamePath) {
      // If no game, show title error (visual feedback)
      const bannerText = document.querySelector('#globalBanner .banner-text');
      if (bannerText) bannerText.textContent = "Game Not Found";
    }

    // --- 5. LOAD MOD LIST (XML) ---
    if (hasGamePath && appState.settingsPath) {
      try {
        const settingsFilePath = await join(appState.settingsPath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
        const content = await readTextFile(settingsFilePath);
        await loadXmlContent(content, settingsFilePath);
      } catch (e) {
        console.warn("Could not auto-load settings file.", e);
      }
    }

    // --- 6. SETUP LISTENERS ---
    listen('nxm-link-received', (event) => handleNxmLink(event.payload));

    listen('install-progress', (event) => {
      const payload = event.payload;
      const item = downloadHistory.find(d => d.id === payload.id);
      if (item) {
        item.statusText = payload.step;
        // Update UI immediately
        const row = document.querySelector(`.download-item[data-download-id="${payload.id}"]`);
        if (row) {
          const statusEl = row.querySelector('.download-item-status');
          if (statusEl) statusEl.textContent = payload.step;

          const bar = row.querySelector('.download-progress-bar');
          if (bar && payload.progress !== undefined && payload.progress !== null) {
            bar.style.width = `${payload.progress}%`;
            bar.classList.remove('indeterminate');
          } else if (bar) {
            bar.style.width = '100%';
            bar.style.opacity = '0.5';
          }
        }
      }
    });

    // --- 7. HANDLE BACKGROUND TASKS (UI is already interactive here) ---

    // A. Drive Check (Async Promise Chain)
    if (appState.gamePath) {
      invoke('get_library_path').then(libPath => {
        const getDrive = (p) => {
          if (!p) return null;
          const m = p.match(/([a-zA-Z]):/);
          return m ? m[1].toUpperCase() : null;
        };

        const gameDrive = getDrive(appState.gamePath);
        const libDrive = getDrive(libPath);
        const suppressDriveCheck = localStorage.getItem('suppressDriveCheck') === 'true';

        if (gameDrive && libDrive && gameDrive !== libDrive && !suppressDriveCheck) {
          window.customConfirm(
            i18n.get('driveCheckMsg', { gameDrive, libDrive }),
            i18n.get('driveCheckTitle'),
            i18n.get('btnMoveNow'),
            i18n.get('btnDontAskAgain')
          ).then(moveIt => {
            if (moveIt) document.getElementById('changeLibraryDirBtn').click();
            else localStorage.setItem('suppressDriveCheck', 'true');
          });
        }
      }).catch(console.warn);
    }

    // B. Untracked Mods Check (Async Promise Chain)
    const suppressWarning = localStorage.getItem('suppressUntrackedWarning') === 'true';
    if (!suppressWarning) {
      invoke('check_for_untracked_mods').then(hasUntracked => {
        if (hasUntracked) {
          window.customConfirm(
            i18n.get('untrackedModsMsg'),
            i18n.get('warningTitle'),
            i18n.get('okBtn'),
            i18n.get('dontShowAgainBtn')
          ).then(keepShowing => {
            if (keepShowing === false) localStorage.setItem('suppressUntrackedWarning', 'true');
            // Re-render list to update red dots based on user choice
            renderModList();
          });
        }
      }).catch(console.warn);
    }

    // C. Login Result (Updates UI when ready)
    loginPromise.then(() => {
      i18n.updateUI(); // Refreshes the "Connected as..." text
    });

    // D. Curated Data & Updates (Updates UI dots when ready)
    curatedDataPromise.then(() => {
      if (appState.gamePath && appState.modDataCache.size > 0) {
        checkForUpdates(true); // Silent check
      }
    });

    try {
      // Ask Rust if we have a pending link
      const pendingLink = await invoke('check_startup_intent');
      if (pendingLink) {
        console.log("Found pending startup NXM link:", pendingLink);
        // Process it just like a normal link event
        handleNxmLink(pendingLink);
      }
    } catch (e) {
      console.error("Failed to check startup intent:", e);
    }
  };

  const loadXmlContent = async (content, path) => {
    appState.currentFilePath = path;
    const fileNameWithExt = await basename(appState.currentFilePath);
    const fileNameWithoutExt = fileNameWithExt.slice(0, fileNameWithExt.lastIndexOf('.'));
    filePathLabel.textContent = i18n.get('editingFile', { fileName: fileNameWithoutExt });
    appState.xmlDoc = new DOMParser().parseFromString(content, "application/xml");
    await renderModList();
  };

  const renderModList = async (directData = null) => {
    if (!directData && !appState.xmlDoc) return;

    const scrollPos = modListContainer.scrollTop;
    appState.isPopulating = true;
    modListContainer.innerHTML = '';
    appState.installedModsMap.clear();

    const suppressUntracked = localStorage.getItem('suppressUntrackedWarning') === 'true';

    const disableAllNode = appState.xmlDoc.querySelector('Property[name="DisableAllMods"]');
    if (disableAllNode) {
      disableAllSwitch.checked = disableAllNode.getAttribute('value').toLowerCase() === 'true';
      disableAllSwitch.disabled = false;
    }

    const modsToRender = directData ? directData : await invoke('get_all_mods_for_render');

    appState.modDataCache.clear();
    modsToRender.forEach(modData => {
      appState.modDataCache.set(modData.folder_name, modData);
    });

    modsToRender.forEach((modData, index) => {
      if (modData.local_info) {
        const { mod_id, file_id, version } = modData.local_info;
        if (mod_id && file_id && version) {
          const modIdStr = String(mod_id);
          if (!appState.installedModsMap.has(modIdStr)) {
            appState.installedModsMap.set(modIdStr, new Map());
          }
          appState.installedModsMap.get(modIdStr).set(String(file_id), version);
        }
      }

      const row = document.createElement('div');
      row.className = 'mod-row';
      row.dataset.modName = modData.folder_name;
      const showRedDot = !suppressUntracked && (!modData.local_info || !modData.local_info.install_source);

      const untrackedHtml = showRedDot
        ? `<span class="untracked-indicator" title="${i18n.get('untrackedModTooltip')}"></span>`
        : '';

      row.innerHTML = `
                <div class="mod-name-container">
                    <span class="mod-name-text">${modData.folder_name}</span>
                    ${untrackedHtml}
                    <span class="update-indicator hidden" data-i18n-title="updateAvailableTooltip" title="Update available"></span>
                </div>
                <div class="priority"><input type="text" class="priority-input" value="${index}" readonly></div>
                <div class="enabled"><label class="switch"><input type="checkbox" class="enabled-switch" ${modData.enabled ? 'checked' : ''}><span class="slider"></span></label></div>
            `;

      row.querySelector('.enabled-switch').addEventListener('change', async (e) => {
        const newState = e.target.checked;
        window.addAppLog(`User toggled mod '${modData.folder_name}': ${newState ? 'ENABLED' : 'DISABLED'}`, "INFO");

        const modNode = Array.from(appState.xmlDoc.querySelectorAll('Property[name="Data"] > Property'))
          .find(node => {
            const nameProp = node.querySelector('Property[name="Name"]');
            return nameProp && nameProp.getAttribute('value').toUpperCase() === modData.folder_name.toUpperCase();
          });
        if (modNode) {
          const newVal = newState ? 'true' : 'false';
          const eNode = modNode.querySelector('Property[name="Enabled"]');
          const evrNode = modNode.querySelector('Property[name="EnabledVR"]');
          if (eNode) eNode.setAttribute('value', newVal);
          if (evrNode) evrNode.setAttribute('value', newVal);
          await saveChanges();
          await saveCurrentProfile();
        }
      });

      modListContainer.appendChild(row);
    });

    appState.isPopulating = false;
    filterModList();
    modListContainer.scrollTop = scrollPos;
  };

  function updateModListStates() {
    if (!appState.xmlDoc) return;

    const modRows = modListContainer.querySelectorAll('.mod-row');

    modRows.forEach(row => {
      const modName = row.dataset.modName;
      const modNode = Array.from(appState.xmlDoc.querySelectorAll('Property[name="Data"] > Property'))
        .find(node => {
          const nameProp = node.querySelector('Property[name="Name"]');
          return nameProp && nameProp.getAttribute('value').toUpperCase() === modName.toUpperCase();
        });

      if (modNode) {
        const isEnabled = modNode.querySelector('Property[name="Enabled"]')?.getAttribute('value').toLowerCase() === 'true';

        const checkbox = row.querySelector('.enabled-switch');
        if (checkbox && checkbox.checked !== isEnabled) {
          checkbox.checked = isEnabled;
        }
      }
    });
  }

  // --- APP AUTO-UPDATER LOGIC ---
  async function checkAppUpdate(isManual = false) {
    try {
      const isInstalled = await invoke('is_app_installed');

      if (!isInstalled) {
        console.log("Portable mode detected. Auto-updater disabled.");
        if (isManual) {
          await window.customAlert(
            i18n.get('portableModeMsg'),
            i18n.get('portableModeTitle')
          );
        }
        return;
      }

      if (isManual) {
        const btn = document.getElementById('checkAppUpdateBtn');
        if (btn) {
          btn.textContent = i18n.get('statusChecking');
          btn.disabled = true;
        }
      } else {
        console.log("Running silent startup app update check...");
      }

      const update = await check();

      if (update) {
        console.log(`App Update found: ${update.version}`);

        const confirmed = await window.customConfirm(
          i18n.get('appUpdateMsg', {
            version: update.version,
            notes: update.body || ""
          }),
          i18n.get('appUpdateAvailableTitle'),
          i18n.get('btnUpdateRestart'),
          i18n.get('btnLater')
        );

        if (confirmed) {
          await window.customAlert(i18n.get('statusDownloadingUpdate'), i18n.get('statusUpdating'));

          let downloaded = 0;
          let contentLength = 0;

          await update.downloadAndInstall((event) => {
            switch (event.event) {
              case 'Started':
                contentLength = event.data.contentLength;
                console.log(`Update started: ${contentLength} bytes`);
                break;
              case 'Progress':
                downloaded += event.data.chunkLength;
                console.log(`Update progress: ${downloaded}`);
                break;
              case 'Finished':
                console.log('Update download finished.');
                break;
            }
          });

          await relaunch();
        }
      } else {
        if (isManual) {
          await window.customAlert(i18n.get('updateUpToDateMsg'), i18n.get('updateUpToDateTitle'));
        }
      }
    } catch (error) {
      console.error("App update check failed:", error);
      if (isManual) {
        await window.customAlert(i18n.get('updateErrorMsg', { error: String(error) }), i18n.get('updateErrorTitle'));
      }
    } finally {
      // Re-enable button if it's installed
      if (isManual) {
        const btn = document.getElementById('checkAppUpdateBtn');
        if (btn) {
          // Restore default text
          btn.textContent = i18n.get('checkUpdateBtn');
          btn.disabled = false;
        }
      }
    }
  }

  // --- CHECK MOD UPDATES ---
  async function checkForUpdates(isSilent = false) {
    if (!appState.gamePath || curatedData.length === 0) {
      if (!isSilent) await window.customAlert("Mod data is not loaded. Cannot check for updates.", "Error");
      return;
    }

    if (isSilent) {
      console.log("Performing silent update check...");
    } else {
      updateListContainer.innerHTML = `<p>${i18n.get('updateChecking')}</p>`;
      updateModalOverlay.classList.remove('hidden');
    }

    const groupedUpdates = new Map();

    for (const [modFolderName, cachedModData] of appState.modDataCache.entries()) {
      const localModInfo = cachedModData.local_info;

      if (localModInfo) {
        const modId = localModInfo.mod_id;
        const installedVersion = localModInfo.version;
        const installedFileId = localModInfo.file_id;

        if (modId && installedVersion) {
          const remoteModInfo = curatedData.find(mod => String(mod.mod_id) === String(modId));

          if (remoteModInfo && remoteModInfo.files) {

            // --- 1. IDENTIFY INSTALLED MOD ---
            let installedBaseName = "";

            // Try matching by File ID first (Most accurate)
            const installedFileOnNexus = remoteModInfo.files.find(f => String(f.file_id) === String(installedFileId));

            if (installedFileOnNexus) {
              // Use the display name from Nexus
              installedBaseName = getBaseName(installedFileOnNexus.name || installedFileOnNexus.file_name);
            } else if (localModInfo.install_source) {
              // Fallback: Use the local zip filename
              installedBaseName = getBaseName(localModInfo.install_source);
            } else {
              // Last Resort: Use the folder name itself
              installedBaseName = getBaseName(modFolderName);
            }

            // --- 2. FIND UPDATES ---
            if (installedBaseName) {
              const candidateFiles = remoteModInfo.files.filter(f => {
                // Never consider 'OLD_VERSION' files as a new update
                if (f.category_name === 'OLD_VERSION') return false;

                const candidateBaseName = getBaseName(f.name || f.file_name);
                return candidateBaseName === installedBaseName;
              });

              if (candidateFiles.length > 0) {
                // Find the absolute newest file among candidates
                const latestFile = candidateFiles.sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];

                if (isNewerVersionAvailable(installedVersion, latestFile.version)) {

                  // VISUALS: Show Yellow Dot
                  const row = modListContainer.querySelector(`.mod-row[data-mod-name="${modFolderName}"]`);
                  const indicator = row?.querySelector('.update-indicator');
                  if (indicator) indicator.classList.remove('hidden');

                  // MODAL: Add to list
                  const modIdStr = String(modId);
                  if (!groupedUpdates.has(modIdStr)) {
                    groupedUpdates.set(modIdStr, {
                      name: remoteModInfo.name || modFolderName,
                      installed: installedVersion,
                      latest: latestFile.version,
                      nexusUrl: `https://www.nexusmods.com/nomanssky/mods/${remoteModInfo.mod_id}`,
                      folders: [modFolderName]
                    });
                  } else {
                    const entry = groupedUpdates.get(modIdStr);
                    entry.folders.push(modFolderName);
                  }
                }
              }
            }
          }
        }
      }
    }

    if (isSilent) return;

    updateListContainer.innerHTML = '';

    if (groupedUpdates.size > 0) {
      groupedUpdates.forEach((updateInfo) => {
        const item = document.createElement('div');
        item.className = 'update-item';

        const nexusLinkHtml = updateInfo.nexusUrl
          ? `<a href="${updateInfo.nexusUrl}" class="nexus-button" target="_blank" title="${i18n.get('btnVisitNexus')}"><img src="${iconNexus}" alt="Nexus"></a>`
          : '';

        const folderListStr = updateInfo.folders.join(', ');
        const folderCountText = updateInfo.folders.length > 1
          ? `<div style="font-size: 0.85em; opacity: 0.7; margin-top: 4px;">Affects ${updateInfo.folders.length} folders: ${folderListStr}</div>`
          : '';

        item.innerHTML = `
                    <div class="update-item-info">
                        <div class="update-item-name">${updateInfo.name}</div>
                        <div class="update-item-version">
                            ${updateInfo.installed} <span class="arrow">→</span> <span class="latest">${updateInfo.latest}</span>
                        </div>
                        ${folderCountText}
                    </div>
                    ${nexusLinkHtml}`;

        updateListContainer.appendChild(item);
      });
    } else {
      updateListContainer.innerHTML = `<p>${i18n.get('updateNoneFound')}</p>`;
    }
  }

  // --- Other Helper Functions ---
  function refreshBrowseTabBadges() {
    // Safety check
    if (!browseGridContainer || browseGridContainer.childElementCount === 0) return;

    const cards = browseGridContainer.querySelectorAll('.mod-card');
    cards.forEach(card => {
      const modId = card.dataset.modId;
      const isInstalled = appState.installedModsMap.has(String(modId));

      card.classList.toggle('is-installed', isInstalled);

      const badge = card.querySelector('.mod-card-installed-badge');
      if (badge) {
        badge.classList.toggle('hidden', !isInstalled);
      }
    });
  }

  function updateSliderFill(slider) {
    const val = slider.value;
    const min = slider.min || 0;
    const max = slider.max || 100;

    // Calculate percentage
    const percentage = ((val - min) / (max - min)) * 100;

    // Update background: Accent Color on Left | White on Right
    slider.style.background = `linear-gradient(to right, var(--c-accent-primary) ${percentage}%, #EAEAEA ${percentage}%)`;
  }

  function formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '...';
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString();
  }

  function getBaseName(name) {
    if (!name) return "";
    let clean = name.toLowerCase();

    // Remove file extensions first
    clean = clean.replace(/\.(zip|rar|7z|pak)$/i, '');

    // Remove Nexus ID/Date suffix pattern (hyphen+digits at end)
    clean = clean.replace(/-\d+(-\d+)*$/i, '');

    // Remove typical version patterns anywhere in the string
    // Matches: "v" followed by digits, or space/dash followed by digits
    clean = clean.replace(/[- _]?v?\d+(\.\d+)*[a-z]?/gi, '');

    // FINAL SWEEP: Keep ONLY letters (a-z). 
    clean = clean.replace(/[^a-z]/g, '');

    return clean;
  }

  async function startModDownload({ modId, fileId, version, fileName, displayName, replacingFileId, nxmQueryParams }, isUpdate = false) {

    window.addAppLog(`Download Requested: ${displayName || fileName} (ID: ${modId}-${fileId}) [Update: ${isUpdate}]`, "INFO");

    // 1. DUPLICATE CHECK
    const existingItem = downloadHistory.find(d => d.fileId === fileId);

    if (existingItem && existingItem.archivePath && !isUpdate) {
      const confirmed = await window.customConfirm(
        `You have already downloaded "${displayName || fileName}".\n\nDo you want to download it again and replace the existing file?`,
        'Duplicate Download'
      );

      if (!confirmed) {
        downloadHistoryModalOverlay.classList.remove('hidden');
        downloadHistory = downloadHistory.filter(d => d.fileId !== fileId);
        downloadHistory.unshift(existingItem);
        renderDownloadHistory();
        window.addAppLog("Download skipped by user (Duplicate).", "INFO");
        return;
      }

      downloadHistory = downloadHistory.filter(d => d.fileId !== fileId);
    }

    // 2. UPDATE LOGIC: HIDE OLD VERSION
    if (replacingFileId) {
      const oldVersionItem = downloadHistory.find(d => String(d.fileId) === String(replacingFileId));

      if (oldVersionItem && oldVersionItem.archivePath) {
        console.log(`Update detected. Hiding old version from list: ${oldVersionItem.fileName}`);
        downloadHistory = downloadHistory.filter(d => d.id !== oldVersionItem.id);
      }
    }

    downloadHistoryModalOverlay.classList.remove('hidden');

    const downloadId = `download-${Date.now()}`;
    const newItemData = {
      id: downloadId,
      modId: modId,
      fileId: fileId,
      version: version,
      displayName: displayName,
      fileName: fileName,
      statusText: isUpdate ? i18n.get('statusUpdating') : i18n.get('statusWaiting'),
      statusClass: 'progress',
      archivePath: null,
      modFolderName: null,
      size: 0,
      createdAt: 0
    };

    downloadHistory.unshift(newItemData);
    renderDownloadHistory();

    const updateStatus = (text, statusClass) => {
      const item = downloadHistory.find(d => d.id === downloadId);
      if (item) {
        item.statusText = text;
        item.statusClass = statusClass;
        renderDownloadHistory();
      }
    };

    try {
      updateStatus('Requesting download URL...', 'progress');
      const downloadUrl = await fetchDownloadUrlFromNexus(modId, fileId, nxmQueryParams);
      if (!downloadUrl) {
        throw new Error("Could not retrieve download URL. (Check API Key or Premium Status)");
      }

      updateStatus(i18n.get('statusDownloading'), 'progress');

      const downloadResult = await invoke('download_mod_archive', {
        downloadUrl,
        fileName,
        downloadId
      });

      const item = downloadHistory.find(d => d.id === downloadId);
      if (item) {
        item.archivePath = downloadResult.path;
        item.size = downloadResult.size;
        item.createdAt = downloadResult.created_at;

        window.addAppLog(`Download chain finished successfully for ${fileName}`, "INFO");

        if (isUpdate) {
          await handleDownloadItemInstall(downloadId, true);
        } else {
          item.statusText = 'Downloaded';
          item.statusClass = 'success';
          await saveDownloadHistory(downloadHistory);
          renderDownloadHistory();
        }
      }

    } catch (error) {
      console.error("Download/Update failed:", error);
      window.addAppLog(`Frontend Download Error: ${error.message}`, "ERROR");
      updateStatus(`Error: ${error.message}`, 'error');
      await saveDownloadHistory(downloadHistory);
    }
  }

  function showDownloadContextMenu(e, downloadId) {
    e.preventDefault();
    e.stopPropagation();
    removeContextMenu();

    // Auto-select the item if it wasn't part of the existing selection
    if (!appState.selectedDownloadIds.has(downloadId)) {
      appState.selectedDownloadIds.clear();
      appState.selectedDownloadIds.add(downloadId);
      // Visual update
      const allRows = downloadListContainer.querySelectorAll('.download-item');
      allRows.forEach(row => {
        if (row.dataset.downloadId === downloadId) row.classList.add('selected');
        else row.classList.remove('selected');
      });
    }

    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    const selectionCount = appState.selectedDownloadIds.size;

    if (selectionCount > 1) {
      // --- BULK DELETE OPTION ---
      const deleteButton = document.createElement('button');

      deleteButton.textContent = i18n.get('deleteMultipleBtn', { count: selectionCount }) || `Delete ${selectionCount} Items`;
      deleteButton.className = 'context-menu-item delete';

      deleteButton.onclick = async () => {
        removeContextMenu();

        const confirmed = await window.customConfirm(
          i18n.get('confirmDeleteMultipleMsg') || "Delete selected files?",
          i18n.get('confirmDeleteTitle') || "Confirm Delete"
        );

        if (confirmed) {
          const idsToDelete = Array.from(appState.selectedDownloadIds);

          for (const id of idsToDelete) {
            const itemIndex = downloadHistory.findIndex(d => d.id === id);
            if (itemIndex > -1) {
              const item = downloadHistory[itemIndex];
              try {
                if (item.archivePath) await invoke('delete_archive_file', { path: item.archivePath });
                if (item.fileName) await invoke('delete_library_folder', { zipFilename: item.fileName });

                // Remove from history array
                downloadHistory.splice(itemIndex, 1);
              } catch (err) {
                console.error(`Failed to delete ${item.fileName}`, err);
              }
            }
          }

          appState.selectedDownloadIds.clear();
          renderDownloadHistory();
          await saveDownloadHistory(downloadHistory);
        }
      };
      contextMenu.appendChild(deleteButton);

    } else {
      // --- SINGLE ITEM OPTIONS ---
      const itemData = downloadHistory.find(d => d.id === downloadId);
      if (!itemData) return;

      // Install Button
      if ((itemData.statusClass === 'success' ||
        itemData.statusClass === 'cancelled' ||
        itemData.statusClass === 'error' ||
        itemData.statusClass === 'unpacked')
        && itemData.archivePath) {

        const installButton = document.createElement('button');
        installButton.textContent = i18n.get('ctxInstall');
        installButton.className = 'context-menu-item';
        installButton.onclick = () => handleDownloadItemInstall(downloadId);
        contextMenu.appendChild(installButton);
      }

      // Visit on Nexus Button
      const nexusButton = document.createElement('button');
      nexusButton.textContent = i18n.get('ctxVisitNexus');
      nexusButton.className = 'context-menu-item';
      nexusButton.onclick = () => {
        invoke('plugin:shell|open', {
          path: `https://www.nexusmods.com/nomanssky/mods/${itemData.modId}`,
          with: null
        });
      };
      contextMenu.appendChild(nexusButton);

      // Reveal in Explorer
      if (itemData.archivePath) {
        const revealButton = document.createElement('button');
        revealButton.textContent = i18n.get('ctxRevealExplorer');
        revealButton.className = 'context-menu-item';
        revealButton.onclick = () => invoke('show_in_folder', { path: itemData.archivePath });
        contextMenu.appendChild(revealButton);
      }

      // Delete Button
      const deleteButton = document.createElement('button');
      deleteButton.textContent = i18n.get('deleteBtn');
      deleteButton.className = 'context-menu-item delete';
      deleteButton.onclick = () => handleDownloadItemDelete(downloadId);
      contextMenu.appendChild(deleteButton);
    }

    document.body.appendChild(contextMenu);
  }

  async function processInstallAnalysis(analysis, item, isUpdate) {
    let oldArchiveToDelete = null;

    // 1. Handle Direct Conflicts (Same Folder Name)
    if (analysis.conflicts && analysis.conflicts.length > 0) {
      for (const conflict of analysis.conflicts) {
        const oldItemIndex = downloadHistory.findIndex(d => d.modFolderName === conflict.old_mod_folder_name);
        if (oldItemIndex > -1) {
          const oldItem = downloadHistory[oldItemIndex];
          if (oldItem.archivePath && oldItem.id !== item.id) {
            oldArchiveToDelete = oldItem.archivePath;
            downloadHistory.splice(oldItemIndex, 1);
          }
        }

        const shouldReplace = isUpdate ? true : await window.customConfirm(
          i18n.get('modUpdateConflictMsg', {
            oldName: conflict.old_mod_folder_name,
            newName: conflict.new_mod_name
          }),
          i18n.get('modUpdateConflictTitle')
        );

        await invoke('resolve_conflict', {
          newModName: conflict.new_mod_name,
          oldModFolderName: conflict.old_mod_folder_name,
          tempModPathStr: conflict.temp_path,
          replace: shouldReplace
        });

        if (shouldReplace) {
          if (conflict.new_mod_name.toUpperCase() !== conflict.old_mod_folder_name.toUpperCase()) {
            const updatedXmlContent = await invoke('update_mod_name_in_xml', {
              oldName: conflict.old_mod_folder_name.toUpperCase(),
              newName: conflict.new_mod_name.toUpperCase()
            });
            await loadXmlContent(updatedXmlContent, appState.currentFilePath);
          }
          await invoke('ensure_mod_info', {
            modFolderName: conflict.new_mod_name,
            modId: item.modId || "",
            fileId: item.fileId || "",
            version: item.version || "",
            installSource: item.fileName
          });

          item.modFolderName = conflict.new_mod_name;
        }
      }
    }

    // 2. Handle New Installations (Different Folder Name)
    if (analysis.successes && analysis.successes.length > 0) {
      const processedNames = new Set();

      // Flag to ensure we only trigger the prompt once per batch
      let hasPromptedForRename = false;

      for (const mod of analysis.successes) {
        if (processedNames.has(mod.name)) continue;

        let isRenamedEntry = false;

        // --- INTELLIGENT RENAME DETECTION ---
        // We look for an existing mod with the SAME ID but DIFFERENT Name.
        // If we find multiple (Main + Addon), we pick the one with the most similar name.
        let oldFolderName = null;

        if (item.modId && !hasPromptedForRename) {
          let bestMatch = null;
          let bestMatchScore = -1;

          for (const [fName, data] of appState.modDataCache.entries()) {
            // Match ID
            if (String(data.local_info?.mod_id) === String(item.modId)) {
              // Match Name Similarity (Common Prefix Length)
              // e.g. "MyMod_v2" matches "MyMod_v1" (score 7) better than "MyMod_Addon" (score 6)
              let score = 0;
              const minLen = Math.min(fName.length, mod.name.length);
              for (let i = 0; i < minLen; i++) {
                if (fName[i] === mod.name[i]) score++;
                else break;
              }

              // Prefer higher score. 
              if (score > bestMatchScore) {
                bestMatchScore = score;
                bestMatch = fName;
              }
            }
          }
          oldFolderName = bestMatch;
        }

        // If found a candidate, and it's different from the new one
        if (oldFolderName && oldFolderName !== mod.name) {

          const userChoice = await window.customConflictDialog(
            i18n.get('folderConflictMsg', {
              oldName: oldFolderName,
              newName: mod.name
            }),
            i18n.get('folderConflictTitle'),
            i18n.get('btnReplace'),   // "Replace (Update)"
            i18n.get('btnKeepBoth'),  // "Keep Both (Addon)"
            i18n.get('cancelBtn')     // "Cancel"
          );

          if (userChoice === 'cancel') {
            window.addAppLog(`User cancelled installation due to conflict: ${mod.name}`, "INFO");

            try {
              console.log(`Cancelling install. Deleting folder: ${mod.name}`);
              await invoke('delete_mod', { modName: mod.name });

              // Refresh the XML in memory just in case 'delete_mod' touched it
              if (appState.gamePath) {
                const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
                const content = await readTextFile(settingsPath);
                appState.xmlDoc = new DOMParser().parseFromString(content, "application/xml");
              }
            } catch (err) {
              console.warn(`Failed to cleanup rejected mod folder ${mod.name}:`, err);
            }

            // Cleanup visually
            const currentItem = downloadHistory.find(d => d.id === item.id);
            if (currentItem) {
              currentItem.statusText = i18n.get('statusCancelled');
              currentItem.statusClass = 'cancelled';
              renderDownloadHistory();
              await saveDownloadHistory(downloadHistory);
            }

            // Revert the temporary "Cancelled" status to "Downloaded" after a few seconds
            setTimeout(() => {
              if (currentItem && currentItem.statusClass === 'cancelled') {
                currentItem.statusText = i18n.get('statusUnpacked');
                currentItem.statusClass = 'unpacked';

                renderDownloadHistory();
                saveDownloadHistory(downloadHistory);
              }
            }, 4000);

            return;
          }

          const shouldReplace = (userChoice === 'replace');

          if (shouldReplace) {
            console.log(`User chose to replace: ${oldFolderName} -> ${mod.name}`);
            try {
              const updatedXmlContent = await invoke('update_mod_name_in_xml', {
                oldName: oldFolderName.toUpperCase(),
                newName: mod.name.toUpperCase()
              });
              await loadXmlContent(updatedXmlContent, appState.currentFilePath);

              await invoke('delete_mod', { modName: oldFolderName });

              isRenamedEntry = true;
            } catch (e) {
              console.warn("Failed to process folder rename:", e);
            }
          } else {
            console.log("User chose to keep both.");
          }

          hasPromptedForRename = true;
        }

        if (!isRenamedEntry) {
          addNewModToXml(mod.name);
        }

        await invoke('ensure_mod_info', {
          modFolderName: mod.name,
          modId: item.modId || "",
          fileId: item.fileId || "",
          version: item.version || "",
          installSource: item.fileName
        });

        await checkForAndLinkMod(mod.name);
        processedNames.add(mod.name);
      }

      item.modFolderName = analysis.successes[0].name;
    }

    await saveChanges();
    await renderModList();

    const updateStatus = (text, statusClass) => {
      const currentItem = downloadHistory.find(d => d.id === item.id);
      if (currentItem) {
        currentItem.statusText = text;
        currentItem.statusClass = statusClass;
        renderDownloadHistory();
      }
    };

    updateStatus(i18n.get('statusInstalled'), 'installed');
    await saveDownloadHistory(downloadHistory);

    updateModDisplayState(item.modId);
    await saveCurrentProfile();
  }

  async function handleDownloadItemInstall(downloadId, isUpdate = false) {
    const item = downloadHistory.find(d => d.id === downloadId);
    if (!item || !item.archivePath) {
      console.error("Attempted to install an item with no archive path:", item);
      return;
    }

    const updateStatus = (text, statusClass) => {
      const currentItem = downloadHistory.find(d => d.id === downloadId);
      if (currentItem) {
        currentItem.statusText = text;
        currentItem.statusClass = statusClass;
        renderDownloadHistory();
      }
    };

    try {
      updateStatus(isUpdate ? i18n.get('statusUpdating') : i18n.get('statusWaiting'), 'progress');

      // 1. Call Phase 1 with the ID
      const analysis = await invoke('install_mod_from_archive', {
        archivePathStr: item.archivePath,
        downloadId: downloadId // <--- PASS ID HERE
      });

      // 2. Check if user selection is required (Multi-folder zip)
      if (analysis.selection_needed) {
        const userResult = await openFolderSelectionModal(analysis.available_folders, item.fileName, analysis.temp_id);

        if (!userResult) {
          // User Cancelled - Clean up staging
          // await invoke('clean_staging_folder');
          updateStatus(i18n.get('statusCancelled'), 'cancelled');

          // --- Revert status after 5 seconds ---
          setTimeout(() => {
            const current = downloadHistory.find(d => d.id === downloadId);
            // Only revert if it is still in the 'cancelled' state
            if (current && current.statusClass === 'cancelled') {
              current.statusText = i18n.get('statusDownloaded');
              current.statusClass = 'success';
              renderDownloadHistory();
            }
          }, 5000);

          return;
        }

        // 3a. Call Phase 2: Finalize with specific folders
        const finalAnalysis = await invoke('finalize_installation', {
          libraryId: analysis.temp_id,
          selectedFolders: userResult.selected,
          flattenPaths: userResult.flatten
        });

        await processInstallAnalysis(finalAnalysis, item, isUpdate);

      } else {
        // 3b. Single folder detected (or direct install)
        await processInstallAnalysis(analysis, item, isUpdate);
      }

    } catch (error) {
      // Log to internal console
      const errMsg = `Installation failed for ${item.fileName}: ${error}`;
      window.addAppLog(errMsg, 'ERROR');

      console.error("Installation process failed:", error);

      // Show error state immediately
      updateStatus(`${i18n.get('installFailedTitle')}: ${error}`, 'error');
      await saveDownloadHistory(downloadHistory);

      // Show Popup
      await window.customAlert(`${i18n.get('installFailedTitle')}: ${error}`, "Error");

      // --- Revert to 'Downloaded' after 10 seconds ---
      setTimeout(() => {
        const current = downloadHistory.find(d => d.id === downloadId);
        // Only revert if it is still in the 'error' state (user hasn't deleted it)
        if (current && current.statusClass === 'error') {
          current.statusText = i18n.get('statusDownloaded');
          current.statusClass = 'success';
          renderDownloadHistory();
          saveDownloadHistory(downloadHistory);
        }
      }, 10000);
      // -----------------------------------------------------
    }
  }

  async function handleDownloadItemDelete(downloadId) {
    const confirmed = await window.customConfirm(i18n.get('deleteDownloadArchiveMsg'), i18n.get('deleteDownloadArchiveTitle'));
    if (!confirmed) return;

    const itemIndex = downloadHistory.findIndex(d => d.id === downloadId);
    if (itemIndex === -1) return;

    const item = downloadHistory[itemIndex];

    try {
      // 1. Delete the Zip File
      if (item.archivePath) {
        await invoke('delete_archive_file', { path: item.archivePath });
      }

      // 2. Delete the Unpacked Library Folder
      // Pass the filename (e.g. "Mod.zip") and backend appends "_unpacked"
      if (item.fileName) {
        await invoke('delete_library_folder', { zipFilename: item.fileName });
      }

      // 3. Update UI
      downloadHistory.splice(itemIndex, 1);
      renderDownloadHistory();
      await saveDownloadHistory(downloadHistory);

    } catch (error) {
      await window.customAlert(`Failed to delete files: ${error}`, "Error");
    }
  }

  function updateModDisplayState(modId) {
    const modIdStr = String(modId);
    const installedFiles = appState.installedModsMap.get(modIdStr);
    const isInstalled = installedFiles && installedFiles.size > 0;

    // --- 1. Update the Mod Detail Panel (if it's open for this mod) ---
    if (!modDetailPanel.classList.contains('hidden') && modDetailName.dataset.modId === modIdStr) {
      const primaryBtn = modDetailInstallBtnContainer.querySelector('.mod-card-install-btn');
      if (primaryBtn) {
        primaryBtn.textContent = isInstalled ? 'MANAGE FILES' : 'DOWNLOAD';
      }

      // Update the "Installed" version field in the metadata
      if (isInstalled) {
        modDetailInstalled.textContent = installedFiles.values().next().value || 'Installed';
      } else {
        modDetailInstalled.textContent = 'N/A';
      }
    }

    // --- 2. Update the Mod Card in the Browse Grid ---
    const card = browseGridContainer.querySelector(`.mod-card[data-mod-id="${modIdStr}"]`);
    if (card) {
      console.log(`Updating grid card for modId: ${modIdStr}. Is installed: ${isInstalled}`);
      const badge = card.querySelector('.mod-card-installed-badge');

      card.classList.toggle('is-installed', isInstalled);
      if (badge) {
        badge.classList.toggle('hidden', !isInstalled);
      }
    }
  }

  // --- DOWNLOAD PATH SETTINGS ---
  const changeDownloadDirBtn = document.getElementById('changeDownloadDirBtn');
  const currentDownloadPathEl = document.getElementById('currentDownloadPath');

  async function updateDownloadPathUI() {
    try {
      const path = await invoke('get_downloads_path');
      currentDownloadPathEl.textContent = path;
    } catch (e) {
      currentDownloadPathEl.textContent = "Error loading path";
    }
  }

  changeDownloadDirBtn.addEventListener('click', async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select New Downloads Folder"
      });

      if (selected) {
        // 1. Update UI to show loading state
        currentDownloadPathEl.textContent = "Moving files... please wait...";

        // 2. Call Backend
        await invoke('set_downloads_path', { newPath: selected });

        // 3. Refresh Path UI
        await updateDownloadPathUI();

        // 4. Show success message with specific path
        await window.customAlert(`Downloads moved to:\n${selected}/downloads`, "Success");
      }
    } catch (e) {
      // If failed, refresh UI to show old path (or whatever state it's in)
      updateDownloadPathUI();
      await window.customAlert("Failed to set path: " + e, "Error");
    }
  });

  const openDownloadsFolderBtn = document.getElementById('openDownloadsFolderBtn');
  openDownloadsFolderBtn.addEventListener('click', async () => {
    try {
      await invoke('open_special_folder', { folderType: 'downloads' });
    } catch (e) {
      console.error(e);
    }
  });

  async function loadDownloadHistory() {
    try {
      const dataDir = await appDataDir();
      const historyFilePath = await join(dataDir, 'download_history.json');
      const content = await readTextFile(historyFilePath);
      downloadHistory = JSON.parse(content);
    } catch (e) {
      console.log("No download history file found. Starting fresh.");
      downloadHistory = [];
    }
  }

  async function saveDownloadHistory(history) {
    try {
      const dataDir = await appDataDir();
      await mkdir(dataDir, { recursive: true });
      const historyFilePath = await join(dataDir, 'download_history.json');
      await writeTextFile(historyFilePath, JSON.stringify(history, null, 2));
    } catch (error) {
      console.error("Failed to save download history:", error);
    }
  }

  function renderDownloadHistory() {
    downloadHistory.sort((a, b) => {
      let valA, valB;
      switch (downloadSortState.key) {
        case 'name':
          valA = (a.displayName || a.fileName || '').toLowerCase();
          valB = (b.displayName || b.fileName || '').toLowerCase();
          break;
        case 'status':
          valA = (a.statusText || '').toLowerCase();
          valB = (b.statusText || '').toLowerCase();
          break;
        case 'size':
          valA = a.size || 0;
          valB = b.size || 0;
          break;
        default:
          valA = a.createdAt || parseInt(a.id.split('-')[1], 10);
          valB = b.createdAt || parseInt(b.id.split('-')[1], 10);
          break;
      }

      if (valA < valB) return downloadSortState.direction === 'asc' ? -1 : 1;
      if (valA > valB) return downloadSortState.direction === 'asc' ? 1 : -1;
      return 0;
    });

    downloadListContainer.innerHTML = '';
    const template = document.getElementById('downloadItemTemplate');

    for (const itemData of downloadHistory) {
      const newItem = template.content.cloneNode(true).firstElementChild;

      const progressBar = document.createElement('div');
      progressBar.className = 'download-progress-bar';
      newItem.appendChild(progressBar);

      newItem.dataset.downloadId = itemData.id;

      // --- SELECTION STATE LOGIC ---
      if (appState.selectedDownloadIds.has(itemData.id)) {
        newItem.classList.add('selected');
      }

      if ((itemData.statusClass === 'success' ||
        itemData.statusClass === 'cancelled' ||
        itemData.statusClass === 'error' ||
        itemData.statusClass === 'unpacked')
        && itemData.archivePath) {
        newItem.classList.add('installable');
      }

      const displayName = (itemData.displayName && itemData.version)
        ? `${itemData.displayName} (${itemData.version})`
        : itemData.fileName;
      const nameEl = newItem.querySelector('.download-item-name');
      nameEl.textContent = displayName;
      nameEl.setAttribute('title', displayName);

      const statusEl = newItem.querySelector('.download-item-status');

      // 1. Set the Class (Color)
      statusEl.className = 'download-item-status';
      statusEl.classList.add(`status-${itemData.statusClass}`);

      // 2. Set the Text (Translation)
      if (itemData.statusClass === 'installed') {
        statusEl.textContent = i18n.get('statusInstalled');
      } else if (itemData.statusClass === 'success') {
        statusEl.textContent = i18n.get('statusDownloaded');
      } else if (itemData.statusClass === 'unpacked') {
        statusEl.textContent = i18n.get('statusUnpacked');
      } else if (itemData.statusClass === 'cancelled') {
        statusEl.textContent = i18n.get('statusCancelled');
      } else {
        statusEl.textContent = itemData.statusText;
      }

      newItem.querySelector('.download-item-size').textContent = formatBytes(itemData.size);

      const timestamp = itemData.createdAt || parseInt(itemData.id.split('-')[1], 10) / 1000;
      newItem.querySelector('.download-item-date').textContent = formatDate(timestamp);

      // --- CLICK LISTENERS ---

      // 1. Selection Handler (Single vs Multi)
      newItem.addEventListener('click', (e) => {
        if (e.ctrlKey) {
          // Multi-select toggle
          if (appState.selectedDownloadIds.has(itemData.id)) {
            appState.selectedDownloadIds.delete(itemData.id);
            newItem.classList.remove('selected');
          } else {
            appState.selectedDownloadIds.add(itemData.id);
            newItem.classList.add('selected');
          }
        } else {
          // Single select (Clear others)
          appState.selectedDownloadIds.clear();
          appState.selectedDownloadIds.add(itemData.id);

          // Update visuals manually to avoid full re-render
          const allRows = downloadListContainer.querySelectorAll('.download-item');
          allRows.forEach(row => row.classList.remove('selected'));
          newItem.classList.add('selected');
        }
      });

      // 2. Install Action
      newItem.addEventListener('dblclick', () => {
        if (newItem.classList.contains('installable')) {
          handleDownloadItemInstall(itemData.id);
        }
      });

      // 3. Context Menu
      newItem.addEventListener('contextmenu', (e) => showDownloadContextMenu(e, itemData.id));

      downloadListContainer.appendChild(newItem);
    }

    const headerRow = document.querySelector('.download-header-row');
    if (headerRow) {
      headerRow.querySelectorAll('.sortable').forEach(header => {
        header.classList.remove('asc', 'desc');
        if (header.dataset.sort === downloadSortState.key) {
          header.classList.add(downloadSortState.direction);
        }
      });
    }
  }

  function updateDownloadStatus(downloadId, text, statusClass, modName) {
    const item = document.getElementById(downloadId);
    if (!item) return;

    const nameEl = item.querySelector('.download-item-name');
    const statusEl = item.querySelector('.download-item-status');

    if (modName && nameEl) {
      nameEl.textContent = modName;
    }

    if (statusEl) {
      statusEl.textContent = text;
      statusEl.className = 'download-item-status';
      statusEl.classList.add(`status-${statusClass}`);
    }
  }

  async function handleNxmLink(link) {
    console.log(`Frontend received nxm link: ${link}`);

    const match = link.match(/nxm:\/\/nomanssky\/mods\/(\d+)\/files\/(\d+)/);
    if (!match || match.length < 3) {
      await window.customAlert('Error: The received Nexus link was malformed.', "Link Error");
      return;
    }

    const modId = match[1];
    const fileId = match[2];

    const queryParts = link.split('?');
    const queryParams = queryParts.length > 1 ? queryParts[1] : "";

    let fileInfo = null;

    // 1. Check Local Curated Data First
    const localMod = curatedData.find(m => String(m.mod_id) === modId);
    if (localMod && localMod.files) {
      fileInfo = localMod.files.find(f => String(f.file_id) === fileId);
      if (fileInfo) {
        console.log("NXM Link: Found file info in local cache.");
      }
    }

    // 2. FALLBACK: If not in local list, use API
    if (!fileInfo) {
      console.log("NXM Link: Mod not in local cache. Fetching from API...");
      const filesData = await fetchModFilesFromNexus(modId);
      if (filesData && filesData.files) {
        fileInfo = filesData.files.find(f => String(f.file_id) === fileId);
      }
    }

    if (!fileInfo) {
      await window.customAlert(`File ID ${fileId} not found for mod ${modId}.`, "Error");
      return;
    }

    // 3. Start Download
    const displayName = fileInfo.name || fileInfo.file_name;

    await startModDownload({
      modId: modId,
      fileId: fileId,
      version: fileInfo.version,
      fileName: fileInfo.file_name,
      displayName: displayName,
      replacingFileId: null,
      nxmQueryParams: queryParams
    });
  }

  const reorderModsByList = async (orderedModNames) => {
    try {
      // 1. Call the new Rust command, passing the desired order.
      const updatedXmlContent = await invoke('reorder_mods', { orderedModNames });

      // 2. Load the perfectly sorted XML returned by the backend. This refreshes the state.
      await loadXmlContent(updatedXmlContent, appState.currentFilePath);

      // 3. The renderModList() called by loadXmlContent will automatically redraw the UI.
      await saveChanges();
    } catch (error) {
      await window.customAlert(`Error re-ordering mods: ${error}`, "Error");
      // If it fails, re-render the original list to avoid a broken UI state
      renderModList();
    }
  };

  function reorderModListUI(orderedModNames) {
    const rowsMap = new Map();
    modListContainer.querySelectorAll('.mod-row').forEach(row => {
      rowsMap.set(row.dataset.modName, row);
    });

    orderedModNames.forEach(modName => {
      const rowElement = rowsMap.get(modName);
      if (rowElement) {
        modListContainer.appendChild(rowElement);
      }
    });

    modListContainer.querySelectorAll('.mod-row').forEach((row, index) => {
      const priorityInput = row.querySelector('.priority-input');
      if (priorityInput) {
        priorityInput.value = index;
      }
    });
  }

  const saveChanges = async () => {
    if (appState.isPopulating || !appState.currentFilePath || !appState.xmlDoc) return;
    const formattedXmlString = formatNode(appState.xmlDoc.documentElement, 0);
    const finalContent = `<?xml version="1.0" encoding="utf-8"?>\n${formattedXmlString.trimEnd()}`;
    try {
      await invoke('save_file', { filePath: appState.currentFilePath, content: finalContent });
    }
    catch (e) { await window.customAlert(`Error saving file: ${e}`, "Error"); }
  };

  const setAllModsEnabled = async (enabled) => {
    if (!appState.xmlDoc) {
      await window.customAlert("Please load a GCMODSETTINGS.MXML file first.", "Error");
      return;
    }
    const modNodes = appState.xmlDoc.querySelectorAll('Property[name="Data"] > Property[value="GcModSettingsInfo"]');
    if (modNodes.length === 0) return;

    const newValue = enabled ? 'true' : 'false';
    modNodes.forEach(modNode => {
      const enabledNode = modNode.querySelector('Property[name="Enabled"]');
      const enabledVRNode = modNode.querySelector('Property[name="EnabledVR"]');
      if (enabledNode) enabledNode.setAttribute('value', newValue);
      if (enabledVRNode) enabledVRNode.setAttribute('value', newValue);
    });

    // Save the changes to the XML in memory
    saveChanges();

    updateModListStates();
  };

  const addNewModToXml = (modName) => {
    if (!appState.xmlDoc || !modName) return;
    const dataContainer = appState.xmlDoc.querySelector('Property[name="Data"]');
    if (!dataContainer) return;

    const allMods = dataContainer.querySelectorAll('Property[value="GcModSettingsInfo"]');
    let maxIndex = -1;
    let maxPriority = -1;

    allMods.forEach(mod => {
      const index = parseInt(mod.getAttribute('_index'), 10);
      const priorityNode = mod.querySelector('Property[name="ModPriority"]');
      const priority = priorityNode ? parseInt(priorityNode.getAttribute('value'), 10) : -1;
      if (index > maxIndex) maxIndex = index;
      if (priority > maxPriority) maxPriority = priority;
    });

    const newMod = appState.xmlDoc.createElement('Property');
    newMod.setAttribute('name', 'Data');
    newMod.setAttribute('value', 'GcModSettingsInfo');
    newMod.setAttribute('_index', (maxIndex + 1).toString());

    const createProp = (name, value) => {
      const prop = appState.xmlDoc.createElement('Property');
      prop.setAttribute('name', name);
      prop.setAttribute('value', value);
      return prop;
    };

    newMod.appendChild(createProp('Name', modName.toUpperCase()));
    newMod.appendChild(createProp('Author', ''));
    newMod.appendChild(createProp('ID', '0'));
    newMod.appendChild(createProp('AuthorID', '0'));
    newMod.appendChild(createProp('LastUpdated', '0'));
    newMod.appendChild(createProp('ModPriority', (maxPriority + 1).toString()));
    newMod.appendChild(createProp('Enabled', 'true'));
    newMod.appendChild(createProp('EnabledVR', 'true'));

    const dependencies = appState.xmlDoc.createElement('Property');
    dependencies.setAttribute('name', 'Dependencies');
    newMod.appendChild(dependencies);

    dataContainer.appendChild(newMod);
  };

  const escapeXml = (unsafe) => unsafe.replace(/[<>"'&]/g, char => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '&': '&amp;' }[char]));
  const unescapeXml = (safe) => safe.replace(/&lt;|&gt;|&quot;|&apos;|&amp;/g, entity => ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }[entity]));

  function isNewerVersionAvailable(installedVersion, latestVersion) {
    if (!installedVersion || !latestVersion) {
      return false;
    }
    const regex = /^([0-9.]+)(.*)$/;
    const installedMatch = String(installedVersion).match(regex) || [];
    const latestMatch = String(latestVersion).match(regex) || [];
    const installedNumeric = (installedMatch[1] || "0").split('.').map(Number);
    const latestNumeric = (latestMatch[1] || "0").split('.').map(Number);
    const installedSuffix = installedMatch[2] || '';
    const latestSuffix = latestMatch[2] || '';
    const len = Math.max(installedNumeric.length, latestNumeric.length);
    for (let i = 0; i < len; i++) {
      const installedPart = installedNumeric[i] || 0;
      const latestPart = latestNumeric[i] || 0;
      if (latestPart > installedPart) return true;
      if (latestPart < installedPart) return false;
    }
    if (!installedSuffix && latestSuffix) return true;
    if (installedSuffix && !latestSuffix) return false;
    if (installedSuffix && latestSuffix) return latestSuffix > installedSuffix;
    return false;
  }

  async function checkForAndLinkMod(modFolderName) {
    try {
      const modInfoPath = await join(appState.gamePath, 'GAMEDATA', 'MODS', modFolderName, 'mod_info.json');
      const content = await readTextFile(modInfoPath);
      const modInfo = JSON.parse(content);

      if (modInfo && modInfo.id === "") {
        const nexusUrl = await window.customPrompt(
          i18n.get('promptForNexusLink', { modName: modFolderName }),
          i18n.get('linkModTitle')
        );
        if (!nexusUrl) {
          await window.customAlert(i18n.get('linkCancelled', { modName: modFolderName }), "Cancelled");
          return;
        }
        const match = nexusUrl.match(/nexusmods\.com\/nomanssky\/mods\/(\d+)/);
        const parsedId = match ? match[1] : null;
        if (parsedId) {
          await invoke('update_mod_id_in_json', {
            modFolderName: modFolderName,
            newModId: parsedId
          });
          await window.customAlert(i18n.get('linkSuccess', { modName: modFolderName }), "Success");
        } else {
          await window.customAlert(i18n.get('linkInvalid', { modName: modFolderName }), "Error");
        }
      }
    } catch (error) { /* Silently ignore mods without info files */ }
  }

  const formatNode = (node, indentLevel) => {
    const indent = '  '.repeat(indentLevel);
    let attributeList = Array.from(node.attributes);
    const nameAttr = node.getAttribute('name');
    const isMainDataContainer = (nameAttr === 'Data' && node.parentNode?.tagName === 'Data');
    const isDependenciesTag = (nameAttr === 'Dependencies');

    if (isMainDataContainer || isDependenciesTag) {
      attributeList = attributeList.filter(attr => attr.name !== 'value');
    }
    const attributes = attributeList.map(attr => `${attr.name}="${escapeXml(attr.value)}"`).join(' ');
    const tag = node.tagName;
    let nodeString = `${indent}<${tag}${attributes ? ' ' + attributes : ''}`;
    if (node.children.length > 0) {
      nodeString += '>\n';
      for (const child of node.children) {
        nodeString += formatNode(child, indentLevel + 1);
      }
      nodeString += `${indent}</${tag}>\n`;
    } else {
      nodeString += ' />\n';
    }
    return nodeString;
  };

  function formatNexusDate(timestamp, lang) {
    if (!timestamp) return '---';
    const date = new Date(timestamp * 1000);
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
    return date.toLocaleDateString(lang, options);
  }

  function mapLangCode(langCode) {
    const map = { cn: 'zh-CN', kr: 'ko-KR' };
    return map[langCode] || langCode;
  }

  function bbcodeToHtml(str) {
    if (!str) return '';
    const codeBlocks = [];
    str = str.replace(/\[code\]([\s\S]*?)\[\/code\]/gis, (match, content) => {
      const placeholder = `{{CODE_BLOCK_${codeBlocks.length}}}`;
      const tempElem = document.createElement('textarea');
      tempElem.innerHTML = content;
      let decodedContent = tempElem.value;
      decodedContent = decodedContent.replace(/<br\s*\/?>/gi, '\n');
      codeBlocks.push(decodedContent);
      return placeholder;
    });
    str = str.replace(/<br\s*\/?>/gi, '\n');
    const listReplacer = (match, listTag, content) => {
      const listType = listTag.includes('1') ? 'ol' : 'ul';
      const items = content.split(/\[\*\]/g).slice(1).map(item => `<li>${item.trim()}</li>`).join('');
      return `<${listType}>${items}</${listType}>`;
    };
    while (/\[(list|list=1)\]([\s\S]*?)\[\/list\]/i.test(str)) {
      str = str.replace(/\[(list|list=1)\]([\s\S]*?)\[\/list\]/i, listReplacer);
    }
    str = str.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gis, '<blockquote>$1</blockquote>');
    str = str.replace(/\[center\]([\s\S]*?)\[\/center\]/gis, '<div class="bbcode-center">$1</div>');
    str = str.replace(/\[img\](.*?)\[\/img\]/gis, '<img class="bbcode-img" src="$1" />');
    str = str.replace(/\[b\](.*?)\[\/b\]/gis, '<strong>$1</strong>');
    str = str.replace(/\[i\](.*?)\[\/i\]/gis, '<em>$1</em>');
    str = str.replace(/\[u\](.*?)\[\/u\]/gis, '<u>$1</u>');
    str = str.replace(/\[url=(.*?)\](.*?)\[\/url\]/gis, '<a href="$1" target="_blank">$2</a>');
    str = str.replace(/\[color=(.*?)\](.*?)\[\/color\]/gis, '<span style="color: $1">$2</span>');
    str = str.replace(/\[size=(\d+)\](.*?)\[\/size\]/gis, (match, size, text) => {
      const sizeMap = { '1': '10px', '2': '12px', '3': '14px', '4': '16px', '5': '18px' };
      const fontSize = sizeMap[size] || 'inherit';
      return `<span style="font-size: ${fontSize}">${text}</span>`;
    });
    const paragraphs = str.split(/\n\s*\n/);
    let html = paragraphs.map(p => {
      let para = p.trim();
      if (!para) return '';
      const isBlock = para.startsWith('<blockquote') || para.startsWith('<ol') || para.startsWith('<ul') || para.startsWith('{{CODE_BLOCK') || para.startsWith('<div class="bbcode-center') || para.startsWith('<img');
      para = para.replace(/\n/g, '<br>');
      return isBlock ? para : `<p>${para}</p>`;
    }).join('');
    html = html.replace(/{{CODE_BLOCK_(\d+)}}/g, (match, index) => {
      const content = codeBlocks[parseInt(index, 10)];
      const escapedContent = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code>${escapedContent}</code></pre>`;
    });
    return html;
  }

  async function fetchDownloadUrlFromNexus(modId, fileId, queryParams = "") {
    let url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}/files/${fileId}/download_link.json`;

    if (queryParams) {
      url += `?${queryParams}`;
    }

    const headers = { "apikey": NEXUS_API_KEY };
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.error(`API Error ${response.status}:`, await response.text());
        return null;
      }
      const data = await response.json();
      return data[0]?.URI;
    } catch (error) {
      console.error(`Failed to get download URL for mod ${modId}:`, error);
      return null;
    }
  }

  async function fetchModFilesFromNexus(modId) {
    const modIdStr = String(modId);
    if (nexusFileCache.has(modIdStr)) {
      return nexusFileCache.get(modIdStr);
    }
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modIdStr}/files.json`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) return null;
      const data = await response.json();
      nexusFileCache.set(modIdStr, data);
      return data;
    } catch (error) {
      return null;
    }
  }

  function displayChangelogs(modName, changelogs) {
    changelogModalTitle.textContent = `Changelogs: ${modName}`;
    changelogListContainer.innerHTML = '';

    if (!changelogs || Object.keys(changelogs).length === 0) {
      changelogListContainer.innerHTML = '<p>No changelogs available for this mod.</p>';
      changelogModalOverlay.classList.remove('hidden');
      return;
    }

    const sortedVersions = Object.keys(changelogs).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const version of sortedVersions) {
      const changes = changelogs[version];
      const versionTitle = document.createElement('h3');
      versionTitle.className = 'changelog-version';
      versionTitle.textContent = `Version ${version}`;
      changelogListContainer.appendChild(versionTitle);
      const list = document.createElement('ul');
      list.className = 'changelog-list';
      for (const change of changes) {
        const listItem = document.createElement('li');
        listItem.textContent = change;
        list.appendChild(listItem);
      }
      changelogListContainer.appendChild(list);
    }
    changelogModalOverlay.classList.remove('hidden');
  }

  // --- Drag and Drop Logic (Row Reordering) ---
  function autoScrollLoop() {
    if (scrollState.isScrollingUp) modListContainer.scrollTop -= SCROLL_SPEED;
    if (scrollState.isScrollingDown) modListContainer.scrollTop += SCROLL_SPEED;
    if (dragState.draggedElement) scrollState.animationFrameId = requestAnimationFrame(autoScrollLoop);
  }

  function onMouseMove(e) {
    if (!dragState.ghostElement) return;

    dragState.ghostElement.style.left = `${e.clientX - dragState.offsetX}px`;
    dragState.ghostElement.style.top = `${e.clientY - dragState.offsetY}px`;

    const allRows = Array.from(modListContainer.querySelectorAll('.mod-row:not(.is-dragging)'));
    let nextElement = null;
    for (const row of allRows) {
      const rect = row.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        nextElement = row;
        break;
      }
    }
    if (nextElement) {
      modListContainer.insertBefore(dragState.placeholder, nextElement);
    } else {
      modListContainer.appendChild(dragState.placeholder);
    }

    const listRect = modListContainer.getBoundingClientRect();
    const triggerZone = 50;
    scrollState.isScrollingUp = e.clientY < listRect.top + triggerZone;
    scrollState.isScrollingDown = e.clientY > listRect.bottom - triggerZone;
  }

  function onMouseUp(e) {
    if (!dragState.draggedElement) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      return;
    }

    const dropTarget = e.target.closest('#modListContainer');
    if (dropTarget && dragState.placeholder.parentNode) {
      dragState.placeholder.parentNode.insertBefore(dragState.draggedElement, dragState.placeholder);
      const finalModOrder = Array.from(modListContainer.querySelectorAll('.mod-row')).map(row => row.dataset.modName);

      window.addAppLog("User reordered mod list via drag & drop.", "INFO");

      // 1. Immediately update the UI with no blink.
      reorderModListUI(finalModOrder);

      // 2. In the background, tell the backend to save the new order.
      invoke('reorder_mods', { orderedModNames: finalModOrder })
        .then(async (updatedXmlContent) => {
          // 3. Silently update the in-memory data to match what was saved.
          appState.xmlDoc = new DOMParser().parseFromString(updatedXmlContent, "application/xml");
          await saveChanges();
          await saveCurrentProfile();
          console.log("Mod order saved and local state synced.");
        })
        .catch(async error => {
          window.addAppLog(`Failed to save reorder: ${error}`, "ERROR");
          await window.customAlert(`Error saving new mod order: ${error}`, "Error");
          renderModList();
        });
    } else {
      renderModList();
    }

    dragState.draggedElement.classList.remove('is-dragging');
    if (dragState.ghostElement) document.body.removeChild(dragState.ghostElement);
    if (dragState.placeholder) dragState.placeholder.remove();

    dragState.draggedElement = null;
    dragState.ghostElement = null;
    dragState.placeholder = null;

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    cancelAnimationFrame(scrollState.animationFrameId);
    scrollState.isScrollingUp = false;
    scrollState.isScrollingDown = false;
  }

  // --- Browse Tab Logic ---
  function fetchAndRenderBrowseGrid() {
    if (curatedData.length === 0) {
      browseGridContainer.innerHTML = '<h2>Curated list could not be loaded.</h2>';
      return;
    }
    filterAndDisplayMods();
  }

  function filterAndDisplayMods() {
    if (!browseSearchInput || !browseFilterSelect || !browseSortSelect) return;

    const searchTerm = browseSearchInput.value.toLowerCase().trim();
    const filterBy = browseFilterSelect.value;
    const sortBy = browseSortSelect.value;

    if (!curatedData) return;

    let processedMods = [...curatedData];

    // --- STAGE 1: FILTERING ---
    if (searchTerm) {
      processedMods = processedMods.filter(modData => {
        // CHECK 1: If entry is null, skip it
        if (!modData) return false;

        // CHECK 2: Safe String Access
        const name = (modData.name || "").toLowerCase();
        const author = (modData.author || "").toLowerCase();
        const summary = (modData.summary || "").toLowerCase();

        return (
          name.includes(searchTerm) ||
          author.includes(searchTerm) ||
          summary.includes(searchTerm)
        );
      });
    }

    if (filterBy === 'installed') {
      processedMods = processedMods.filter(mod => mod && appState.installedModsMap.has(String(mod.mod_id)));
    } else if (filterBy === 'uninstalled') {
      processedMods = processedMods.filter(mod => mod && !appState.installedModsMap.has(String(mod.mod_id)));
    }

    // --- STAGE 2: SORTING ---
    if (sortBy === 'name_asc') {
      processedMods.sort((a, b) => {
        // Safe access for sorting
        const nameA = a?.name || "";
        const nameB = b?.name || "";
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
      });
    } else {
      // Default: Last Updated (Desc)
      processedMods.sort((a, b) => (b?.updated_timestamp || 0) - (a?.updated_timestamp || 0));
    }

    // --- STAGE 3: PAGINATION & DISPLAY ---
    const totalItems = processedMods.length;
    const totalPages = Math.ceil(totalItems / appState.modsPerPage) || 1;

    if (appState.currentPage > totalPages) appState.currentPage = 1;
    if (appState.currentPage < 1) appState.currentPage = 1;

    const startIndex = (appState.currentPage - 1) * appState.modsPerPage;
    const endIndex = startIndex + appState.modsPerPage;

    const modsForCurrentPage = processedMods.slice(startIndex, endIndex);

    displayMods(modsForCurrentPage);
    renderPaginationControls(totalPages, appState.currentPage);
  }

  const paginationContainer = document.getElementById('paginationContainer');

  function renderPaginationControls(totalPages, currentPage) {
    paginationContainer.innerHTML = '';

    // 1. Always Render the Total Count on the left
    const countDiv = document.createElement('div');
    countDiv.className = 'pagination-count';
    countDiv.textContent = i18n.get('browseTotalMods', { count: curatedData.length });
    paginationContainer.appendChild(countDiv);

    paginationContainer.classList.remove('hidden');

    // 2. Only render buttons if we have more than 1 page
    if (totalPages <= 1) {
      return;
    }

    const createButton = (text, page, isActive = false, isDisabled = false) => {
      const btn = document.createElement('div');
      btn.className = `page-btn ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`;
      btn.textContent = text;
      if (!isDisabled && !isActive) {
        btn.onclick = () => {
          appState.currentPage = page;
          filterAndDisplayMods();
          browseGridContainer.scrollTop = 0;
        };
      }
      return btn;
    };

    const createDots = () => {
      const dots = document.createElement('span');
      dots.className = 'page-dots';
      dots.textContent = '...';
      return dots;
    };

    // --- PREVIOUS ARROW ---
    paginationContainer.appendChild(createButton('<', currentPage - 1, false, currentPage === 1));

    const MAX_VISIBLE_PAGES = 7;

    if (totalPages <= MAX_VISIBLE_PAGES) {
      for (let i = 1; i <= totalPages; i++) {
        paginationContainer.appendChild(createButton(i, i, i === currentPage));
      }
    } else {
      if (currentPage <= 4) {
        for (let i = 1; i <= 5; i++) {
          paginationContainer.appendChild(createButton(i, i, i === currentPage));
        }
        paginationContainer.appendChild(createDots());
        paginationContainer.appendChild(createButton(totalPages, totalPages, totalPages === currentPage));
      } else if (currentPage >= totalPages - 3) {
        paginationContainer.appendChild(createButton(1, 1, 1 === currentPage));
        paginationContainer.appendChild(createDots());
        for (let i = totalPages - 4; i <= totalPages; i++) {
          paginationContainer.appendChild(createButton(i, i, i === currentPage));
        }
      } else {
        paginationContainer.appendChild(createButton(1, 1, 1 === currentPage));
        paginationContainer.appendChild(createDots());
        paginationContainer.appendChild(createButton(currentPage - 1, currentPage - 1));
        paginationContainer.appendChild(createButton(currentPage, currentPage, true));
        paginationContainer.appendChild(createButton(currentPage + 1, currentPage + 1));
        paginationContainer.appendChild(createDots());
        paginationContainer.appendChild(createButton(totalPages, totalPages, totalPages === currentPage));
      }
    }

    // --- NEXT ARROW ---
    paginationContainer.appendChild(createButton('>', currentPage + 1, false, currentPage === totalPages));
  }
  function displayMods(modsToDisplay) {
    browseGridContainer.innerHTML = '';
    const template = document.getElementById('modCardTemplate');
    if (modsToDisplay.length === 0) {
      browseGridContainer.innerHTML = '<h2>No mods match your search.</h2>';
      return;
    }

    for (const modData of modsToDisplay) {
      if (!modData) continue;
      const card = template.content.cloneNode(true).firstElementChild;
      card.dataset.modId = modData.mod_id;
      const modIdStr = String(modData.mod_id);
      if (appState.installedModsMap.has(modIdStr)) {

        card.classList.add('is-installed');

        card.querySelector('.mod-card-installed-badge').classList.remove('hidden');
      }

      const titleElement = card.querySelector('.mod-card-title');

      card.querySelector('.mod-card-thumbnail').src = modData.picture_url || '/src/assets/placeholder.png';
      titleElement.title = modData.name;

      const versionSpan = `<span class="mod-card-version-inline">${modData.version || ''}</span>`;
      let titleHtml = modData.name + versionSpan;

      if (modData.state === 'warning') {
        card.classList.add('has-warning');
        if (modData.warningMessage) {
          const warningIconHtml = `<span class="warning-icon" title="${modData.warningMessage}">⚠️ </span>`;
          titleHtml = warningIconHtml + titleHtml;
        }
      }

      titleElement.innerHTML = titleHtml;
      card.querySelector('.mod-card-summary').textContent = modData.summary || 'No summary available.';
      card.querySelector('.mod-card-author').innerHTML = `by <span class="author-name-highlight">${modData.author}</span>`;
      const currentLang = mapLangCode(languageSelector.value);
      const dateStr = formatNexusDate(modData.updated_timestamp, currentLang);
      card.querySelector('.mod-card-date').textContent = `Updated: ${dateStr}`;

      browseGridContainer.appendChild(card);
    }
  }

  async function openModDetailPanel(modData) {
    modDetailName.textContent = modData.name;
    modDetailName.dataset.modId = modData.mod_id;
    modDetailImage.src = modData.picture_url || '/src/assets/placeholder.png';
    modDetailDescription.innerHTML = bbcodeToHtml(modData.description) || '<p>No description available.</p>';
    modDetailAuthor.textContent = modData.author || 'Unknown';
    modDetailVersion.textContent = modData.version || '?.?';

    const currentLang = mapLangCode(languageSelector.value);
    modDetailUpdated.textContent = formatNexusDate(modData.updated_timestamp, currentLang);
    modDetailCreated.textContent = formatNexusDate(modData.created_timestamp, currentLang);

    const modIdStr = String(modData.mod_id);
    const installedFiles = appState.installedModsMap.get(modIdStr);

    let versionToShow = 'N/A';

    if (installedFiles && installedFiles.size > 0) {
      let mainFileVersion = null;
      const allModFilesFromCurated = modData.files || [];

      for (const installedFileId of installedFiles.keys()) {
        const fileData = allModFilesFromCurated.find(f => String(f.file_id) === installedFileId);
        if (fileData && fileData.category_name === 'MAIN') {
          mainFileVersion = installedFiles.get(installedFileId);
          break;
        }
      }

      if (mainFileVersion) {
        versionToShow = mainFileVersion;
      } else {
        versionToShow = installedFiles.values().next().value || 'N/A';
      }
    }

    modDetailInstalled.textContent = versionToShow;

    modDetailInstallBtnContainer.innerHTML = '';
    const primaryBtn = document.createElement('button');
    primaryBtn.className = 'mod-card-install-btn';
    primaryBtn.textContent = (installedFiles && installedFiles.size > 0) ? 'MANAGE FILES' : 'DOWNLOAD';
    primaryBtn.onclick = () => showFileSelectionModal(modData.mod_id);
    modDetailInstallBtnContainer.appendChild(primaryBtn);

    modDetailSecondaryActions.innerHTML = '';
    const changelogBtn = document.createElement('button');
    changelogBtn.className = 'detail-action-btn';
    changelogBtn.textContent = 'Changelogs';
    changelogBtn.onclick = () => {
      const changelogs = modData.changelogs || {};
      displayChangelogs(modData.name, changelogs);
    };
    modDetailSecondaryActions.appendChild(changelogBtn);

    const nexusLinkBtn = document.createElement('a');
    nexusLinkBtn.className = 'detail-action-btn';
    nexusLinkBtn.textContent = 'Visit on Nexus';
    nexusLinkBtn.href = `https://www.nexusmods.com/nomanssky/mods/${modData.mod_id}`;
    nexusLinkBtn.target = '_blank';
    modDetailSecondaryActions.appendChild(nexusLinkBtn);

    if (!isPanelOpen) {
      // This tells us the width of the monitor the window is currently on.
      const screenWidth = window.screen.availWidth;

      // If the screen is big enough (PC), resize the window
      if (screenWidth >= PANEL_OPEN_WIDTH) {
        isPanelOpen = true; // Mark as expanded mode
        const currentSize = await appWindow.innerSize();
        await appWindow.setSize(new LogicalSize(PANEL_OPEN_WIDTH, currentSize.height));
      } else {
        // If screen is small (Steam Deck: 1280px), DO NOT resize window.
        isPanelOpen = false;
      }
    }

    modDetailPanel.classList.add('open');
  }

  async function showFileSelectionModal(modId) {
    const modData = curatedData.find(m => m.mod_id === modId);
    // Ensure files exist
    const filesData = { files: modData?.files || [] };

    if (!modData) {
      await window.customAlert("Could not find file information for this mod in the local data.", "Error");
      return;
    }

    fileSelectionModalTitle.textContent = `Download: ${modData.name}`;
    fileSelectionListContainer.innerHTML = '';

    const modIdStr = String(modId);

    // --- HELPER TO GENERATE ROWS ---
    const createFileRow = (file) => {
      const item = document.createElement('div');
      item.className = 'update-item';

      let buttonHtml = '';
      const installedFilesForThisMod = appState.installedModsMap.get(modIdStr);
      const fileIdStr = String(file.file_id);
      const installedVersionForThisFile = installedFilesForThisMod ? installedFilesForThisMod.get(fileIdStr) : undefined;

      const rawFileName = file.file_name;
      const remoteBaseName = getBaseName(file.name || file.file_name);
      let replacingFileId = "";

      if (installedVersionForThisFile) {
        // Case 1: Exact ID Match (You have this specific file installed)
        const isUpToDate = !isNewerVersionAvailable(installedVersionForThisFile, file.version);
        if (isUpToDate) {
          buttonHtml = `<button class="mod-card-install-btn" disabled>INSTALLED</button>`;
        } else {
          replacingFileId = fileIdStr;
          buttonHtml = `<button class="mod-card-install-btn" data-file-id="${fileIdStr}" data-mod-id="${modId}" data-version="${file.version}" data-raw-filename="${rawFileName}" data-replacing-file-id="${replacingFileId}">UPDATE</button>`;
        }
      } else {
        // Case 2: Smart Match (Different ID, check if it's an update to what you have)
        let isUpdateForAnotherFile = false;

        if (installedFilesForThisMod) {
          for (const [installedFileId, installedVersion] of installedFilesForThisMod.entries()) {

            let installedBaseName = "";

            // A. Try to get name from Remote Data
            const installedNexusFile = filesData.files.find(f => String(f.file_id) === installedFileId);
            if (installedNexusFile) {
              installedBaseName = getBaseName(installedNexusFile.name || installedNexusFile.file_name);
            } else {
              // B. FALLBACK: Try to get name from Local Cache (mod_info.json/install_source)
              for (const modEntry of appState.modDataCache.values()) {
                if (String(modEntry.local_info?.file_id) === installedFileId) {
                  if (modEntry.local_info.install_source) {
                    installedBaseName = getBaseName(modEntry.local_info.install_source);
                  }
                  break;
                }
              }
            }

            // Compare Names
            if (installedBaseName && installedBaseName === remoteBaseName) {
              // Compare Versions
              if (isNewerVersionAvailable(installedVersion, file.version)) {
                isUpdateForAnotherFile = true;
                replacingFileId = installedFileId;
                break;
              }
            }
          }
        }

        const buttonText = isUpdateForAnotherFile ? 'UPDATE' : 'DOWNLOAD';
        buttonHtml = `<button class="mod-card-install-btn" data-file-id="${fileIdStr}" data-mod-id="${modId}" data-version="${file.version}" data-raw-filename="${rawFileName}" data-replacing-file-id="${replacingFileId}">${buttonText}</button>`;
      }

      const displayName = file.name || file.file_name;

      item.innerHTML = `
                <div class="update-item-info">
                    <div class="update-item-name">${displayName} (v${file.version})</div>
                    <div class="update-item-version">${file.description || "No description."}</div>
                </div>
                ${buttonHtml}`;
      return item;
    };

    const allowedCategories = ['MAIN', 'OPTIONAL', 'MISCELLANEOUS', 'OLD_VERSION'];
    const categorizedFiles = {};
    for (const file of filesData.files) {
      const category = file.category_name;
      if (allowedCategories.includes(category)) {
        if (!categorizedFiles[category]) categorizedFiles[category] = [];
        categorizedFiles[category].push(file);
      }
    }

    let primaryFileId = -1;
    if (categorizedFiles['MAIN'] && categorizedFiles['MAIN'].length > 0) {
      categorizedFiles['MAIN'].sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp);
      const primaryMainFile = categorizedFiles['MAIN'][0];
      primaryFileId = primaryMainFile.file_id;
      const primaryContainer = document.createElement('div');
      primaryContainer.className = 'primary-file-container';
      primaryContainer.appendChild(createFileRow(primaryMainFile));
      fileSelectionListContainer.appendChild(primaryContainer);
    }

    const categoryOrder = ['OPTIONAL', 'MISCELLANEOUS', 'OLD_VERSION'];
    const collapsibleTemplate = document.getElementById('collapsibleSectionTemplate');
    const categoryDisplayNames = { 'OPTIONAL': 'Optional Files', 'MISCELLANEOUS': 'Miscellaneous', 'OLD_VERSION': 'Old Versions' };

    for (const category of categoryOrder) {
      if (categorizedFiles[category] && categorizedFiles[category].length > 0) {
        const section = collapsibleTemplate.content.cloneNode(true).firstElementChild;
        const header = section.querySelector('.collapsible-header');
        const content = section.querySelector('.collapsible-content');
        header.querySelector('.collapsible-title').textContent = categoryDisplayNames[category] || category;
        categorizedFiles[category].sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp);
        for (const file of categorizedFiles[category]) {
          if (file.file_id === primaryFileId) continue;
          content.appendChild(createFileRow(file));
        }
        if (content.hasChildNodes()) fileSelectionListContainer.appendChild(section);
      }
    }
    fileSelectionModalOverlay.classList.remove('hidden');
  }

  async function displayModInfo(modRow) {
    modRow.after(modInfoPanel);
    infoNexusLink.classList.add('hidden');

    const modFolderName = modRow.dataset.modName;
    // --- Read from the in-memory cache ---
    const cachedModData = appState.modDataCache.get(modFolderName);

    if (!cachedModData) {
      console.error("Could not find data for mod in cache:", modFolderName);
      infoModName.textContent = modFolderName;
      infoDescription.textContent = "Error: Could not load mod details.";
      infoAuthor.textContent = '...';
      infoInstalledVersion.textContent = '...';
      infoLatestVersion.textContent = '...';
      modInfoPanel.classList.remove('hidden');
      return;
    }

    // Use the pre-loaded local info
    const localModInfo = cachedModData.local_info;
    if (localModInfo && localModInfo.version) {
      infoInstalledVersion.textContent = localModInfo.version;
    } else {
      infoInstalledVersion.textContent = '...';
    }

    // Now, find the remote info
    const modId = localModInfo?.mod_id;
    const remoteInfo = modId ? curatedData.find(m => String(m.mod_id) === String(modId)) : null;

    // Prioritize showing remote data, but fall back to local/default data
    infoModName.textContent = remoteInfo?.name || modFolderName;
    infoAuthor.textContent = remoteInfo?.author || 'Unknown';
    infoDescription.textContent = remoteInfo?.summary || (localModInfo ? i18n.get('noDescription') : i18n.get('noLocalInfo'));

    // Logic to determine latest version
    let latestVersionToShow = remoteInfo?.version || 'N/A';

    if (remoteInfo) {
      // 1. Determine Identity of Installed File
      let installedBaseName = "";
      const installedFileOnNexus = localModInfo?.file_id
        ? remoteInfo.files.find(f => String(f.file_id) === String(localModInfo.file_id))
        : null;

      if (installedFileOnNexus) {
        installedBaseName = getBaseName(installedFileOnNexus.name || installedFileOnNexus.file_name);
      } else if (localModInfo?.install_source) {
        installedBaseName = getBaseName(localModInfo.install_source);
      } else {
        installedBaseName = null;
      }

      // 2. Find Best Match
      if (installedBaseName) {
        const filesToCheck = remoteInfo.files.filter(f => {
          if (f.category_name === 'OLD_VERSION') return false;
          const candidateBaseName = getBaseName(f.name || f.file_name);
          return candidateBaseName === installedBaseName;
        });

        if (filesToCheck.length > 0) {
          const latestFile = filesToCheck.sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
          latestVersionToShow = latestFile.version;
        }
      }
    }

    infoLatestVersion.textContent = latestVersionToShow;

    infoLatestVersion.classList.remove('update-available');
    if (localModInfo?.version && isNewerVersionAvailable(localModInfo.version, latestVersionToShow)) {
      infoLatestVersion.classList.add('update-available');
    }

    if (remoteInfo?.mod_id) {
      infoNexusLink.href = `https://www.nexusmods.com/nomanssky/mods/${remoteInfo.mod_id}`;
      infoNexusLink.classList.remove('hidden');
    }

    modInfoPanel.classList.remove('hidden');
  }

  // --- Event Listeners ---

  customCloseBtn.addEventListener('click', () => appWindow.close());

  const removeContextMenu = () => {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
  };
  window.addEventListener('click', removeContextMenu, true);
  window.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
      e.preventDefault();
    }
    removeContextMenu();
  }, true);

  modListContainer.addEventListener('contextmenu', (e) => {
    const modRow = e.target.closest('.mod-row');
    if (!modRow) return;

    e.preventDefault();
    e.stopPropagation();
    removeContextMenu();

    const clickedModName = modRow.dataset.modName;

    // If right-clicked on a mod that ISN'T in the current selection, select it solely
    if (!appState.selectedModNames.has(clickedModName)) {
      appState.selectedModNames.clear();
      appState.selectedModNames.add(clickedModName);
      modListContainer.querySelectorAll('.mod-row.selected').forEach(el => el.classList.remove('selected'));
      modRow.classList.add('selected');
    }

    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
    contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 85)}px`;

    const selectionCount = appState.selectedModNames.size;

    if (selectionCount > 1) {
      // --- BULK ACTIONS ---
      const deleteButton = document.createElement('button');
      deleteButton.textContent = i18n.get('deleteModBtn', { modName: `${selectionCount} Mods` }); // reuse key or add new "Delete X Mods"
      deleteButton.className = 'context-menu-item delete';
      deleteButton.onclick = async () => {
        removeContextMenu();
        const confirmed = await window.customConfirm(
          `Are you sure you want to delete these ${selectionCount} mods?`,
          "Confirm Bulk Deletion"
        );

        if (confirmed) {
          let successCount = 0;
          // Copy set to array to iterate safely
          const modsToDelete = Array.from(appState.selectedModNames);

          for (const modName of modsToDelete) {
            try {
              await invoke('delete_mod', { modName: modName });

              // Cleanup history locally
              const deletedItem = downloadHistory.find(item => item.modFolderName && item.modFolderName.toUpperCase() === modName.toUpperCase());
              if (deletedItem) {
                deletedItem.statusText = i18n.get('statusUnpacked');
                deletedItem.statusClass = 'unpacked';
                deletedItem.modFolderName = null;
              }
              successCount++;
            } catch (err) {
              console.error(`Failed to delete ${modName}:`, err);
            }
          }

          // Reload List
          const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
          const content = await readTextFile(settingsPath);
          await loadXmlContent(content, settingsPath);
          await saveDownloadHistory(downloadHistory);
          await saveCurrentProfile();

          await window.customAlert(`Successfully deleted ${successCount} mods.`, "Deleted");
        }
      };
      contextMenu.appendChild(deleteButton);

    } else {
      // --- SINGLE ACTIONS (Existing + Rename) ---
      const modName = clickedModName;

      const renameButton = document.createElement('button');
      renameButton.textContent = i18n.get('renameBtn');
      renameButton.className = 'context-menu-item';
      renameButton.onclick = async () => {
        removeContextMenu();
        const newName = await window.customPrompt(
          `Enter new name for "${modName}":`,
          "Rename Mod",
          modName
        );

        if (newName && newName !== modName) {
          try {
            const newRenderList = await invoke('rename_mod_folder', {
              oldName: modName,
              newName: newName
            });

            // Update History reference
            const historyItem = downloadHistory.find(item => item.modFolderName === modName);
            if (historyItem) {
              historyItem.modFolderName = newName;
              await saveDownloadHistory(downloadHistory);
            }

            // Re-render
            await renderModList(newRenderList);
            // Refresh XML doc in memory
            const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
            const content = await readTextFile(settingsPath);
            appState.xmlDoc = new DOMParser().parseFromString(content, "application/xml");

            await saveCurrentProfile();

          } catch (e) {
            await window.customAlert(`Rename failed: ${e}`, "Error");
          }
        }
      };
      contextMenu.appendChild(renameButton);

      const copyButton = document.createElement('button');
      copyButton.textContent = i18n.get('copyModNameBtn');
      copyButton.className = 'context-menu-item';
      copyButton.onclick = async () => {
        removeContextMenu();
        try {
          await navigator.clipboard.writeText(modName);
          await window.customAlert(i18n.get('copySuccess', { modName }), "Success");
        } catch (err) { /* ignore */ }
      };
      contextMenu.appendChild(copyButton);

      const priorityButton = document.createElement('button');
      priorityButton.textContent = i18n.get('ctxChangePriority');
      priorityButton.className = 'context-menu-item';
      priorityButton.onclick = () => {
        removeContextMenu();
        const allRows = Array.from(modListContainer.querySelectorAll('.mod-row'));
        const modIndex = allRows.findIndex(row => row.dataset.modName === modName);
        const maxPriority = allRows.length - 1;
        priorityModalTitle.textContent = i18n.get('priorityModalTitleWithMod', { modName: modName });
        priorityModalDescription.textContent = i18n.get('priorityModalDesc', { max: maxPriority });
        priorityInput.value = modIndex;
        priorityInput.max = maxPriority;
        priorityModalOverlay.dataset.modName = modName;
        priorityModalOverlay.classList.remove('hidden');
        // Auto focus the input
        setTimeout(() => priorityInput.focus(), 50);
      };
      contextMenu.appendChild(priorityButton);

      const deleteButton = document.createElement('button');
      deleteButton.textContent = i18n.get('deleteModBtn', { modName });
      deleteButton.className = 'context-menu-item delete';
      deleteButton.onclick = async () => {
        removeContextMenu();
        const confirmed = await window.customConfirm(
          i18n.get('confirmDeleteMod', { modName }),
          i18n.get('confirmDeleteTitle')
        );
        if (confirmed) {
          try {
            const modsToRender = await invoke('delete_mod', { modName: modName });

            // Sync XML memory
            try {
              const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
              const content = await readTextFile(settingsPath);
              appState.xmlDoc = new DOMParser().parseFromString(content, "application/xml");
            } catch (e) {
              location.reload();
              return;
            }

            await renderModList(modsToRender);

            const deletedItem = downloadHistory.find(item => item.modFolderName && item.modFolderName.toUpperCase() === modName.toUpperCase());
            if (deletedItem) {
              deletedItem.statusText = i18n.get('statusUnpacked');
              deletedItem.statusClass = 'unpacked';
              deletedItem.modFolderName = null;
              await saveDownloadHistory(downloadHistory);
              if (deletedItem.modId) updateModDisplayState(deletedItem.modId);
            }

            await window.customAlert(i18n.get('deleteSuccess', { modName }), "Deleted");
            await saveCurrentProfile();

          } catch (error) {
            await window.customAlert(`${i18n.get('deleteError', { modName })}\n\n${error}`, "Error");
          }
        }
      };
      contextMenu.appendChild(deleteButton);
    }

    document.body.appendChild(contextMenu);
  });

  modListContainer.addEventListener('mousedown', (e) => {
    if (e.target.closest('.switch') || e.button !== 0) return;
    const row = e.target.closest('.mod-row');
    if (!row) return;

    const modName = row.dataset.modName;

    // Check if this specific row is the ONLY one currently selected
    const isAlreadyTheSingleSelection = appState.selectedModNames.has(modName) && appState.selectedModNames.size === 1;

    // --- MULTI-SELECT LOGIC (CTRL) ---
    if (e.ctrlKey) {
      e.preventDefault();
      if (appState.selectedModNames.has(modName)) {
        appState.selectedModNames.delete(modName);
        row.classList.remove('selected');
        if (appState.selectedModRow === row) {
          appState.selectedModRow = null;
          modInfoPanel.classList.add('hidden');
        }
      } else {
        appState.selectedModNames.add(modName);
        row.classList.add('selected');
      }
      return;
    }

    // --- SINGLE SELECT LOGIC ---
    // If it's NOT the currently selected item (or there are multiple), select it immediately.
    // If it IS the currently selected item, do NOTHING yet. We wait to see if it's a Click (Toggle Off) or a Drag (Keep Selected).
    if (!isAlreadyTheSingleSelection) {
      modListContainer.querySelectorAll('.mod-row.selected').forEach(el => el.classList.remove('selected'));
      appState.selectedModNames.clear();
      appState.selectedModNames.add(modName);
      row.classList.add('selected');
    }

    // --- DRAG / CLICK HANDLING ---
    e.preventDefault();
    const DRAG_DELAY = 200;

    const handleMouseUpAsClick = () => {
      clearTimeout(dragState.dragTimer);
      document.removeEventListener('mouseup', handleMouseUpAsClick);

      // LOGIC: If we clicked the item that was ALREADY selected, we Toggle it OFF.
      if (isAlreadyTheSingleSelection) {
        appState.selectedModNames.delete(modName);
        row.classList.remove('selected');
        appState.selectedModRow = null;
        modInfoPanel.classList.add('hidden');
        return;
      }

      // Otherwise, show info
      if (appState.selectedModNames.size === 1) {
        appState.selectedModRow = row;
        displayModInfo(row);
      } else {
        modInfoPanel.classList.add('hidden');
      }
    };

    document.addEventListener('mouseup', handleMouseUpAsClick);

    dragState.dragTimer = setTimeout(() => {
      document.removeEventListener('mouseup', handleMouseUpAsClick);

      if (appState.selectedModNames.size > 1) return;

      if (appState.selectedModRow) {
        appState.selectedModRow = null;
        modInfoPanel.classList.add('hidden');
      }
      dragState.draggedElement = row;

      const rect = dragState.draggedElement.getBoundingClientRect();
      dragState.offsetX = e.clientX - rect.left;
      dragState.offsetY = e.clientY - rect.top;

      dragState.placeholder = document.createElement('div');
      dragState.placeholder.className = 'placeholder';
      dragState.placeholder.style.height = `${rect.height}px`;

      dragState.ghostElement = dragState.draggedElement.cloneNode(true);
      dragState.ghostElement.classList.add('ghost');
      document.body.appendChild(dragState.ghostElement);

      dragState.ghostElement.style.width = `${rect.width}px`;
      dragState.ghostElement.style.left = `${e.clientX - dragState.offsetX}px`;
      dragState.ghostElement.style.top = `${e.clientY - dragState.offsetY}px`;

      dragState.draggedElement.parentNode.insertBefore(dragState.placeholder, dragState.draggedElement);
      dragState.draggedElement.classList.add('is-dragging');

      scrollState.animationFrameId = requestAnimationFrame(autoScrollLoop);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }, DRAG_DELAY);
  });

  const filterModList = () => {
    const searchTerm = searchModsInput.value.trim().toLowerCase();
    const modRows = modListContainer.querySelectorAll('.mod-row');
    modRows.forEach(row => {
      const modNameElement = row.querySelector('.mod-name-text');
      if (modNameElement) {
        const modName = modNameElement.textContent.toLowerCase();
        row.style.display = modName.includes(searchTerm) ? 'flex' : 'none';
      }
    });
  };
  searchModsInput.addEventListener('input', filterModList);

  enableAllBtn.addEventListener('click', () => setAllModsEnabled(true));
  disableAllBtn.addEventListener('click', () => setAllModsEnabled(false));

  updateCheckBtn.addEventListener('click', async () => {
    await fetchCuratedData();
    await checkForUpdates(false);
  });

  closeUpdateModalBtn.addEventListener('click', () => updateModalOverlay.classList.add('hidden'));
  updateModalOverlay.addEventListener('click', (e) => {
    if (e.target === updateModalOverlay) updateModalOverlay.classList.add('hidden');
  });

  loadFileBtn.addEventListener('click', async () => {
    let startDir = appState.gamePath ? `${appState.gamePath}\\Binaries\\SETTINGS` : undefined;
    const selPath = await open({ title: i18n.get('loadFileBtn'), defaultPath: startDir, filters: [{ name: 'MXML Files', extensions: ['mxml'] }] });
    if (typeof selPath === 'string') {
      const content = await readTextFile(selPath);
      await loadXmlContent(content, selPath);
    }
  });

  openModsFolderBtn.addEventListener('click', () => invoke('open_mods_folder'));

  disableAllSwitch.addEventListener('change', () => {
    const daNode = appState.xmlDoc.querySelector('Property[name="DisableAllMods"]');
    if (daNode) { daNode.setAttribute('value', disableAllSwitch.checked ? 'true' : 'false'); saveChanges(); }
  });

  async function updateNXMButtonState() {
    try {
      const isRegistered = await invoke('is_protocol_handler_registered');
      const btn = document.getElementById('nxmHandlerBtn');
      const statusEl = document.getElementById('nxmHandlerStatus');

      if (isRegistered) {
        // Use i18n.get to fetch the text dynamically based on current language
        btn.textContent = i18n.get('removeHandlerBtn');
        btn.className = 'modal-btn-nxm';
        btn.classList.remove('modal-btn-nxm-confirm');
        if (statusEl) statusEl.classList.add('hidden');
      } else {
        btn.textContent = i18n.get('setHandlerBtn');
        btn.className = 'modal-btn-nxm-confirm';
        btn.classList.remove('modal-btn-nxm');
        if (statusEl) statusEl.classList.add('hidden');
      }
    } catch (e) {
      console.warn("NXM check failed", e);
    }
  }

  settingsBtn.addEventListener('click', async () => {
    await updateNXMButtonState();

    document.getElementById('nxmHandlerStatus').classList.add('hidden');
    settingsModalOverlay.classList.remove('hidden');
    updateDownloadPathUI();
    updateLibraryPathUI();
  });
  closeSettingsModalBtn.addEventListener('click', () => settingsModalOverlay.classList.add('hidden'));
  settingsModalOverlay.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) settingsModalOverlay.classList.add('hidden');
  });

  const changeLibraryDirBtn = document.getElementById('changeLibraryDirBtn');
  const currentLibraryPathEl = document.getElementById('currentLibraryPath');

  async function updateLibraryPathUI() {
    try {
      const path = await invoke('get_library_path');
      currentLibraryPathEl.textContent = path;
    } catch (e) {
      currentLibraryPathEl.textContent = "Error loading path";
    }
  }

  changeLibraryDirBtn.addEventListener('click', async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select New Library Folder"
      });

      if (selected) {
        // Show loading state because moving files might take a moment
        currentLibraryPathEl.textContent = "Moving files... please wait...";

        await invoke('set_library_path', { newPath: selected });
        await updateLibraryPathUI();

        await window.customAlert(`Library moved to:\n${selected}/Library`, "Success");
      }
    } catch (e) {
      await window.customAlert(`Failed to move library: ${e}`, "Error");
      updateLibraryPathUI();
    }
  });

  // --- SLIDER LOGIC ---

  // 1. List Density
  rowPaddingSlider.addEventListener('input', function () {
    rowPaddingValue.textContent = this.value;
    document.documentElement.style.setProperty('--mod-row-vertical-padding', `${this.value}px`);
    updateSliderFill(this);
  });
  rowPaddingSlider.addEventListener('change', function () {
    localStorage.setItem('modRowPadding', this.value);
  });

  // 2. Grid Density
  gridGapSlider.addEventListener('input', function () {
    gridGapValue.textContent = this.value;
    document.documentElement.style.setProperty('--browse-grid-gap', `${this.value}px`);
    updateSliderFill(this);
  });
  gridGapSlider.addEventListener('change', function () {
    localStorage.setItem('browseGridGap', this.value);
  });

  // 3. Mods Per Page
  const modsPerPageSlider = document.getElementById('modsPerPageSlider');
  const modsPerPageValue = document.getElementById('modsPerPageValue');

  modsPerPageSlider.addEventListener('input', function () {
    modsPerPageValue.textContent = this.value;
    updateSliderFill(this);
  });

  modsPerPageSlider.addEventListener('change', function () {
    const newValue = parseInt(this.value, 10);
    appState.modsPerPage = newValue;
    localStorage.setItem('modsPerPage', newValue);
    appState.currentPage = 1;
    filterAndDisplayMods();
  });

  deleteSettingsBtn.addEventListener('click', async () => {
    const confirmed = await window.customConfirm(
      i18n.get('troubleshootModalDesc'),
      i18n.get('troubleshootModalTitle')
    );
    if (!confirmed) return;
    try {
      const resultKey = await invoke('delete_settings_file');
      appState.currentFilePath = null;
      appState.xmlDoc = null;
      filePathLabel.textContent = i18n.get('noFileLoaded');
      disableAllSwitch.checked = false;
      disableAllSwitch.disabled = true;
      modListContainer.innerHTML = '';
      await window.customAlert(i18n.get(resultKey), "Success");
    } catch (error) {
      await window.customAlert(`Error: ${error}`, "Error");
    }
  });

  const cleanStagingBtn = document.getElementById('cleanStagingBtn');
  cleanStagingBtn.addEventListener('click', async () => {
    try {
      const count = await invoke('clean_staging_folder');

      if (count > 0) {
        await window.customAlert(
          i18n.get('cleanStagingSuccess', { count: count }),
          i18n.get('cleanupTitle')
        );
      } else {
        await window.customAlert(
          i18n.get('cleanStagingEmpty'),
          i18n.get('cleanupTitle')
        );
      }
    } catch (e) {
      await window.customAlert(`${i18n.get('cleanStagingError')}: ${e}`, "Error");
    }
  });

  const setupDragAndDrop = async () => {
    console.log("Setting up Drag & Drop listeners...");

    // Helper to handle visual feedback
    const showHighlight = () => {
      dropZone.classList.add('drag-over');
    };

    const hideHighlight = () => {
      dropZone.classList.remove('drag-over');
    };

    // --- 1. Hover Events ---
    const onDragEnter = (event) => {
      if (dragState.draggedElement) return;

      // Debug Log: Useful to see if hover events trigger layout shifts
      console.log("Drag enter detected");
      showHighlight();
    };

    await appWindow.listen('tauri://file-drop-hover', onDragEnter);
    await appWindow.listen('tauri://drag-enter', onDragEnter);

    // --- 2. Cancel/Leave Events ---
    const onDragLeave = () => {
      console.log("Drag leave detected");
      hideHighlight();
    };

    await appWindow.listen('tauri://file-drop-cancelled', onDragLeave);
    await appWindow.listen('tauri://drag-leave', onDragLeave);

    // --- 3. Drop Event ---
    const onDrop = async (event) => {
      console.log("File drop detected:", event);

      if (dragState.draggedElement) return;
      hideHighlight();

      let files = event.payload;
      if (files && files.paths) files = files.paths;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return;
      }

      // LOGGING: Catch the event start
      window.addAppLog(`File Drop Detected: ${files.length} paths received.`, "INFO");

      if (!appState.xmlDoc) {
        await window.customAlert("Please load a GCMODSETTINGS.MXML file first.", "Error");
        return;
      }

      const archiveFiles = files.filter(p => /\.(zip|rar|7z)$/i.test(p));
      if (archiveFiles.length === 0) {
        window.addAppLog("File Drop ignored: No valid archives found in drop.", "WARN");
        return;
      }

      for (const filePath of archiveFiles) {
        const fileName = await basename(filePath);

        // Check if this filename is already in the history
        const existingIndex = downloadHistory.findIndex(d => d.fileName === fileName);

        // If found, remove it so it can add the fresh one to the top
        if (existingIndex > -1) {
          downloadHistory.splice(existingIndex, 1);
        }

        // LOGGING: Track specific file processing
        window.addAppLog(`Processing dropped file: ${fileName}`, "INFO");

        const downloadId = `manual-${Date.now()}`;
        const newItem = {
          id: downloadId,
          modId: "",
          fileId: "",
          version: 'Manual',
          displayName: fileName,
          fileName: fileName,
          statusText: i18n.get('statusWaiting') || "Installing...",
          statusClass: 'progress',
          archivePath: null,
          modFolderName: null,
          size: 0,
          createdAt: Date.now() / 1000
        };

        downloadHistory.unshift(newItem);
        renderDownloadHistory();

        try {
          console.log(`Processing dropped file: ${fileName}`);

          // 2. Phase 1: Analyze / Extract
          const analysis = await invoke('install_mod_from_archive', {
            archivePathStr: filePath,
            downloadId: downloadId
          });

          if (analysis.active_archive_path) {
            newItem.archivePath = analysis.active_archive_path;
          }

          let finalResult = analysis;

          // 3. Phase 2: Selection or Direct Install
          if (analysis.selection_needed) {
            const userResult = await openFolderSelectionModal(
              analysis.available_folders,
              fileName,
              analysis.temp_id
            );

            if (!userResult) {
              // CANCELLED
              await invoke('clean_staging_folder');
              newItem.statusText = i18n.get('statusCancelled') || "Cancelled";
              newItem.statusClass = 'cancelled';

              window.addAppLog(`User cancelled folder selection for: ${fileName}`, "INFO");

              await saveDownloadHistory(downloadHistory);
              renderDownloadHistory();

              // --- Revert status after 5 seconds ---
              setTimeout(() => {
                const current = downloadHistory.find(d => d.id === downloadId);
                if (current && current.statusClass === 'cancelled') {
                  current.statusText = i18n.get('statusDownloaded');
                  current.statusClass = 'success';
                  renderDownloadHistory();
                  saveDownloadHistory(downloadHistory);
                }
              }, 5000);

              continue;
            }

            finalResult = await invoke('finalize_installation', {
              libraryId: analysis.temp_id,
              selectedFolders: userResult.selected,
              flattenPaths: userResult.flatten
            });

            await processInstallAnalysis(finalResult, newItem, false);

          } else {
            await processInstallAnalysis(analysis, newItem, false);
          }

          // 4. Success Popup (With Suppression Logic)
          const installedCount = finalResult.successes ? finalResult.successes.length : 0;

          // Check preference
          const suppressSuccess = localStorage.getItem('suppressInstallSuccess') === 'true';

          if (!suppressSuccess && installedCount > 0) {
            // We use customConfirm here.
            // TRUE = OK
            // FALSE = Don't Show Again
            const keepShowing = await window.customConfirm(
              i18n.get('installCompleteMsg', {
                count: installedCount,
                fileName: fileName
              }),
              i18n.get('installCompleteTitle'),
              i18n.get('okBtn'),              // "OK"
              i18n.get('dontShowAgainBtn')    // "Don't Show Again"
            );

            if (keepShowing === false) {
              localStorage.setItem('suppressInstallSuccess', 'true');
            }
          }

          // LOGGING: Success
          window.addAppLog(`Successfully installed dropped file: ${fileName}`, "INFO");

        } catch (error) {
          // LOGGING: Error
          const errMsg = `Drag/Drop install failed for ${fileName}: ${error}`;
          window.addAppLog(errMsg, "ERROR");
          console.error(`Error installing ${fileName}:`, error);

          newItem.statusText = "Error";
          newItem.statusClass = "error";
          renderDownloadHistory();

          await window.customAlert(`${i18n.get('installFailedTitle')}: ${error}`, "Error");

          // 5. Cleanup on Failure
          try {
            const downloadsDir = await invoke('get_downloads_path');
            const targetPath = await join(downloadsDir, fileName);
            await invoke('delete_archive_file', { path: targetPath });

            downloadHistory = downloadHistory.filter(d => d.id !== downloadId);
            renderDownloadHistory();
            await saveDownloadHistory(downloadHistory);
          } catch (delErr) {
            console.warn("Failed to cleanup bad zip:", delErr);
          }
        }
      }
    };

    await appWindow.listen('tauri://file-drop', onDrop);
    await appWindow.listen('tauri://drag-drop', onDrop);
  };

  const folderSelectionModal = document.getElementById('folderSelectionModal');
  const folderSelectionList = document.getElementById('folderSelectionList');
  const fsmCancelBtn = document.getElementById('fsmCancelBtn');
  const fsmInstallAllBtn = document.getElementById('fsmInstallAllBtn');
  const fsmInstallSelectedBtn = document.getElementById('fsmInstallSelectedBtn');
  const flattenStructureCb = document.getElementById('flattenStructureCb');

  function openFolderSelectionModal(folders, modName, tempId) {
    return new Promise((resolve) => {
      folderSelectionList.innerHTML = '';
      flattenStructureCb.checked = false;

      function getCleanZipName(rawName) {
        let clean = rawName.replace(/\.(zip|rar|7z)$/i, '');
        clean = clean.replace(/-[\d.]+(-[\d.]+)*$/, '');
        return clean;
      }

      function getCommonPrefix(paths) {
        if (!paths || paths.length === 0) return null;

        const separator = paths[0].includes('/') ? '/' : '\\';
        const firstPathParts = paths[0].split(separator);
        if (firstPathParts.length < 2) return null;

        const potentialParent = firstPathParts[0];
        const allShare = paths.every(p => p.startsWith(potentialParent + separator));

        return allShare ? potentialParent : null;
      }

      let rootLabel = getCleanZipName(modName);
      const commonParent = getCommonPrefix(folders);
      if (commonParent) {
        rootLabel = commonParent;
      }

      function handleCheckboxChange(targetCheckbox, wrapper) {
        const isChecked = targetCheckbox.checked;
        const childrenContainer = wrapper.querySelector('.fs-children');
        if (childrenContainer) {
          const childCheckboxes = childrenContainer.querySelectorAll('.folder-select-checkbox');
          childCheckboxes.forEach(cb => cb.checked = isChecked);
        }
        updateParentCheckbox(wrapper);
      }

      function updateParentCheckbox(element) {
        const parentContainer = element.closest('.fs-children');
        if (!parentContainer) return;

        const parentWrapper = parentContainer.closest('.fs-wrapper');
        if (!parentWrapper) return;

        const parentCheckbox = parentWrapper.querySelector('.fs-item-row > .folder-select-checkbox');
        if (!parentCheckbox) return;

        const siblings = parentContainer.querySelectorAll(':scope > .fs-wrapper > .fs-item-row > .folder-select-checkbox');
        const allChecked = Array.from(siblings).every(cb => cb.checked);
        const someChecked = Array.from(siblings).some(cb => cb.checked);

        if (allChecked) {
          parentCheckbox.checked = true;
          parentCheckbox.indeterminate = false;
        } else if (someChecked) {
          parentCheckbox.checked = false;
          parentCheckbox.indeterminate = true;
        } else {
          parentCheckbox.checked = false;
          parentCheckbox.indeterminate = false;
        }

        updateParentCheckbox(parentWrapper);
      }

      // --- MODIFIED: Added isPreloaded argument ---
      function renderTreeItem(name, relativePath, isDir, container, parentIsChecked = false, isPreloaded = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'fs-wrapper';

        const row = document.createElement('div');
        row.className = 'fs-item-row';
        row.title = relativePath;

        const expander = document.createElement('div');
        expander.className = isDir ? 'fs-expander' : 'fs-expander placeholder';
        expander.textContent = isDir ? '▶' : '';
        row.appendChild(expander);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'folder-select-checkbox fs-checkbox';
        checkbox.value = relativePath;

        if (parentIsChecked) checkbox.checked = true;

        checkbox.onclick = (e) => {
          e.stopPropagation();
          handleCheckboxChange(checkbox, wrapper);
        };
        row.appendChild(checkbox);

        const label = document.createElement('span');
        label.className = 'fs-label';

        const displayName = name.split(/[/\\]/).pop();
        label.textContent = displayName;

        label.style.color = isDir ? 'var(--c-text-primary)' : 'rgba(255,255,255,0.6)';
        if (!isDir) label.style.fontStyle = 'italic';

        row.appendChild(label);
        wrapper.appendChild(row);

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'fs-children hidden';
        wrapper.appendChild(childrenContainer);

        label.onclick = () => {
          checkbox.checked = !checkbox.checked;
          handleCheckboxChange(checkbox, wrapper);
        };

        if (isDir) {
          let loaded = isPreloaded;

          expander.onclick = async (e) => {
            e.stopPropagation();
            const isClosed = childrenContainer.classList.contains('hidden');
            if (isClosed) {
              expander.classList.add('open');
              childrenContainer.classList.remove('hidden');
              if (!loaded) {
                childrenContainer.innerHTML = '<div style="padding:5px 0 5px 25px; opacity:0.5; font-size:12px;">Loading...</div>';
                try {
                  const contents = await invoke('get_staging_contents', {
                    tempId: tempId,
                    relativePath: relativePath
                  });
                  childrenContainer.innerHTML = '';
                  if (contents.length === 0) {
                    childrenContainer.innerHTML = '<div style="padding:5px 0 5px 25px; opacity:0.5; font-size:12px;">(Empty)</div>';
                  } else {
                    contents.forEach(node => {
                      const childPath = relativePath === "."
                        ? node.name
                        : `${relativePath}/${node.name}`;
                      // Children are NOT preloaded
                      renderTreeItem(node.name, childPath, node.is_dir, childrenContainer, checkbox.checked, false);
                    });
                  }
                  loaded = true;
                } catch (err) {
                  childrenContainer.innerHTML = `<div style="color:red; padding-left:25px; font-size:12px;">Error: ${err}</div>`;
                }
              }
            } else {
              expander.classList.remove('open');
              childrenContainer.classList.add('hidden');
            }
          };
        }
        container.appendChild(wrapper);
      }

      // --- INITIAL RENDER ---

      // 1. Render Root with isPreloaded = true
      // This prevents it from fetching data again when collapsed/expanded
      renderTreeItem(rootLabel, ".", true, folderSelectionList, false, true);

      const rootWrapper = folderSelectionList.firstElementChild;
      const rootExpander = rootWrapper.querySelector('.fs-expander');
      const rootChildren = rootWrapper.querySelector('.fs-children');

      // Populate children manually
      folders.forEach(childName => {
        renderTreeItem(childName, childName, true, rootChildren, false, false);
      });

      if (rootExpander && rootChildren) {
        rootExpander.classList.add('open');
        rootChildren.classList.remove('hidden');
      }

      folderSelectionModal.classList.remove('hidden');

      const cleanup = () => {
        folderSelectionModal.classList.add('hidden');
        fsmCancelBtn.onclick = null;
        fsmInstallAllBtn.onclick = null;
        fsmInstallSelectedBtn.onclick = null;
      };

      fsmCancelBtn.onclick = () => {
        cleanup();
        resolve(null);
      };

      fsmInstallAllBtn.onclick = () => {
        const isFlatten = flattenStructureCb.checked;
        cleanup();
        resolve({ selected: [], flatten: isFlatten });
      };

      fsmInstallSelectedBtn.onclick = () => {
        // 1. Get all checked values
        let rawSelected = Array.from(document.querySelectorAll('.folder-select-checkbox:checked'))
          .map(cb => cb.value);

        // 2. Filter out the root dot "."
        rawSelected = rawSelected.filter(val => val !== ".");

        // 3. Remove children if their parent is already selected
        rawSelected.sort();

        const finalSelected = [];

        for (const path of rawSelected) {
          const isRedundant = finalSelected.some(parent => {
            return path.startsWith(parent + "/") || path.startsWith(parent + "\\");
          });

          // If it's not a child of an existing selection, add it.
          if (!isRedundant) {
            finalSelected.push(path);
          }
        }

        const isFlatten = flattenStructureCb.checked;
        cleanup();

        if (finalSelected.length === 0) {
          resolve(null);
        } else {
          resolve({ selected: finalSelected, flatten: isFlatten });
        }
      };
    });
  }

  // --- PROFILE MANAGEMENT LOGIC ---

  const profileSelect = document.getElementById('profileSelect');
  const applyProfileBtn = document.getElementById('applyProfileBtn');
  const addProfileBtn = document.getElementById('addProfileBtn');
  const renameProfileBtn = document.getElementById('renameProfileBtn');
  const deleteProfileBtn = document.getElementById('deleteProfileBtn');

  // Progress Modal Elements
  const profileProgressModal = document.getElementById('profileProgressModal');
  const profileProgressText = document.getElementById('profileProgressText');
  const profileProgressBar = document.getElementById('profileProgressBar');
  const profileTimeEst = document.getElementById('profileTimeEst');

  async function refreshProfileList() {
    try {
      const profiles = await invoke('list_profiles');

      // Save the currently selected value in the dropdown to restore it if it still exists
      const currentSelection = profileSelect.value;

      profileSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        profileSelect.appendChild(opt);
      });

      // If the previously selected profile still exists, keep it selected.
      // Otherwise, default to "Default".
      if (profiles.includes(currentSelection)) {
        profileSelect.value = currentSelection;
      } else {
        profileSelect.value = 'Default';
      }

      updateApplyButtonVisibility();
    } catch (err) {
      console.error("Failed to refresh profiles:", err);
    }
  }

  const openProfileManagerBtn = document.getElementById('openProfileManagerBtn');
  const profileManagerModal = document.getElementById('profileManagerModal');
  const mpProfileList = document.getElementById('mpProfileList');

  // State for the modal selection
  let selectedProfileInModal = null;

  // Helper: Render the list inside the modal
  async function renderManagerList() {
    const profiles = await invoke('list_profiles');
    mpProfileList.innerHTML = '';

    profiles.forEach(p => {
      const li = document.createElement('li');
      li.className = 'mp-list-item';
      li.textContent = p;

      // Highlight logic
      if (p === selectedProfileInModal) li.classList.add('active');
      else if (!selectedProfileInModal && p === appState.activeProfile) {
        li.classList.add('active');
        selectedProfileInModal = p;
      }

      // Click to select
      li.onclick = () => {
        document.querySelectorAll('.mp-list-item').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
        selectedProfileInModal = p;
      };

      // Double click to "Select & Apply"
      li.ondblclick = () => {
        selectedProfileInModal = p;
        document.getElementById('mpSelectBtn').click();
      };

      mpProfileList.appendChild(li);
    });
  }

  // Open Modal
  openProfileManagerBtn.addEventListener('click', async () => {
    selectedProfileInModal = appState.activeProfile; // Reset selection to current active
    await renderManagerList();
    profileManagerModal.classList.remove('hidden');
  });

  // Close Modal Logic
  const closeManager = () => profileManagerModal.classList.add('hidden');
  document.getElementById('mpCloseBtn').addEventListener('click', closeManager);

  const mpOpenFolderBtn = document.getElementById('mpOpenFolderBtn');
  mpOpenFolderBtn.addEventListener('click', async () => {
    try {
      await invoke('open_special_folder', { folderType: 'profiles' });
    } catch (e) {
      console.error(e);
    }
  });

  // --- MODAL ACTION BUTTONS ---

  // 1. ADD
  document.getElementById('mpCreateBtn').addEventListener('click', async () => {
    const name = await window.customPrompt(i18n.get('enterProfileName'), i18n.get('addBtn'));
    if (name && name.trim() !== "") {
      try {
        await invoke('create_empty_profile', { profileName: name });

        // Update both lists
        await renderManagerList();
        await refreshProfileList();

        // Auto-select the new one in modal
        selectedProfileInModal = name;
        renderManagerList();
      } catch (e) { await window.customAlert("Error: " + e, "Error"); }
    }
  });

  // 2. COPY
  document.getElementById('mpCopyBtn').addEventListener('click', async () => {
    if (!selectedProfileInModal) return;

    const newName = await window.customPrompt(
      i18n.get('copyProfilePrompt', { source: selectedProfileInModal }),
      i18n.get('copyBtn')
    );
    if (newName && newName.trim() !== "") {
      try {
        await invoke('copy_profile', {
          sourceName: selectedProfileInModal,
          newName: newName
        });

        await renderManagerList();
        await refreshProfileList();

        selectedProfileInModal = newName; // Select the copy
        renderManagerList();
      } catch (e) { await window.customAlert("Error copying: " + e, "Error"); }
    }
  });

  // 3. RENAME
  document.getElementById('mpRenameBtn').addEventListener('click', async () => {
    if (!selectedProfileInModal) return;
    if (selectedProfileInModal === 'Default') return await window.customAlert(i18n.get('cannotRenameDefault'), "Action Denied");

    const newName = await window.customPrompt(
      i18n.get('renameProfilePrompt', { profile: selectedProfileInModal }),
      i18n.get('renameBtn'),
      selectedProfileInModal // Pass current name as default value
    );
    if (newName && newName !== selectedProfileInModal) {
      try {
        await invoke('rename_profile', { oldName: selectedProfileInModal, newName: newName });

        // If we renamed the currently ACTIVE profile, update global state
        if (appState.activeProfile === selectedProfileInModal) {
          appState.activeProfile = newName;
          localStorage.setItem('activeProfile', newName);
          // Update main dropdown selection too
          profileSelect.value = newName;
        }

        selectedProfileInModal = newName;
        await renderManagerList();
        await refreshProfileList();
      } catch (e) { await window.customAlert("Error renaming: " + e, "Error"); }
    }
  });

  // 4. DELETE
  document.getElementById('mpRemoveBtn').addEventListener('click', async () => {
    if (!selectedProfileInModal) return;
    if (selectedProfileInModal === 'Default') return await window.customAlert(i18n.get('cannotDeleteDefault'), "Action Denied");

    if (await window.customConfirm(i18n.get('deleteProfileConfirm', { profile: selectedProfileInModal }), "Confirm")) {
      try {
        await invoke('delete_profile', { profileName: selectedProfileInModal });

        // Handle if active was deleted
        if (appState.activeProfile === selectedProfileInModal) {
          appState.activeProfile = null;
          localStorage.removeItem('activeProfile');
          profileSelect.value = 'Default';
          updateApplyButtonVisibility();
        }

        selectedProfileInModal = 'Default';
        await renderManagerList();
        await refreshProfileList();
      } catch (e) { await window.customAlert("Error deleting: " + e, "Error"); }
    }
  });

  // 5. SELECT / APPLY
  document.getElementById('mpSelectBtn').addEventListener('click', async () => {
    if (!selectedProfileInModal) return;

    closeManager();

    // Set the main dropdown to what was selected here
    profileSelect.value = selectedProfileInModal;
    updateApplyButtonVisibility();

    // Automatically trigger the Apply logic
    document.getElementById('applyProfileBtn').click();
  });

  function updateApplyButtonVisibility() {
    if (profileSelect.value !== appState.activeProfile) {
      applyProfileBtn.classList.remove('hidden');
    } else {
      applyProfileBtn.classList.add('hidden');
    }
  }

  function getDetailedInstalledMods() {
    const installedMods = [];
    const seen = new Set();

    downloadHistory.forEach(item => {
      if (item.statusClass === 'installed' && item.fileName) {
        if (!seen.has(item.fileName)) {
          seen.add(item.fileName);
          installedMods.push({
            filename: item.fileName,
            mod_id: item.modId ? String(item.modId) : null,
            file_id: item.fileId ? String(item.fileId) : null,
            version: item.version ? String(item.version) : null
          });
        }
      }
    });
    return installedMods;
  }

  async function saveCurrentProfile() {
    if (appState.isPopulating) return;
    if (!appState.activeProfile) return;

    const modsData = getDetailedInstalledMods();

    try {
      await invoke('save_active_profile', {
        profileName: appState.activeProfile,
        mods: modsData
      });
      console.log(`Auto-saved profile: ${appState.activeProfile}`);
    } catch (e) {
      console.error("Failed to auto-save profile:", e);
    }
  }

  profileSelect.addEventListener('change', updateApplyButtonVisibility);

  addProfileBtn.addEventListener('click', async () => {
    const name = await window.customPrompt(i18n.get('enterProfileName'), i18n.get('addBtn'));
    if (name && name.trim() !== "") {
      try {
        await invoke('create_empty_profile', { profileName: name });

        await refreshProfileList();

        profileSelect.value = name;
        updateApplyButtonVisibility();

      } catch (e) { await window.customAlert("Error creating profile: " + e, "Error"); }
    }
  });

  renameProfileBtn.addEventListener('click', async () => {
    const current = profileSelect.value;
    if (current === 'Default') return await window.customAlert("Cannot rename Default profile.", "Action Denied");

    const newName = await window.customPrompt(
      i18n.get('renameProfilePrompt', { profile: current }),
      i18n.get('renameBtn'),
      current
    );
    if (newName && newName !== current) {
      try {
        await invoke('rename_profile', { oldName: current, newName: newName });

        // If renamed the active profile, update the state
        if (appState.activeProfile === current) {
          appState.activeProfile = newName;
          localStorage.setItem('activeProfile', newName);
        }

        await refreshProfileList();
        profileSelect.value = newName;
        updateApplyButtonVisibility();
      } catch (e) { await window.customAlert("Error renaming: " + e, "Error"); }
    }
  });

  deleteProfileBtn.addEventListener('click', async () => {
    const current = profileSelect.value;
    if (current === 'Default') return await window.customAlert("Cannot delete Default profile.", "Action Denied");

    if (await window.customConfirm(`Delete profile "${current}"?`, "Delete Profile")) {
      try {
        await invoke('delete_profile', { profileName: current });

        // 1. Refresh the list (the deleted profile will disappear)
        await refreshProfileList();

        // 2. Check if it deleted the Active Profile
        if (appState.activeProfile === current) {
          appState.activeProfile = null;
          localStorage.removeItem('activeProfile');

          // Force dropdown to Default
          profileSelect.value = 'Default';
        } else {
          // If it deleted an inactive profile, make sure dropdown stays on the current active one
          if (appState.activeProfile) {
            profileSelect.value = appState.activeProfile;
          }
        }

        // 3. This will now show the button because ('Default' !== null)
        updateApplyButtonVisibility();

      } catch (e) { await window.customAlert("Error deleting: " + e, "Error"); }
    }
  });

  applyProfileBtn.addEventListener('click', async () => {
    const targetProfile = profileSelect.value;

    // --- SAFETY CHECK START ---
    // Prevent re-applying the profile that is already active.
    // This prevents unnecessary file operations and "purging" the folder.
    if (targetProfile === appState.activeProfile) {
      await window.customAlert(
        `The profile "${targetProfile}" is already active.`,
        "Action Ignored"
      );
      return;
    }
    // --- SAFETY CHECK END ---

    const confirmed = await window.customConfirm(
      i18n.get('switchProfileMsg', {
        profileName: targetProfile
      }),
      i18n.get('switchProfileTitle')
    );

    // If the user clicked Cancel (false), stop everything immediately.
    if (!confirmed) {
      return;
    }

    // LOGGING: Start
    window.addAppLog(`Starting Profile Switch to: ${targetProfile}`, "INFO");

    // Show Modal
    profileProgressModal.classList.remove('hidden');
    profileProgressBar.style.width = '0%';
    profileProgressText.textContent = "Initializing...";

    const start = Date.now();

    // Listen for progress from Rust
    const unlisten = await listen('profile-progress', (event) => {
      const p = event.payload;

      // Math: ((Current Mod Index - 1) * 100 + Current File %) / Total Mods
      // This gives a smooth 0-100% value for the entire process
      const totalPercentage = ((p.current - 1) * 100 + p.file_progress) / p.total;

      profileProgressBar.style.width = `${totalPercentage}%`;
      profileProgressText.textContent = `Installing ${p.current}/${p.total}: ${p.current_mod}`;

      // --- Improved Time Estimation ---
      const elapsedSeconds = (Date.now() - start) / 1000;

      // Don't estimate in the first second to avoid "Infinity" or "0s" spikes
      if (elapsedSeconds > 1 && totalPercentage > 0) {
        // Calculate speed: Percent per Second
        const rate = totalPercentage / elapsedSeconds;

        const remainingPercent = 100 - totalPercentage;
        const remainingSeconds = remainingPercent / rate;

        if (remainingSeconds < 60) {
          profileTimeEst.textContent = `Estimated time remaining: ${Math.ceil(remainingSeconds)}s`;
        } else {
          const mins = Math.ceil(remainingSeconds / 60);
          profileTimeEst.textContent = `Estimated time remaining: ~${mins} min`;
        }
      } else {
        profileTimeEst.textContent = i18n.get('calculatingTimeText');
      }
    });

    try {
      // 1. Backend swaps files
      await invoke('apply_profile', { profileName: targetProfile });

      // 2. Frontend syncs history
      await syncDownloadHistoryWithProfile(targetProfile);

      // LOGGING: Success
      window.addAppLog(`Profile Switch to ${targetProfile} successful.`, "INFO");

      // 3. Update State
      appState.activeProfile = targetProfile;
      localStorage.setItem('activeProfile', targetProfile);
      updateApplyButtonVisibility();

      // 4. Force reload of XML from disk
      const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
      const content = await readTextFile(settingsPath);
      await loadXmlContent(content, settingsPath);

      // 5. Explicitly call refreshBrowseTabBadges AFTER renderModList finishes
      setTimeout(() => {
        refreshBrowseTabBadges();
      }, 100);

      await saveCurrentProfile();

      profileProgressModal.classList.add('hidden');
      await window.customAlert(`Profile "${targetProfile}" applied successfully.`, "Success");

    } catch (e) {
      // LOGGING: Failure
      window.addAppLog(`Profile Switch FAILED: ${e}`, "ERROR");

      profileProgressModal.classList.add('hidden');
      await window.customAlert(`Error applying profile: ${e}`, "Error");
    } finally {
      unlisten();
    }
  });

  async function syncDownloadHistoryWithProfile(profileName) {
    try {
      // 1. Get Active Mods
      const profileFiles = await invoke('get_profile_mod_list', { profileName });

      // 2. Get Library Status for ALL items
      const allFilenames = downloadHistory.map(item => item.fileName).filter(n => n);
      const libraryMap = await invoke('check_library_existence', { filenames: allFilenames });

      let changed = false;

      downloadHistory.forEach(item => {
        // Is it currently installed in the game?
        const isInstalled = profileFiles.includes(item.fileName);

        // Is it sitting unpacked in the library?
        const isUnpacked = libraryMap[item.fileName];

        let newStatusClass = '';
        let newStatusText = '';

        if (isInstalled) {
          newStatusClass = 'installed';
          newStatusText = i18n.get('statusInstalled');
        } else if (isUnpacked) {
          newStatusClass = 'unpacked';
          newStatusText = i18n.get('statusUnpacked');
        } else {
          // Only allow reverting to 'success' (Downloaded) if it wasn't Error/Cancelled
          // Or if it WAS installed/unpacked and now isn't.
          if (item.statusClass === 'installed' || item.statusClass === 'unpacked' || item.statusClass === 'success') {
            newStatusClass = 'success';
            newStatusText = i18n.get('statusDownloaded');
          }
        }

        // Only apply if changed to avoid overwriting temporary states like 'progress' or 'error'
        if (newStatusClass && item.statusClass !== newStatusClass) {
          // Safety: Don't overwrite an active error/progress unless we are sure
          if (item.statusClass !== 'error' && item.statusClass !== 'progress' && item.statusClass !== 'cancelled') {
            item.statusClass = newStatusClass;
            item.statusText = newStatusText;
            changed = true;
          }
          // Override: If it WAS installed, force update (e.g. user switched profiles)
          if (item.statusClass === 'installed' && !isInstalled) {
            item.statusClass = isUnpacked ? 'unpacked' : 'success';
            item.statusText = isUnpacked ? i18n.get('statusUnpacked') : i18n.get('statusDownloaded');
            changed = true;
          }
        }
      });

      // Save the corrected history
      if (changed) {
        await saveDownloadHistory(downloadHistory);
        console.log("Download history synchronized with profile.");
      }

      if (!document.getElementById('downloadHistoryModalOverlay').classList.contains('hidden')) {
        renderDownloadHistory();
      }

      // Also update the Browse Grid cards
      if (!browseView.classList.contains('hidden')) {
        const allCards = browseGridContainer.querySelectorAll('.mod-card');
        allCards.forEach(card => {
          const modId = card.dataset.modId;
        });
      }

    } catch (e) {
      console.error("Failed to sync download history:", e);
    }
  }

  languageSelector.addEventListener('change', (e) => i18n.loadLanguage(e.target.value));

  navMyMods.addEventListener('click', () => {
    if (isPanelOpen) modDetailCloseBtn.click();
    navMyMods.classList.add('active');
    navBrowse.classList.remove('active');
    myModsView.classList.remove('hidden');
    browseView.classList.add('hidden');
  });

  navBrowse.addEventListener('click', async () => {
    navBrowse.classList.add('active');
    navMyMods.classList.remove('active');
    browseView.classList.remove('hidden');
    myModsView.classList.add('hidden');

    // 1. Force a scan of the disk
    if (appState.activeProfile) {
      await saveCurrentProfile();
      // Update the internal map of installed mods immediately
      const installedList = await invoke('get_profile_mod_list', { profileName: appState.activeProfile });
    }

    if (browseGridContainer.childElementCount === 0) {
      fetchAndRenderBrowseGrid();
    } else {
      // 2. Refresh the badges on existing cards
      refreshBrowseTabBadges();
    }
  });

  browseGridContainer.addEventListener('click', (e) => {
    const previouslySelected = browseGridContainer.querySelector('.mod-card.selected');
    if (previouslySelected) {
      previouslySelected.classList.remove('selected');
    }

    const clickedCard = e.target.closest('.mod-card');
    if (clickedCard) {
      clickedCard.classList.add('selected');

      const modId = parseInt(clickedCard.dataset.modId, 10);
      const modData = curatedData.find(m => m.mod_id === modId);
      if (modData) openModDetailPanel(modData);
    }
  });

  modDetailCloseBtn.addEventListener('click', async () => {
    modDetailPanel.classList.remove('open');

    // Only shrink the window if the manager actually expanded it (PC Mode)
    if (isPanelOpen) {
      isPanelOpen = false;
      const currentSize = await appWindow.innerSize();
      await appWindow.setSize(new LogicalSize(DEFAULT_WIDTH, currentSize.height));
    }

    const currentlySelected = browseGridContainer.querySelector('.mod-card.selected');
    if (currentlySelected) {
      currentlySelected.classList.remove('selected');
    }
  });

  browseView.addEventListener('click', (e) => {
    if (isPanelOpen && !modDetailPanel.contains(e.target) && !e.target.closest('.mod-card')) {
      modDetailCloseBtn.click();
    }
  });

  closeFileSelectionModalBtn.addEventListener('click', () => fileSelectionModalOverlay.classList.add('hidden'));
  fileSelectionModalOverlay.addEventListener('click', (e) => {
    if (e.target === fileSelectionModalOverlay) fileSelectionModalOverlay.classList.add('hidden');
  });

  closeChangelogModalBtn.addEventListener('click', () => changelogModalOverlay.classList.add('hidden'));
  changelogModalOverlay.addEventListener('click', (e) => {
    if (e.target === changelogModalOverlay) changelogModalOverlay.classList.add('hidden');
  });

  const closePriorityModal = () => priorityModalOverlay.classList.add('hidden');
  cancelPriorityBtn.addEventListener('click', closePriorityModal);
  priorityModalOverlay.addEventListener('click', (e) => {
    if (e.target === priorityModalOverlay) closePriorityModal();
  });

  confirmPriorityBtn.addEventListener('click', async () => {
    const modToMove = priorityModalOverlay.dataset.modName;
    const newPriority = parseInt(priorityInput.value, 10);
    const maxPriority = parseInt(priorityInput.max, 10);
    if (isNaN(newPriority) || newPriority < 0 || newPriority > maxPriority) {
      await window.customAlert(
        i18n.get('invalidPriorityMsg', { max: maxPriority }),
        i18n.get('invalidInputTitle')
      );
      return;
    }
    let currentOrder = Array.from(modListContainer.querySelectorAll('.mod-row')).map(row => row.dataset.modName);
    currentOrder = currentOrder.filter(name => name !== modToMove);
    currentOrder.splice(newPriority, 0, modToMove);
    // 1. Immediately update the UI with no blink.
    reorderModListUI(currentOrder);

    if (appState.selectedModRow) {
      appState.selectedModRow.classList.remove('selected');
      appState.selectedModRow = null;
      modInfoPanel.classList.add('hidden');
    }

    // 2. In the background, save the changes.
    invoke('reorder_mods', { orderedModNames: currentOrder })
      .then(async (updatedXmlContent) => {
        // 3. Silently update the in-memory data.
        appState.xmlDoc = new DOMParser().parseFromString(updatedXmlContent, "application/xml");
        await saveChanges();
        await saveCurrentProfile();
        console.log("Mod order saved and local state synced.");
      })
      .catch(async error => {
        await window.customAlert(`Error saving new mod order: ${error}`, "Error");
        renderModList();
      });

    closePriorityModal()
  });

  fileSelectionListContainer.addEventListener('click', async (e) => {
    const header = e.target.closest('.collapsible-header');
    if (header) {
      header.classList.toggle('active');
      header.nextElementSibling.classList.toggle('open');
      return;
    }

    if (e.target.classList.contains('mod-card-install-btn')) {
      const button = e.target;
      const itemElement = button.closest('.update-item');

      const isUpdate = button.textContent === 'UPDATE';

      const modId = button.dataset.modId;
      const fileId = button.dataset.fileId;
      const version = button.dataset.version;
      const displayName = itemElement.querySelector('.update-item-name').textContent.split(' (v')[0];
      const rawFileName = button.dataset.rawFilename;

      // Get the ID to delete
      const replacingFileId = button.dataset.replacingFileId;

      button.disabled = true;
      fileSelectionModalOverlay.classList.add('hidden');

      await startModDownload({
        modId: modId,
        fileId: fileId,
        version: version,
        fileName: rawFileName,
        displayName: displayName,
        replacingFileId: replacingFileId
      }, isUpdate);
    }
  });

  browseSortSelect.addEventListener('input', () => {
    appState.currentPage = 1; // <--- Reset page
    filterAndDisplayMods();
  });
  browseFilterSelect.addEventListener('input', () => {
    appState.currentPage = 1; // <--- Reset page
    filterAndDisplayMods();
  });
  browseSearchInput.addEventListener('input', () => {
    appState.currentPage = 1; // <--- Reset page
    filterAndDisplayMods();
  });

  downloadHistoryBtn.addEventListener('click', async () => {
    if (appState.activeProfile) {
      await saveCurrentProfile();

      await syncDownloadHistoryWithProfile(appState.activeProfile);
    }
    renderDownloadHistory();
    downloadHistoryModalOverlay.classList.remove('hidden');
  });

  const closeDownloadHistory = () => {
    downloadHistoryModalOverlay.classList.add('hidden');
    // Clear selection when closing
    appState.selectedDownloadIds.clear();
    // Remove visual highlights
    downloadListContainer.querySelectorAll('.download-item.selected').forEach(el => el.classList.remove('selected'));
  };

  closeDownloadHistoryBtn.addEventListener('click', closeDownloadHistory);

  downloadHistoryModalOverlay.addEventListener('click', (e) => {
    if (e.target === downloadHistoryModalOverlay) {
      closeDownloadHistory();
    }
  });

  clearDownloadHistoryBtn.addEventListener('click', async () => {
    // 1. Show the new, more explicit confirmation dialog.
    const confirmed = await window.customConfirm(i18n.get('deleteAllDownloadsMsg'), i18n.get('deleteAllDownloadsTitle'));

    if (confirmed) {
      try {
        console.log("User confirmed. Deleting all downloaded archives...");

        // 2. Call the new Rust command to wipe the downloads folder.
        await invoke('clear_downloads_folder');

        // 3. Clear the in-memory history array.
        downloadHistory = [];

        // 4. Save the now-empty history array to the file.
        await saveDownloadHistory(downloadHistory);

        // 5. Re-render the UI, which will now be empty.
        renderDownloadHistory();

        console.log("All downloads successfully deleted.");

      } catch (error) {
        console.error("Failed to delete all downloads:", error);
        await window.customAlert(`An error occurred while deleting the files: ${error}`, "Error");
      }
    } else {
      console.log("User cancelled 'Delete All' operation.");
    }
  });

  document.getElementById('resetWarningsBtn').addEventListener('click', async () => {
    localStorage.removeItem('suppressUntrackedWarning');
    localStorage.removeItem('suppressInstallSuccess');
    await window.customAlert(i18n.get('resetWarningMsg'), i18n.get('resetWarningTitle'));

    await renderModList();
  });

  nxmHandlerBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('nxmHandlerStatus');

    // Helper to show the final success/error message
    const setStatus = (message, type = 'success') => {
      statusEl.textContent = message;
      statusEl.className = `handler-status status-${type}`;
      statusEl.classList.remove('hidden');
    };

    nxmHandlerBtn.disabled = true;
    const isCurrentlyRegistered = await invoke('is_protocol_handler_registered');
    let confirmed = false;

    if (isCurrentlyRegistered) {
      confirmed = await window.customConfirm(i18n.get('removeNXMHandlerMsg'), i18n.get('removeNXMHandlerTitle'));
      if (confirmed) {
        try {
          await invoke('unregister_nxm_protocol');

          // FIX: Use the global function that supports translation
          await updateNXMButtonState();

          // Optional: Try to translate the success message, fallback to English
          const msg = i18n.get('nxmRemovedSuccess') || 'Successfully removed.';
          setStatus(msg, 'success');
        } catch (error) {
          setStatus(`Error: ${error}`, 'error');
        }
      }
    } else {
      confirmed = await window.customConfirm(i18n.get('addNXMHandlerMsg'), i18n.get('addNXMHandlerTitle'));
      if (confirmed) {
        try {
          await invoke('register_nxm_protocol');

          // FIX: Use the global function that supports translation
          await updateNXMButtonState();

          // Optional: Try to translate the success message, fallback to English
          const msg = i18n.get('nxmSetSuccess') || 'Successfully set!';
          setStatus(msg, 'success');
        } catch (error) {
          setStatus(`Error: ${error}`, 'error');
        }
      }
    }

    nxmHandlerBtn.disabled = false;
  });

  document.querySelector('.download-header-row').addEventListener('click', (e) => {
    const clickedHeader = e.target.closest('.sortable');
    if (!clickedHeader) return;

    const sortKey = clickedHeader.dataset.sort;

    if (downloadSortState.key === sortKey) {
      downloadSortState.direction = downloadSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
      downloadSortState.key = sortKey;
      downloadSortState.direction = 'desc';
    }

    renderDownloadHistory();
  });

  // --- Launch Game Button ---
  const launchBtn = document.getElementById('launchGameBtn');
  const launchText = launchBtn.querySelector('.launch-text');

  launchBtn.addEventListener('click', async () => {
    if (!appState.gamePath || !appState.versionType) return;
    if (launchBtn.classList.contains('is-launching')) return; // Prevent double click

    // 1. SET UI STATE: LAUNCHING
    const originalText = launchText.textContent;
    launchBtn.classList.add('is-launching');
    launchText.textContent = i18n.get('launchingStateText');

    try {
      // 2. CALL RUST
      await invoke('launch_game', {
        versionType: appState.versionType,
        gamePath: appState.gamePath
      });

      // 3. RESET UI STATE (After a delay)
      setTimeout(() => {
        launchBtn.classList.remove('is-launching');
        launchText.textContent = originalText;
      }, 10000);

    } catch (error) {
      // If it fails, reset immediately and show error
      launchBtn.classList.remove('is-launching');
      launchText.textContent = originalText;
      await window.customAlert(`Failed to launch game: ${error}`, "Launch Error");
    }
  });

  nexusAuthBtn.addEventListener('click', async () => {
    const isLoggedIn = nexusAccountStatus.classList.contains('logged-in');

    // LOGOUT
    if (isLoggedIn) {
      const confirmed = await window.customConfirm(i18n.get('disconnectNexusAccMsg'), i18n.get('disconnectNexusAccTitle'));
      if (confirmed) {
        await invoke('logout_nexus');
        await validateLoginState();
      }
      return;
    }

    // LOGIN
    try {
      nexusAccountStatus.textContent = "Waiting for browser...";
      nexusAuthBtn.disabled = true; // Prevent double clicks

      // Calls Rust -> Opens Browser -> Waits for Socket
      const newKey = await invoke('login_to_nexus');

      if (newKey) {
        await window.customAlert("Successfully connected!", "Success");
        await validateLoginState(newKey);
      }
    } catch (error) {
      await window.customAlert(`Login Failed: ${error}`, "Error");
      // Reset UI on failure
      await validateLoginState();
    } finally {
      nexusAuthBtn.disabled = false;
    }
  });

  document.getElementById('openLibraryBtn').addEventListener('click', async () => {
    try {
      await invoke('open_special_folder', { folderType: 'library' });
    } catch (e) {
      console.error(e);
    }
  });

  (async () => {
    try {
      console.log("Starting App Initialization...");

      // 1. Initialize App (Language, History, Migrations, etc.)
      await initializeApp();

      try {
        // A. Get and show version number in Settings
        const v = await getVersion();
        const el = document.getElementById('currentAppVersion');
        if (el) el.textContent = `v${v}`;

        // B. Bind the Settings Button (With Portable Check)
        const btnAppUpdate = document.getElementById('checkAppUpdateBtn');
        if (btnAppUpdate) {
          const isInstalled = await invoke('is_app_installed');

          if (isInstalled) {
            // INSTALLED MODE:
            // 1. Enable the button click listener
            btnAppUpdate.addEventListener('click', () => checkAppUpdate(true));

            // 2. Run the Silent Check immediately on startup
            checkAppUpdate(false);
          } else {
            // PORTABLE MODE:
            // 1. Change text to "PORTABLE MODE"
            btnAppUpdate.textContent = i18n.get('btnPortableMode') || "PORTABLE MODE";

            // 2. Visually disable it
            btnAppUpdate.classList.add('disabled');
            btnAppUpdate.style.opacity = "0.5";
            btnAppUpdate.style.cursor = "not-allowed";
            btnAppUpdate.title = i18n.get('portableTooltip') || "Updates disabled in Portable version";

          }
        }
      } catch (e) {
        console.warn("Failed to initialize updater UI:", e);
      }

      // 2. Initialize Profile System
      await refreshProfileList();

      const savedProfile = localStorage.getItem('activeProfile') || 'Default';
      appState.activeProfile = savedProfile;

      // Safety Check: Ensure the saved profile actually exists
      const availableProfiles = Array.from(profileSelect.options).map(opt => opt.value);
      if (availableProfiles.includes(savedProfile)) {
        profileSelect.value = savedProfile;
      } else {
        console.warn(`Saved profile '${savedProfile}' not found. Resetting to Default.`);
        profileSelect.value = 'Default';
        appState.activeProfile = 'Default';
        localStorage.setItem('activeProfile', 'Default');
      }

      updateApplyButtonVisibility();

      // 3. Initialize Drag & Drop
      await setupDragAndDrop();

      // 4. Steam Deck / Small Screen Height Fix
      const screenHeight = window.screen.availHeight;
      const windowHeight = window.outerHeight;

      if (windowHeight > screenHeight) {
        console.log("Small screen detected. Adjusting window height...");
        const newHeight = Math.floor(screenHeight * 0.90);
        await appWindow.setSize(new LogicalSize(DEFAULT_WIDTH, newHeight));
        await appWindow.center();
      }

      console.log("Initialization Complete.");

    } catch (error) {
      console.error("Critical Initialization Error:", error);
    }
  })();

});