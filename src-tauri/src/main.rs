#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// --- IMPORTS ---
use chrono::Utc;
use quick_xml::de::from_str;
use quick_xml::events::Event;
use quick_xml::se::to_string;
use quick_xml::{Reader, Writer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri::{LogicalSize, PhysicalPosition};
use unrar;
use winreg::enums::*;
use winreg::RegKey;
use zip::ZipArchive;
use std::time::UNIX_EPOCH;
use std::process::Command;
use std::io::{self, Read};
use sha2::{Sha256, Digest};
use hex;
use uuid::Uuid;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures_util::{StreamExt, SinkExt};
use url::Url;
use tauri::path::BaseDirectory;
use std::sync::Mutex;

// --- STRUCTS ---

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ModProperty {
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@value", default)]
    value: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename = "Property")]
struct ModEntry {
    #[serde(rename = "@name")]
    entry_name: String,
    #[serde(rename = "@value")]
    entry_value: String,
    #[serde(rename = "@_index")]
    index: String,
    #[serde(rename = "Property", default)]
    properties: Vec<ModProperty>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct TopLevelProperty {
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@value", default)]
    value: Option<String>,
    #[serde(rename = "Property", default)]
    mods: Vec<ModEntry>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename = "Data")]
struct SettingsData {
    #[serde(rename = "@template")]
    template: String,
    #[serde(rename = "Property")]
    properties: Vec<TopLevelProperty>,
}

#[derive(Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    maximized: bool,
}

#[derive(serde::Deserialize, Debug)]
struct ModInfo {
    #[serde(rename = "modId")]
    mod_id: Option<String>,
    #[serde(rename = "fileId")]
    file_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ModInstallInfo {
    name: String,
    temp_path: String,
}

#[derive(serde::Serialize, Clone)]
struct ModConflictInfo {
    new_mod_name: String,
    temp_path: String,
    old_mod_folder_name: String,
}

#[derive(serde::Serialize)]
struct InstallationAnalysis {
    successes: Vec<ModInstallInfo>,
    conflicts: Vec<ModConflictInfo>,
    messy_archive_path: Option<String>,
    active_archive_path: Option<String>,
    // Trigger fields for the UI
    selection_needed: bool,
    temp_id: Option<String>,
    available_folders: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
struct LocalModInfo {
    folder_name: String,
    mod_id: Option<String>,
    file_id: Option<String>,
    version: Option<String>,
}

#[derive(Serialize, Clone)]
struct ModRenderData {
    folder_name: String,
    enabled: bool,
    priority: u32,
    local_info: Option<LocalModInfo>,
}

#[derive(Serialize, Clone)]
struct DownloadResult {
    path: String,
    size: u64,
    created_at: u64,
}

#[derive(Serialize, Clone)]
struct GamePaths {
    game_root_path: String,
    settings_root_path: String,
    version_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ProfileModEntry {
    filename: String,
    hash: String,
    mod_id: Option<String>,
    file_id: Option<String>,
    version: Option<String>,
    //Track which specific folders from the zip were installed
    #[serde(default)] 
    installed_options: Option<Vec<String>>, 
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ModProfileData {
    name: String,
    mods: Vec<ProfileModEntry>,
}

#[derive(Serialize, Clone)]
struct ProfileSwitchProgress {
    current: usize,
    total: usize,
    current_mod: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct GlobalAppConfig {
    custom_download_path: Option<String>,
}

#[derive(Serialize, Clone)]
struct FileNode {
    name: String,
    is_dir: bool,
}

const CLEAN_MXML_TEMPLATE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Data template="GcModSettings">
  <Property name="DisableAllMods" value="false" />
  <Property name="Data">
  </Property>
</Data>"#;

static DIR_LOCK: Mutex<()> = Mutex::new(());

// --- HELPER FUNCTIONS ---
fn scan_for_installable_mods(dir: &Path, base_dir: &Path) -> Vec<String> {
    let mut candidates = Vec::new();
    
    if let Ok(entries) = fs::read_dir(dir) {
        let mut has_pak = false;
        let mut subdirs = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                subdirs.push(path);
            } else if let Some(ext) = path.extension() {
                if ext.eq_ignore_ascii_case("pak") {
                    has_pak = true;
                }
            }
        }

        // If this folder contains a .pak, it is a Mod Root. 
        // We stop recursing here and add this folder relative to the staging base.
        if has_pak {
            if let Ok(rel) = dir.strip_prefix(base_dir) {
                let rel_str = rel.to_string_lossy().replace("\\", "/");
                if !rel_str.is_empty() {
                    candidates.push(rel_str);
                }
            }
            return candidates; 
        }

        // If no .pak found here, recurse into subdirectories
        for subdir in subdirs {
            let sub_candidates = scan_for_installable_mods(&subdir, base_dir);
            candidates.extend(sub_candidates);
        }
    }
    candidates
}


fn find_folder_in_tree(root: &Path, target_name: &str) -> Option<PathBuf> {
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.eq_ignore_ascii_case(target_name) {
                        return Some(path);
                    }
                }
                // Recurse
                if let Some(found) = find_folder_in_tree(&path, target_name) {
                    return Some(found);
                }
            }
        }
    }
    None
}
fn get_staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = get_singularity_root(app)?;
    let staging = root.join("staging");
    // Always recreate it if missing
    if !staging.exists() {
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    Ok(staging)
}

// Helper to move a directory safely, handling cross-device moves (C: to D:)
fn move_dir_safely(src: &Path, dest: &Path) -> Result<(), String> {
    // 1. Try cheap rename (fastest, works on same drive)
    if fs::rename(src, dest).is_ok() {
        return Ok(());
    }

    // 2. If rename failed, likely cross-device. We must Copy + Delete.
    if !dest.exists() {
        fs::create_dir_all(dest).map_err(|e| format!("Failed to create dest dir: {}", e))?;
    }

    // Recursively copy
    copy_dir_recursive(src, dest)?;

    // Delete source
    fs::remove_dir_all(src).map_err(|e| format!("Failed to remove source after copy: {}", e))?;

    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let dest_path = dest.join(entry.file_name());

        if file_type.is_dir() {
            fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn get_singularity_root(app: &AppHandle) -> Result<PathBuf, String> {
    // This creates/finds: %APPDATA%/Singularity
    // We use data_dir() which usually points to Roaming, then join "Singularity"
    let path = app.path().resolve("Singularity", BaseDirectory::Data)
        .map_err(|e| e.to_string())?;
    
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn get_config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Keeps config in the standard Tauri app data: %APPDATA%/com.syzzle.singularity/config.json
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data.exists() {
        fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    }
    Ok(app_data.join("config.json"))
}

fn get_downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Check if user has a custom path in config.json
    if let Ok(config_path) = get_config_file_path(app) {
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<GlobalAppConfig>(&content) {
                    if let Some(custom_path) = config.custom_download_path {
                        let path = PathBuf::from(custom_path);
                        if !path.exists() {
                            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                        }
                        return Ok(path);
                    }
                }
            }
        }
    }

    // 2. Fallback to default: %APPDATA%/Singularity/downloads
    let root = get_singularity_root(app)?;
    let downloads = root.join("downloads");
    if !downloads.exists() {
        fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    }
    Ok(downloads)
}

fn calculate_file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 4096];

    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn read_mod_info(mod_path: &Path) -> Option<ModInfo> {
    let info_path = mod_path.join("mod_info.json");
    if !info_path.exists() {
        return None;
    }
    fs::read_to_string(info_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn get_state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    
    Ok(app_data_dir.join("window-state.json"))
}

fn find_game_path() -> Option<PathBuf> {
    if cfg!(not(windows)) {
        return None;
    }
    find_steam_path()
        .or_else(find_gog_path)
        .or_else(find_gamepass_path)
}

fn find_gog_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let gog_key = hklm
        .open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games\1446223351")
        .ok()?;
    let game_path_str: String = gog_key.get_value("PATH").ok()?;
    let game_path = PathBuf::from(game_path_str);
    if game_path.join("Binaries").is_dir() {
        Some(game_path)
    } else {
        None
    }
}

fn find_steam_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let steam_key = hklm.open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam").ok()?;
    let steam_path_str: String = steam_key.get_value("InstallPath").ok()?;
    let steam_path = PathBuf::from(steam_path_str);
    let mut library_folders = vec![steam_path.clone()];
    if let Ok(content) = fs::read_to_string(steam_path.join("steamapps").join("libraryfolders.vdf"))
    {
        for line in content.lines() {
            if let Some(path_str) = line.split('"').nth(3) {
                let p = PathBuf::from(path_str.replace("\\\\", "\\"));
                if p.exists() {
                    library_folders.push(p);
                }
            }
        }
    }
    for folder in library_folders {
        let manifest_path = folder.join("steamapps").join("appmanifest_275850.acf");
        if let Ok(content) = fs::read_to_string(manifest_path) {
            if let Some(dir_str) = content
                .lines()
                .find(|l| l.contains("\"installdir\""))
                .and_then(|l| l.split('"').nth(3))
            {
                let game_path = folder.join("steamapps").join("common").join(dir_str);
                if game_path.is_dir() {
                    return Some(game_path);
                }
            }
        }
    }
    None
}

fn find_gamepass_path() -> Option<PathBuf> {
    let default_path = PathBuf::from("C:\\XboxGames\\No Man's Sky\\Content");
    if default_path.join("Binaries").is_dir() {
        return Some(default_path);
    }
    let output = match Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-AppxPackage -Name 'HelloGames.NoMansSky' | Select-Object -ExpandProperty InstallLocation",
        ])
        .output()
        {
            Ok(output) => output,
            Err(_) => return None,
        };

    if output.status.success() {
        let path_str = String::from_utf8(output.stdout).unwrap_or_default().trim().to_string();
        if !path_str.is_empty() {
            let game_path = PathBuf::from(path_str).join("Content");
            if game_path.join("Binaries").is_dir() {
                return Some(game_path);
            }
        }
    }

    None
}

fn extract_archive_to_temp(archive_path: &Path, target_staging_root: &Path) -> Result<PathBuf, String> {
    let unique_folder_name = format!("extract_{}", Utc::now().timestamp_millis());
    let temp_extract_path = target_staging_root.join(unique_folder_name);
    
    fs::create_dir_all(&temp_extract_path)
        .map_err(|e| format!("Could not create extraction dir: {}", e))?;

    // Need the absolute path because RAR logic changes the working directory
    let abs_archive_path = archive_path.canonicalize()
        .map_err(|e| format!("Invalid archive path '{}': {}", archive_path.display(), e))?;

    let extension = archive_path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "zip" => {
            let file = fs::File::open(&abs_archive_path)
                .map_err(|e| format!("Failed to open ZIP file: {}", e))?;
            
            let mut archive = ZipArchive::new(file)
                .map_err(|e| format!("Failed to read ZIP archive structure: {}", e))?;
            
            archive.extract(&temp_extract_path)
                .map_err(|e| format!("Failed to extract ZIP contents: {}", e))?;
        }
        "rar" => {
            let _guard = DIR_LOCK.lock().map_err(|e| format!("Failed to acquire thread lock: {}", e))?;
            
            let original_dir = env::current_dir()
                .map_err(|e| format!("Failed to get current working directory: {}", e))?;
            
            env::set_current_dir(&temp_extract_path)
                .map_err(|e| format!("Failed to change directory to staging area: {}", e))?;
            
            let extract_result = (|| -> Result<(), String> {
                let mut archive = unrar::Archive::new(&abs_archive_path)
                    .open_for_processing()
                    .map_err(|e| format!("Failed to open RAR archive: {:?}", e))?;

                while let Ok(Some(header)) = archive.read_header() {
                    archive = header.extract()
                        .map_err(|e| format!("Failed to extract RAR entry: {:?}", e))?;
                }
                Ok(())
            })();

            if let Err(e) = env::set_current_dir(&original_dir) {
                eprintln!("CRITICAL: Failed to restore working directory: {}", e);
            }

            extract_result?;
        }
        "7z" => {
            sevenz_rust::decompress_file(&abs_archive_path, &temp_extract_path)
                .map_err(|e| format!("Failed to extract 7z archive: {}", e))?;
        }
        _ => return Err(format!("Unsupported file type: .{}", extension)),
    }
    
    Ok(temp_extract_path)
}

// --- TAURI COMMANDS ---

#[tauri::command]
fn get_all_mods_for_render() -> Result<Vec<ModRenderData>, String> {
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let settings_file_path = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");

    if !settings_file_path.exists() {
        return Ok(Vec::new());
    }

    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let root: SettingsData =
        from_str(&xml_content).map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    let mut mods_to_render = Vec::new();

    if let Some(prop) = root.properties.iter().find(|p| p.name == "Data") {
        for mod_entry in &prop.mods {
            let folder_name_prop = mod_entry
                .properties
                .iter()
                .find(|p| p.name == "Name")
                .and_then(|p| p.value.as_ref());
            
            if let Some(folder_name) = folder_name_prop {
                let enabled = mod_entry
                    .properties
                    .iter()
                    .find(|p| p.name == "Enabled")
                    .and_then(|p| p.value.as_deref())
                    .unwrap_or("false")
                    .eq_ignore_ascii_case("true");
                
                let priority = mod_entry
                    .properties
                    .iter()
                    .find(|p| p.name == "ModPriority")
                    .and_then(|p| p.value.as_ref())
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(0);

                let mod_info_path = game_path.join("GAMEDATA").join("MODS").join(folder_name).join("mod_info.json");
                let local_info = if let Ok(content) = fs::read_to_string(&mod_info_path) {
                    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                        Some(LocalModInfo {
                            folder_name: folder_name.clone(),
                            mod_id: json_val.get("modId").or(json_val.get("id")).and_then(|v| v.as_str()).map(String::from),
                            file_id: json_val.get("fileId").and_then(|v| v.as_str()).map(String::from),
                            version: json_val.get("version").and_then(|v| v.as_str()).map(String::from),
                        })
                    } else { None }
                } else { None };

                mods_to_render.push(ModRenderData {
                    folder_name: folder_name.clone(),
                    enabled,
                    priority,
                    local_info,
                });
            }
        }
    }

    mods_to_render.sort_by_key(|m| m.priority);

    Ok(mods_to_render)
}

#[tauri::command]
fn install_mod_from_archive(app: AppHandle, archive_path_str: String) -> Result<InstallationAnalysis, String> {
    let mut archive_path = PathBuf::from(&archive_path_str);
    let downloads_dir = get_downloads_dir(&app)?;
    let staging_dir = get_staging_dir(&app)?; 

    // 1. Ensure file is in downloads
    if !downloads_dir.exists() { 
        fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?; 
    }
    
    let in_downloads = if let (Ok(p1), Ok(p2)) = (archive_path.canonicalize(), downloads_dir.canonicalize()) { 
        p1.starts_with(p2) 
    } else { 
        false 
    };

    if !in_downloads {
        let file_name = archive_path.file_name().ok_or("Invalid filename")?;
        let target_path = downloads_dir.join(file_name);
        fs::copy(&archive_path, &target_path).map_err(|e| e.to_string())?;
        archive_path = target_path;
    }

    // Store path for later use
    let final_archive_path_str = archive_path.to_string_lossy().into_owned();

    // 2. Extract to Staging
    let temp_extract_path = extract_archive_to_temp(&archive_path, &staging_dir)?;

    // 3. Analyze Contents (Using Deep Scan for nested mods)
    let installable_paths = scan_for_installable_mods(&temp_extract_path, &temp_extract_path);
    let temp_id = temp_extract_path.file_name().unwrap().to_string_lossy().into_owned();

    // CASE A: Multiple valid mod folders found (Deep or Shallow)
    if installable_paths.len() > 1 {
        return Ok(InstallationAnalysis {
            successes: vec![],
            conflicts: vec![],
            messy_archive_path: None,
            active_archive_path: Some(final_archive_path_str),
            selection_needed: true,
            temp_id: Some(temp_id),
            available_folders: Some(installable_paths),
        });
    }
    
    // CASE B: Only 1 deep folder found
    // Install it automatically, but we MUST pass the specific path so it gets moved correctly
    if installable_paths.len() == 1 {
        let mut analysis = finalize_installation(app, temp_id, vec![installable_paths[0].clone()], false)?;
        analysis.active_archive_path = Some(final_archive_path_str);
        return Ok(analysis);
    }

    // CASE C: Fallback
    // Check top level folders just in case it's a weird non-standard mod
    let folder_entries: Vec<_> = fs::read_dir(&temp_extract_path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect();

    if folder_entries.len() > 1 {
        let folder_names: Vec<String> = folder_entries.iter()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
            
        return Ok(InstallationAnalysis {
            successes: vec![],
            conflicts: vec![],
            messy_archive_path: None,
            active_archive_path: Some(final_archive_path_str),
            selection_needed: true,
            temp_id: Some(temp_id),
            available_folders: Some(folder_names),
        });
    }

    // CASE D: Single folder / Install All (Default)
    let mut analysis = finalize_installation(app, temp_id, vec![], false)?;
    analysis.active_archive_path = Some(final_archive_path_str);
    
    Ok(analysis)
}

#[tauri::command]
fn finalize_installation(
    app: AppHandle, 
    temp_id: String, 
    selected_folders: Vec<String>,
    flatten_paths: bool 
) -> Result<InstallationAnalysis, String> {
    let game_path = find_game_path().ok_or_else(|| "Could not find game path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;

    let staging_dir = get_staging_dir(&app)?;
    let temp_extract_path = staging_dir.join(&temp_id);

    if !temp_extract_path.exists() {
        return Err("Staging folder expired or missing.".to_string());
    }

    let mut installed_mods_by_id: HashMap<String, String> = HashMap::new();
    if let Ok(entries) = fs::read_dir(&mods_path) {
        for entry in entries.filter_map(Result::ok) {
            if let Some(info) = read_mod_info(&entry.path()) {
                if let (Some(mod_id), Some(folder_name)) = (info.mod_id, entry.path().file_name().and_then(|n| n.to_str())) {
                    installed_mods_by_id.insert(mod_id, folder_name.to_string());
                }
            }
        }
    }

    let conflict_staging_path = staging_dir.join(format!("conflict_{}", Utc::now().timestamp_millis()));
    let mut successes = Vec::new();
    let mut conflicts = Vec::new();

    // 1. Identify Items to Move
    let items_to_process = if selected_folders.is_empty() {
        // "Install All" behavior: Grab top level folders
        fs::read_dir(&temp_extract_path)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect::<Vec<String>>()
    } else {
        // Use user selection (which now contains deep paths like "Parent/Child")
        selected_folders
    };

    for relative_path_str in items_to_process {
        let source_path = temp_extract_path.join(&relative_path_str);
        if !source_path.exists() { continue; }

        // --- CHANGED LOGIC START ---
        let (final_dest_path, mod_root_name_for_xml) = if flatten_paths {
            // CASE A: Flatten (Skip Root)
            let leaf_name = Path::new(&relative_path_str)
                .file_name()
                .ok_or("Invalid path")?
                .to_string_lossy()
                .into_owned();
            
            (mods_path.join(&leaf_name), leaf_name)
        } else {
            // CASE B: Preserve Structure
            let dest = mods_path.join(&relative_path_str);
            let top_level = Path::new(&relative_path_str)
                .components()
                .next()
                .ok_or("Invalid path")?
                .as_os_str()
                .to_string_lossy()
                .into_owned();

            (dest, top_level)
        };
        // --- CHANGED LOGIC END ---

        let mut conflict_found = false;

        // Check ID conflict
        if let Some(info) = read_mod_info(&source_path) {
            if let Some(mod_id) = info.mod_id {
                if let Some(old_folder_name) = installed_mods_by_id.get(&mod_id) {
                    if !conflict_staging_path.exists() { fs::create_dir_all(&conflict_staging_path).map_err(|e| e.to_string())?; }
                    
                    let dest_name = final_dest_path.file_name().unwrap().to_string_lossy().into_owned();
                    let staged_mod_path = conflict_staging_path.join(&dest_name);
                    
                    move_dir_safely(&source_path, &staged_mod_path)?;

                    conflicts.push(ModConflictInfo {
                        new_mod_name: dest_name, 
                        temp_path: staged_mod_path.to_string_lossy().into_owned(),
                        old_mod_folder_name: old_folder_name.clone(),
                    });
                    conflict_found = true;
                }
            }
        }

        if !conflict_found {
            // Check Name conflict (Does destination exist?)
            if final_dest_path.exists() {
                if !conflict_staging_path.exists() { fs::create_dir_all(&conflict_staging_path).map_err(|e| e.to_string())?; }
                
                let dest_name = final_dest_path.file_name().unwrap().to_string_lossy().into_owned();
                let staged_mod_path = conflict_staging_path.join(&dest_name);
                
                move_dir_safely(&source_path, &staged_mod_path)?;

                conflicts.push(ModConflictInfo {
                    new_mod_name: dest_name.clone(),
                    temp_path: staged_mod_path.to_string_lossy().into_owned(),
                    // If preserving structure, we are technically colliding with the subfolder, 
                    // but simple conflict logic treats it as a collision with "itself" or the existing folder.
                    old_mod_folder_name: dest_name, 
                });
            } else {
                // Ensure parent exists if preserving structure (e.g. create "MODS/Discounted" before moving "Child")
                if !flatten_paths {
                    if let Some(parent) = final_dest_path.parent() {
                        if !parent.exists() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                    }
                }

                move_dir_safely(&source_path, &final_dest_path)?;
                
                successes.push(ModInstallInfo {
                    name: mod_root_name_for_xml,
                    temp_path: final_dest_path.to_string_lossy().into_owned(),
                });
            }
        }
    }

    // Cleanup
    let cleanup_path = temp_extract_path.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1000));
        let _ = fs::remove_dir_all(&cleanup_path);
    });

    Ok(InstallationAnalysis {
        successes,
        conflicts,
        messy_archive_path: None,
        active_archive_path: None,
        selection_needed: false,
        temp_id: None,
        available_folders: None,
    })
}

#[tauri::command]
fn resolve_conflict(
    new_mod_name: String,
    old_mod_folder_name: String,
    temp_mod_path_str: String,
    replace: bool,
) -> Result<(), String> {
    let game_path = find_game_path().ok_or_else(|| "Could not find game path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    let old_mod_path = mods_path.join(&old_mod_folder_name);
    let final_new_mod_path = mods_path.join(&new_mod_name);
    let temp_mod_path = PathBuf::from(&temp_mod_path_str);

    if replace {
        if old_mod_path.exists() {
            fs::remove_dir_all(&old_mod_path)
                .map_err(|e| format!("Failed to remove old mod: {}", e))?;
        }
        // CHANGE: Use safe move (temp is in AppData, destination is Game folder)
        move_dir_safely(&temp_mod_path, &final_new_mod_path)?;
    } else {
        // Just delete the staged folder in AppData
        fs::remove_dir_all(&temp_mod_path)
            .map_err(|e| format!("Failed to cleanup temp mod folder: {}", e))?;
    }

    // Clean up parent conflict container if empty
    if let Some(parent) = temp_mod_path.parent() {
        if parent.exists() && parent.read_dir().map_or(false, |mut i| i.next().is_none()) {
            let _ = fs::remove_dir(parent);
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_settings_file() -> Result<String, String> {
    if let Some(game_path) = find_game_path() {
        let settings_file = game_path
            .join("Binaries")
            .join("SETTINGS")
            .join("GCMODSETTINGS.MXML");
        if settings_file.exists() {
            fs::remove_file(&settings_file).map_err(|e| {
                format!(
                    "Failed to delete file at '{}': {}",
                    settings_file.display(),
                    e
                )
            })?;
            Ok("alertDeleteSuccess".to_string())
        } else {
            Ok("alertDeleteNotFound".to_string())
        }
    } else {
        Err("alertDeleteError".to_string())
    }
}

#[tauri::command]
fn detect_game_installation() -> Option<GamePaths> {
    if cfg!(not(windows)) { return None; }

    // --- Try Steam ---
    if let Some(path) = find_steam_path() {
        let settings_dir = path.join("Binaries\\SETTINGS");
        if settings_dir.exists() {
            return Some(GamePaths {
                game_root_path: path.to_string_lossy().into_owned(),
                settings_root_path: path.to_string_lossy().into_owned(),
                version_type: "Steam".to_string(),
            });
        }
    }

    // --- Try GOG ---
    if let Some(path) = find_gog_path() {
        let settings_dir = path.join("Binaries\\SETTINGS");
        if settings_dir.exists() {
            return Some(GamePaths {
                game_root_path: path.to_string_lossy().into_owned(),
                settings_root_path: path.to_string_lossy().into_owned(),
                version_type: "GOG".to_string(),
            });
        }
    }
    
    // --- Try Game Pass ---
    if let Some(path) = find_gamepass_path() {
        let settings_dir = path.join("Binaries\\SETTINGS");
        if settings_dir.exists() {
            return Some(GamePaths {
                game_root_path: path.to_string_lossy().into_owned(),
                settings_root_path: path.to_string_lossy().into_owned(),
                version_type: "GamePass".to_string(),
            });
        }
    }

    None // No installation found
}

#[tauri::command]
fn open_mods_folder() -> Result<(), String> {
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA").join("MODS");
        fs::create_dir_all(&mods_path).map_err(|e| {
            format!(
                "Could not create MODS folder at '{}': {}",
                mods_path.display(),
                e
            )
        })?;
        open::that(&mods_path).map_err(|e| {
            format!(
                "Could not open MODS folder at '{}': {}",
                mods_path.display(),
                e
            )
        })?;
        Ok(())
    } else {
        Err("Game path not found.".to_string())
    }
}

#[tauri::command]
fn save_file(file_path: String, content: String) -> Result<(), String> {
    fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write to file '{}': {}", file_path, e))
}

#[tauri::command]
fn resize_window(window: tauri::Window, width: f64) -> Result<(), String> {
    let current_height = window.outer_size().map_err(|e| e.to_string())?.height;
    window
        .set_size(LogicalSize::new(width, current_height as f64))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_mod(mod_name: String) -> Result<Vec<ModRenderData>, String> {
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let settings_file_path = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");
    let mod_to_delete_path = game_path.join("GAMEDATA").join("MODS").join(&mod_name);

    if mod_to_delete_path.exists() {
        fs::remove_dir_all(&mod_to_delete_path).map_err(|e| {
            format!(
                "Failed to delete mod folder for '{}' at '{}': {}",
                mod_name,
                mod_to_delete_path.display(),
                e
            )
        })?;
    }

    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let mut root: SettingsData =
        from_str(&xml_content).map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    let mut deleted_priority_val: Option<u32> = None;
    for prop in root.properties.iter_mut() {
        if prop.name == "Data" {
            if let Some(index_to_delete) = prop.mods.iter().position(|entry| {
                entry.properties.iter().any(|p| {
                    p.name == "Name"
                        && p.value
                            .as_deref()
                            .map_or(false, |v| v.eq_ignore_ascii_case(&mod_name))
                })
            }) {
                deleted_priority_val = prop.mods[index_to_delete].properties.iter().find(|p| p.name == "ModPriority").and_then(|p| p.value.as_ref()).and_then(|v| v.parse::<u32>().ok());
                prop.mods.remove(index_to_delete);
            }
            if let Some(deleted_p) = deleted_priority_val {
                for mod_entry in prop.mods.iter_mut() {
                    if let Some(priority_prop) = mod_entry.properties.iter_mut().find(|p| p.name == "ModPriority") {
                        if let Some(current_p_str) = priority_prop.value.as_ref() {
                            if let Ok(current_p) = current_p_str.parse::<u32>() {
                                if current_p > deleted_p {
                                    priority_prop.value = Some((current_p - 1).to_string());
                                }
                            }
                        }
                    }
                }
            }
            prop.mods.sort_by_key(|entry| entry.properties.iter().find(|p| p.name == "ModPriority").and_then(|p| p.value.as_ref()).and_then(|v| v.parse::<u32>().ok()).unwrap_or(u32::MAX));
            for (i, mod_entry) in prop.mods.iter_mut().enumerate() {
                mod_entry.index = i.to_string();
            }
            break;
        }
    }

    let unformatted_xml = to_string(&root).map_err(|e| format!("Failed to serialize XML data: {}", e))?;
    let mut reader = Reader::from_str(&unformatted_xml);
    reader.config_mut().trim_text(true);
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(event) => writer.write_event(event).unwrap(),
            Err(e) => return Err(format!("XML formatting error: {:?}", e)),
        }
    }
    let buf = writer.into_inner();
    let xml_body = String::from_utf8(buf).map_err(|e| format!("Failed to convert formatted XML to string: {}", e))?;
    
    // --- THIS IS THE FIX ---
    let final_content = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}", xml_body)
        .replace(" name=\"Data\" value=\"\"", " name=\"Data\"")
        .replace(" name=\"Dependencies\" value=\"\"", " name=\"Dependencies\"")
        .replace("\"/>", "\" />");

    fs::write(&settings_file_path, &final_content)
        .map_err(|e| format!("Failed to save updated GCMODSETTINGS.MXML: {}", e))?;

    let mut mods_to_render_vec = Vec::new();
    if let Some(prop) = root.properties.iter().find(|p| p.name == "Data") {
        for mod_entry in &prop.mods {
            if let Some(folder_name) = mod_entry.properties.iter().find(|p| p.name == "Name").and_then(|p| p.value.as_ref()) {
                let enabled = mod_entry.properties.iter().find(|p| p.name == "Enabled").and_then(|p| p.value.as_deref()).unwrap_or("false").eq_ignore_ascii_case("true");
                let priority = mod_entry.properties.iter().find(|p| p.name == "ModPriority").and_then(|p| p.value.as_ref()).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
                let mod_info_path = game_path.join("GAMEDATA").join("MODS").join(folder_name).join("mod_info.json");
                let local_info = if let Ok(content) = fs::read_to_string(&mod_info_path) {
                    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                        Some(LocalModInfo {
                            folder_name: folder_name.clone(),
                            mod_id: json_val.get("modId").or(json_val.get("id")).and_then(|v| v.as_str()).map(String::from),
                            file_id: json_val.get("fileId").and_then(|v| v.as_str()).map(String::from),
                            version: json_val.get("version").and_then(|v| v.as_str()).map(String::from),
                        })
                    } else { None }
                } else { None };
                mods_to_render_vec.push(ModRenderData {
                    folder_name: folder_name.clone(), enabled, priority, local_info,
                });
            }
        }
    }
    
    Ok(mods_to_render_vec)
}

#[tauri::command]
fn reorder_mods(ordered_mod_names: Vec<String>) -> Result<String, String> {
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let settings_file_path = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");

    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let mut root: SettingsData =
        from_str(&xml_content).map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    if let Some(prop) = root.properties.iter_mut().find(|p| p.name == "Data") {
        let mut mods_map: HashMap<String, ModEntry> = prop
            .mods
            .drain(..)
            .map(|entry| {
                let name = entry
                    .properties
                    .iter()
                    .find(|p| p.name == "Name")
                    .and_then(|p| p.value.as_ref())
                    .cloned()
                    .unwrap_or_default();
                (name, entry)
            })
            .collect();

        let mut sorted_mods: Vec<ModEntry> = Vec::new();
        for (new_priority, mod_name_upper) in ordered_mod_names
            .iter()
            .map(|n| n.to_uppercase())
            .enumerate()
        {
            if let Some(mut mod_entry) = mods_map.remove(&mod_name_upper) {
                let new_order_str = new_priority.to_string();
                mod_entry.index = new_order_str.clone();
                if let Some(priority_prop) = mod_entry
                    .properties
                    .iter_mut()
                    .find(|p| p.name == "ModPriority")
                {
                    priority_prop.value = Some(new_order_str);
                }
                sorted_mods.push(mod_entry);
            }
        }

        sorted_mods.extend(mods_map.into_values());
        prop.mods = sorted_mods;
    }

    let unformatted_xml =
        to_string(&root).map_err(|e| format!("Failed to serialize XML data: {}", e))?;

    let mut reader = Reader::from_str(&unformatted_xml);
    reader.config_mut().trim_text(true);
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(event) => writer.write_event(event).unwrap(),
            Err(e) => return Err(format!("XML formatting error: {:?}", e)),
        }
    }
    let buf = writer.into_inner();
    let xml_body = String::from_utf8(buf)
        .map_err(|e| format!("Failed to convert formatted XML to string: {}", e))?;

    let final_content = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}", xml_body)
        .replace(" name=\"Data\" value=\"\"", " name=\"Data\"")
        .replace(" name=\"Dependencies\" value=\"\"", " name=\"Dependencies\"")
        .replace("\"/>", "\" />");

    Ok(final_content)
}

#[tauri::command]
fn update_mod_name_in_xml(old_name: String, new_name: String) -> Result<String, String> {
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let settings_file_path = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");

    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let mut root: SettingsData =
        from_str(&xml_content).map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    let mut mod_found = false;
    for prop in root.properties.iter_mut() {
        if prop.name == "Data" {
            if let Some(mod_entry) = prop.mods.iter_mut().find(|entry| {
                if let Some(name_prop) = entry.properties.iter().find(|p| p.name == "Name") {
                    name_prop.value.as_deref() == Some(&old_name)
                } else {
                    false
                }
            }) {
                if let Some(name_prop) = mod_entry.properties.iter_mut().find(|p| p.name == "Name")
                {
                    name_prop.value = Some(new_name.to_uppercase());
                    mod_found = true;
                }
            }
            break;
        }
    }

    if !mod_found {
        return Err(format!(
            "Could not find a mod entry with the name '{}' in the XML file.",
            old_name
        ));
    }

    let unformatted_xml =
        to_string(&root).map_err(|e| format!("Failed to serialize XML data: {}", e))?;

    let mut reader = Reader::from_str(&unformatted_xml);
    reader.config_mut().trim_text(true);
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(event) => writer.write_event(event).unwrap(),
            Err(e) => return Err(format!("XML formatting error: {:?}", e)),
        }
    }
    let buf = writer.into_inner();
    let xml_body = String::from_utf8(buf)
        .map_err(|e| format!("Failed to convert formatted XML to string: {}", e))?;
    
    let final_content = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}", xml_body)
        .replace(" name=\"Data\" value=\"\"", " name=\"Data\"")
        .replace(" name=\"Dependencies\" value=\"\"", " name=\"Dependencies\"")
        .replace("\"/>", "\" />");
    
    Ok(final_content)
}

#[tauri::command]
fn update_mod_id_in_json(mod_folder_name: String, new_mod_id: String) -> Result<(), String> {
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let mod_info_path = game_path
        .join("GAMEDATA")
        .join("MODS")
        .join(&mod_folder_name)
        .join("mod_info.json");

    if !mod_info_path.exists() {
        return Err(format!(
            "mod_info.json not found for mod '{}'.",
            mod_folder_name
        ));
    }

    let content = fs::read_to_string(&mod_info_path)
        .map_err(|e| format!("Failed to read mod_info.json: {}", e))?;

    let mut json_value: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse mod_info.json: {}", e))?;

    if let Some(obj) = json_value.as_object_mut() {
        obj.insert("id".to_string(), Value::String(new_mod_id));
    } else {
        return Err("mod_info.json is not a valid JSON object.".to_string());
    }

    let new_content = serde_json::to_string_pretty(&json_value)
        .map_err(|e| format!("Failed to serialize updated JSON: {}", e))?;

    fs::write(&mod_info_path, new_content)
        .map_err(|e| format!("Failed to write updated mod_info.json: {}", e))?;

    Ok(())
}

#[tauri::command]
fn ensure_mod_info(
    mod_folder_name: String,
    mod_id: String,
    file_id: String,
    version: String,
    install_source: String,
) -> Result<(), String> {
    let game_path = find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let mod_info_path = game_path
        .join("GAMEDATA")
        .join("MODS")
        .join(&mod_folder_name)
        .join("mod_info.json");

    let mut json_value: Value;

    if mod_info_path.exists() {
        let content = fs::read_to_string(&mod_info_path).map_err(|e| e.to_string())?;
        json_value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    } else {
        json_value = serde_json::json!({});
    }

    if let Some(obj) = json_value.as_object_mut() {
        if !mod_id.is_empty() { obj.insert("modId".to_string(), Value::String(mod_id)); }
        if !file_id.is_empty() { obj.insert("fileId".to_string(), Value::String(file_id)); }
        if !version.is_empty() { obj.insert("version".to_string(), Value::String(version)); }
        // Save the source zip name so Profile Save knows where this folder came from
        obj.insert("installSource".to_string(), Value::String(install_source));
    }

    let new_content = serde_json::to_string_pretty(&json_value).map_err(|e| e.to_string())?;
    fs::write(&mod_info_path, new_content).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_nexus_api_key(app: tauri::AppHandle) -> Result<String, String> {
    let auth_path = get_auth_file_path(&app)?;

    if auth_path.exists() {
        let content = fs::read_to_string(auth_path).map_err(|e| e.to_string())?;
        // Parse JSON safely
        let json: Value = serde_json::from_str(&content).map_err(|_| "Invalid auth file".to_string())?;
        
        if let Some(key) = json.get("apikey").and_then(|k| k.as_str()) {
            println!("Loaded API Key from AppData");
            return Ok(key.to_string());
        }
    }

    Err("No API Key found. Please log in.".to_string())
}

#[tauri::command]
fn unregister_nxm_protocol() -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.delete_subkey_all("Software\\Classes\\nxm").map_err(|e| e.to_string())?;
        println!("Successfully unregistered nxm:// protocol handler from current user.");
    }
    Ok(())
}

#[tauri::command]
fn is_protocol_handler_registered() -> bool {
    #[cfg(windows)]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_path_str) = exe_path.to_str() {
                let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
                if let Ok(command_key) = hkcr.open_subkey("nxm\\shell\\open\\command") {
                    if let Ok(command_val) = command_key.get_value::<String, _>("") {
                        return command_val.contains(exe_path_str);
                    }
                }
            }
        }
    }
    false
}

#[tauri::command]
fn register_nxm_protocol() -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_path_str = exe_path.to_string_lossy();
        let command = format!("\"{}\" \"%1\"", exe_path_str);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (nxm_key, _) = hkcu.create_subkey("Software\\Classes\\nxm").map_err(|e| e.to_string())?;

        nxm_key.set_value("", &"URL:NXM Protocol").map_err(|e| e.to_string())?;
        nxm_key.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;

        let (command_key, _) = nxm_key
            .create_subkey_with_flags("shell\\open\\command", KEY_WRITE)
            .map_err(|e| e.to_string())?;
        command_key.set_value("", &command).map_err(|e| e.to_string())?;

        println!("Successfully registered nxm:// protocol handler to current user.");
    }
    Ok(())
}

#[tauri::command]
async fn download_mod_archive(app: AppHandle, download_url: String, file_name: String) -> Result<DownloadResult, String> {
    let downloads_path = get_downloads_dir(&app)?;
    let final_archive_path = downloads_path.join(&file_name);

    let response = reqwest::get(&download_url)
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let file_bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read downloaded file bytes: {}", e))?;

    fs::write(&final_archive_path, &file_bytes)
        .map_err(|e| format!("Failed to write archive to downloads folder: {}", e))?;
    
    // --- Get file metadata ---
    let metadata = fs::metadata(&final_archive_path).map_err(|e| e.to_string())?;
    let file_size = metadata.len();
    let created_time = metadata.created().map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    Ok(DownloadResult {
        path: final_archive_path.to_string_lossy().into_owned(),
        size: file_size,
        created_at: created_time,
    })
}

#[tauri::command]
fn show_in_folder(path: String) {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .unwrap();
    }
}

#[tauri::command]
fn delete_archive_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn clear_downloads_folder(app: AppHandle) -> Result<(), String> {
    let downloads_path = get_downloads_dir(&app)?;

    if downloads_path.exists() {
        // Read all entries in the directory
        let entries = fs::read_dir(&downloads_path).map_err(|e| e.to_string())?;
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    fs::remove_file(path).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn launch_game(version_type: String, game_path: String) -> Result<(), String> {
    match version_type.as_str() {
        "Steam" => {
            // Launch via Steam Protocol to ensure overlay/logging works
            open::that("steam://run/275850").map_err(|e| e.to_string())?;
        }
        "GOG" | "GamePass" | _ => {
            // For GOG and GamePass, we try to launch the Binary directly
            let exe_path = std::path::Path::new(&game_path)
                .join("Binaries")
                .join("NMS.exe");
            
            if exe_path.exists() {
                 open::that(exe_path).map_err(|e| e.to_string())?;
            } else {
                return Err("Could not find NMS.exe in Binaries folder.".to_string());
            }
        }
    }
    Ok(())
}

fn get_auth_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    
    Ok(app_data_dir.join("auth.json"))
}

// --- PROFILE MANAGEMENT ---

fn get_profiles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = get_singularity_root(app)?;
    let profiles = root.join("profiles");
    if !profiles.exists() {
        fs::create_dir_all(&profiles).map_err(|e| e.to_string())?;
    }
    Ok(profiles)
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = get_profiles_dir(&app)?;
    let mut profiles = Vec::new();
    
    // 1. Always ensure "Default" is first in the list
    profiles.push("Default".to_string());

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.path().file_stem() {
                let name_str = name.to_string_lossy().into_owned();
                // 2. Filter out "Default" here so it doesn't appear twice
                if name_str != "Default" && entry.path().extension().unwrap_or_default() == "json" {
                    profiles.push(name_str);
                }
            }
        }
    }
    let mut others: Vec<String> = profiles.drain(1..).collect();
    others.sort();
    profiles.extend(others);

    Ok(profiles)
}

#[tauri::command]
fn save_active_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let profiles_dir = get_profiles_dir(&app)?;
    let json_path = profiles_dir.join(format!("{}.json", profile_name));
    let mxml_backup_path = profiles_dir.join(format!("{}.mxml", profile_name));
    let downloads_dir = get_downloads_dir(&app)?;
    
    // Map: ZipFilename -> List of Installed Folder Names
    let mut profile_map: HashMap<String, Vec<String>> = HashMap::new();
    
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA").join("MODS");
        if let Ok(entries) = fs::read_dir(mods_path) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().into_owned();
                    let info_path = entry.path().join("mod_info.json");
                    
                    if let Ok(content) = fs::read_to_string(&info_path) {
                        if let Ok(json) = serde_json::from_str::<Value>(&content) {
                            // If it has installSource, group it. 
                            if let Some(source) = json.get("installSource").and_then(|s| s.as_str()) {
                                profile_map.entry(source.to_string()).or_default().push(folder_name);
                            } 
                            // If legacy (no installSource), we assume the folder name + .zip might be the source, or we skip tracking?
                            // For robustness, let's only track if we have source or can infer it.
                        }
                    }
                }
            }
        }
        
        // Backup MXML
        let current_mxml = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");
        if current_mxml.exists() {
            fs::copy(current_mxml, mxml_backup_path).map_err(|e| e.to_string())?;
        }
    }

    // Convert Map to ProfileModEntry list
    let mut profile_entries = Vec::new();
    for (filename, installed_folders) in profile_map {
        let archive_path = downloads_dir.join(&filename);
        let hash = if archive_path.exists() {
            calculate_file_hash(&archive_path).unwrap_or("HASH_ERROR".to_string())
        } else {
            "MISSING_FILE".to_string()
        };

        // We need one sample mod_info to get modId/version for the profile entry (UI display)
        // We'll just grab info from the first folder in the list
        let mut p_mod_id = None;
        let mut p_file_id = None;
        let mut p_version = None;

        if let Some(first_folder) = installed_folders.first() {
             if let Some(gp) = find_game_path() {
                 let info_p = gp.join("GAMEDATA/MODS").join(first_folder).join("mod_info.json");
                 if let Ok(c) = fs::read_to_string(info_p) {
                     if let Ok(j) = serde_json::from_str::<Value>(&c) {
                         p_mod_id = j.get("modId").and_then(|s| s.as_str()).map(String::from);
                         p_file_id = j.get("fileId").and_then(|s| s.as_str()).map(String::from);
                         p_version = j.get("version").and_then(|s| s.as_str()).map(String::from);
                     }
                 }
             }
        }

        profile_entries.push(ProfileModEntry {
            filename,
            hash,
            mod_id: p_mod_id,
            file_id: p_file_id,
            version: p_version,
            installed_options: Some(installed_folders), // Save specific folders
        });
    }

    let data = ModProfileData {
        name: profile_name,
        mods: profile_entries,
    };
    
    let json_str = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&json_path, json_str).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn apply_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let json_path = dir.join(format!("{}.json", profile_name));
    let mxml_backup_path = dir.join(format!("{}.mxml", profile_name));

    let profile_data: ModProfileData = if profile_name == "Default" && !json_path.exists() {
        ModProfileData { name: "Default".to_string(), mods: vec![] }
    } else {
        let content = fs::read_to_string(&json_path).map_err(|_| "Profile not found".to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    };

    let game_path = find_game_path().ok_or("Game path not found")?;
    let mods_dir = game_path.join("GAMEDATA/MODS");
    if mods_dir.exists() {
        for entry in fs::read_dir(&mods_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().is_dir() || entry.path().extension().unwrap_or_default() == "pak" {
                if entry.path().is_dir() { fs::remove_dir_all(entry.path()).ok(); }
                else { fs::remove_file(entry.path()).ok(); }
            }
        }
    }

    let live_mxml = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");
    println!("Applying Profile: {}", profile_name);

    if mxml_backup_path.exists() {
        let mut src = fs::File::open(&mxml_backup_path).map_err(|e| e.to_string())?;
        let mut dst = fs::File::create(&live_mxml).map_err(|e| e.to_string())?;
        io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
    } else {
        fs::write(&live_mxml, CLEAN_MXML_TEMPLATE).map_err(|e| e.to_string())?;
    }

    let downloads_dir = get_downloads_dir(&app)?;
    let total_mods = profile_data.mods.len();
    
    for (i, entry) in profile_data.mods.iter().enumerate() {
        let archive_path = downloads_dir.join(&entry.filename);
        
        app.emit("profile-progress", ProfileSwitchProgress {
            current: i + 1,
            total: total_mods,
            current_mod: entry.filename.clone()
        }).unwrap();

        if archive_path.exists() {
             match extract_archive_to_temp(&archive_path, &mods_dir) { 
                Ok(temp_path) => {
                     // Profile might just say "Install everything" (legacy) or specific folders
                     let has_specific_options = entry.installed_options.as_ref().map(|o| !o.is_empty()).unwrap_or(false);

                     if has_specific_options {
                        // install specific folders found in the tree
                        if let Some(options) = &entry.installed_options {
                            for target_folder_name in options {
                                // USE RECURSIVE SEARCH to find where this folder is hiding
                                if let Some(source_path) = find_folder_in_tree(&temp_path, target_folder_name) {
                                    
                                    let dest = mods_dir.join(target_folder_name);
                                    if dest.exists() { fs::remove_dir_all(&dest).ok(); }
                                    
                                    if let Err(e) = fs::rename(&source_path, &dest) {
                                        println!("Failed to move {}: {}", target_folder_name, e);
                                        continue;
                                    }

                                    // Restore mod_info
                                    let info_path = dest.join("mod_info.json");
                                    let info_json = serde_json::json!({
                                        "modId": entry.mod_id,
                                        "fileId": entry.file_id,
                                        "version": entry.version,
                                        "installSource": entry.filename
                                    });
                                    if let Ok(json_str) = serde_json::to_string_pretty(&info_json) {
                                        fs::write(info_path, json_str).ok();
                                    }
                                }
                            }
                        }
                     } else {
                        for fs_entry in fs::read_dir(&temp_path).map_err(|e| e.to_string())? {
                            let fs_entry = fs_entry.map_err(|e| e.to_string())?;
                            let folder_name = fs_entry.file_name().to_string_lossy().into_owned();
                            let dest = mods_dir.join(&folder_name);
                            if dest.exists() { fs::remove_dir_all(&dest).ok(); }
                            fs::rename(fs_entry.path(), &dest).ok();
                        }
                     }
                     let _ = fs::remove_dir_all(temp_path);
                },
                Err(e) => println!("Failed to extract {}: {}", entry.filename, e)
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let json_path = dir.join(format!("{}.json", profile_name));
    let mxml_path = dir.join(format!("{}.mxml", profile_name));
    if json_path.exists() { fs::remove_file(json_path).map_err(|e| e.to_string())?; }
    if mxml_path.exists() { fs::remove_file(mxml_path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn rename_profile(app: AppHandle, old_name: String, new_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let old_json = dir.join(format!("{}.json", old_name));
    let old_mxml = dir.join(format!("{}.mxml", old_name));
    let new_json = dir.join(format!("{}.json", new_name));
    let new_mxml = dir.join(format!("{}.mxml", new_name));
    
    if old_json.exists() { fs::rename(old_json, new_json).map_err(|e| e.to_string())?; }
    if old_mxml.exists() { fs::rename(old_mxml, new_mxml).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn create_empty_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let json_path = dir.join(format!("{}.json", profile_name));
    let mxml_path = dir.join(format!("{}.mxml", profile_name));

    if json_path.exists() {
        return Err("Profile already exists".to_string());
    }

    // 1. Create Empty Mod List (JSON)
    let empty_data = ModProfileData {
        name: profile_name,
        mods: Vec::new(),
    };
    let json_str = serde_json::to_string_pretty(&empty_data).map_err(|e| e.to_string())?;
    fs::write(&json_path, json_str).map_err(|e| e.to_string())?;

    // 2. Create Clean GCMODSETTINGS (MXML)
    fs::write(&mxml_path, CLEAN_MXML_TEMPLATE).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn check_for_untracked_mods() -> bool {
    // Returns TRUE if there are folders in GAMEDATA/MODS that do NOT have a mod_info.json
    // This implies they were put there manually and the manager doesn't know about them.
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA").join("MODS");
        if let Ok(entries) = fs::read_dir(mods_path) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    // Check if this folder contains mod_info.json
                    let info_path = entry.path().join("mod_info.json");
                    if !info_path.exists() {
                        // Found a folder without info -> It is untracked
                        return true; 
                    }
                }
            }
        }
    }
    false
}

#[tauri::command]
fn get_profile_mod_list(app: AppHandle, profile_name: String) -> Result<Vec<String>, String> {
    let dir = get_profiles_dir(&app)?;
    let json_path = dir.join(format!("{}.json", profile_name));
    
    if !json_path.exists() {
        // If profile file doesn't exist (e.g. fresh Default), return empty list
        return Ok(Vec::new()); 
    }

    let content = fs::read_to_string(&json_path).map_err(|e| e.to_string())?;
    let data: ModProfileData = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Return just the list of filenames
    let filenames = data.mods.iter().map(|m| m.filename.clone()).collect();
    Ok(filenames)
}

#[tauri::command]
fn copy_profile(app: AppHandle, source_name: String, new_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let source_json = dir.join(format!("{}.json", source_name));
    let source_mxml = dir.join(format!("{}.mxml", source_name));
    
    let new_json = dir.join(format!("{}.json", new_name));
    let new_mxml = dir.join(format!("{}.mxml", new_name));

    if new_json.exists() {
        return Err("A profile with that name already exists.".to_string());
    }
    if !source_json.exists() {
        return Err("Source profile not found.".to_string());
    }

    // 1. Copy the JSON file
    fs::copy(&source_json, &new_json).map_err(|e| format!("Failed to copy JSON: {}", e))?;

    // 2. Open the new JSON and update the "name" field inside it
    // (Otherwise the copied profile will internally claim to be the old profile)
    let content = fs::read_to_string(&new_json).map_err(|e| e.to_string())?;
    let mut data: ModProfileData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    data.name = new_name.clone();
    
    let new_content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&new_json, new_content).map_err(|e| e.to_string())?;

    // 3. Copy the MXML file
    if source_mxml.exists() {
        fs::copy(&source_mxml, &new_mxml).map_err(|e| format!("Failed to copy MXML: {}", e))?;
    } else {
        // If source had no MXML (rare), make a clean one
        fs::write(&new_mxml, CLEAN_MXML_TEMPLATE).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn login_to_nexus(app: tauri::AppHandle) -> Result<String, String> {
    // 1. Generate a unique Request ID (UUID)
    let uuid = Uuid::new_v4().to_string();
    
    // 2. Construct the WebSocket URL
    let sso_url = Url::parse("wss://sso.nexusmods.com").map_err(|e| e.to_string())?;

    // 3. Open the connection
    let (ws_stream, _) = connect_async(sso_url.to_string())
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;
        
    let (mut write, mut read) = ws_stream.split();

    // 4. Send the Handshake
    let msg = serde_json::json!({
        "id": uuid,
        "token": null,
        "protocol": 2
    });

    write.send(Message::Text(msg.to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    // 5. Open the User's Browser to authorize
    let auth_url = format!("https://www.nexusmods.com/sso?id={}&application=syzzle07-singularity", uuid);
    open::that(auth_url).map_err(|e| e.to_string())?;

    // 6. Wait for the response (The API Key)
    while let Some(message) = read.next().await {
        let message = message.map_err(|e| e.to_string())?;
        
        if let Message::Text(text) = message {
            let text_str = text.to_string(); 
            let response: Value = serde_json::from_str(&text_str).map_err(|e| e.to_string())?;
            
            // Check for success data
            if let Some(data) = response.get("data") {
                if let Some(api_key) = data.get("api_key").and_then(|k| k.as_str()) {
                    
                    // 7. SAVE THE KEY (AppData)
                    let auth_path = get_auth_file_path(&app)?;
                    let auth_data = serde_json::json!({ "apikey": api_key });
                    
                    fs::write(&auth_path, serde_json::to_string_pretty(&auth_data).unwrap())
                        .map_err(|e| format!("Failed to save auth file: {}", e))?;
                    
                    println!("API Key saved to: {:?}", auth_path);
                    return Ok(api_key.to_string());
                }
            }
            
            // Check for errors
            if let Some(success) = response.get("success").and_then(|s| s.as_bool()) {
                if !success {
                    return Err("Nexus refused the connection.".to_string());
                }
            }
        }
    }

    Err("Connection closed before authentication finished.".to_string())
}

#[tauri::command]
fn logout_nexus(app: tauri::AppHandle) -> Result<(), String> {
    let auth_path = get_auth_file_path(&app)?;
    
    if auth_path.exists() {
        fs::remove_file(auth_path).map_err(|e| e.to_string())?;
        println!("Logged out. Auth file deleted.");
    }
    Ok(())
}

#[tauri::command]
fn open_folder_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    if p.exists() {
        open::that(p).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Folder does not exist".to_string())
    }
}

#[tauri::command]
fn get_downloads_path(app: AppHandle) -> Result<String, String> {
    let path = get_downloads_dir(&app)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_downloads_path(app: AppHandle, new_path: String) -> Result<(), String> {
    let config_path = get_config_file_path(&app)?;
    
    // Validate path exists
    if !Path::new(&new_path).exists() {
        return Err("The selected path does not exist.".to_string());
    }

    let config = GlobalAppConfig {
        custom_download_path: Some(new_path),
    };

    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn open_special_folder(app: AppHandle, folder_type: String) -> Result<(), String> {
    let path = match folder_type.as_str() {
        "downloads" => get_downloads_dir(&app)?,
        "profiles" => get_profiles_dir(&app)?,
        _ => return Err("Unknown folder type".to_string()),
    };
    open::that(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn clean_staging_folder(app: AppHandle) -> Result<String, String> {
    let staging_dir = get_staging_dir(&app)?;
    
    if staging_dir.exists() {
        // Read directory to count items before deleting (for UI feedback)
        let count = fs::read_dir(&staging_dir).map_err(|e| e.to_string())?.count();
        
        if count > 0 {
            // We just delete the whole staging folder and recreate it
            fs::remove_dir_all(&staging_dir).map_err(|e| e.to_string())?;
            fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;
            return Ok(format!("Cleaned {} items from staging area.", count));
        }
    }
    
    Ok("Staging area is already empty.".to_string())
}

#[tauri::command]
fn get_staging_contents(app: AppHandle, temp_id: String, relative_path: String) -> Result<Vec<FileNode>, String> {
    let staging = get_staging_dir(&app)?;
    let root_path = staging.join(&temp_id);
    
    // Construct target path
    let target_path = if relative_path.is_empty() {
        root_path.clone()
    } else {
        root_path.join(&relative_path)
    };

    // Security: Ensure target is still inside the specific staging folder (prevent traversal)
    if !target_path.starts_with(&root_path) {
        return Err("Invalid path access".to_string());
    }

    let mut nodes = Vec::new();
    if target_path.is_dir() {
        for entry in fs::read_dir(target_path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            nodes.push(FileNode {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
            });
        }
    }
    
    // Sort: Directories first, then files (alphabetical)
    nodes.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(nodes)
}

// --- MAIN FUNCTION ---
fn main() {    
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!("New instance detected, args: {:?}", argv);

            if let Some(nxm_link) = argv.iter().find(|arg| arg.starts_with("nxm://")) {
                app.emit("nxm-link-received", nxm_link.clone()).unwrap();
            }

            if let Some(window) = app.get_webview_window("main") {
                window.unminimize().unwrap();
                window.set_focus().unwrap();
            }
        }))
        .setup(|app| {
            let app_handle = app.handle();
            let args: Vec<String> = std::env::args().collect();

            if let Some(nxm_link) = args.iter().find(|arg| arg.starts_with("nxm://")) {
                println!("NXM link found on startup: {}", nxm_link);
                app_handle
                    .emit("nxm-link-received", nxm_link.clone())
                    .unwrap();
            }

            let window = app.get_webview_window("main").unwrap();
            
            // --- UPDATED STATE LOADING ---
            if let Ok(state_path) = get_state_file_path(app_handle) {
                if let Ok(state_json) = fs::read_to_string(state_path) {
                    if let Ok(state) = serde_json::from_str::<WindowState>(&state_json) {
                        window
                            .set_position(PhysicalPosition::new(state.x, state.y))
                            .unwrap();

                        if state.maximized {
                            window.maximize().unwrap();
                        }
                    }
                }
            }
            // -----------------------------

            window.show().unwrap();
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::CloseRequested { .. } => {
                    // --- UPDATED STATE SAVING ---
                    let app_handle = window.app_handle();
                    let is_maximized = window.is_maximized().unwrap_or(false);

                    if !is_maximized {
                        if let Ok(position) = window.outer_position() {
                            let state = WindowState {
                                x: position.x,
                                y: position.y,
                                maximized: false,
                            };
                            if let Ok(state_json) = serde_json::to_string(&state) {
                                if let Ok(path) = get_state_file_path(app_handle) {
                                    fs::write(path, state_json).ok();
                                }
                            }
                        }
                    } else {
                        // If maximized, we update the maximized bool but keep the old X/Y
                        if let Ok(path) = get_state_file_path(app_handle) {
                            if let Ok(state_json) = fs::read_to_string(&path) {
                                if let Ok(mut state) = serde_json::from_str::<WindowState>(&state_json) {
                                    state.maximized = true;
                                    if let Ok(new_state_json) = serde_json::to_string(&state) {
                                        fs::write(path, new_state_json).ok();
                                    }
                                }
                            }
                        }
                    }
                    // -----------------------------
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            detect_game_installation,
            open_mods_folder,
            save_file,
            delete_settings_file,
            reorder_mods,
            install_mod_from_archive,
            resolve_conflict,
            resize_window,
            delete_mod,
            update_mod_name_in_xml,
            update_mod_id_in_json,
            ensure_mod_info,
            get_nexus_api_key,
            register_nxm_protocol,
            unregister_nxm_protocol,
            is_protocol_handler_registered,
            get_all_mods_for_render,
            download_mod_archive,
            show_in_folder,
            delete_archive_file,
            clear_downloads_folder,
            launch_game,
            list_profiles,
            save_active_profile,
            apply_profile,
            delete_profile,
            rename_profile,
            create_empty_profile,
            check_for_untracked_mods,
            get_profile_mod_list,
            copy_profile,
            login_to_nexus,
            logout_nexus,
            get_downloads_path,
            set_downloads_path,
            open_special_folder,
            open_folder_path,
            clean_staging_folder,
            finalize_installation,
            get_staging_contents
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}