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
        isProfileSwitching: false,
        xmlDoc: null,
        isPopulating: false,
        currentTranslations: {},
        selectedModRow: null,
        installedModsMap: new Map(),
        modDataCache: new Map(),
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

    // --- CUSTOM DIALOG HELPERS ---
    const genericDialogModal = document.getElementById('genericDialogModal');
    const genericDialogTitle = document.getElementById('genericDialogTitle');
    const genericDialogMessage = document.getElementById('genericDialogMessage');
    const genericDialogActions = document.getElementById('genericDialogActions');

    // CHANGE 1: Added confirmText and cancelText arguments
    function showDialog(title, message, type = 'alert', confirmText = 'OK', cancelText = 'Cancel') {
        return new Promise((resolve) => {
            genericDialogTitle.textContent = title || 'Singularity';
            genericDialogMessage.textContent = message;
            genericDialogActions.innerHTML = '';

            if (type === 'confirm') {
                const btnCancel = document.createElement('button');
                btnCancel.className = 'modal-gen-btn-cancel';

                // CHANGE 2: Use variable instead of string 'Cancel'
                btnCancel.textContent = cancelText;

                // CHANGE 3: Auto-expand width if text is long (like "Don't Show Again")
                if (cancelText.length > 8) {
                    btnCancel.style.width = 'auto';
                    btnCancel.style.paddingLeft = '15px';
                    btnCancel.style.paddingRight = '15px';
                }

                btnCancel.onclick = () => {
                    genericDialogModal.classList.add('hidden');
                    resolve(false);
                };
                genericDialogActions.appendChild(btnCancel);

                const btnOk = document.createElement('button');
                btnOk.className = 'modal-gen-btn-confirm';

                // CHANGE 4: Use variable instead of string 'OK'
                btnOk.textContent = confirmText;

                btnOk.onclick = () => {
                    genericDialogModal.classList.add('hidden');
                    resolve(true);
                };
                genericDialogActions.appendChild(btnOk);
            } else {
                const btnOk = document.createElement('button');
                btnOk.className = 'modal-gen-btn-confirm';
                btnOk.textContent = 'OK';
                btnOk.onclick = () => {
                    genericDialogModal.classList.add('hidden');
                    resolve(true);
                };
                genericDialogActions.appendChild(btnOk);
            }

            genericDialogModal.classList.remove('hidden');
        });
    }

    window.customAlert = async (msg, title) => {
        await showDialog(title, msg, 'alert');
    };

    // CHANGE 5: Update wrapper to pass the new arguments
    window.customConfirm = async (msg, title, confirmBtnText = 'OK', cancelBtnText = 'Cancel') => {
        return await showDialog(title, msg, 'confirm', confirmBtnText, cancelBtnText);
    };

    window.customAlert = async (msg, title) => {
        await showDialog(title, msg, 'alert');
    };

    // Updated to accept custom button text
    window.customConfirm = async (msg, title, confirmBtnText = 'OK', cancelBtnText = 'Cancel') => {
        return await showDialog(title, msg, 'confirm', confirmBtnText, cancelBtnText);
    };

    window.customAlert = async (msg, title) => {
        await showDialog(title, msg, 'alert');
    };

    window.customConfirm = async (msg, title, confirmBtnText = 'OK', cancelBtnText = 'Cancel') => {
        return await showDialog(title, msg, 'confirm', confirmBtnText, cancelBtnText);
    };

    const i18n = {
        async loadLanguage(lang) {
            try {
                const resourcePath = await resolveResource(`locales/${lang}.json`);
                const content = await readTextFile(resourcePath);
                appState.currentTranslations = JSON.parse(content);
                localStorage.setItem('selectedLanguage', lang);
                this.updateUI();
            } catch (e) {
                console.error(`Failed to load language file for ${lang}`, e);
                if (lang !== 'en') await this.loadLanguage('en');
            }
        },
        updateUI() {
            document.querySelectorAll('[data-i18n]').forEach(el => {
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

                nexusAccountStatus.textContent = `Connected as: ${userData.name}`;
                nexusAccountStatus.classList.add('logged-in');

                nexusAuthBtn.textContent = "Disconnect";
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

            nexusAccountStatus.textContent = "Not connected";
            nexusAccountStatus.classList.remove('logged-in');

            nexusAuthBtn.textContent = "Connect";
            nexusAuthBtn.className = "modal-btn-confirm";
            nexusAuthBtn.style.width = "100px";
            nexusAuthBtn.style.padding = "5px";

            NEXUS_API_KEY = "";
            return false;
        }
    }

    const initializeApp = async () => {
        const savedLang = localStorage.getItem('selectedLanguage') || 'en';
        languageSelector.value = savedLang;
        await i18n.loadLanguage(savedLang);
        await loadDownloadHistory();

        const savedPadding = localStorage.getItem('modRowPadding') || '5';
        document.documentElement.style.setProperty('--mod-row-vertical-padding', `${savedPadding}px`);
        rowPaddingSlider.value = savedPadding;
        rowPaddingValue.textContent = `${savedPadding}px`;

        const savedGridGap = localStorage.getItem('browseGridGap') || '10';
        document.documentElement.style.setProperty('--browse-grid-gap', `${savedGridGap}px`);
        gridGapSlider.value = savedGridGap;
        gridGapValue.textContent = `${savedGridGap}px`;

        const savedModsPerPage = localStorage.getItem('modsPerPage') || '20';
        appState.modsPerPage = parseInt(savedModsPerPage, 10);

        const modsPerPageSlider = document.getElementById('modsPerPageSlider');
        const modsPerPageValue = document.getElementById('modsPerPageValue');
        if (modsPerPageSlider) {
            modsPerPageSlider.value = appState.modsPerPage;
            modsPerPageValue.textContent = appState.modsPerPage;
        }

        // Check for untracked/manual mods
        const suppressWarning = localStorage.getItem('suppressUntrackedWarning') === 'true';

        if (!suppressWarning) {
            const hasUntracked = await invoke('check_for_untracked_mods');

            if (hasUntracked) {
                // TRUE = "OK" (Acknowledged, keep showing)
                // FALSE = "Don't Show Again" (Suppress future warnings)
                const keepShowing = await window.customConfirm(
                    "WARNING: Untracked Mods Detected!\n\nYou have mods installed in your folder that were not installed via this Manager.\n\nThese files are NOT tracked by the Profile system. If you switch profiles, these files might be deleted or cause conflicts.\n\nTo fix this, delete them from the folder and reinstall them by dragging their .zip files into the Manager.",
                    "Warning",
                    "OK",
                    "Don't Show Again"
                );

                // If they clicked "Don't Show Again" (which returns false), save the preference
                if (keepShowing === false) {
                    localStorage.setItem('suppressUntrackedWarning', 'true');
                }
            }
        }

        // 1. Ensure Default Profile Exists
        const profiles = await invoke('list_profiles');

        // We check if "Default.json" physically exists
        const activeProfileName = localStorage.getItem('activeProfile') || 'Default';

        if (activeProfileName === 'Default') {
            // If is on Default, ensure it's saved to disk to not lose current state
            // BUT only do this if it has valid mods to save.

            const installedData = getDetailedInstalledMods();

            // Save the current state as Default immediately
            // This creates the file so the user doesn't lose valid mods on switch
            await invoke('save_active_profile', {
                profileName: 'Default',
                mods: installedData
            });
        }

        // --- GAME DETECTION ---
        const gamePaths = await invoke('detect_game_installation');
        if (gamePaths) {
            console.log(`Detected ${gamePaths.version_type} version of No Man's Sky.`);

            appState.gamePath = gamePaths.game_root_path;
            appState.settingsPath = gamePaths.settings_root_path;
            appState.versionType = gamePaths.version_type;

            // --- LAUNCH BUTTON UI ---
            const launchBtn = document.getElementById('launchGameBtn');
            const launchIcon = document.getElementById('launchIcon');

            launchBtn.classList.remove('disabled');
            launchBtn.dataset.platform = appState.versionType;

            // Set the correct icon
            if (appState.versionType === 'Steam') {
                launchIcon.src = iconSteam;
            } else if (appState.versionType === 'GOG') {
                launchIcon.src = iconGog;
            } else if (appState.versionType === 'GamePass') {
                launchIcon.src = iconXbox;
            }
        }

        const hasGamePath = !!appState.gamePath;
        openModsFolderBtn.disabled = !hasGamePath;
        settingsBtn.classList.toggle('disabled', !hasGamePath);
        updateCheckBtn.classList.toggle('disabled', !hasGamePath);
        enableAllBtn.classList.toggle('disabled', !hasGamePath);
        disableAllBtn.classList.toggle('disabled', !hasGamePath);
        dropZone.classList.toggle('hidden', !hasGamePath);

        if (!hasGamePath) {
            const title = "Could not find NMS installation path";
            openModsFolderBtn.title = title;
            settingsBtn.title = title;
            enableAllBtn.title = title;
            disableAllBtn.title = title;
            // Do not proceed further if no game path is found
        }

        if (hasGamePath && appState.settingsPath) {
            enableAllBtn.title = '';
            disableAllBtn.title = '';
            try {
                const settingsFilePath = await join(appState.settingsPath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
                const content = await readTextFile(settingsFilePath);
                await loadXmlContent(content, settingsFilePath);
            } catch (e) {
                console.warn("Could not auto-load settings file. It may not exist yet.", e);
            }
        }

        listen('nxm-link-received', (event) => {
            handleNxmLink(event.payload);
        });

        loadDataInBackground();
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
            row.innerHTML = `
                <div class="mod-name-container">
                    <span class="mod-name-text">${modData.folder_name}</span>
                    <span class="update-indicator hidden" data-i18n-title="updateAvailableTooltip" title="Update available"></span>
                </div>
                <div class="priority"><input type="text" class="priority-input" value="${index}" readonly></div>
                <div class="enabled"><label class="switch"><input type="checkbox" class="enabled-switch" ${modData.enabled ? 'checked' : ''}><span class="slider"></span></label></div>
            `;

            row.querySelector('.enabled-switch').addEventListener('change', async (e) => {
                const modNode = Array.from(appState.xmlDoc.querySelectorAll('Property[name="Data"] > Property'))
                    .find(node => {
                        const nameProp = node.querySelector('Property[name="Name"]');
                        return nameProp && nameProp.getAttribute('value').toUpperCase() === modData.folder_name.toUpperCase();
                    });
                if (modNode) {
                    const newVal = e.target.checked ? 'true' : 'false';
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

        // Use a Map to group updates by Nexus Mod ID
        // Key: ModID, Value: { name, installedVer, latestVer, nexusUrl, affectedFolders: [] }
        const groupedUpdates = new Map();

        for (const [modFolderName, cachedModData] of appState.modDataCache.entries()) {
            const localModInfo = cachedModData.local_info;

            if (localModInfo) {
                const modId = localModInfo.mod_id;
                const installedVersion = localModInfo.version;
                const installedFileId = localModInfo.file_id;

                if (modId && installedVersion && installedFileId) {
                    const remoteModInfo = curatedData.find(mod => String(mod.mod_id) === String(modId));

                    if (remoteModInfo && remoteModInfo.files) {
                        const installedFileOnNexus = remoteModInfo.files.find(f => String(f.file_id) === String(installedFileId));

                        if (installedFileOnNexus) {
                            const category = installedFileOnNexus.category_name;
                            const allFilesInCategory = remoteModInfo.files.filter(f => f.category_name === category);

                            if (allFilesInCategory.length > 0) {
                                const latestFile = allFilesInCategory.sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];

                                if (isNewerVersionAvailable(installedVersion, latestFile.version)) {

                                    // 1. ALWAYS Update the UI Dot (Silent & Visual)
                                    const row = modListContainer.querySelector(`.mod-row[data-mod-name="${modFolderName}"]`);
                                    const indicator = row?.querySelector('.update-indicator');
                                    if (indicator) indicator.classList.remove('hidden');

                                    // 2. Aggregate for the Modal
                                    const modIdStr = String(modId);

                                    if (!groupedUpdates.has(modIdStr)) {
                                        // Create new entry
                                        groupedUpdates.set(modIdStr, {
                                            name: remoteModInfo.name || modFolderName,
                                            installed: installedVersion,
                                            latest: latestFile.version,
                                            nexusUrl: `https://www.nexusmods.com/nomanssky/mods/${remoteModInfo.mod_id}`,
                                            folders: [modFolderName]
                                        });
                                    } else {
                                        // Update existing entry with new folder name
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

        // If silent, we stop here (dots are already updated)
        if (isSilent) {
            console.log(`Update check found updates for ${groupedUpdates.size} mods.`);
            return;
        }

        // Render the grouped list
        updateListContainer.innerHTML = '';

        if (groupedUpdates.size > 0) {
            groupedUpdates.forEach((updateInfo) => {
                const item = document.createElement('div');
                item.className = 'update-item';

                const nexusLinkHtml = updateInfo.nexusUrl
                    ? `<a href="${updateInfo.nexusUrl}" class="nexus-button" target="_blank" title="Visit on Nexus Mods"><img src="/src/assets/icon-nexus.png" alt="Nexus"></a>`
                    : '';

                // Create a nice list string: "Folder A, Folder B"
                // If too many, truncate it? For now, let's list them all.
                const folderListStr = updateInfo.folders.join(', ');
                const folderCountText = updateInfo.folders.length > 1
                    ? `<div style="font-size: 0.85em; opacity: 0.7; margin-top: 4px;">Affects ${updateInfo.folders.length} folders: ${folderListStr}</div>`
                    : '';

                item.innerHTML = `
                    <div class="update-item-info">
                        <div class="update-item-name">${updateInfo.name}</div>
                        <div class="update-item-version">
                            ${updateInfo.installed} <span class="arrow">--></span> <span class="latest">${updateInfo.latest}</span>
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

    async function startModDownload({ modId, fileId, version, fileName, displayName, replacingFileId, nxmQueryParams }, isUpdate = false) {
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
                return;
            }

            downloadHistory = downloadHistory.filter(d => d.fileId !== fileId);
        }

        // 2. UPDATE LOGIC: DELETE OLD ZIP
        // If this is an update, find the OLD version and delete its zip to keep the folder clean.
        if (replacingFileId) {
            const oldVersionItem = downloadHistory.find(d => String(d.fileId) === String(replacingFileId));

            if (oldVersionItem && oldVersionItem.archivePath) {
                console.log(`Update detected. Removing old version archive: ${oldVersionItem.fileName}`);
                try {
                    await invoke('delete_archive_file', { path: oldVersionItem.archivePath });
                    downloadHistory = downloadHistory.filter(d => d.id !== oldVersionItem.id);
                } catch (e) {
                    console.warn("Failed to delete old version zip:", e);
                }
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
            statusText: isUpdate ? 'Updating...' : 'Waiting to start...',
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
            if (!downloadUrl) throw new Error("Could not retrieve download URL. (Check API Key or Premium Status)");

            updateStatus('Downloading...', 'progress');
            const downloadResult = await invoke('download_mod_archive', { downloadUrl, fileName });

            const item = downloadHistory.find(d => d.id === downloadId);
            if (item) {
                item.archivePath = downloadResult.path;
                item.size = downloadResult.size;
                item.createdAt = downloadResult.created_at;

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
            updateStatus(`Error: ${error.message}`, 'error');
            await saveDownloadHistory(downloadHistory);
        }
    }

    function showDownloadContextMenu(e, downloadId) {
        const itemData = downloadHistory.find(d => d.id === downloadId);

        console.log(`[CONTEXT MENU] Opening for downloadId: "${downloadId}"`);

        if (!itemData) {
            console.error("[CONTEXT MENU] Could not find item data for this ID!");
            return;
        }

        console.log("[CONTEXT MENU] Item data:", JSON.parse(JSON.stringify(itemData)));

        e.preventDefault();
        e.stopPropagation();
        removeContextMenu();

        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';
        contextMenu.style.left = `${e.clientX}px`;
        contextMenu.style.top = `${e.clientY}px`;

        // --- Create Menu Items ---
        console.log(`[CONTEXT MENU] Checking condition to show 'Install' button: statusClass === 'success' (${itemData.statusClass === 'success'}), archivePath exists (${!!itemData.archivePath})`);

        // Install Button
        if (itemData.statusClass === 'success' && itemData.archivePath) {
            console.log("[CONTEXT MENU] 'Install' button will be SHOWN.");
            const installButton = document.createElement('button');
            installButton.textContent = 'Install';
            installButton.className = 'context-menu-item';
            installButton.onclick = () => handleDownloadItemInstall(downloadId);
            contextMenu.appendChild(installButton);
        } else {
            console.log("[CONTEXT MENU] 'Install' button will be HIDDEN.");
        }

        // Visit on Nexus Button
        const nexusButton = document.createElement('button');
        nexusButton.textContent = 'Visit on Nexus';
        nexusButton.className = 'context-menu-item';
        nexusButton.onclick = () => {
            invoke('plugin:shell|open', {
                path: `https://www.nexusmods.com/nomanssky/mods/${itemData.modId}`,
                with: null
            });
        };
        contextMenu.appendChild(nexusButton);

        // Reveal in Explorer Button
        if (itemData.archivePath) {
            const revealButton = document.createElement('button');
            revealButton.textContent = 'Reveal in Explorer';
            revealButton.className = 'context-menu-item';
            revealButton.onclick = () => invoke('show_in_folder', { path: itemData.archivePath });
            contextMenu.appendChild(revealButton);
        }

        // Delete Button
        const deleteButton = document.createElement('button');
        deleteButton.textContent = 'Delete';
        deleteButton.className = 'context-menu-item delete';
        deleteButton.onclick = () => handleDownloadItemDelete(downloadId);
        contextMenu.appendChild(deleteButton);

        document.body.appendChild(contextMenu);
    }

    async function handleDownloadItemInstall(downloadId, isUpdate = false) {
        const item = downloadHistory.find(d => d.id === downloadId);
        if (!item || !item.archivePath) {
            console.error("Attempted to install an item with no archive path:", item);
            return;
        }

        // Helper to update the UI status in the download list
        const updateStatus = (text, statusClass) => {
            const currentItem = downloadHistory.find(d => d.id === downloadId);
            if (currentItem) {
                currentItem.statusText = text;
                currentItem.statusClass = statusClass;
                renderDownloadHistory();
            }
        };

        try {
            updateStatus(isUpdate ? 'Auto-Installing Update...' : 'Installing...', 'progress');

            // Core Rust command that extracts and moves the mod.
            const analysis = await invoke('install_mod_from_archive', { archivePathStr: item.archivePath });

            let oldArchiveToDelete = null;

            // --- Handle Conflicts ---
            if (analysis.conflicts && analysis.conflicts.length > 0) {
                for (const conflict of analysis.conflicts) {
                    const oldItemIndex = downloadHistory.findIndex(d => d.modFolderName === conflict.old_mod_folder_name);
                    if (oldItemIndex > -1) {
                        const oldItem = downloadHistory[oldItemIndex];
                        // Ensure it doesn't delete the archive it's currently installing
                        if (oldItem.archivePath && oldItem.id !== item.id) {
                            oldArchiveToDelete = oldItem.archivePath;
                            // Remove the old item from the history array
                            downloadHistory.splice(oldItemIndex, 1);
                        }
                    }

                    // If it's an auto-update, always replace. Otherwise, ask the user.
                    const shouldReplace = isUpdate ? true : await window.customConfirm(
                        `A mod with this ID is already installed ('${conflict.old_mod_folder_name}'). Replace it with '${conflict.new_mod_name}'?`,
                        'Mod Update Conflict'
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
                            // SAFETY CHECKS
                            modId: item.modId || "",
                            fileId: item.fileId || "",
                            version: item.version || ""
                        });
                        // The new folder name after replacement
                        item.modFolderName = conflict.new_mod_name;
                    }
                }
            }

            // --- Handle New Installations ---
            if (analysis.successes && analysis.successes.length > 0) {
                for (const mod of analysis.successes) {
                    addNewModToXml(mod.name);
                    await invoke('ensure_mod_info', {
                        modFolderName: mod.name,
                        // SAFETY CHECKS
                        modId: item.modId || "",
                        fileId: item.fileId || "",
                        version: item.version || ""
                    });
                }
                // The new folder name after installation
                item.modFolderName = analysis.successes[0].name;
            }

            // Save changes to GCMODSETTINGS.MXML and re-render the main mod list
            await saveChanges();
            await renderModList();

            updateStatus('Installed', 'installed');
            await saveDownloadHistory(downloadHistory);

            // Clean up the old archive file *after* everything else is successful
            if (oldArchiveToDelete) {
                console.log("Cleaning up old, outdated mod archive:", oldArchiveToDelete);
                await invoke('delete_archive_file', { path: oldArchiveToDelete });
            }

            // Update the "Install" button in the browse tab reactively
            updateModDisplayState(item.modId);

            await saveCurrentProfile();

        } catch (error) {
            console.error("Installation process failed:", error);
            updateStatus(`Install failed: ${error.message}`, 'error');
            await saveDownloadHistory(downloadHistory);
        }
    }

    async function handleDownloadItemDelete(downloadId) {
        const confirmed = await window.customConfirm("Are you sure you want to delete this downloaded mod archive?\n\nThis cannot be undone.", "Delete Archive");
        if (!confirmed) return;

        const itemIndex = downloadHistory.findIndex(d => d.id === downloadId);
        if (itemIndex === -1) return;

        const item = downloadHistory[itemIndex];

        try {
            if (item.archivePath) {
                await invoke('delete_archive_file', { path: item.archivePath });
            }

            downloadHistory.splice(itemIndex, 1);
            renderDownloadHistory();
            await saveDownloadHistory(downloadHistory);
        } catch (error) {
            await window.customAlert(`Failed to delete archive: ${error}`, "Error");
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

    async function loadDataInBackground() {
        // 1. Fetch all the data we need in a single call.
        await fetchCuratedData();

        // 2. Once data is loaded, run the silent update check.
        if (appState.gamePath && appState.modDataCache.size > 0) {
            await checkForUpdates(true);
        }
    }

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
            newItem.dataset.downloadId = itemData.id;

            if (itemData.statusClass === 'success' && itemData.archivePath) {
                newItem.classList.add('installable');
            }

            const displayName = (itemData.displayName && itemData.version)
                ? `${itemData.displayName} (${itemData.version})`
                : itemData.fileName;
            const nameEl = newItem.querySelector('.download-item-name');
            nameEl.textContent = displayName;
            nameEl.setAttribute('title', displayName);

            newItem.querySelector('.download-item-status').textContent = itemData.statusText;
            newItem.querySelector('.download-item-size').textContent = formatBytes(itemData.size);

            const timestamp = itemData.createdAt || parseInt(itemData.id.split('-')[1], 10) / 1000;
            newItem.querySelector('.download-item-date').textContent = formatDate(timestamp);

            const statusEl = newItem.querySelector('.download-item-status');
            statusEl.className = 'download-item-status';
            statusEl.classList.add(`status-${itemData.statusClass}`);

            newItem.addEventListener('dblclick', () => {
                if (newItem.classList.contains('installable')) {
                    handleDownloadItemInstall(itemData.id);
                }
            });
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
                const nexusUrl = prompt(i18n.get('promptForNexusLink', { modName: modFolderName }));
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
        const searchTerm = browseSearchInput.value.toLowerCase();
        const filterBy = browseFilterSelect.value;
        const sortBy = browseSortSelect.value;

        let processedMods = [...curatedData];

        // --- STAGE 1: FILTERING ---
        if (searchTerm) {
            processedMods = processedMods.filter(modData => {
                if (!modData) return false;
                return (
                    modData.name.toLowerCase().includes(searchTerm) ||
                    modData.author.toLowerCase().includes(searchTerm) ||
                    modData.summary.toLowerCase().includes(searchTerm)
                );
            });
        }

        if (filterBy === 'installed') {
            processedMods = processedMods.filter(mod => appState.installedModsMap.has(String(mod.mod_id)));
        } else if (filterBy === 'uninstalled') {
            processedMods = processedMods.filter(mod => !appState.installedModsMap.has(String(mod.mod_id)));
        }

        // --- STAGE 2: SORTING ---
        if (sortBy === 'name_asc') {
            processedMods.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        } else {
            processedMods.sort((a, b) => (b.updated_timestamp || 0) - (a.updated_timestamp || 0));
        }

        // --- STAGE 3: PAGINATION ---
        const totalItems = processedMods.length;
        const totalPages = Math.ceil(totalItems / appState.modsPerPage);

        // Safety check: If it filtered and current page is now out of bounds, reset to 1
        if (appState.currentPage > totalPages) appState.currentPage = 1;
        if (appState.currentPage < 1) appState.currentPage = 1;

        const startIndex = (appState.currentPage - 1) * appState.modsPerPage;
        const endIndex = startIndex + appState.modsPerPage;

        const modsForCurrentPage = processedMods.slice(startIndex, endIndex);

        // --- STAGE 4: DISPLAY ---
        displayMods(modsForCurrentPage);

        // Update the pagination UI
        renderPaginationControls(totalPages, appState.currentPage);
    }

    const paginationContainer = document.getElementById('paginationContainer');

    function renderPaginationControls(totalPages, currentPage) {
        paginationContainer.innerHTML = '';

        // Hide if only 1 page or no items
        if (totalPages <= 1) {
            paginationContainer.classList.add('hidden');
            return;
        }
        paginationContainer.classList.remove('hidden');

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

        // --- STABLE PAGINATION LOGIC ---
        // This logic ensures we almost always render the same number of elements 
        // so the UI doesn't jitter left/right when clicking next.

        const MAX_VISIBLE_PAGES = 7; // Threshold to switch to complex view

        if (totalPages <= MAX_VISIBLE_PAGES) {
            // Case 1: Few pages (e.g. 1 2 3 4 5). Show all.
            for (let i = 1; i <= totalPages; i++) {
                paginationContainer.appendChild(createButton(i, i, i === currentPage));
            }
        } else {
            // Case 2: Many pages. We use a sliding window to keep exactly 7 items visible.
            // The 3 layouts are:
            // Start:  [1] [2] [3] [4] [5] [...] [100]
            // Middle: [1] [...] [49] [50] [51] [...] [100]
            // End:    [1] [...] [96] [97] [98] [99] [100]

            if (currentPage <= 4) {
                // Near Start
                for (let i = 1; i <= 5; i++) {
                    paginationContainer.appendChild(createButton(i, i, i === currentPage));
                }
                paginationContainer.appendChild(createDots());
                paginationContainer.appendChild(createButton(totalPages, totalPages, totalPages === currentPage));

            } else if (currentPage >= totalPages - 3) {
                // Near End
                paginationContainer.appendChild(createButton(1, 1, 1 === currentPage));
                paginationContainer.appendChild(createDots());
                for (let i = totalPages - 4; i <= totalPages; i++) {
                    paginationContainer.appendChild(createButton(i, i, i === currentPage));
                }

            } else {
                // Middle
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

            // Loop through all the files that are INSTALLED for this mod.
            for (const installedFileId of installedFiles.keys()) {
                // Find the full data for this installed file from the curated list.
                const fileData = allModFilesFromCurated.find(f => String(f.file_id) === installedFileId);

                // If it find its data and its category is "MAIN"...
                if (fileData && fileData.category_name === 'MAIN') {
                    // found the priority version
                    mainFileVersion = installedFiles.get(installedFileId);
                    break; // No need to look further.
                }
            }

            // Now, decide what to display.
            if (mainFileVersion) {
                // If found a main file version, that's what it show.
                versionToShow = mainFileVersion;
            } else {
                // Otherwise, no main file is installed. Fall back to showing the first installed version it has.
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
        nexusLinkBtn.textContent = 'Visit on Nexus Mods';
        nexusLinkBtn.href = `https://www.nexusmods.com/nomanssky/mods/${modData.mod_id}`;
        nexusLinkBtn.target = '_blank';
        modDetailSecondaryActions.appendChild(nexusLinkBtn);

        if (!isPanelOpen) {
            isPanelOpen = true;
            const currentSize = await appWindow.innerSize();
            await appWindow.setSize(new LogicalSize(PANEL_OPEN_WIDTH, currentSize.height));
        }
        modDetailPanel.classList.add('open');
    }

    async function showFileSelectionModal(modId) {
        const modData = curatedData.find(m => m.mod_id === modId);
        const filesData = { files: modData?.files || [] };

        if (!modData || !filesData || !filesData.files || filesData.files.length === 0) {
            await window.customAlert("Could not find file information for this mod in the local data. Please try again later.", "Error");
            return;
        }

        fileSelectionModalTitle.textContent = `Download: ${modData.name}`;
        fileSelectionListContainer.innerHTML = '';

        const modIdStr = String(modId);

        const createFileRow = (file) => {
            const item = document.createElement('div');
            item.className = 'update-item';

            let buttonHtml = '';
            const installedFilesForThisMod = appState.installedModsMap.get(modIdStr);
            const fileIdStr = String(file.file_id);
            const installedVersionForThisFile = installedFilesForThisMod ? installedFilesForThisMod.get(fileIdStr) : undefined;

            // This is the raw, original filename
            const rawFileName = file.file_name;

            // Track which file ID it's replacing (if any)
            // If this remains empty string "", nothing will be deleted.
            let replacingFileId = "";

            if (installedVersionForThisFile) {
                // Case 1: This exact file ID is already installed
                const isUpToDate = !isNewerVersionAvailable(installedVersionForThisFile, file.version);
                if (isUpToDate) {
                    buttonHtml = `<button class="mod-card-install-btn" disabled>INSTALLED</button>`;
                } else {
                    // Updating the exact same file ID
                    replacingFileId = fileIdStr;
                    buttonHtml = `<button class="mod-card-install-btn" data-file-id="${fileIdStr}" data-mod-id="${modId}" data-version="${file.version}" data-raw-filename="${rawFileName}" data-replacing-file-id="${replacingFileId}">UPDATE</button>`;
                }
            } else {
                // Case 2: This file ID is NOT installed (could be a new file, or an update via a new ID)
                let isUpdateForAnotherFile = false;

                if (installedFilesForThisMod) {
                    // Check if it has another file installed for this mod that matches the Category (e.g. MAIN vs OPTIONAL)
                    for (const [installedFileId, installedVersion] of installedFilesForThisMod.entries()) {
                        const installedFileOnNexus = filesData.files.find(f => String(f.file_id) === installedFileId);

                        // Only mark as "Update" (and mark for deletion) if categories match.
                        if (installedFileOnNexus && installedFileOnNexus.category_name === file.category_name) {
                            if (isNewerVersionAvailable(installedVersion, file.version)) {
                                isUpdateForAnotherFile = true;
                                replacingFileId = installedFileId; // Store the ID of the OLD file to delete
                                break;
                            }
                        }
                    }
                }

                const buttonText = isUpdateForAnotherFile ? 'UPDATE' : 'DOWNLOAD';

                // Add the data-replacing-file-id attribute to the button so the click listener can read it
                buttonHtml = `<button class="mod-card-install-btn" data-file-id="${fileIdStr}" data-mod-id="${modId}" data-version="${file.version}" data-raw-filename="${rawFileName}" data-replacing-file-id="${replacingFileId}">${buttonText}</button>`;
            }

            // The clean name for display
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
        infoDescription.textContent = remoteInfo?.summary || (localModInfo ? 'No description provided.' : 'No local mod info file found.');

        // Logic to determine latest version
        let latestVersionToShow = remoteInfo?.version || 'N/A';
        if (remoteInfo && localModInfo?.file_id) {
            const installedFileOnNexus = remoteInfo.files.find(f => String(f.file_id) === String(localModInfo.file_id));
            if (installedFileOnNexus) {
                const category = installedFileOnNexus.category_name;
                const filesInCategory = remoteInfo.files.filter(f => f.category_name === category);
                if (filesInCategory.length > 0) {
                    const latestFile = filesInCategory.sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
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

        const modName = modRow.dataset.modName;
        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';
        contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
        contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 85)}px`;

        const copyButton = document.createElement('button');
        copyButton.textContent = i18n.get('copyModNameBtn');
        copyButton.className = 'context-menu-item';
        copyButton.onclick = async () => {
            removeContextMenu();
            try {
                await navigator.clipboard.writeText(modName);
                await window.customAlert(i18n.get('copySuccess', { modName }), "Success");
            } catch (err) {
                console.error('Failed to copy text: ', err);
                await window.customAlert('Could not copy text to clipboard.', "Error");
            }
        };

        const priorityButton = document.createElement('button');
        priorityButton.textContent = 'Change Priority';
        priorityButton.className = 'context-menu-item';
        priorityButton.onclick = () => {
            removeContextMenu();
            const allRows = Array.from(modListContainer.querySelectorAll('.mod-row'));
            const modIndex = allRows.findIndex(row => row.dataset.modName === modName);
            const maxPriority = allRows.length - 1;
            priorityModalTitle.textContent = `Change Priority: ${modName}`;
            priorityModalDescription.textContent = `Enter a new priority number between 0 and ${maxPriority}.`;
            priorityInput.value = modIndex;
            priorityInput.max = maxPriority;
            priorityModalOverlay.dataset.modName = modName;
            priorityModalOverlay.classList.remove('hidden');
        };

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

                    try {
                        const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
                        const content = await readTextFile(settingsPath);
                        appState.xmlDoc = new DOMParser().parseFromString(content, "application/xml");
                    } catch (e) {
                        console.error("Failed to re-sync xmlDoc after deletion:", e);
                        location.reload();
                        return;
                    }

                    await renderModList(modsToRender);

                    const deletedItem = downloadHistory.find(item => item.modFolderName && item.modFolderName.toUpperCase() === modName.toUpperCase());
                    if (deletedItem) {
                        deletedItem.statusText = 'Downloaded';
                        deletedItem.statusClass = 'success';

                        const modIdToUpdate = deletedItem.modId;

                        deletedItem.modFolderName = null;

                        await saveDownloadHistory(downloadHistory);

                        if (modIdToUpdate) {
                            updateModDisplayState(modIdToUpdate);
                        }
                    }

                    await window.customAlert(i18n.get('deleteSuccess', { modName }), "Deleted");

                    await saveCurrentProfile();

                } catch (error) {
                    await window.customAlert(`${i18n.get('deleteError', { modName })}\n\n${error}`, "Error");
                }
            }
        };

        contextMenu.appendChild(copyButton);
        contextMenu.appendChild(priorityButton);
        contextMenu.appendChild(deleteButton);
        document.body.appendChild(contextMenu);
    });

    modListContainer.addEventListener('mousedown', (e) => {
        if (e.target.closest('.switch') || e.button !== 0) return;
        const row = e.target.closest('.mod-row');
        if (!row) return;

        e.preventDefault();
        const DRAG_DELAY = 200;

        const handleMouseUpAsClick = () => {
            clearTimeout(dragState.dragTimer);
            document.removeEventListener('mouseup', handleMouseUpAsClick);
            const previouslySelected = appState.selectedModRow;
            if (previouslySelected) previouslySelected.classList.remove('selected');
            if (previouslySelected === row) {
                appState.selectedModRow = null;
                modInfoPanel.classList.add('hidden');
            } else {
                appState.selectedModRow = row;
                appState.selectedModRow.classList.add('selected');
                displayModInfo(row);
            }
        };

        document.addEventListener('mouseup', handleMouseUpAsClick);

        dragState.dragTimer = setTimeout(() => {
            document.removeEventListener('mouseup', handleMouseUpAsClick);
            if (appState.selectedModRow) {
                appState.selectedModRow.classList.remove('selected');
                appState.selectedModRow = null;
                modInfoPanel.classList.add('hidden');
            }
            dragState.draggedElement = row;
            if (appState.selectedModRow) appState.selectedModRow.classList.remove('selected');
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

    settingsBtn.addEventListener('click', async () => {
        // Check the current status when the modal is opened
        const isRegistered = await invoke('is_protocol_handler_registered');
        if (isRegistered) {
            nxmHandlerBtn.textContent = 'Remove as Default Handler';
            nxmHandlerBtn.classList.add('modal-btn-nxm');
            nxmHandlerBtn.classList.remove('modal-btn-nxm-confirm');
        } else {
            nxmHandlerBtn.textContent = 'Set as Default Handler';
            nxmHandlerBtn.classList.remove('modal-btn-nxm');
            nxmHandlerBtn.classList.add('modal-btn-nxm-confirm');
        }
        document.getElementById('nxmHandlerStatus').classList.add('hidden');
        settingsModalOverlay.classList.remove('hidden');
    });
    closeSettingsModalBtn.addEventListener('click', () => settingsModalOverlay.classList.add('hidden'));
    settingsModalOverlay.addEventListener('click', (e) => {
        if (e.target === settingsModalOverlay) settingsModalOverlay.classList.add('hidden');
    });

    rowPaddingSlider.addEventListener('input', () => {
        const padding = rowPaddingSlider.value;
        document.documentElement.style.setProperty('--mod-row-vertical-padding', `${padding}px`);
        rowPaddingValue.textContent = `${padding}px`;
    });
    rowPaddingSlider.addEventListener('change', () => {
        localStorage.setItem('modRowPadding', rowPaddingSlider.value);
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

            // Ignore if user is rearranging rows
            if (dragState.draggedElement) return;

            // Remove highlight immediately
            hideHighlight();

            // Normalize Payload
            let files = event.payload;
            if (files && files.paths) {
                files = files.paths;
            }

            // Validation
            if (!files || !Array.isArray(files) || files.length === 0) {
                console.warn("Drop ignored: Payload empty or invalid format", event);
                return;
            }

            if (!appState.xmlDoc) {
                await window.customAlert("Please load a GCMODSETTINGS.MXML file first.", "Error");
                return;
            }

            // Filter for valid archives
            const archiveFiles = files.filter(p =>
                p.toLowerCase().endsWith('.zip') ||
                p.toLowerCase().endsWith('.rar') ||
                p.toLowerCase().endsWith('.7z')
            );

            if (archiveFiles.length === 0) {
                console.log("Ignored drop: No valid archive files found.");
                return;
            }

            // Process files
            for (const filePath of archiveFiles) {
                const fileName = await basename(filePath);
                try {
                    console.log(`Processing dropped file: ${fileName}`);

                    // Call Backend
                    const analysis = await invoke('install_mod_from_archive', { archivePathStr: filePath });

                    // Handle Successful Installs
                    if (analysis.successes?.length > 0) {
                        for (const mod of analysis.successes) {
                            addNewModToXml(mod.name);

                            // --- ADD THIS BLOCK ---
                            // Explicitly generate mod_info.json for every folder extracted.
                            // Since this is a manual drop, we pass empty strings, 
                            // allowing checkForAndLinkMod (or the user later) to link it.
                            await invoke('ensure_mod_info', {
                                modFolderName: mod.name,
                                modId: "",
                                fileId: "",
                                version: ""
                            });
                            // ----------------------

                            await checkForAndLinkMod(mod.name);
                        }
                        await saveChanges();
                        await renderModList();

                        // Manually add to downloadHistory so Profile Manager sees it
                        const manualEntry = {
                            id: `manual-${Date.now()}`,
                            modId: null,
                            fileId: null,
                            version: 'Manual',
                            displayName: fileName,
                            fileName: fileName,
                            statusText: 'Installed',
                            statusClass: 'installed',
                            archivePath: analysis.active_archive_path,
                            modFolderName: analysis.successes[0].name,
                            size: 0,
                            createdAt: Date.now() / 1000
                        };
                        downloadHistory.unshift(manualEntry);
                        await saveDownloadHistory(downloadHistory);

                        // Then save profile
                        await saveCurrentProfile();
                        await window.customAlert(`Successfully installed ${analysis.successes.length} new mod(s) from ${fileName}.`, "Install Complete");
                    }

                    // Handle Conflicts
                    if (analysis.conflicts?.length > 0) {
                        for (const conflict of analysis.conflicts) {
                            const shouldReplace = await window.customConfirm(
                                `A mod with this ID is already installed ('${conflict.old_mod_folder_name}').\n\nReplace it with '${conflict.new_mod_name}'?`,
                                'Mod Conflict'
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
                                await saveChanges();
                                await window.customAlert(`Mod '${conflict.old_mod_folder_name}' was successfully updated to '${conflict.new_mod_name}'.`, "Updated");
                            } else {
                                await window.customAlert(`Update for mod '${conflict.old_mod_folder_name}' was cancelled.`, "Cancelled");
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error installing ${fileName}:`, error);
                    await window.customAlert(`Error installing ${fileName}: ${error}`, "Installation Failed");
                }
            }
        };

        await appWindow.listen('tauri://file-drop', onDrop);
        await appWindow.listen('tauri://drag-drop', onDrop);
    };


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

    // --- PROFILE MANAGER LOGIC ---

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

    // --- MODAL ACTION BUTTONS ---

    // 1. ADD
    document.getElementById('mpCreateBtn').addEventListener('click', async () => {
        const name = prompt("Enter new profile name:");
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

        const newName = prompt(`Copy "${selectedProfileInModal}" to new profile named:`);
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
        if (selectedProfileInModal === 'Default') return await window.customAlert("Cannot rename Default profile.", "Action Denied");

        const newName = prompt(`Rename ${selectedProfileInModal} to:`, selectedProfileInModal);
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
        if (selectedProfileInModal === 'Default') return await window.customAlert("Cannot delete Default profile.", "Action Denied");

        if (await window.customConfirm(`Delete profile "${selectedProfileInModal}"?`, "Confirm")) {
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
        const name = prompt("Enter new profile name:");
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

        const newName = prompt(`Rename ${current} to:`, current);
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

        const confirmed = await window.customConfirm(
            `Switch profile to "${targetProfile}"?\n\nThis will purge current mods and install the profile's mods.`,
            "Switch Profile"
        );

        // If the user clicked Cancel (false), stop everything immediately.
        if (!confirmed) {
            return;
        }

        // Show Modal
        profileProgressModal.classList.remove('hidden');
        profileProgressBar.style.width = '0%';
        profileProgressText.textContent = "Initializing...";

        const start = Date.now();

        // Listen for progress from Rust
        const unlisten = await listen('profile-progress', (event) => {
            const p = event.payload;
            const pct = (p.current / p.total) * 100;
            profileProgressBar.style.width = `${pct}%`;
            profileProgressText.textContent = `Installing ${p.current}/${p.total}: ${p.current_mod}`;

            // Simple time estimation
            const elapsed = (Date.now() - start) / 1000;
            const rate = p.current / elapsed; // mods per second
            const remaining = (p.total - p.current) / rate;
            profileTimeEst.textContent = `Estimated time remaining: ${Math.ceil(remaining)}s`;
        });

        try {
            // 1. Backend swaps files
            await invoke('apply_profile', { profileName: targetProfile });

            // 2. Frontend syncs history
            await syncDownloadHistoryWithProfile(targetProfile);

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

            profileProgressModal.classList.add('hidden');
            await window.customAlert(`Profile "${targetProfile}" applied successfully.`, "Success");

        } catch (e) {
            profileProgressModal.classList.add('hidden');
            await window.customAlert(`Error applying profile: ${e}`, "Error");
        } finally {
            unlisten();
        }
    });

    async function syncDownloadHistoryWithProfile(profileName) {
        try {
            // 1. Get the list of zips that SHOULD be installed according to the profile
            const profileFiles = await invoke('get_profile_mod_list', { profileName });

            // 2. Loop through history and update statuses
            let changed = false;
            downloadHistory.forEach(item => {
                // Check if this item's filename exists in the profile just loaded
                const shouldBeInstalled = profileFiles.includes(item.fileName);

                if (shouldBeInstalled) {
                    if (item.statusClass !== 'installed') {
                        item.statusText = 'Installed';
                        item.statusClass = 'installed';
                        changed = true;
                    }
                } else {
                    // If it was installed but is NOT in this profile, set it to Downloaded
                    if (item.statusClass === 'installed' || item.statusClass === 'success') {
                        item.statusText = 'Downloaded';
                        item.statusClass = 'success';
                        changed = true;
                    }
                }
            });

            // 3. Save the corrected history
            if (changed) {
                await saveDownloadHistory(downloadHistory);
                console.log("Download history synchronized with profile.");
            }

            // 4. Also update the Browse Grid cards
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

    navBrowse.addEventListener('click', () => {
        navBrowse.classList.add('active');
        navMyMods.classList.remove('active');
        browseView.classList.remove('hidden');
        myModsView.classList.add('hidden');
        if (browseGridContainer.childElementCount === 0) {
            fetchAndRenderBrowseGrid();
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
        if (!isPanelOpen) return;
        isPanelOpen = false;
        modDetailPanel.classList.remove('open');
        const currentSize = await appWindow.innerSize();
        await appWindow.setSize(new LogicalSize(DEFAULT_WIDTH, currentSize.height));

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
            await window.customAlert(`Invalid priority. Please enter a number between 0 and ${maxPriority}.`, "Invalid Input");
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
            await syncDownloadHistoryWithProfile(appState.activeProfile);
        }
        renderDownloadHistory();
        downloadHistoryModalOverlay.classList.remove('hidden');
    });

    closeDownloadHistoryBtn.addEventListener('click', () => downloadHistoryModalOverlay.classList.add('hidden'));
    downloadHistoryModalOverlay.addEventListener('click', (e) => {
        if (e.target === downloadHistoryModalOverlay) {
            downloadHistoryModalOverlay.classList.add('hidden');
        }
    });

    clearDownloadHistoryBtn.addEventListener('click', async () => {
        // 1. Show the new, more explicit confirmation dialog.
        const confirmed = await window.customConfirm(
            'Are you sure you want to delete ALL downloaded mod archives?\n\nThis will remove the files from your computer and cannot be undone.',
            'Delete All Downloads'
        );

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
        await window.customAlert("Hidden warnings have been reset and will appear again if issues are detected.", "Reset Complete");
    });

    nxmHandlerBtn.addEventListener('click', async () => {
        const statusEl = document.getElementById('nxmHandlerStatus');

        // Helper to show the final success/error message
        const setStatus = (message, type = 'success') => {
            statusEl.textContent = message;
            statusEl.className = `handler-status status-${type}`;
            statusEl.classList.remove('hidden');
        };

        // Helper to update the button's appearance
        const updateButtonState = async () => {
            const isRegistered = await invoke('is_protocol_handler_registered');
            if (isRegistered) {
                nxmHandlerBtn.textContent = 'Remove as Default Handler';
                nxmHandlerBtn.classList.add('modal-btn-nxm');
                nxmHandlerBtn.classList.remove('modal-btn-nxm-confirm');
            } else {
                nxmHandlerBtn.textContent = 'Set as Default Handler';
                nxmHandlerBtn.classList.remove('modal-btn-nxm');
                nxmHandlerBtn.classList.add('modal-btn-nxm-confirm');
            }
        };

        nxmHandlerBtn.disabled = true;
        const isCurrentlyRegistered = await invoke('is_protocol_handler_registered');
        let confirmed = false;

        if (isCurrentlyRegistered) {
            confirmed = await window.customConfirm(
                'Singularity is currently the default handler for NXM links.\nDo you want to remove this association?',
                'Remove NXM Handler'
            );
            if (confirmed) {
                try {
                    await invoke('unregister_nxm_protocol');
                    await updateButtonState();
                    setStatus('NXM handler successfully removed.', 'success');
                } catch (error) {
                    setStatus(`Error: ${error}`, 'error');
                }
            }
        } else {
            confirmed = await window.customConfirm(
                'Do you want to set Singularity as the default application for "Mod Manager Download" (nxm://) links?',
                'Set NXM Handler'
            );
            if (confirmed) {
                try {
                    await invoke('register_nxm_protocol');
                    await updateButtonState();
                    setStatus('NXM handler successfully set!', 'success');
                } catch (error) {
                    setStatus(`Error: ${error}`, 'error');
                }
            }
        }

        nxmHandlerBtn.disabled = false;
    });

    gridGapSlider.addEventListener('input', () => {
        const gap = gridGapSlider.value;
        document.documentElement.style.setProperty('--browse-grid-gap', `${gap}px`);
        gridGapValue.textContent = `${gap}px`;
    });
    gridGapSlider.addEventListener('change', () => {
        localStorage.setItem('browseGridGap', gridGapSlider.value);
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
        launchText.textContent = "LAUNCHING...";

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
            const confirmed = await window.customConfirm("Are you sure you want to disconnect your Nexus Mods account?", "Disconnect");
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

    const modsPerPageSlider = document.getElementById('modsPerPageSlider');
    const modsPerPageValue = document.getElementById('modsPerPageValue');

    modsPerPageSlider.addEventListener('input', () => {
        modsPerPageValue.textContent = modsPerPageSlider.value;
    });

    modsPerPageSlider.addEventListener('change', () => {
        const newValue = parseInt(modsPerPageSlider.value, 10);
        appState.modsPerPage = newValue;
        localStorage.setItem('modsPerPage', newValue);

        // Reset to page 1 and refresh grid if currently viewing it
        appState.currentPage = 1;
        filterAndDisplayMods();
    });

    (async () => {
        try {
            console.log("Starting App Initialization...");

            // 1. Check Login Status & Load API Key
            await validateLoginState();

            // 2. Initialize Main App Logic
            await initializeApp();

            // 3. Initialize Profile System
            await refreshProfileList();

            const savedProfile = localStorage.getItem('activeProfile') || 'Default';
            appState.activeProfile = savedProfile;

            // Safety Check: Ensure the saved profile actually exists in the list
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

            // 4. Initialize Drag & Drop
            await setupDragAndDrop();

            console.log("Initialization Complete.");

        } catch (error) {
            console.error("Critical Initialization Error:", error);
        }
    })();

});