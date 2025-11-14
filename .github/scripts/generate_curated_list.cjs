// This script runs in a Node.js environment, so we use 'require'
const fs = require('fs').promises;
const path = require('path');

// Get the API key from the GitHub Secret we created
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
if (!NEXUS_API_KEY) {
  throw new Error("NEXUS_API_KEY environment variable not set!");
}

const WARNINGS_FILE_PATH = path.join(process.cwd(), 'mod_warnings.json');
const OUTPUT_FILE_PATH = path.join(process.cwd(), 'curated', 'curated_list.json');

// Helper function to fetch data for a single mod from the v1 API
async function fetchModDataFromNexus(modId) {
  const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}.json`;
  const headers = { "apikey": NEXUS_API_KEY };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(`Nexus API error for mod ID ${modId}: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch data for mod ID ${modId}:`, error);
    return null;
  }
}

// NEW helper function to fetch the file list for a mod
async function fetchModFilesFromNexus(modId) {
  const url = `https://api.nexusmods.com/v1/games/nomanssky/mods/${modId}/files.json`;
  const headers = { "apikey": NEXUS_API_KEY };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return { files: [] }; // Return empty array on error
    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch files for mod ID ${modId}:`, error);
    return { files: [] }; // Return empty array on error
  }
}

// Main function to orchestrate the process
async function buildCuratedList() {
  console.log("Starting to build curated mod list...");

  // 1. Read the source file with mod IDs and warnings
  const warningsContent = await fs.readFile(WARNINGS_FILE_PATH, 'utf8');
  const modsToProcess = JSON.parse(warningsContent);
  const warningsMap = new Map(modsToProcess.map(mod => [mod.id, mod]));

  console.log(`Found ${modsToProcess.length} mods to process.`);

  // 2. NEW: Fetch both mod data and file data in parallel for each mod
  const promises = modsToProcess.map(async (mod) => {
    const [modData, filesData] = await Promise.all([
      fetchModDataFromNexus(mod.id),
      fetchModFilesFromNexus(mod.id)
    ]);
    return { modData, filesData }; // Return a combined object
  });
  
  const results = await Promise.all(promises);

  // 3. Process and merge the data
  const finalModData = results
    .filter(result => result.modData !== null) // Filter out any failed mod requests
    .map(result => {
      const { modData, filesData } = result;
      const modIdStr = String(modData.mod_id);
      const warningInfo = warningsMap.get(modIdStr);

      // This is the final object structure our app expects
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
        // NEW: Add the files array to the final object
        files: filesData.files 
      };
    });

  console.log(`Successfully processed ${finalModData.length} mods.`);

  // 4. Write the final JSON file
  await fs.mkdir(path.dirname(OUTPUT_FILE_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_FILE_PATH, JSON.stringify(finalModData, null, 2));

  console.log(`Successfully wrote curated list to ${OUTPUT_FILE_PATH}`);
}

// Run the main function
buildCuratedList().catch(error => {
  console.error("Script failed:", error);
  process.exit(1);
});
