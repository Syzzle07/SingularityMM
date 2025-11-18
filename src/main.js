import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { basename, join, resolveResource, appDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
const appWindow = getCurrentWindow()

// --- Global State & Constants ---
let NEXUS_API_KEY = "";
const CURATED_LIST_URL = "https://raw.githubusercontent.com/Syzzle07/SingularityMM/refs/heads/data/curated/curated_list.json";
let curatedData = []; // This will hold all pre-processed data from the server.
let downloadHistory = [];
const nexusModCache = new Map();
const nexusFileCache = new Map();

const DEFAULT_WIDTH = 950;
const PANEL_OPEN_WIDTH = 1300;
let isPanelOpen = false;
const SCROLL_SPEED = 5;
const CACHE_DURATION_MS = 60 * 60 * 1000;

// A simple in-memory cache for changelogs for the current session.
const changelogCache = new Map();

document.addEventListener('DOMContentLoaded', () => {
    // --- Application & UI State ---
    const appState = {
        gamePath: null,
        settingsPath: null,
        currentFilePath: null,
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
          modDetailDownloads = document.getElementById('modDetailDownloads'),
          modDetailEndorsements = document.getElementById('modDetailEndorsements'),
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
          confirmationModalOverlay = document.getElementById('confirmationModalOverlay'),
          confirmationModalTitle = document.getElementById('confirmationModalTitle'),
          confirmationModalDescription = document.getElementById('confirmationModalDescription'),
          confirmActionBtn = document.getElementById('confirmActionBtn'),
          cancelActionBtn = document.getElementById('cancelActionBtn'),
          gridGapSlider = document.getElementById('gridGapSlider'),
          gridGapValue = document.getElementById('gridGapValue');

    // --- Core Application Logic ---

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

            // Check if the cached data is stale
            const isStale = (Date.now() - cachedData.timestamp) > CACHE_DURATION_MS;

            if (isStale) {
                console.log("Local cache is stale.");
                return null; // Treat stale data as if it doesn't exist
            }

            console.log("Successfully loaded curated list from local cache.");
            return cachedData.data;
        } catch (error) {
            // This is expected if the file doesn't exist yet
            console.log("No local cache found.");
            return null;
        }
    }

    async function saveCuratedListToCache(data) {
        try {
            const dataToCache = {
                timestamp: Date.now(),
                data: data
            };

            const dataDir = await appDataDir();
            await mkdir(dataDir, { recursive: true }); // Ensure the directory exists
            const cacheFilePath = await join(dataDir, 'curated_list_cache.json');
            await writeTextFile(cacheFilePath, JSON.stringify(dataToCache));
            console.log("Saved fresh curated list to local cache.");
        } catch (error) {
            console.error("Failed to save curated list to cache:", error);
        }
    }
    
    /**
     * Fetches the single source of truth for all mod data from the GitHub Action's output.
     */
    async function fetchCuratedData() {
        // 1. First, try to load from the local cache.
        const cachedList = await loadCuratedListFromCache();
        if (cachedList) {
            curatedData = cachedList; // Use the cached data
            console.log(`Successfully loaded ${curatedData.length} mods from cache.`);
            return; // We're done!
        }

        // 2. If cache is missing or stale, fetch from the network.
        try {
            console.log("Fetching latest curated mod data from GitHub...");
            // We can now remove the cache-busting timestamp from the URL
            const response = await fetch(CURATED_LIST_URL);
            if (!response.ok) throw new Error("Could not fetch remote curated list.");
            
            const freshData = await response.json();
            curatedData = freshData;
            console.log(`Successfully loaded ${curatedData.length} mods from network.`);

            // 3. Save the freshly downloaded data to our cache for next time.
            await saveCuratedListToCache(freshData);

        } catch (error) {
            console.error("CRITICAL: Could not load curated mod data:", error);
            alert("Failed to load mod data from the server. Update checks and the browse tab will not work.");
        }
    }

    const initializeApp = async () => {
        try {
            NEXUS_API_KEY = await invoke('get_nexus_api_key');
        } catch (error) {
            console.error("CRITICAL: Could not fetch Nexus API Key from backend.", error);
            alert("Could not load API Key. Mod download and update features will be disabled.");
        }

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

        // --- NEW, ROBUST GAME DETECTION ---
        const gamePaths = await invoke('detect_game_installation');
        if (gamePaths) {
            console.log(`Detected ${gamePaths.version_type} version of No Man's Sky.`);
            // Store both paths in your app's state
            appState.gamePath = gamePaths.game_root_path;
            appState.settingsPath = gamePaths.settings_root_path;
        }
        // --- END OF NEW LOGIC ---

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
                // Now, we construct the full path to the settings file with confidence.
                const settingsFilePath = await join(appState.settingsPath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
                const content = await readTextFile(settingsFilePath);
                await loadXmlContent(content, settingsFilePath);
            } catch (e) {
                console.warn("Could not auto-load settings file. It may not exist yet.", e);
            }
        }

        // Listen for the nxm-link-received event from the Rust backend
        listen('nxm-link-received', (event) => {
            handleNxmLink(event.payload);
        });

        // Load remote data and check for updates in the background
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
            // Populate the installedModsMap from the data we just received
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
            
            // Build the HTML for the row
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

            // Attach the event listener for the checkbox
            row.querySelector('.enabled-switch').addEventListener('change', (e) => {
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
                    saveChanges();
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

        // Get all the mod rows currently in the DOM
        const modRows = modListContainer.querySelectorAll('.mod-row');

        modRows.forEach(row => {
            const modName = row.dataset.modName;
            // Find the XML node corresponding to this row
            const modNode = Array.from(appState.xmlDoc.querySelectorAll('Property[name="Data"] > Property'))
                                .find(node => {
                                    const nameProp = node.querySelector('Property[name="Name"]');
                                    return nameProp && nameProp.getAttribute('value').toUpperCase() === modName.toUpperCase();
                                });

            if (modNode) {
                // Get the latest "enabled" state from the XML
                const isEnabled = modNode.querySelector('Property[name="Enabled"]')?.getAttribute('value').toLowerCase() === 'true';
                
                // Find the checkbox in this row and update its state
                const checkbox = row.querySelector('.enabled-switch');
                if (checkbox && checkbox.checked !== isEnabled) {
                    checkbox.checked = isEnabled;
                }
            }
        });
    }

    /**
     * Performs an update check using the pre-loaded curated data. Makes ZERO API calls.
     */
    async function checkForUpdates(isSilent = false) {
        if (!appState.gamePath || curatedData.length === 0) {
            if (!isSilent) alert("Mod data is not loaded. Cannot check for updates.");
            return;
        }

        if (isSilent) {
            console.log("Performing silent update check using in-memory data...");
        } else {
            updateListContainer.innerHTML = `<p>${i18n.get('updateChecking')}</p>`;
            updateModalOverlay.classList.remove('hidden');
        }

        const modsWithUpdates = [];

        // --- THIS IS THE FIX ---
        // Instead of looping over the UI and reading files, we now loop over
        // our fast in-memory cache, which already has all the mod info.
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
                            const installedFileCategory = installedFileOnNexus.category_name;
                            const allFilesInCategory = remoteModInfo.files.filter(f => f.category_name === installedFileCategory);
                            if (allFilesInCategory.length > 0) {
                                const latestFileInCategory = allFilesInCategory.sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
                                if (isNewerVersionAvailable(installedVersion, latestFileInCategory.version)) {
                                    modsWithUpdates.push({
                                        folderName: modFolderName,
                                        name: remoteModInfo.name || modFolderName,
                                        installed: installedVersion,
                                        latest: latestFileInCategory.version,
                                        nexusUrl: `https://www.nexusmods.com/nomanssky/mods/${remoteModInfo.mod_id}`
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        // --- END OF FIX ---

        // The rest of the function for displaying the results is perfectly fine.
        if (isSilent) {
            modsWithUpdates.forEach(mod => {
                const row = modListContainer.querySelector(`.mod-row[data-mod-name="${mod.folderName}"]`);
                const indicator = row?.querySelector('.update-indicator');
                if (indicator) indicator.classList.remove('hidden');
            });
            console.log(`Update check found ${modsWithUpdates.length} outdated mods.`);
        } else {
            if (modsWithUpdates.length > 0) {
                updateListContainer.innerHTML = '';
                modsWithUpdates.forEach(mod => {
                    const item = document.createElement('div');
                    item.className = 'update-item';
                    const nexusLinkHtml = mod.nexusUrl ? `<a href="${mod.nexusUrl}" class="nexus-button" target="_blank" title="Visit on Nexus Mods"><img src="/src/assets/icon-nexus.png" alt="Nexus"></a>` : '';
                    item.innerHTML = `
                        <div class="update-item-info">
                            <div class="update-item-name">${mod.name}</div>
                            <div class="update-item-version">
                                ${mod.installed} <span class="arrow">--></span> <span class="latest">${mod.latest}</span>
                            </div>
                        </div>
                        ${nexusLinkHtml}`;
                    updateListContainer.appendChild(item);
                });
            } else {
                updateListContainer.innerHTML = `<p>${i18n.get('updateNoneFound')}</p>`;
            }
        }
    }

    // --- Other Helper Functions ---
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
        // The timestamp from Rust is in seconds, JS Date needs milliseconds
        const date = new Date(timestamp * 1000); 
        return date.toLocaleDateString(); // Uses the user's local date format
    }

    function showConfirmationModal(title, description) {
        return new Promise((resolve) => {
            confirmationModalTitle.textContent = title;
            confirmationModalDescription.textContent = description;
            confirmationModalOverlay.classList.remove('hidden');

            const handleConfirm = () => {
                cleanup();
                resolve(true);
            };

            const handleCancel = () => {
                cleanup();
                resolve(false);
            };

            const cleanup = () => {
                confirmActionBtn.removeEventListener('click', handleConfirm);
                cancelActionBtn.removeEventListener('click', handleCancel);
                confirmationModalOverlay.classList.add('hidden');
            };

            confirmActionBtn.addEventListener('click', handleConfirm);
            cancelActionBtn.addEventListener('click', handleCancel);
        });
    }

    async function startModDownload({ modId, fileId, version, fileName, displayName }, isUpdate = false) {
        const existingItem = downloadHistory.find(d => d.fileId === fileId);
        
        if (existingItem && existingItem.archivePath && !isUpdate) {
            const confirmed = await showConfirmationModal(
                'Duplicate Download',
                `You have already downloaded "${displayName || fileName}". Do you want to download it again and replace the existing file?`
            );

            if (!confirmed) {
                console.log("User cancelled duplicate download.");
                downloadHistoryModalOverlay.classList.remove('hidden');
                downloadHistory = downloadHistory.filter(d => d.fileId !== fileId);
                downloadHistory.unshift(existingItem);
                renderDownloadHistory();
                return;
            }
            
            downloadHistory = downloadHistory.filter(d => d.fileId !== fileId);
        }

        downloadHistoryModalOverlay.classList.remove('hidden');

        const downloadId = `download-${Date.now()}`;
        const newItemData = {
            id: downloadId,
            modId: modId,
            fileId: fileId,
            version: version,
            displayName: displayName, // The clean name for display
            fileName: fileName,       // The raw filename for saving
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
            const downloadUrl = await fetchDownloadUrlFromNexus(modId, fileId);
            if (!downloadUrl) throw new Error("Could not retrieve download URL.");

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

        // Log the complete state of the item we're opening the menu for.
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
            
            // This is the core Rust command that extracts and moves the mod.
            const analysis = await invoke('install_mod_from_archive', { archivePathStr: item.archivePath });

            let oldArchiveToDelete = null;

            // --- Handle Conflicts (Typically for Updates) ---
            if (analysis.conflicts && analysis.conflicts.length > 0) {
                for (const conflict of analysis.conflicts) {
                    // Find the download history item that corresponds to the mod folder being replaced.
                    const oldItemIndex = downloadHistory.findIndex(d => d.modFolderName === conflict.old_mod_folder_name);
                    if (oldItemIndex > -1) {
                        const oldItem = downloadHistory[oldItemIndex];
                        // Ensure we don't delete the archive we're currently installing
                        if (oldItem.archivePath && oldItem.id !== item.id) {
                            oldArchiveToDelete = oldItem.archivePath;
                            // Remove the old item from the history array
                            downloadHistory.splice(oldItemIndex, 1);
                        }
                    }

                    // If it's an auto-update, we always replace. Otherwise, ask the user.
                    const shouldReplace = isUpdate ? true : await confirm(
                        `A mod with this ID is already installed ('${conflict.old_mod_folder_name}'). Replace it with '${conflict.new_mod_name}'?`,
                        { title: 'Mod Update Conflict', type: 'warning' }
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
                            modId: item.modId,
                            fileId: item.fileId,
                            version: item.version
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
                        modId: item.modId,
                        fileId: item.fileId,
                        version: item.version
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

        } catch (error) {
            console.error("Installation process failed:", error);
            updateStatus(`Install failed: ${error.message}`, 'error');
            await saveDownloadHistory(downloadHistory);
        }
    }

    async function handleDownloadItemDelete(downloadId) {
        const confirmed = await confirm("Are you sure you want to delete this downloaded mod archive? This cannot be undone.", { type: 'warning' });
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
            alert(`Failed to delete archive: ${error}`);
        }
    }
    
    function updateModDisplayState(modId) {
        const modIdStr = String(modId);
        const installedFiles = appState.installedModsMap.get(modIdStr);
        const isInstalled = installedFiles && installedFiles.size > 0;

        // --- 1. Update the Mod Detail Panel (if it's open for this mod) ---
        if (!modDetailPanel.classList.contains('hidden') && modDetailName.dataset.modId === modIdStr) {
            // Update the main download/manage button text
            const primaryBtn = modDetailInstallBtnContainer.querySelector('.mod-card-install-btn');
            if (primaryBtn) {
                primaryBtn.textContent = isInstalled ? 'MANAGE FILES' : 'DOWNLOAD';
            }

            // Update the "Installed" version field in the metadata
            if (isInstalled) {
                // This displays the version of the first installed file we find for that mod
                modDetailInstalled.textContent = installedFiles.values().next().value || 'Installed';
            } else {
                modDetailInstalled.textContent = 'N/A';
            }
        }

        // --- 2. THIS IS THE FIX: Update the Mod Card in the Browse Grid ---
        const card = browseGridContainer.querySelector(`.mod-card[data-mod-id="${modIdStr}"]`);
        if (card) {
            console.log(`Updating grid card for modId: ${modIdStr}. Is installed: ${isInstalled}`);
            const badge = card.querySelector('.mod-card-installed-badge');
            
            // Use classList.toggle for a clean add/remove based on the isInstalled boolean
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
        // This will now correctly populate the update indicators.
        if (appState.gamePath) {
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
                default: // Default to 'date'
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
            statusEl.className = 'download-item-status'; // Reset classes
            statusEl.classList.add(`status-${statusClass}`);
        }
    }

    async function handleNxmLink(link) {
        console.log(`Frontend received nxm link: ${link}`);
        
        const match = link.match(/nxm:\/\/nomanssky\/mods\/(\d+)\/files\/(\d+)/);
        if (!match || match.length < 3) {
            alert('Error: The received Nexus link was malformed.');
            return;
        }

        const modId = match[1];
        const fileId = match[2];

        try {
            const filesData = await fetchModFilesFromNexus(modId);
            const fileInfo = filesData?.files.find(f => String(f.file_id) === fileId);
            if (!fileInfo) {
                throw new Error(`File ID ${fileId} not found for mod ${modId}.`);
            }

            // Unlike the in-app download, we don't have the main mod title readily available,
            // so we use the file's specific name as the best display name.
            const displayName = fileInfo.name || fileInfo.file_name;

            await startModDownload({
                modId: modId,
                fileId: fileId,
                version: fileInfo.version,
                fileName: fileInfo.file_name,
                displayName: displayName
            });

        } catch (error) {
            alert(`Failed to process NXM link: ${error.message}`);
        }
    }

    const reorderModsByList = async (orderedModNames) => {
        try {
            // 1. Call the new Rust command, passing the desired order.
            const updatedXmlContent = await invoke('reorder_mods', { orderedModNames });

            // 2. Load the perfectly sorted XML returned by the backend. This refreshes our state.
            await loadXmlContent(updatedXmlContent, appState.currentFilePath);
            
            // 3. The renderModList() called by loadXmlContent will automatically redraw the UI.
            // No need to call saveChanges() here, as the backend has already saved the file implicitly
            // by returning the content for us to manage. We just need to write it.
            await saveChanges(); // This will write the new content to the file.
        } catch (error) {
            alert(`Error re-ordering mods: ${error}`);
            // If it fails, re-render the original list to avoid a broken UI state
            renderModList();
        }
    };

    function reorderModListUI(orderedModNames) {
        // For efficiency, first create a Map of the existing DOM elements,
        // so we can look them up instantly instead of searching the DOM repeatedly.
        const rowsMap = new Map();
        modListContainer.querySelectorAll('.mod-row').forEach(row => {
            rowsMap.set(row.dataset.modName, row);
        });

        // Now, append the elements back to the container in the new, correct order.
        // Appending an element that's already in the DOM simply moves it.
        orderedModNames.forEach(modName => {
            const rowElement = rowsMap.get(modName);
            if (rowElement) {
                modListContainer.appendChild(rowElement);
            }
        });

        // Finally, update the visible priority numbers to reflect the new order.
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
        catch (e) { alert(`Error saving file: ${e}`); }
    };

    const setAllModsEnabled = (enabled) => {
        if (!appState.xmlDoc) {
            alert("Please load a GCMODSETTINGS file first.");
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
        
        // THIS IS THE FIX:
        // Instead of rebuilding the whole list, just update the checkboxes.
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
                    alert(i18n.get('linkCancelled', { modName: modFolderName }));
                    return;
                }
                const match = nexusUrl.match(/nexusmods\.com\/nomanssky\/mods\/(\d+)/);
                const parsedId = match ? match[1] : null;
                if (parsedId) {
                    await invoke('update_mod_id_in_json', {
                        modFolderName: modFolderName,
                        newModId: parsedId
                    });
                    alert(i18n.get('linkSuccess', { modName: modFolderName }));
                } else {
                    alert(i18n.get('linkInvalid', { modName: modFolderName }));
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

    /**
     * Fetches a download URL. This is one of the few remaining live API calls, as it's user-initiated.
     */
    async function fetchDownloadUrlFromNexus(modId, fileId) {
        const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}/files/${fileId}/download_link.json`;
        const headers = { "apikey": NEXUS_API_KEY };
        try {
            const response = await fetch(url, { headers });
            if (!response.ok) return null;
            const data = await response.json();
            return data[0]?.URI;
        } catch (error) {
            console.error(`Failed to get download URL for mod ${modId}:`, error);
            return null;
        }
    }

    async function fetchModDataFromNexus(modId) {
        const modIdStr = String(modId);
        if (nexusModCache.has(modIdStr)) {
            return nexusModCache.get(modIdStr);
        }
        const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modIdStr}.json`;
        const headers = { "apikey": NEXUS_API_KEY };
        try {
            const response = await fetch(url, { headers });
            if (!response.ok) {
                console.error(`Nexus API error for mod ID ${modIdStr}: ${response.status}`);
                return null;
            }
            const data = await response.json();
            nexusModCache.set(modIdStr, data);
            return data;
        } catch (error) {
            console.error(`Failed to fetch data for mod ID ${modIdStr}:`, error);
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

    /**
     * Fetches changelogs. Caches them for the session to avoid repeated calls.
     */
    async function fetchChangelogsFromNexus(modId) {
        const modIdStr = String(modId);
        if (changelogCache.has(modIdStr)) return changelogCache.get(modIdStr);

        const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modIdStr}/changelogs.json`;
        const headers = { "apikey": NEXUS_API_KEY };
        try {
            const response = await fetch(url, { headers });
            if (!response.ok) return null;
            const data = await response.json();
            changelogCache.set(modIdStr, data); // Cache the result
            return data;
        } catch (error) {
            console.error(`Failed to fetch changelogs for mod ID ${modIdStr}:`, error);
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

    // --- Drag and Drop Logic ---
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
            // We don't need to re-render again after this, as the UI is already correct.
            invoke('reorder_mods', { orderedModNames: finalModOrder })
                .then(updatedXmlContent => {
                    // 3. Silently update our in-memory data to match what was saved.
                    appState.xmlDoc = new DOMParser().parseFromString(updatedXmlContent, "application/xml");
                    saveChanges();
                    console.log("Mod order saved and local state synced.");
                })
                .catch(error => {
                    alert(`Error saving new mod order: ${error}`);
                    // If saving fails, we should probably re-render to revert the UI change.
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
        const filterBy = browseFilterSelect.value; // Read from the new filter dropdown
        const sortBy = browseSortSelect.value;     // Read from the sort dropdown

        let processedMods = [...curatedData]; // Start with a full copy

        // --- STAGE 1: FILTERING ---

        // 1a. Filter by Search Term
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

        // 1b. Filter by Installation Status
        if (filterBy === 'installed') {
            processedMods = processedMods.filter(mod => appState.installedModsMap.has(String(mod.mod_id)));
        } else if (filterBy === 'uninstalled') {
            processedMods = processedMods.filter(mod => !appState.installedModsMap.has(String(mod.mod_id)));
        }

        // --- STAGE 2: SORTING ---
        // Now, sort the already filtered list.
        if (sortBy === 'endorsements') {
            processedMods.sort((a, b) => (b.endorsement_count || 0) - (a.endorsement_count || 0));
        } else { // Default sort is 'last_updated'
            processedMods.sort((a, b) => (b.updated_timestamp || 0) - (a.updated_timestamp || 0));
        }

        // --- STAGE 3: DISPLAY ---
        displayMods(processedMods);
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
            // --- THIS IS THE NEW LOGIC ---
            // Check if this mod is in our map of installed mods.
            const modIdStr = String(modData.mod_id);
            if (appState.installedModsMap.has(modIdStr)) {
                
                // 1. Add the 'is-installed' class to the main card to trigger the border.
                card.classList.add('is-installed');

                // 2. Make the badge container visible.
                card.querySelector('.mod-card-installed-badge').classList.remove('hidden');
            }
            // --- END OF NEW LOGIC ---
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
            card.querySelector('.mod-card-author').textContent = `by ${modData.author}`;
            card.querySelector('.mod-card-downloads').textContent = new Intl.NumberFormat().format(modData.mod_downloads);
            card.querySelector('.mod-card-endorsements').textContent = new Intl.NumberFormat().format(modData.endorsement_count);

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
        modDetailDownloads.textContent = new Intl.NumberFormat().format(modData.mod_downloads);
        modDetailEndorsements.textContent = new Intl.NumberFormat().format(modData.endorsement_count);

        const currentLang = mapLangCode(languageSelector.value);
        modDetailUpdated.textContent = formatNexusDate(modData.updated_timestamp, currentLang);
        modDetailCreated.textContent = formatNexusDate(modData.created_timestamp, currentLang);

        // --- THIS IS THE NEW, CORRECTED LOGIC FOR THE "INSTALLED" FIELD ---
        const modIdStr = String(modData.mod_id);
        const installedFiles = appState.installedModsMap.get(modIdStr); // This is our Map<fileId, version>

        let versionToShow = 'N/A'; // Default value

        if (installedFiles && installedFiles.size > 0) {
            // We have installed files. Now let's try to find the main one.
            let mainFileVersion = null;
            const allModFilesFromCurated = modData.files || [];

            // Loop through all the files that are INSTALLED for this mod.
            for (const installedFileId of installedFiles.keys()) {
                // Find the full data for this installed file from our curated list.
                const fileData = allModFilesFromCurated.find(f => String(f.file_id) === installedFileId);
                
                // If we find its data and its category is "MAIN"...
                if (fileData && fileData.category_name === 'MAIN') {
                    // ...we've found our priority version!
                    mainFileVersion = installedFiles.get(installedFileId);
                    break; // No need to look further.
                }
            }

            // Now, decide what to display.
            if (mainFileVersion) {
                // If we found a main file version, that's what we show.
                versionToShow = mainFileVersion;
            } else {
                // Otherwise, no main file is installed. Fall back to showing the first installed version we have.
                versionToShow = installedFiles.values().next().value || 'N/A';
            }
        }

        modDetailInstalled.textContent = versionToShow;
        // --- END OF CORRECTION ---
        
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
        changelogBtn.onclick = async () => {
            changelogListContainer.innerHTML = '<p>Loading...</p>';
            changelogModalOverlay.classList.remove('hidden');
            const changelogs = await fetchChangelogsFromNexus(modData.mod_id);
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
            alert("Could not find file information for this mod in the local data. Please try again later.");
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

            // This is the raw, original filename (e.g., ModName-1234-1-0.zip)
            const rawFileName = file.file_name;

            if (installedVersionForThisFile) {
                const isUpToDate = !isNewerVersionAvailable(installedVersionForThisFile, file.version);
                if (isUpToDate) {
                    buttonHtml = `<button class="mod-card-install-btn" disabled>INSTALLED</button>`;
                } else {
                    buttonHtml = `<button class="mod-card-install-btn" data-file-id="${fileIdStr}" data-mod-id="${modId}" data-version="${file.version}" data-raw-filename="${rawFileName}">UPDATE</button>`;
                }
            } else {
                let isUpdateForAnotherFile = false;
                if (installedFilesForThisMod) {
                    for (const [installedFileId, installedVersion] of installedFilesForThisMod.entries()) {
                        const installedFileOnNexus = filesData.files.find(f => String(f.file_id) === installedFileId);
                        if (installedFileOnNexus && installedFileOnNexus.category_name === file.category_name) {
                            if (isNewerVersionAvailable(installedVersion, file.version)) {
                                isUpdateForAnotherFile = true;
                                break; 
                            }
                        }
                    }
                }
                const buttonText = isUpdateForAnotherFile ? 'UPDATE' : 'DOWNLOAD';
                // --- THIS IS THE FIX ---
                // We add data-raw-filename to the button to store the original filename.
                buttonHtml = `<button class="mod-card-install-btn" data-file-id="${fileIdStr}" data-mod-id="${modId}" data-version="${file.version}" data-raw-filename="${rawFileName}">${buttonText}</button>`;
            }

            // The clean name for display (e.g., "sHealthcare - Powerless Stations")
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
        // --- PERFORMANCE FIX: Read from our fast in-memory cache ---
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
        
        // Now, find the remote info (this is also fast, as it's in memory)
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

        // Set Nexus link
        if (remoteInfo?.mod_id) {
            infoNexusLink.href = `https://www.nexusmods.com/nomanssky/mods/${remoteInfo.mod_id}`;
            infoNexusLink.classList.remove('hidden');
        }

        modInfoPanel.classList.remove('hidden');
    }

    // --- UI Event Listeners ---

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
                alert(i18n.get('copySuccess', { modName }));
            } catch (err) {
                console.error('Failed to copy text: ', err);
                alert('Could not copy text to clipboard.');
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
            const confirmed = await confirm(
                i18n.get('confirmDeleteMod', { modName }),
                { title: i18n.get('confirmDeleteTitle'), type: 'warning' }
            );
            if (confirmed) {
                try {
                    // Call the Rust command. It handles file deletion and returns the new data for the UI.
                    const modsToRender = await invoke('delete_mod', { modName: modName });
                    
                    // Re-sync the in-memory XML document to reflect the deletion.
                    try {
                        const settingsPath = await join(appState.gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
                        const content = await readTextFile(settingsPath);
                        appState.xmlDoc = new DOMParser().parseFromString(content, "application/xml");
                    } catch (e) {
                        console.error("Failed to re-sync xmlDoc after deletion:", e);
                        // Force a reload to prevent a de-synced state, which is safer for the user.
                        location.reload(); 
                        return;
                    }
                    
                    // Re-render the main mod list UI efficiently.
                    await renderModList(modsToRender);

                    // Find the corresponding item in the download history to update its state.
                    const deletedItem = downloadHistory.find(item => item.modFolderName && item.modFolderName.toUpperCase() === modName.toUpperCase());
                    if (deletedItem) {
                        // Revert the status from "Installed" back to "Downloaded".
                        deletedItem.statusText = 'Downloaded';
                        deletedItem.statusClass = 'success';
                        
                        const modIdToUpdate = deletedItem.modId;
                        
                        // Clear the folder name association.
                        deletedItem.modFolderName = null; 
                        
                        // Save the updated download history.
                        await saveDownloadHistory(downloadHistory);

                        // If we found the item, we also have its modId, so we can update the browse tab UI.
                        if (modIdToUpdate) {
                            updateModDisplayState(modIdToUpdate);
                        }
                    }

                    alert(i18n.get('deleteSuccess', { modName }));

                } catch (error) {
                    alert(`${i18n.get('deleteError', { modName })}\n\n${error}`);
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
            nxmHandlerBtn.classList.add('modal-btn-delete');
            nxmHandlerBtn.classList.remove('modal-btn-confirm');
        } else {
            nxmHandlerBtn.textContent = 'Set as Default Handler';
            nxmHandlerBtn.classList.remove('modal-btn-delete');
            nxmHandlerBtn.classList.add('modal-btn-confirm');
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
        const confirmed = await confirm(i18n.get('troubleshootModalDesc'), {
            title: i18n.get('troubleshootModalTitle'),
            type: 'warning',
            okLabel: 'Delete',
            cancelLabel: 'Cancel'
        });
        if (!confirmed) return;
        try {
            const resultKey = await invoke('delete_settings_file');
            appState.currentFilePath = null;
            appState.xmlDoc = null;
            filePathLabel.textContent = i18n.get('noFileLoaded');
            disableAllSwitch.checked = false;
            disableAllSwitch.disabled = true;
            modListContainer.innerHTML = '';
            alert(i18n.get(resultKey));
        } catch (error) {
            alert(`Error: ${error}`);
        }
    });

    const setupDragAndDrop = async () => {
        // This listener handles the files when they are actually dropped onto the window.
        // The payload is an array of file paths.
        await listen('tauri://file-drop', async (event) => {
            // Ignore file drops while a mod is being dragged for reordering
            if (dragState.draggedElement) return;

            dropZone.classList.remove('drag-over');
            if (!appState.xmlDoc) {
                alert("Please load a GCMODSETTINGS.MXML file first.");
                return;
            }
            
            const archiveFiles = event.payload.filter(p => p.toLowerCase().endsWith('.zip') || p.toLowerCase().endsWith('.rar'));
            if (archiveFiles.length === 0) return;

            // Your existing logic for processing the files is perfect and can be reused here.
            for (const filePath of archiveFiles) {
                const fileName = await basename(filePath);
                try {
                    const analysis = await invoke('install_mod_from_archive', { archivePathStr: filePath });

                    if (analysis.successes?.length > 0) {
                        for (const mod of analysis.successes) {
                            addNewModToXml(mod.name);
                            await checkForAndLinkMod(mod.name);
                        }
                        alert(`Successfully installed ${analysis.successes.length} new mod(s) from ${fileName}.`);
                    }

                    if (analysis.conflicts?.length > 0) {
                        for (const conflict of analysis.conflicts) {
                            const shouldReplace = await confirm(
                                `A mod with this ID is already installed ('${conflict.old_mod_folder_name}'). Replace it with '${conflict.new_mod_name}'?`,
                                { title: 'Mod Conflict', type: 'warning' }
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
                                alert(`Mod '${conflict.old_mod_folder_name}' was successfully updated to '${conflict.new_mod_name}'.`);
                            } else {
                                alert(`Update for mod '${conflict.old_mod_folder_name}' was cancelled.`);
                            }
                        }
                    }
                } catch (error) {
                    alert(`Error installing ${fileName}: ${error}`);
                }
            }
        });

        // This listener adds the visual "drag-over" effect when files hover over the window.
        await listen('tauri://file-drop-hover', () => {
            if (dragState.draggedElement) return;
            dropZone.classList.add('drag-over');
        });

        // This listener removes the visual effect when the dragged files leave the window.
        await listen('tauri://file-drop-cancelled', () => {
            if (dragState.draggedElement) return;
            dropZone.classList.remove('drag-over');
        });
    };
    
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
        // --- THIS IS THE NEW LOGIC ---
        // Remove 'selected' from any previously selected card
        const previouslySelected = browseGridContainer.querySelector('.mod-card.selected');
        if (previouslySelected) {
            previouslySelected.classList.remove('selected');
        }
        // --- END OF NEW LOGIC ---

        const clickedCard = e.target.closest('.mod-card');
        if (clickedCard) {
            // Add 'selected' to the newly clicked card
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

        // --- THIS IS THE NEW LOGIC ---
        // When the panel closes, find the selected card and remove the highlight
        const currentlySelected = browseGridContainer.querySelector('.mod-card.selected');
        if (currentlySelected) {
            currentlySelected.classList.remove('selected');
        }
        // --- END OF NEW LOGIC ---
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

    confirmPriorityBtn.addEventListener('click', () => {
        const modToMove = priorityModalOverlay.dataset.modName;
        const newPriority = parseInt(priorityInput.value, 10);
        const maxPriority = parseInt(priorityInput.max, 10);
        if (isNaN(newPriority) || newPriority < 0 || newPriority > maxPriority) {
            alert(`Invalid priority. Please enter a number between 0 and ${maxPriority}.`);
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
            .then(updatedXmlContent => {
                // 3. Silently update our in-memory data.
                appState.xmlDoc = new DOMParser().parseFromString(updatedXmlContent, "application/xml");
                saveChanges();
                console.log("Mod order saved and local state synced.");
            })
            .catch(error => {
                alert(`Error saving new mod order: ${error}`);
                renderModList(); // Revert on error
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
            
            // --- THIS IS THE FIX ---
            // 1. Get the CLEAN name from the UI for display purposes.
            const displayName = itemElement.querySelector('.update-item-name').textContent.split(' (v')[0];
            
            // 2. Get the RAW filename from the data attribute we just added.
            const rawFileName = button.dataset.rawFilename;

            button.disabled = true;
            fileSelectionModalOverlay.classList.add('hidden');
            
            // 3. Pass the correct variables to the download function.
            await startModDownload({
                modId: modId,
                fileId: fileId,
                version: version,
                fileName: rawFileName, // The raw name for saving the file
                displayName: displayName // The clean name for the UI
            }, isUpdate);
        }
    });

    browseSortSelect.addEventListener('change', filterAndDisplayMods);
    browseFilterSelect.addEventListener('change', filterAndDisplayMods);
    browseSearchInput.addEventListener('input', filterAndDisplayMods);

    downloadHistoryBtn.addEventListener('click', async () => {
        // Before showing the modal, check for removed mods
        let historyChanged = false;
        for (const item of downloadHistory) {
            // Only check items that were successfully installed
            if (item.statusClass === 'success' && item.modFolderName) {
                const exists = await invoke('check_mod_exists', { modFolderName: item.modFolderName });
                if (!exists) {
                    item.statusText = 'Mod has been removed from the MODS folder.';
                    item.statusClass = 'removed';
                    historyChanged = true;
                }
            }
        }
        // If we found any removed mods, save the updated history and re-render the list
        if (historyChanged) {
            await saveDownloadHistory(downloadHistory);
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
        const confirmed = await showConfirmationModal(
            'Delete All Downloads',
            'Are you sure you want to delete ALL downloaded mod archives? This will remove the files from your computer and cannot be undone.'
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
                alert(`An error occurred while deleting the files: ${error}`);
            }
        } else {
            console.log("User cancelled 'Delete All' operation.");
        }
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
                nxmHandlerBtn.classList.add('modal-btn-delete');
                nxmHandlerBtn.classList.remove('modal-btn-confirm');
            } else {
                nxmHandlerBtn.textContent = 'Set as Default Handler';
                nxmHandlerBtn.classList.remove('modal-btn-delete');
                nxmHandlerBtn.classList.add('modal-btn-confirm');
            }
        };

        // --- NEW LOGIC FLOW ---
        nxmHandlerBtn.disabled = true; // Disable button while modal is open
        const isCurrentlyRegistered = await invoke('is_protocol_handler_registered');
        let confirmed = false;

        if (isCurrentlyRegistered) {
            // Ask for confirmation to REMOVE the handler
            confirmed = await showConfirmationModal(
                'Remove NXM Handler',
                'Singularity is currently the default handler for NXM links. Do you want to remove this association?'
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
            // Ask for confirmation to SET the handler
            confirmed = await showConfirmationModal(
                'Set NXM Handler',
                'Do you want to set Singularity as the default application for "Mod Manager Download" (nxm://) links?'
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
        
        nxmHandlerBtn.disabled = false; // Re-enable button
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

        // If clicking the same header again, reverse the direction.
        if (downloadSortState.key === sortKey) {
            downloadSortState.direction = downloadSortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            // Otherwise, set the new key and default to descending order.
            downloadSortState.key = sortKey;
            downloadSortState.direction = 'desc';
        }

        // Re-render the list with the new sort order.
        renderDownloadHistory();
    });

    // --- App Initialization ---
    initializeApp();
    setupDragAndDrop();

});