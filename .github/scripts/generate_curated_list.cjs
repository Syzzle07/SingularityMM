const fs = require('fs').promises;
const path = require('path');

// --- CONFIGURATION ---
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
if (!NEXUS_API_KEY) throw new Error("NEXUS_API_KEY environment variable not set!");

const WARNINGS_FILE_PATH = path.join(process.cwd(), 'mod_warnings.json');
const OUTPUT_FILE_PATH = path.join(process.cwd(), 'curated', 'curated_list.json');
const UPDATE_PERIOD = '1d';
const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES = 1000;

// --- API HELPERS ---

async function fetchUpdatedModsList() {
  const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/updated.json?period=${UPDATE_PERIOD}`;
  const headers = { "apikey": NEXUS_API_KEY };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const data = await response.json();
    return data.map(m => String(m.mod_id));
  } catch (error) {
    return [];
  }
}

async function fetchModDataFromNexus(modId) {
  const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}.json`;
  const headers = { "apikey": NEXUS_API_KEY };
  try {
    const response = await fetch(url, { headers });
    if (response.status === 429) throw new Error("RATE_LIMIT");

    // Handle 404 (Not Found) or 403 (Hidden/Deleted) explicitly
    if (response.status === 404 || response.status === 403) return null;

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
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
  console.log("Starting Optimized Smart Update (Safe Mode)...");

  // 1. Load Inputs
  const warningsContent = await fs.readFile(WARNINGS_FILE_PATH, 'utf8');
  let modsToProcess = JSON.parse(warningsContent);

  // Filter empty IDs just in case
  modsToProcess = modsToProcess.filter(mod => mod.id && String(mod.id).trim() !== "");

  console.log(`Input: Tracking ${modsToProcess.length} mods.`);

  const warningsMap = new Map(modsToProcess.map(mod => [String(mod.id), mod]));

  // 2. Load Previous Cache
  let previousDataMap = new Map();
  try {
    const oldContent = await fs.readFile(OUTPUT_FILE_PATH, 'utf8');
    const oldJson = JSON.parse(oldContent);
    oldJson.forEach(mod => previousDataMap.set(String(mod.mod_id), mod));
    console.log(`Loaded ${oldJson.length} mods from local cache.`);
  } catch (e) {
    console.log("No previous cache found. First run will be heavy.");
  }

  // 3. Fetch Updated List
  const recentlyUpdatedIds = await fetchUpdatedModsList();
  let apiCallCount = 1;

  const updatedSet = new Set(recentlyUpdatedIds);
  console.log(`Nexus reports ${updatedSet.size} mods updated in the last ${UPDATE_PERIOD}.`);

  // 4. Determine Work
  const modsToFetch = [];
  const finalResults = [];
  // Array to store IDs that fail verification
  const removedIds = [];

  for (const inputMod of modsToProcess) {
    const modId = String(inputMod.id);
    const cachedMod = previousDataMap.get(modId);

    const isNew = !cachedMod;
    const isUpdatedOnNexus = updatedSet.has(modId);
    // Ensure cache has valid data structure
    const isMissingData = cachedMod && (!cachedMod.files || !cachedMod.changelogs);

    if (isNew || isUpdatedOnNexus || isMissingData) {
      modsToFetch.push(inputMod);
      if (isNew) console.log(`[Mod ${modId}] Queueing: New mod.`);
      else if (isUpdatedOnNexus) console.log(`[Mod ${modId}] Queueing: Update detected.`);
      else console.log(`[Mod ${modId}] Queueing: Repairing missing data.`);
    } else {
      // REUSE CACHE
      const warningInfo = warningsMap.get(modId);
      finalResults.push({
        mod_id: cachedMod.mod_id,
        name: cachedMod.name,
        summary: cachedMod.summary,
        version: cachedMod.version,
        picture_url: cachedMod.picture_url,
        author: cachedMod.author,
        updated_timestamp: cachedMod.updated_timestamp,
        created_timestamp: cachedMod.created_timestamp,
        description: cachedMod.description,
        state: warningInfo ? warningInfo.state : 'normal',
        warningMessage: warningInfo ? warningInfo.warningMessage : '',
        files: cachedMod.files,
        changelogs: cachedMod.changelogs
      });
    }
  }

  console.log(`Fetching fresh data for: ${modsToFetch.length} mods...`);

  // 5. Process Fetches
  for (let i = 0; i < modsToFetch.length; i += BATCH_SIZE) {
    const batch = modsToFetch.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (inputMod) => {
      const modId = String(inputMod.id);

      // 1. ALWAYS Fetch Info
      const modData = await fetchModDataFromNexus(modId);
      apiCallCount++;

      // Check 1: Does data exist? (Handles 404/Deleted)
      if (!modData || !modData.name) {
        console.log(`[Mod ${modId}] REMOVED: API returned no data (404/Deleted).`);
        removedIds.push(modId); // Track ID
        return null;
      }

      // Check 2: Is status valid?
      if (modData.status !== "published") {
        console.log(`[Mod ${modId}] REMOVED: Status is '${modData.status}'.`);
        removedIds.push(modId);
        return null;
      }

      // 2. CHECK: Is this a "False Alarm" update?
      let files = [];
      let changelogs = {};

      const cachedMod = previousDataMap.get(modId);
      const isFalseAlarm = cachedMod &&
        cachedMod.updated_timestamp === modData.updated_timestamp &&
        cachedMod.files &&
        cachedMod.changelogs;

      if (isFalseAlarm) {
        console.log(`[Mod ${modId}] False alarm (Timestamp match). Using cached Files/Logs.`);
        files = cachedMod.files;
        changelogs = cachedMod.changelogs;
      } else {
        // Fetch Files
        const filesData = await fetchModFilesFromNexus(modId);
        apiCallCount++;
        files = filesData.files || [];

        // Fetch Changelogs
        const logs = await fetchModChangelogsFromNexus(modId);
        apiCallCount++;
        changelogs = logs || {};
      }

      const warningInfo = warningsMap.get(modId);
      return {
        mod_id: modData.mod_id,
        name: modData.name,
        summary: modData.summary,
        version: modData.version,
        picture_url: modData.picture_url,
        author: modData.author,
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

    if (i + BATCH_SIZE < modsToFetch.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  // 6. Save Result
  await fs.mkdir(path.dirname(OUTPUT_FILE_PATH), { recursive: true });

  // Deterministic Sorting
  finalResults.sort((a, b) => Number(a.mod_id) - Number(b.mod_id));

  const newFileContent = JSON.stringify(finalResults, null, 2);
  let needsWrite = true;

  try {
    const currentFileContent = await fs.readFile(OUTPUT_FILE_PATH, 'utf8');
    if (currentFileContent === newFileContent) {
      console.log("Skipping write: File content is identical.");
      needsWrite = false;
    }
  } catch (e) { }

  if (needsWrite) {
    await fs.writeFile(OUTPUT_FILE_PATH, newFileContent);
    console.log(`Updated file written to ${OUTPUT_FILE_PATH}`);
  }

  // 7. Final Report
  const totalProcessed = modsToProcess.length;
  const validCount = finalResults.length;
  const removedCount = totalProcessed - validCount; // Counts filtered inputs + failed fetches

  console.log("================================================");
  console.log(` SUMMARY REPORT`);
  console.log("================================================");
  console.log(` Total Tracked IDs:     ${totalProcessed}`);
  console.log(` Valid Mods Saved:      ${validCount}`);
  console.log(` Mods Removed/Hidden:   ${removedIds.length}`);
  console.log("------------------------------------------------");
  console.log(` Actual API Calls:      ${apiCallCount}`);
  console.log(` Output File:           ${OUTPUT_FILE_PATH}`);

  // List failed IDs
  if (removedIds.length > 0) {
    console.log("------------------------------------------------");
    console.log(" MODS TO REMOVE FROM INPUT (IDs):");
    console.log(JSON.stringify(removedIds));
    console.log("------------------------------------------------");
  }

  console.log("================================================");
}

buildCuratedList().catch(error => {
  console.error("Script failed:", error);
  process.exit(1);
});