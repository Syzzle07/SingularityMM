const fs = require('fs').promises;
const path = require('path');

// --- CONFIGURATION ---
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
if (!NEXUS_API_KEY) throw new Error("NEXUS_API_KEY environment variable not set!");

const WARNINGS_FILE_PATH = path.join(process.cwd(), 'mod_warnings.json');
const OUTPUT_FILE_PATH = path.join(process.cwd(), 'curated', 'curated_list.json');
const BATCH_SIZE = 5; 
const DELAY_BETWEEN_BATCHES = 1000; 

// --- API HELPERS ---

async function fetchModDataFromNexus(modId) {
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}.json`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
        const response = await fetch(url, { headers });
        if (response.status === 429) throw new Error("RATE_LIMIT");
        if (!response.ok) {
            console.error(`[Mod ${modId}] Info API Error: ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error(`[Mod ${modId}] Info Fetch Failed:`, error.message);
        return null;
    }
}

async function fetchModFilesFromNexus(modId) {
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}/files.json`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return { files: [] };
        return await response.json();
    } catch (error) {
        console.error(`[Mod ${modId}] Files Fetch Failed:`, error.message);
        return { files: [] };
    }
}

// Fetch Changelogs
async function fetchModChangelogsFromNexus(modId) {
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}/changelogs.json`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return {};
        return await response.json();
    } catch (error) {
        console.error(`[Mod ${modId}] Changelog Fetch Failed:`, error.message);
        return {};
    }
}

// --- MAIN LOGIC ---

async function buildCuratedList() {
    console.log("Starting Smart Update (Info + Files + Changelogs)...");

    // 1. Load Inputs
    const warningsContent = await fs.readFile(WARNINGS_FILE_PATH, 'utf8');
    const modsToProcess = JSON.parse(warningsContent);
    const warningsMap = new Map(modsToProcess.map(mod => [String(mod.id), mod]));

    // 2. Load Previous Cache
    let previousDataMap = new Map();
    try {
        const oldContent = await fs.readFile(OUTPUT_FILE_PATH, 'utf8');
        const oldJson = JSON.parse(oldContent);
        oldJson.forEach(mod => previousDataMap.set(String(mod.mod_id), mod));
        console.log(`Loaded ${oldJson.length} mods from previous cache.`);
    } catch (e) {
        console.log("No previous cache found. Doing full fetch.");
    }

    console.log(`Processing ${modsToProcess.length} mods in batches of ${BATCH_SIZE}...`);

    const finalResults = [];
    let apiCallCount = 0;

    // 3. Process in Batches
    for (let i = 0; i < modsToProcess.length; i += BATCH_SIZE) {
        const batch = modsToProcess.slice(i, i + BATCH_SIZE);
        
        const batchPromises = batch.map(async (inputMod) => {
            const modId = String(inputMod.id);

            // Call #1: Always fetch basic info
            const modData = await fetchModDataFromNexus(modId);
            apiCallCount++;

            if (!modData) return null; 

            let files = [];
            let changelogs = {};
            const cachedMod = previousDataMap.get(modId);

            // SMART CACHE CHECK
            // Reuse cache ONLY if:
            // 1. Timestamps match (Mod hasn't changed)
            // 2. Have Files (Cache isn't broken)
            // 3. Have Changelogs (Cache isn't from the old version of this script)
            if (cachedMod && 
                cachedMod.updated_timestamp === modData.updated_timestamp && 
                cachedMod.files && 
                cachedMod.changelogs
            ) {
                // REUSE CACHE
                files = cachedMod.files;
                changelogs = cachedMod.changelogs;
                // console.log(`[Mod ${modId}] Using cached data.`);
            } else {
                // FETCH FRESH DATA
                // This will run for ALL mods on the first time,
                // filling in the missing changelogs. Afterward, it only runs on updates.
                console.log(`[Mod ${modId}] Fresh fetch required (Update detected or missing data)...`);
                
                // Call #2: Files
                const filesData = await fetchModFilesFromNexus(modId);
                files = filesData.files;
                apiCallCount++;

                // Call #3: Changelogs
                changelogs = await fetchModChangelogsFromNexus(modId);
                apiCallCount++;
            }

            // Merge Data
            const warningInfo = warningsMap.get(modId);
            return {
                mod_id: modData.mod_id,
                name: modData.name,
                summary: modData.summary,
                version: modData.version,
                picture_url: modData.picture_url,
                author: modData.author,
                mod_downloads: modData.mod_downloads,
                endorsement_count: modData.endorsement_count,
                updated_timestamp: modData.updated_timestamp,
                created_timestamp: modData.created_timestamp,
                description: modData.description,
                state: warningInfo ? warningInfo.state : 'normal',
                warningMessage: warningInfo ? warningInfo.warningMessage : '',
                files: files,
                changelogs: changelogs
            };
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(res => { if (res) finalResults.push(res); });

        // Rate Limit Protection
        if (i + BATCH_SIZE < modsToProcess.length) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
        }
    }

    // 4. Save Result
    await fs.mkdir(path.dirname(OUTPUT_FILE_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_FILE_PATH, JSON.stringify(finalResults, null, 2));

    console.log("------------------------------------------------");
    console.log(`Summary:`);
    console.log(`- Total Mods:           ${modsToProcess.length}`);
    console.log(`- Total API Calls:      ${apiCallCount}`);
    console.log(`- Output saved to:      ${OUTPUT_FILE_PATH}`);
    console.log("------------------------------------------------");
}

buildCuratedList().catch(error => {
    console.error("Script failed:", error);
    process.exit(1);
});
