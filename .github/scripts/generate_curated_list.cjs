const fs = require('fs').promises;
const path = require('path');

// --- CONFIGURATION ---
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
if (!NEXUS_API_KEY) throw new Error("NEXUS_API_KEY environment variable not set!");

const WARNINGS_FILE_PATH = path.join(process.cwd(), 'mod_warnings.json');
const OUTPUT_FILE_PATH = path.join(process.cwd(), 'curated', 'curated_list.json');
// Nexus 'updated' endpoint supports: '1d', '1w', '1m'
const UPDATE_PERIOD = '1w';
// Batching to be safe with the ones we DO fetch
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES = 1000;

// --- API HELPERS ---

// 1. Get list of ALL mods updated recently
async function fetchUpdatedModsList() {
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/updated.json?period=${UPDATE_PERIOD}`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            console.error(`Failed to fetch updated mods list: ${response.status}`);
            return [];
        }
        const data = await response.json();
        return data.map(m => String(m.mod_id));
    } catch (error) {
        console.error("Error fetching updated mods list:", error);
        return [];
    }
}

async function fetchModDataFromNexus(modId) {
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}.json`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
        const response = await fetch(url, { headers });
        if (response.status === 429) throw new Error("RATE_LIMIT");
        if (!response.ok) return null;
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

async function fetchModChangelogsFromNexus(modId) {
    const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}/changelogs.json`;
    const headers = { "apikey": NEXUS_API_KEY };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return {};
        return await response.json();
    } catch (error) {
        return {};
    }
}

// --- MAIN LOGIC ---

async function buildCuratedList() {
    console.log("Starting Incremental Smart Update...");

    // 1. Load Inputs (Manual list)
    const warningsContent = await fs.readFile(WARNINGS_FILE_PATH, 'utf8');
    const modsToProcess = JSON.parse(warningsContent)
        .filter(mod => mod.id && String(mod.id).trim() !== ""); // Filter templates

    const warningsMap = new Map(modsToProcess.map(mod => [String(mod.id), mod]));

    // 2. Load Previous Cache (The "Memory")
    let previousDataMap = new Map();
    try {
        const oldContent = await fs.readFile(OUTPUT_FILE_PATH, 'utf8');
        const oldJson = JSON.parse(oldContent);
        oldJson.forEach(mod => previousDataMap.set(String(mod.mod_id), mod));
        console.log(`Loaded ${oldJson.length} mods from local cache.`);
    } catch (e) {
        console.log("No previous cache found. First run will be heavy.");
    }

    // 3. Fetch list of recently updated mods from Nexus
    // This costs 1 API Call
    const recentlyUpdatedIds = await fetchUpdatedModsList();
    const updatedSet = new Set(recentlyUpdatedIds);
    console.log(`Nexus reports ${updatedSet.size} mods updated in the last ${UPDATE_PERIOD}.`);

    // 4. Determine which mods ACTUALLY need fetching
    const modsToFetch = [];
    const finalResults = [];

    for (const inputMod of modsToProcess) {
        const modId = String(inputMod.id);
        const cachedMod = previousDataMap.get(modId);

        const isNew = !cachedMod; // It's not in the JSON yet
        const isUpdatedOnNexus = updatedSet.has(modId); // Nexus says it changed
        const isMissingData = cachedMod && (!cachedMod.files || !cachedMod.changelogs); // Cache is corrupt/old

        if (isNew || isUpdatedOnNexus || isMissingData) {
            // MUST FETCH THIS ONE
            modsToFetch.push(inputMod);
            if (isNew) console.log(`[Mod ${modId}] Queueing: New mod.`);
            else if (isUpdatedOnNexus) console.log(`[Mod ${modId}] Queueing: Update detected on Nexus.`);
            else console.log(`[Mod ${modId}] Queueing: repairing missing data.`);
        } else {
            // CAN SKIP THIS ONE -> Just use cache
            const warningInfo = warningsMap.get(modId);
            finalResults.push({
                ...cachedMod,
                state: warningInfo ? warningInfo.state : 'normal',
                warningMessage: warningInfo ? warningInfo.warningMessage : ''
            });
        }
    }

    console.log(`\nSummary: ${modsToProcess.length} total mods.`);
    console.log(`Cache hits: ${finalResults.length}.`);
    console.log(`Fetching fresh data for: ${modsToFetch.length} mods...`);

    // 5. Process the "To Fetch" list in Batches
    let apiCallCount = 1; // Starts at 1 because of the updated_list call

    for (let i = 0; i < modsToFetch.length; i += BATCH_SIZE) {
        const batch = modsToFetch.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (inputMod) => {
            const modId = String(inputMod.id);

            // Fetch Info
            const modData = await fetchModDataFromNexus(modId);
            apiCallCount++;

            if (!modData) return null;

            // Fetch Files
            const filesData = await fetchModFilesFromNexus(modId);
            apiCallCount++;

            // Fetch Changelogs
            const changelogs = await fetchModChangelogsFromNexus(modId);
            apiCallCount++;

            // Merge
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
                files: filesData.files || [],
                changelogs: changelogs || {}
            };
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(res => { if (res) finalResults.push(res); });

        if (i + BATCH_SIZE < modsToFetch.length) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
        }
    }

    // 6. Save Result
    await fs.mkdir(path.dirname(OUTPUT_FILE_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_FILE_PATH, JSON.stringify(finalResults, null, 2));

    console.log("------------------------------------------------");
    console.log(`Success!`);
    console.log(`- Total Mods in List:   ${modsToProcess.length}`);
    console.log(`- Mods Fetched:         ${modsToFetch.length}`);
    console.log(`- Mods Cached:          ${modsToProcess.length - modsToFetch.length}`);
    console.log(`- Total API Calls:      ${apiCallCount}`);
    console.log("------------------------------------------------");
}

buildCuratedList().catch(error => {
    console.error("Script failed:", error);
    process.exit(1);
});