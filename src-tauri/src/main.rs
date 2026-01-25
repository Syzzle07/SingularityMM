#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// --- IMPORTS ---
#[cfg(target_os = "windows")]
use std::process::Command;
#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

use chrono::{Local, Utc};
use futures_util::{SinkExt, StreamExt};
use quick_xml::de::from_str;
use quick_xml::events::Event;
use quick_xml::se::to_string;
use quick_xml::{Reader, Writer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::path::BaseDirectory;
use tauri::State;
use tauri::{AppHandle, Emitter, Manager};
use tauri::{LogicalSize, PhysicalPosition};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use unrar;
use url::Url;
use uuid::Uuid;
use zip::ZipArchive;
use base64::{engine::general_purpose, Engine as _};

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
    #[allow(dead_code)]
    #[serde(rename = "fileId")]
    file_id: Option<String>,
    #[serde(rename = "installSource")]
    install_source: Option<String>,
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
    install_source: Option<String>,
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
    file_progress: u64,
}

#[derive(Serialize, Deserialize, Debug)]
struct GlobalAppConfig {
    custom_download_path: Option<String>,
    custom_library_path: Option<String>,
    #[serde(default)] // Default to false/null if missing in old configs
    legacy_migration_done: bool,
}

#[derive(Serialize, Clone)]
struct FileNode {
    name: String,
    is_dir: bool,
}

#[derive(Serialize, Clone)]
struct InstallProgressPayload {
    id: String,
    step: String,
    progress: Option<u64>, // 0 to 100
}

const CLEAN_MXML_TEMPLATE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Data template="GcModSettings">
  <Property name="DisableAllMods" value="false" />
  <Property name="Data">
  </Property>
</Data>"#;

static DIR_LOCK: Mutex<()> = Mutex::new(());

struct StartupState {
    pending_nxm: Mutex<Option<String>>,
}

// --- HELPER FUNCTIONS ---
fn smart_deploy_file(source: &Path, dest: &Path) -> Result<(), String> {
    // 1. Ensure destination parent exists
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    // 2. Remove existing file at destination (Hardlinks fail if file exists)
    if dest.exists() {
        // We try removing file. If it's a directory, this will fail, but standard NMS mods are files.
        // If you have nested folders overwriting files, we might need more logic, but this is standard.
        fs::remove_file(dest).map_err(|e| e.to_string())?;
    }

    // 3. Try Hardlink (Fast, 0 Disk Space)
    // This works if Source (Library) and Dest (Game) are on the same partition.
    if std::fs::hard_link(source, dest).is_ok() {
        return Ok(());
    }

    // 4. If Hardlink failed (likely Cross-Drive), Fallback to Copy (Slower, duplicates data)
    // println!("Hardlink failed, falling back to copy for {:?}", source);
    std::fs::copy(source, dest).map_err(|e| e.to_string())?;

    Ok(())
}

fn deploy_structure_recursive(source: &Path, dest: &Path) -> Result<(), String> {
    if !dest.exists() {
        fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    }

    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if file_type.is_dir() {
            deploy_structure_recursive(&src_path, &dest_path)?;
        } else {
            smart_deploy_file(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

fn get_library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Check config for custom path
    if let Ok(config_path) = get_config_file_path(app) {
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<GlobalAppConfig>(&content) {
                    if let Some(custom) = config.custom_library_path {
                        let path = PathBuf::from(custom);
                        if !path.exists() {
                            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                        }
                        return Ok(path);
                    }
                }
            }
        }
    }

    // 2. Fallback to default APPDATA
    let root = get_singularity_root(app)?;
    let lib_dir = root.join("Library");
    if !lib_dir.exists() {
        fs::create_dir_all(&lib_dir).map_err(|e| e.to_string())?;
    }
    Ok(lib_dir)
}

fn rotate_logs(app: &AppHandle) {
    // 1. Get the App Data Directory
    let app_data_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return, // Should not happen, but safe exit
    };

    // 2. Define Paths
    let log_current = app_data_dir.join("singularity.log");
    let log_previous = app_data_dir.join("singularity-previous.log");
    let log_older = app_data_dir.join("singularity-older.log");

    // 3. Rotate: Previous -> Older
    // If 'previous' exists, move it to 'older' (this overwrites 'older' if it exists)
    if log_previous.exists() {
        // We ignore errors here (e.g. if file is open by user) to ensure app startup doesn't crash
        let _ = std::fs::rename(&log_previous, &log_older);
    }

    // 4. Rotate: Current -> Previous
    // If 'current' exists, move it to 'previous'
    if log_current.exists() {
        let _ = std::fs::rename(&log_current, &log_previous);
    }

    // 5. Done. 'log_internal' will automatically create a fresh 'singularity.log'
    // when it writes the first line of the new session.
}

fn log_internal(app: &AppHandle, level: &str, message: &str) {
    if let Ok(log_path) = get_log_file_path(app) {
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let log_entry = format!("[{}] [{}] {}\n", timestamp, level, message);

        // Best effort write - ignore errors to avoid infinite loops
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = file.write_all(log_entry.as_bytes());
        }
    }
    // Print to debug console as well
    println!("[{}] {}", level, message);
}

fn get_log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data.exists() {
        fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    }
    Ok(app_data.join("singularity.log"))
}

fn scan_for_installable_mods(dir: &Path, base_dir: &Path) -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        let mut is_mod_root = false;
        let mut subdirs = Vec::new();

        // The exact list of first-level folders NMS expects
        let game_structure_folders = [
            "AUDIO",
            "FONTS",
            "GLOBALS",
            "INPUT",
            "LANGUAGE",
            "MATERIALS",
            "METADATA",
            "MODELS",
            "MUSIC",
            "PIPELINES",
            "SCENES",
            "SHADERS",
            "TEXTURES",
            "TPFSDICT",
            "UI",
        ];

        // Also keep checking for file extensions just in case
        let game_file_extensions = ["exml", "mbin", "dds", "mxml"];

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    // If we find "METADATA" inside this folder, then THIS folder is a Mod Root.
                    if game_structure_folders
                        .iter()
                        .any(|gf| name.eq_ignore_ascii_case(gf))
                    {
                        is_mod_root = true;
                    }
                }
                subdirs.push(path);
            } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if game_file_extensions
                    .iter()
                    .any(|ge| ext.eq_ignore_ascii_case(ge))
                {
                    is_mod_root = true;
                }
            }
        }

        if is_mod_root {
            if let Ok(rel) = dir.strip_prefix(base_dir) {
                let rel_str = rel.to_string_lossy().replace("\\", "/");
                if !rel_str.is_empty() {
                    candidates.push(rel_str);
                } else {
                    candidates.push(".".to_string());
                }
            }
            return candidates;
        }

        // If current folder isn't a mod root (doesn't have METADATA etc), search subfolders
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
    let path = app
        .path()
        .resolve("Singularity", BaseDirectory::Data)
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
    #[cfg(target_os = "windows")]
    {
        return find_steam_path()
            .or_else(find_gog_path)
            .or_else(find_gamepass_path);
    }

    #[cfg(target_os = "linux")]
    {
        // 1. Get the User's Home Directory
        let home = std::env::var("HOME").ok()?;
        let home_path = PathBuf::from(home);

        // 2. Common Steam Library Locations on Linux
        let possible_paths = vec![
            home_path.join(".steam/steam/steamapps/common/No Man's Sky"),
            home_path.join(".local/share/Steam/steamapps/common/No Man's Sky"),
            // Flatpak Steam path
            home_path
                .join(".var/app/com.valvesoftware.Steam/data/Steam/steamapps/common/No Man's Sky"),
        ];

        for path in possible_paths {
            // Check for the Binaries folder to verify it's a real install
            if path.join("Binaries").exists() {
                return Some(path);
            }
        }

        return None;
    }

    // Fallback for MacOS or other OS
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return None;
}

#[cfg(target_os = "windows")]
fn find_gog_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let known_ids = ["1446213994", "1446223351"];

    for id in known_ids {
        let key_path = format!(r"SOFTWARE\WOW6432Node\GOG.com\Games\{}", id);

        if let Ok(gog_key) = hklm.open_subkey(&key_path) {
            if let Ok(game_path_str) = gog_key.get_value::<String, _>("PATH") {
                let game_path = PathBuf::from(game_path_str);
                if game_path.join("Binaries").is_dir() {
                    return Some(game_path);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn find_steam_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(steam_key) = hklm.open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam") {
        if let Ok(steam_path_str) = steam_key.get_value::<String, _>("InstallPath") {
            let steam_path = PathBuf::from(steam_path_str);
            let mut library_folders = vec![steam_path.clone()];

            let vdf_path = steam_path.join("steamapps").join("libraryfolders.vdf");
            if let Ok(content) = fs::read_to_string(&vdf_path) {
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
        }
    }
    None
}

#[cfg(target_os = "windows")]
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
        let path_str = String::from_utf8(output.stdout)
            .unwrap_or_default()
            .trim()
            .to_string();
        if !path_str.is_empty() {
            let game_path = PathBuf::from(path_str).join("Content");
            if game_path.join("Binaries").is_dir() {
                return Some(game_path);
            }
        }
    }
    None
}

fn extract_archive<F>(
    archive_path: &Path,
    destination: &Path, // <--- CHANGED: Exact path where files go
    on_progress: F,
) -> Result<(), String>
// <--- CHANGED: Returns (), path is already known
where
    F: Fn(u64),
{
    if !destination.exists() {
        fs::create_dir_all(destination).map_err(|e| format!("Could not create dest dir: {}", e))?;
    }

    let abs_archive_path = archive_path
        .canonicalize()
        .map_err(|e| format!("Invalid archive path '{}': {}", archive_path.display(), e))?;

    let extension = archive_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "zip" => {
            let file = fs::File::open(&abs_archive_path).map_err(|e| e.to_string())?;
            let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

            let total_files = archive.len();
            for i in 0..total_files {
                let mut file = archive.by_index(i).map_err(|e| e.to_string())?;

                let outpath = match file.enclosed_name() {
                    Some(path) => destination.join(path), // Use destination directly
                    None => continue,
                };

                if file.name().ends_with('/') {
                    fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
                } else {
                    if let Some(p) = outpath.parent() {
                        if !p.exists() {
                            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
                        }
                    }
                    let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
                    io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
                }

                let pct = ((i as u64 + 1) * 100) / total_files as u64;
                on_progress(pct);
            }
        }
        "rar" => {
            let _guard = DIR_LOCK.lock().map_err(|e| e.to_string())?;
            let original_dir = env::current_dir().map_err(|e| e.to_string())?;

            // Change to destination
            env::set_current_dir(destination).map_err(|e| e.to_string())?;

            let extract_result = (|| -> Result<(), String> {
                let mut archive = unrar::Archive::new(&abs_archive_path)
                    .open_for_processing()
                    .map_err(|e| format!("{:?}", e))?;

                while let Ok(Some(header)) = archive.read_header() {
                    archive = header.extract().map_err(|e| format!("{:?}", e))?;
                    on_progress(0);
                }
                Ok(())
            })();

            let _ = env::set_current_dir(&original_dir);
            extract_result?;
            on_progress(100);
        }
        "7z" => {
            on_progress(50);
            sevenz_rust::decompress_file(&abs_archive_path, destination)
                .map_err(|e| e.to_string())?;
            on_progress(100);
        }
        _ => return Err(format!("Unsupported file type: .{}", extension)),
    }

    Ok(())
}

// --- TAURI COMMANDS ---

#[derive(Serialize, Deserialize)]
struct HttpResponse {
    status: u16,
    status_text: String,
    body: String,
    headers: HashMap<String, String>,
}

#[tauri::command]
async fn http_request(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    let client = reqwest::Client::new();
    let method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "HEAD" => client.head(&url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    // Add headers if provided
    if let Some(headers_map) = headers {
        for (key, value) in headers_map {
            request = request.header(&key, &value);
        }
    }

    let response = request.send().await.map_err(|e| {
        format!("HTTP request failed: {}", e)
    })?;

    let status = response.status().as_u16();
    let status_text = response.status().canonical_reason().unwrap_or("").to_string();

    // Extract response headers
    let mut response_headers = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(name.to_string().to_lowercase(), value_str.to_string());
        }
    }

    // Check if this is an image request by content-type or URL
    let content_type = response_headers.get("content-type").unwrap_or(&String::new()).to_lowercase();
    let is_image = content_type.starts_with("image/") ||
                   url.contains(".jpg") || url.contains(".jpeg") ||
                   url.contains(".png") || url.contains(".gif") ||
                   url.contains(".webp");

    let body = if is_image {
        // For images, get bytes and encode as base64
        let bytes = response.bytes().await.map_err(|e| {
            format!("Failed to read response bytes: {}", e)
        })?;
        general_purpose::STANDARD.encode(bytes)
    } else {
        // For text content, get as string
        response.text().await.map_err(|e| {
            format!("Failed to read response body: {}", e)
        })?
    };

    Ok(HttpResponse {
        status,
        status_text,
        body,
        headers: response_headers,
    })
}

#[tauri::command]
fn get_all_mods_for_render(app: AppHandle) -> Result<Vec<ModRenderData>, String> {
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    let settings_file_path = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");

    if !settings_file_path.exists() {
        return Ok(Vec::new());
    }

    // 1. Scan Disk for Real Folders
    // We create a Set of Uppercase names for easy comparison
    let mut real_folders_map: HashMap<String, String> = HashMap::new();
    let mut real_folders_set: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Ok(entries) = fs::read_dir(&mods_path) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let real_name = entry.file_name().to_string_lossy().into_owned();
                let upper_name = real_name.to_uppercase();
                real_folders_map.insert(upper_name.clone(), real_name);
                real_folders_set.insert(upper_name);
            }
        }
    }

    // 2. Read and Parse XML
    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let mut root: SettingsData =
        from_str(&xml_content).map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    let mut dirty = false; // Track if we need to save changes

    // 3. Clean Orphans (Entries in XML but not on Disk)
    if let Some(prop) = root.properties.iter_mut().find(|p| p.name == "Data") {
        let original_len = prop.mods.len();

        prop.mods.retain(|entry| {
            let xml_name = entry.properties.iter()
                .find(|p| p.name == "Name")
                .and_then(|p| p.value.as_ref())
                .map(|s| s.to_uppercase())
                .unwrap_or_default();

            // Keep it ONLY if it exists on disk
            real_folders_set.contains(&xml_name)
        });

        if prop.mods.len() != original_len {
            dirty = true;
            // Re-index priorities to avoid gaps
            for (i, mod_entry) in prop.mods.iter_mut().enumerate() {
                mod_entry.index = i.to_string();
                if let Some(priority_prop) = mod_entry.properties.iter_mut().find(|p| p.name == "ModPriority") {
                    priority_prop.value = Some(i.to_string());
                }
            }
        }
    }

    // 4. Save XML if we removed anything
    if dirty {
        // Reuse serialization logic (inline to avoid ownership issues)
        let unformatted_xml = to_string(&root).map_err(|e| e.to_string())?;
        let mut reader = Reader::from_str(&unformatted_xml);
        reader.config_mut().trim_text(true);
        let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
        loop {
            match reader.read_event() {
                Ok(Event::Eof) => break,
                Ok(event) => writer.write_event(event).unwrap(),
                Err(e) => return Err(e.to_string()),
            }
        }
        let buf = writer.into_inner();
        let xml_body = String::from_utf8(buf).map_err(|e| e.to_string())?;
        let final_content = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}", xml_body)
            .replace(" name=\"Data\" value=\"\"", " name=\"Data\"")
            .replace(" name=\"Dependencies\" value=\"\"", " name=\"Dependencies\"")
            .replace("\"/>", "\" />");

        // We use a simplified write here directly since we have the path
        let _ = fs::write(&settings_file_path, final_content);
        log_internal(&app, "INFO", "Cleaned orphaned mods from GCMODSETTINGS.MXML");
    }

    // 5. Build Render List
    let mut mods_to_render = Vec::new();

    if let Some(prop) = root.properties.iter().find(|p| p.name == "Data") {
        for mod_entry in &prop.mods {
            let xml_name_prop = mod_entry
                .properties
                .iter()
                .find(|p| p.name == "Name")
                .and_then(|p| p.value.as_ref());

            if let Some(xml_name) = xml_name_prop {
                // Get Real Name from Map
                let folder_name = real_folders_map
                    .get(&xml_name.to_uppercase())
                    .cloned()
                    .unwrap_or_else(|| xml_name.clone());

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

                let mod_info_path = mods_path.join(&folder_name).join("mod_info.json");

                let local_info = if let Ok(content) = fs::read_to_string(&mod_info_path) {
                    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                        Some(LocalModInfo {
                            folder_name: folder_name.clone(),
                            mod_id: json_val.get("modId").or(json_val.get("id")).and_then(|v| v.as_str()).map(String::from),
                            file_id: json_val.get("fileId").and_then(|v| v.as_str()).map(String::from),
                            version: json_val.get("version").and_then(|v| v.as_str()).map(String::from),
                            install_source: json_val.get("installSource").and_then(|v| v.as_str()).map(String::from),
                        })
                    } else { None }
                } else { None };

                mods_to_render.push(ModRenderData {
                    folder_name: folder_name,
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
async fn install_mod_from_archive(
    app: AppHandle,
    archive_path_str: String,
    download_id: String,
) -> Result<InstallationAnalysis, String> {
    let id_for_progress = download_id.clone();
    let app_handle_for_extract = app.clone();

    let progress_callback = move |pct: u64| {
        let _ = app_handle_for_extract.emit(
            "install-progress",
            InstallProgressPayload {
                id: id_for_progress.clone(),
                step: format!("Extracting: {}%", pct),
                progress: Some(pct),
            },
        );
    };

    let emit_progress = |step: &str| {
        let _ = app.emit(
            "install-progress",
            InstallProgressPayload {
                id: download_id.clone(),
                step: step.to_string(),
                progress: None,
            },
        );
    };

    emit_progress("Initializing...");

    let archive_path = PathBuf::from(&archive_path_str);
    let downloads_dir = get_downloads_dir(&app)?;
    let library_dir = get_library_dir(&app)?; // <--- CHANGE: Use Library Dir

    // 1. Copying Phase
    emit_progress("Copying to library...");
    let archive_path_clone = archive_path.clone();
    let downloads_dir_clone = downloads_dir.clone();

    let (final_archive_path, _) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, bool), String> {
            if !downloads_dir_clone.exists() {
                fs::create_dir_all(&downloads_dir_clone).map_err(|e| e.to_string())?;
            }

            let in_downloads = if let (Ok(p1), Ok(p2)) = (
                archive_path_clone.canonicalize(),
                downloads_dir_clone.canonicalize(),
            ) {
                p1.starts_with(p2)
            } else {
                false
            };

            if !in_downloads {
                let file_name = archive_path_clone
                    .file_name()
                    .ok_or("Invalid filename".to_string())?;
                let target_path = downloads_dir_clone.join(file_name);
                fs::copy(&archive_path_clone, &target_path).map_err(|e| e.to_string())?;
                Ok((target_path, false))
            } else {
                Ok((archive_path_clone, true))
            }
        })
        .await
        .map_err(|e| e.to_string())??;

    let final_archive_path_str = final_archive_path.to_string_lossy().into_owned();

    // 2. Library Preparation / Extraction Phase
    // Construct a unique folder name based on the zip filename (e.g. "MyMod.zip_unpacked")
    let zip_name = final_archive_path.file_name().unwrap().to_string_lossy();
    let library_folder_name = format!("{}_unpacked", zip_name);
    let library_mod_path = library_dir.join(&library_folder_name);

    // Clone for thread
    let final_archive_path_clone = final_archive_path.clone();
    let library_mod_path_clone = library_mod_path.clone();

    // Start Task
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // OPTIMIZATION: Check if already extracted
        if library_mod_path_clone.exists() {
            // Optional: You could verify contents here, but for now assume if folder exists, it's good.
            // We skip extraction!
            return Ok(());
        }

        // If not, extract to the permanent library folder
        extract_archive(
            &final_archive_path_clone,
            &library_mod_path_clone,
            progress_callback,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    // 3. Analysis Phase (Scanning the Library)
    emit_progress("Analyzing structure...");

    let library_mod_path_clone = library_mod_path.clone();

    let (folder_entries, installable_paths) = tauri::async_runtime::spawn_blocking(move || {
        let installable =
            scan_for_installable_mods(&library_mod_path_clone, &library_mod_path_clone);

        let entries: Vec<_> = fs::read_dir(&library_mod_path_clone)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .collect();

        Ok::<_, String>((entries, installable))
    })
    .await
    .map_err(|e| e.to_string())??;

    // We pass the library folder name as the ID now
    let library_id = library_folder_name;

    // CASE A: Multiple Options
    if installable_paths.len() > 1 {
        emit_progress("Waiting for selection...");
        return Ok(InstallationAnalysis {
            successes: vec![],
            conflicts: vec![],
            messy_archive_path: None,
            active_archive_path: Some(final_archive_path_str),
            selection_needed: true,
            temp_id: Some(library_id), // Send Library Name
            available_folders: Some(installable_paths),
        });
    }

    // CASE B: Single Deep Folder
    if installable_paths.len() == 1 {
        emit_progress("Finalizing...");
        let mut analysis =
            finalize_installation(app, library_id, vec![installable_paths[0].clone()], true)?;
        analysis.active_archive_path = Some(final_archive_path_str);
        return Ok(analysis);
    }

    // CASE C: Fallback
    if folder_entries.len() > 1 {
        let folder_names: Vec<String> = folder_entries
            .iter()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();

        emit_progress("Waiting for selection...");
        return Ok(InstallationAnalysis {
            successes: vec![],
            conflicts: vec![],
            messy_archive_path: None,
            active_archive_path: Some(final_archive_path_str),
            selection_needed: true,
            temp_id: Some(library_id),
            available_folders: Some(folder_names),
        });
    }

    // CASE D: Install All
    emit_progress("Finalizing...");
    let mut analysis = finalize_installation(app, library_id, vec![], false)?;
    analysis.active_archive_path = Some(final_archive_path_str);

    Ok(analysis)
}

#[tauri::command]
fn finalize_installation(
    app: AppHandle,
    library_id: String,
    selected_folders: Vec<String>,
    flatten_paths: bool
) -> Result<InstallationAnalysis, String> {
    log_internal(&app, "INFO", &format!("Finalizing installation. Source: {}, Flatten: {}", library_id, flatten_paths));

    let game_path = find_game_path().ok_or_else(|| "Could not find game path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;

    let library_dir = get_library_dir(&app)?;
    let source_root = library_dir.join(&library_id);

    if !source_root.exists() {
        let err = format!("Library folder missing: {:?}", source_root);
        log_internal(&app, "ERROR", &err);
        return Err(err);
    }

    // Load existing mods for conflict checking
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

    let staging_dir = get_staging_dir(&app)?;
    let conflict_staging_path = staging_dir.join(format!("conflict_{}", Utc::now().timestamp_millis()));

    let mut successes = Vec::new();
    let mut conflicts = Vec::new();

    // If selected_folders is empty (or just contained "."), fallback to all top-level
    let items_to_process = if selected_folders.is_empty() || (selected_folders.len() == 1 && selected_folders[0] == ".") {
        log_internal(&app, "INFO", "No specific folders selected. Scanning all top-level folders.");
        fs::read_dir(&source_root)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect::<Vec<String>>()
    } else {
        log_internal(&app, "INFO", &format!("Selected folders to install: {:?}", selected_folders));
        selected_folders
    };

    struct DeployOp {
        source: PathBuf,
        dest_name: String,
    }
    let mut ops: Vec<DeployOp> = Vec::new();

    for relative_path_str in items_to_process {
        // Handle the dot "." explicitly if it still sneaks in
        let source_path = if relative_path_str == "." {
            source_root.clone()
        } else {
            source_root.join(&relative_path_str)
        };

        if !source_path.exists() { continue; }

        if flatten_paths {
            // "Smart Extract": Look deeper for the actual mod root
            let deep_candidates = scan_for_installable_mods(&source_path, &source_path);

            if !deep_candidates.is_empty() {
                for deep_rel in deep_candidates {
                    let deep_source = if deep_rel == "." { source_path.clone() } else { source_path.join(&deep_rel) };
                    let folder_name = deep_source.file_name().ok_or("Invalid path")?.to_string_lossy().into_owned();

                    // --- DEDUPLICATION CHECK ---
                    if !ops.iter().any(|op| op.dest_name.eq_ignore_ascii_case(&folder_name)) {
                        ops.push(DeployOp { source: deep_source, dest_name: folder_name });
                    }
                }
            } else {
                // No deep structure found, use current
                let folder_name = source_path.file_name().ok_or("Invalid path")?.to_string_lossy().into_owned();

                // --- DEDUPLICATION CHECK ---
                if !ops.iter().any(|op| op.dest_name.eq_ignore_ascii_case(&folder_name)) {
                    ops.push(DeployOp { source: source_path, dest_name: folder_name });
                }
            }
        } else {
            // Exact Install: Use the folder structure exactly as selected
            let folder_name = source_path.file_name().ok_or("Invalid path")?.to_string_lossy().into_owned();

            // --- DEDUPLICATION CHECK ---
            if !ops.iter().any(|op| op.dest_name.eq_ignore_ascii_case(&folder_name)) {
                ops.push(DeployOp { source: source_path, dest_name: folder_name });
            }
        }
    }

    for op in ops {
        let mut conflict_found = false;

        if let Some(info) = read_mod_info(&op.source) {
            if let Some(mod_id) = info.mod_id {
                if let Some(old_folder_name) = installed_mods_by_id.get(&mod_id) {
                    if !conflict_staging_path.exists() { fs::create_dir_all(&conflict_staging_path).map_err(|e| e.to_string())?; }

                    let staged_mod_path = conflict_staging_path.join(&op.dest_name);

                    if let Err(e) = deploy_structure_recursive(&op.source, &staged_mod_path) {
                        log_internal(&app, "ERROR", &format!("Failed to stage conflict: {}", e));
                    }

                    conflicts.push(ModConflictInfo {
                        new_mod_name: op.dest_name.clone(),
                        temp_path: staged_mod_path.to_string_lossy().into_owned(),
                        old_mod_folder_name: old_folder_name.clone(),
                    });
                    conflict_found = true;
                }
            }
        }

        if !conflict_found {
            let final_dest_path = mods_path.join(&op.dest_name);
            log_internal(&app, "INFO", &format!("Deploying mod folder: {}", op.dest_name));

            if final_dest_path.exists() {
                if !conflict_staging_path.exists() { fs::create_dir_all(&conflict_staging_path).map_err(|e| e.to_string())?; }
                let staged_mod_path = conflict_staging_path.join(&op.dest_name);

                if let Err(e) = deploy_structure_recursive(&op.source, &staged_mod_path) {
                    log_internal(&app, "ERROR", &format!("Failed to stage overwrite: {}", e));
                }

                conflicts.push(ModConflictInfo {
                    new_mod_name: op.dest_name.clone(),
                    temp_path: staged_mod_path.to_string_lossy().into_owned(),
                    old_mod_folder_name: op.dest_name.clone(),
                });
            } else {
                if let Err(e) = deploy_structure_recursive(&op.source, &final_dest_path) {
                    let err_msg = format!("Failed to deploy {}: {}", op.dest_name, e);
                    log_internal(&app, "ERROR", &err_msg);
                    return Err(err_msg);
                }

                successes.push(ModInstallInfo {
                    name: op.dest_name,
                    temp_path: final_dest_path.to_string_lossy().into_owned(),
                });
            }
        }
    }

    log_internal(&app, "INFO", "Installation finalization complete.");

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
fn detect_game_installation(app: AppHandle) -> Option<GamePaths> {
    log_internal(&app, "INFO", "Starting Game Detection...");

    if let Some(path) = find_game_path() {
        let settings_dir = path.join("Binaries").join("SETTINGS");

        if settings_dir.exists() {
            log_internal(&app, "INFO", &format!("Found game path: {:?}", path));

            // Determine "Version Type" based on OS
            #[cfg(target_os = "windows")]
            let v_type = if path.to_string_lossy().contains("Xbox") {
                "GamePass"
            } else if path.to_string_lossy().contains("GOG") {
                "GOG"
            } else {
                "Steam"
            };

            #[cfg(target_os = "linux")]
            let v_type = "Steam";

            return Some(GamePaths {
                game_root_path: path.to_string_lossy().into_owned(),
                settings_root_path: path.to_string_lossy().into_owned(),
                version_type: v_type.to_string(),
            });
        }
    }

    log_internal(
        &app,
        "WARN",
        "Game detection failed: No valid installation found.",
    );
    None
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
fn save_file(app: AppHandle, file_path: String, content: String) -> Result<(), String> {
    log_internal(&app, "INFO", &format!("Saving MXML to: {}", file_path));
    fs::write(&file_path, content).map_err(|e| {
        let err = format!("Failed to write to file '{}': {}", file_path, e);
        log_internal(&app, "ERROR", &err);
        err
    })
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
fn rename_mod_folder(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<Vec<ModRenderData>, String> {
    log_internal(
        &app,
        "INFO",
        &format!("Requesting rename: '{}' -> '{}'", old_name, new_name),
    );

    let game_path = find_game_path().ok_or_else(|| "Could not find game path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");

    let old_path = mods_path.join(&old_name);
    let new_path = mods_path.join(&new_name);

    // 1. Validation
    if !old_path.exists() {
        return Err("Original mod folder not found.".to_string());
    }
    if new_path.exists() {
        return Err("A mod with the new name already exists.".to_string());
    }

    // Reads source zip from mod_info.json and renames the folder inside the Library
    if let Some(info) = read_mod_info(&old_path) {
        if let Some(source_zip) = info.install_source {
            if let Ok(library_dir) = get_library_dir(&app) {
                let lib_unpacked = library_dir.join(format!("{}_unpacked", source_zip));
                let lib_old_path = lib_unpacked.join(&old_name);
                let lib_new_path = lib_unpacked.join(&new_name);

                if lib_old_path.exists() && !lib_new_path.exists() {
                    // Try to rename in library. If it fails, it log it but don't stop the game rename.
                    if let Err(e) = fs::rename(&lib_old_path, &lib_new_path) {
                        log_internal(
                            &app,
                            "WARN",
                            &format!("Failed to sync rename to Library: {}", e),
                        );
                    } else {
                        log_internal(
                            &app,
                            "INFO",
                            "Synced folder rename to Library successfully.",
                        );
                    }
                }
            }
        }
    }

    // 2. Rename Folder (Physically moves the folder, keeping the casing of new_name)
    fs::rename(&old_path, &new_path).map_err(|e| {
        let err = format!("Failed to rename folder: {}", e);
        log_internal(&app, "ERROR", &err);
        err
    })?;

    // 3. Update XML
    // Reuse the logic from update_mod_name_in_xml but integrated here to avoid double-parsing.
    let settings_file = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");
    if settings_file.exists() {
        match update_mod_name_in_xml(old_name.clone(), new_name.clone()) {
            Ok(new_xml) => {
                let _ = save_file(
                    app.clone(),
                    settings_file.to_string_lossy().to_string(),
                    new_xml,
                );
            }
            Err(e) => {
                log_internal(
                    &app,
                    "WARN",
                    &format!("Folder renamed, but XML update failed: {}", e),
                );
            }
        }
    }

    // 4. Return fresh list
    get_all_mods_for_render(app)
}

#[tauri::command]
fn delete_mod(app: AppHandle, mod_name: String) -> Result<Vec<ModRenderData>, String> {
    log_internal(
        &app,
        "INFO",
        &format!("Requesting deletion of mod: {}", mod_name),
    );

    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let settings_file_path = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");
    let mod_to_delete_path = game_path.join("GAMEDATA").join("MODS").join(&mod_name);

    if mod_to_delete_path.exists() {
        if let Err(e) = fs::remove_dir_all(&mod_to_delete_path) {
            log_internal(
                &app,
                "ERROR",
                &format!("Failed to delete folder {}: {}", mod_name, e),
            );
            return Err(format!("Failed to delete mod folder: {}", e));
        }
        log_internal(
            &app,
            "INFO",
            &format!("Deleted folder: {:?}", mod_to_delete_path),
        );
    } else {
        log_internal(
            &app,
            "WARN",
            &format!("Folder not found for deletion: {:?}", mod_to_delete_path),
        );
    }

    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let mut root: SettingsData =
        from_str(&xml_content).map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    for prop in root.properties.iter_mut() {
        if prop.name == "Data" {
            prop.mods.retain(|entry| {
                let entry_name = entry
                    .properties
                    .iter()
                    .find(|p| p.name == "Name")
                    .and_then(|p| p.value.as_deref())
                    .unwrap_or("");

                !entry_name.eq_ignore_ascii_case(&mod_name)
            });

            prop.mods.sort_by_key(|entry| {
                entry
                    .properties
                    .iter()
                    .find(|p| p.name == "ModPriority")
                    .and_then(|p| p.value.as_ref())
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(u32::MAX)
            });
            for (i, mod_entry) in prop.mods.iter_mut().enumerate() {
                mod_entry.index = i.to_string();
            }
            break;
        }
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
        .replace(
            " name=\"Dependencies\" value=\"\"",
            " name=\"Dependencies\"",
        )
        .replace("\"/>", "\" />");

    fs::write(&settings_file_path, &final_content)
        .map_err(|e| format!("Failed to save updated GCMODSETTINGS.MXML: {}", e))?;

    get_all_mods_for_render(app)
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
        .replace(
            " name=\"Dependencies\" value=\"\"",
            " name=\"Dependencies\"",
        )
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
                    if let Some(val) = name_prop.value.as_deref() {
                        val.eq_ignore_ascii_case(&old_name)
                    } else {
                        false
                    }
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
        .replace(
            " name=\"Dependencies\" value=\"\"",
            " name=\"Dependencies\"",
        )
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
    let game_path =
        find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
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
        if !mod_id.is_empty() {
            obj.insert("modId".to_string(), Value::String(mod_id));
        }
        if !file_id.is_empty() {
            obj.insert("fileId".to_string(), Value::String(file_id));
        }
        if !version.is_empty() {
            obj.insert("version".to_string(), Value::String(version));
        }
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
        let json: Value =
            serde_json::from_str(&content).map_err(|_| "Invalid auth file".to_string())?;

        if let Some(key) = json.get("apikey").and_then(|k| k.as_str()) {
            println!("Loaded API Key from AppData");
            return Ok(key.to_string());
        }
    }

    Err("No API Key found. Please log in.".to_string())
}

#[tauri::command]
fn unregister_nxm_protocol() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.delete_subkey_all("Software\\Classes\\nxm")
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").map_err(|_| "Could not find HOME".to_string())?;
        let desktop_file =
            PathBuf::from(home).join(".local/share/applications/nxm-handler.desktop");
        if desktop_file.exists() {
            fs::remove_file(desktop_file).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn is_protocol_handler_registered() -> bool {
    #[cfg(target_os = "windows")]
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
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let desktop_file =
            PathBuf::from(home).join(".local/share/applications/nxm-handler.desktop");
        return desktop_file.exists();
    }
}

#[tauri::command]
fn register_nxm_protocol() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_path_str = exe_path.to_string_lossy();
        let command = format!("\"{}\" \"%1\"", exe_path_str);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (nxm_key, _) = hkcu
            .create_subkey("Software\\Classes\\nxm")
            .map_err(|e| e.to_string())?;

        nxm_key
            .set_value("", &"URL:NXM Protocol")
            .map_err(|e| e.to_string())?;
        nxm_key
            .set_value("URL Protocol", &"")
            .map_err(|e| e.to_string())?;

        let (command_key, _) = nxm_key
            .create_subkey_with_flags("shell\\open\\command", KEY_WRITE)
            .map_err(|e| e.to_string())?;
        command_key
            .set_value("", &command)
            .map_err(|e| e.to_string())?;

        println!("Successfully registered nxm:// protocol handler to current user.");
    }

    #[cfg(target_os = "linux")]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let home = std::env::var("HOME").map_err(|_| "Could not find HOME".to_string())?;

        // 1. Create the .desktop file content
        let desktop_content = format!(
            "[Desktop Entry]\n\
            Type=Application\n\
            Name=Singularity Mod Manager\n\
            Exec=\"{}\" %u\n\
            StartupNotify=false\n\
            MimeType=x-scheme-handler/nxm;\n",
            exe_path.to_string_lossy()
        );

        // 2. Write to ~/.local/share/applications/nxm-handler.desktop
        let apps_dir = PathBuf::from(&home).join(".local/share/applications");
        if !apps_dir.exists() {
            fs::create_dir_all(&apps_dir).map_err(|e| e.to_string())?;
        }
        let desktop_file = apps_dir.join("nxm-handler.desktop");
        fs::write(&desktop_file, desktop_content).map_err(|e| e.to_string())?;

        // 3. Register the mimetype using xdg-mime
        use std::process::Command;
        Command::new("xdg-mime")
            .args(["default", "nxm-handler.desktop", "x-scheme-handler/nxm"])
            .output()
            .map_err(|e| format!("Failed to run xdg-mime: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn download_mod_archive(
    app: AppHandle,
    download_url: String,
    file_name: String,
    download_id: Option<String>,
) -> Result<DownloadResult, String> {
    log_internal(
        &app,
        "INFO",
        &format!("Starting download request for: {}", file_name),
    );

    let downloads_path = get_downloads_dir(&app)?;
    let final_archive_path = downloads_path.join(&file_name);

    let mut response = reqwest::get(&download_url).await.map_err(|e| {
        let err = format!("Failed to initiate HTTP request: {}", e);
        log_internal(&app, "ERROR", &err);
        err
    })?;

    if !response.status().is_success() {
        let err = format!("Download failed with HTTP status: {}", response.status());
        log_internal(&app, "ERROR", &err);
        return Err(err);
    }

    let total_size = response.content_length().unwrap_or(0);
    log_internal(
        &app,
        "INFO",
        &format!("Connection established. Content-Length: {}", total_size),
    );

    let mut file = fs::File::create(&final_archive_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut downloaded: u64 = 0;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if let Some(id) = &download_id {
            if total_size > 0 {
                let pct = (downloaded * 100) / total_size;
                // Don't log every percentage to disk, too spammy. Frontend handles visual progress.
                let _ = app.emit(
                    "install-progress",
                    InstallProgressPayload {
                        id: id.clone(),
                        step: format!("Downloading: {}%", pct),
                        progress: Some(pct),
                    },
                );
            }
        }
    }

    let metadata = fs::metadata(&final_archive_path).map_err(|e| e.to_string())?;
    let file_size = metadata.len();

    log_internal(
        &app,
        "INFO",
        &format!(
            "Download finished. File: {:?} (Size: {} bytes)",
            final_archive_path, file_size
        ),
    );

    let created_time = metadata
        .created()
        .map_err(|e| e.to_string())?
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

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let p = PathBuf::from(&path);

        if let Some(parent) = p.parent() {
            Command::new("xdg-open").arg(parent).spawn().ok();
        } else {
            Command::new("xdg-open").arg(path).spawn().ok();
        }
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
    // 1. Clear Downloads
    let downloads_path = get_downloads_dir(&app)?;
    if downloads_path.exists() {
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

    // 2. Clear Library
    let library_path = get_library_dir(&app)?;
    if library_path.exists() {
        let entries = fs::read_dir(&library_path).map_err(|e| e.to_string())?;
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                // Library contains folders, so remove_dir_all
                if path.is_dir() {
                    fs::remove_dir_all(path).map_err(|e| e.to_string())?;
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
                            if let Some(source) = json.get("installSource").and_then(|s| s.as_str())
                            {
                                if !source.is_empty() {
                                    profile_map
                                        .entry(source.to_string())
                                        .or_default()
                                        .push(folder_name);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Backup MXML
        let current_mxml = game_path
            .join("Binaries")
            .join("SETTINGS")
            .join("GCMODSETTINGS.MXML");
        if current_mxml.exists() {
            fs::copy(current_mxml, mxml_backup_path).map_err(|e| e.to_string())?;
        }
    }

    // Convert Map to ProfileModEntry list
    let mut profile_entries = Vec::new();
    for (filename, installed_folders) in profile_map {
        // --- NO HASHING HERE ANYMORE ---
        // We simply trust the filename linkage.

        // Sample metadata from first folder
        let mut p_mod_id = None;
        let mut p_file_id = None;
        let mut p_version = None;

        if let Some(first_folder) = installed_folders.first() {
            if let Some(gp) = find_game_path() {
                let info_p = gp
                    .join("GAMEDATA/MODS")
                    .join(first_folder)
                    .join("mod_info.json");
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
            // hash: ... REMOVED
            mod_id: p_mod_id,
            file_id: p_file_id,
            version: p_version,
            installed_options: Some(installed_folders),
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
        ModProfileData {
            name: "Default".to_string(),
            mods: vec![],
        }
    } else {
        let content =
            fs::read_to_string(&json_path).map_err(|_| "Profile not found".to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    };

    let game_path = find_game_path().ok_or("Game path not found")?;
    let mods_dir = game_path.join("GAMEDATA/MODS");

    // Clean Game Folder
    if mods_dir.exists() {
        for entry in fs::read_dir(&mods_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().is_dir() || entry.path().extension().unwrap_or_default() == "pak" {
                if entry.path().is_dir() {
                    fs::remove_dir_all(entry.path()).ok();
                } else {
                    fs::remove_file(entry.path()).ok();
                }
            }
        }
    }

    let live_mxml = game_path
        .join("Binaries")
        .join("SETTINGS")
        .join("GCMODSETTINGS.MXML");
    println!("Applying Profile: {}", profile_name);

    if mxml_backup_path.exists() {
        let mut src = fs::File::open(&mxml_backup_path).map_err(|e| e.to_string())?;
        let mut dst = fs::File::create(&live_mxml).map_err(|e| e.to_string())?;
        io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
    } else {
        fs::write(&live_mxml, CLEAN_MXML_TEMPLATE).map_err(|e| e.to_string())?;
    }

    let downloads_dir = get_downloads_dir(&app)?;
    let library_dir = get_library_dir(&app)?; // <--- NEW
    let total_mods = profile_data.mods.len();

    for (i, entry) in profile_data.mods.iter().enumerate() {
        let archive_path = downloads_dir.join(&entry.filename);
        let library_folder_name = format!("{}_unpacked", entry.filename);
        let library_mod_path = library_dir.join(&library_folder_name);

        let current_idx = i + 1;

        app.emit(
            "profile-progress",
            ProfileSwitchProgress {
                current: current_idx,
                total: total_mods,
                current_mod: entry.filename.clone(),
                file_progress: 0,
            },
        )
        .unwrap();

        // 1. Ensure Library Exists (Extract if missing)
        if !library_mod_path.exists() && archive_path.exists() {
            let app_handle = app.clone();
            let mod_name_clone = entry.filename.clone();

            let progress_cb = move |pct: u64| {
                let _ = app_handle.emit(
                    "profile-progress",
                    ProfileSwitchProgress {
                        current: current_idx,
                        total: total_mods,
                        current_mod: mod_name_clone.clone(),
                        file_progress: pct,
                    },
                );
            };

            // Extract to permanent library
            if let Err(e) = extract_archive(&archive_path, &library_mod_path, progress_cb) {
                println!("Failed to extract {}: {}", entry.filename, e);
                continue;
            }
        }

        // 2. Deploy from Library (Instant Hardlink if possible)
        if library_mod_path.exists() {
            let has_specific_options = entry
                .installed_options
                .as_ref()
                .map(|o| !o.is_empty())
                .unwrap_or(false);

            if has_specific_options {
                if let Some(options) = &entry.installed_options {
                    for target_folder_name in options {
                        if let Some(source_path) =
                            find_folder_in_tree(&library_mod_path, target_folder_name)
                        {
                            let dest = mods_dir.join(target_folder_name);

                            // CHANGE: deploy_structure_recursive (Links/Copies) instead of rename (Move)
                            if let Err(e) = deploy_structure_recursive(&source_path, &dest) {
                                println!("Failed to deploy {}: {}", target_folder_name, e);
                                continue;
                            }

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
                // Legacy: Deploy all top-level folders
                if let Ok(entries) = fs::read_dir(&library_mod_path) {
                    for fs_entry in entries.filter_map(Result::ok) {
                        let folder_name = fs_entry.file_name().to_string_lossy().into_owned();
                        let dest = mods_dir.join(&folder_name);
                        let src = fs_entry.path();

                        // CHANGE: Deploy
                        deploy_structure_recursive(&src, &dest).ok();

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
            // Note: We DO NOT remove the library folder here. It stays for next time.

            // Update progress to 100% immediately since linking is fast
            app.emit(
                "profile-progress",
                ProfileSwitchProgress {
                    current: current_idx,
                    total: total_mods,
                    current_mod: entry.filename.clone(),
                    file_progress: 100,
                },
            )
            .unwrap();
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let json_path = dir.join(format!("{}.json", profile_name));
    let mxml_path = dir.join(format!("{}.mxml", profile_name));
    if json_path.exists() {
        fs::remove_file(json_path).map_err(|e| e.to_string())?;
    }
    if mxml_path.exists() {
        fs::remove_file(mxml_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_profile(app: AppHandle, old_name: String, new_name: String) -> Result<(), String> {
    let dir = get_profiles_dir(&app)?;
    let old_json = dir.join(format!("{}.json", old_name));
    let old_mxml = dir.join(format!("{}.mxml", old_name));
    let new_json = dir.join(format!("{}.json", new_name));
    let new_mxml = dir.join(format!("{}.mxml", new_name));

    if old_json.exists() {
        fs::rename(old_json, new_json).map_err(|e| e.to_string())?;
    }
    if old_mxml.exists() {
        fs::rename(old_mxml, new_mxml).map_err(|e| e.to_string())?;
    }
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
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA").join("MODS");
        if let Ok(entries) = fs::read_dir(mods_path) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let info_path = entry.path().join("mod_info.json");

                    if !info_path.exists() {
                        return true; // No file = Untracked
                    }

                    if let Ok(content) = fs::read_to_string(&info_path) {
                        if let Ok(json) = serde_json::from_str::<Value>(&content) {
                            // STRICT CHECK:
                            // 1. Get "installSource"
                            // 2. Ensure it is a String (not null/number)
                            // 3. Ensure it is NOT empty
                            let is_valid_source = json
                                .get("installSource")
                                .and_then(|v| v.as_str())
                                .map(|s| !s.is_empty())
                                .unwrap_or(false); // If key missing or not string, defaults to false

                            if !is_valid_source {
                                return true;
                            }
                        } else {
                            return true; // Invalid JSON
                        }
                    } else {
                        return true; // Read error
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
    log_internal(&app, "INFO", "Starting Nexus login process...");

    // 1. Generate a unique Request ID (UUID)
    let uuid = Uuid::new_v4().to_string();
    log_internal(&app, "INFO", &format!("Generated UUID: {}", uuid));

    // 2. Construct the WebSocket URL
    let sso_url = Url::parse("wss://sso.nexusmods.com").map_err(|e| {
        let err = format!("Failed to parse WebSocket URL: {}", e);
        log_internal(&app, "ERROR", &err);
        err
    })?;

    log_internal(&app, "INFO", &format!("Connecting to: {}", sso_url));

    // 3. Open the connection
    let (ws_stream, _) = connect_async(sso_url.to_string())
        .await
        .map_err(|e| {
            let err = format!("Failed to connect to Nexus WebSocket: {}", e);
            log_internal(&app, "ERROR", &err);
            err
        })?;

    log_internal(&app, "INFO", "WebSocket connection established");

    let (mut write, mut read) = ws_stream.split();

    // 4. Send the Handshake
    let msg = serde_json::json!({
        "id": uuid,
        "token": null,
        "protocol": 2
    });

    log_internal(&app, "INFO", &format!("Sending handshake: {}", msg));

    write
        .send(Message::Text(msg.to_string().into()))
        .await
        .map_err(|e| {
            let err = format!("Failed to send handshake: {}", e);
            log_internal(&app, "ERROR", &err);
            err
        })?;

    // 5. Open the User's Browser to authorize
    let auth_url = format!(
        "https://www.nexusmods.com/sso?id={}&application=syzzle07-singularity",
        uuid
    );
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

                    fs::write(
                        &auth_path,
                        serde_json::to_string_pretty(&auth_data).unwrap(),
                    )
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
async fn set_downloads_path(app: AppHandle, new_path: String) -> Result<(), String> {
    let old_path = get_downloads_dir(&app)?;
    log_internal(
        &app,
        "INFO",
        &format!(
            "Changing Downloads Path. Old: {:?}, New: {}",
            old_path, new_path
        ),
    );

    let user_selected_root = PathBuf::from(&new_path);
    let target_path = user_selected_root.join("downloads");

    if old_path == target_path {
        return Ok(());
    }

    if target_path.starts_with(&old_path) {
        let err =
            "Cannot move the folder inside itself. Please select a different location.".to_string();
        log_internal(&app, "WARN", &err);
        return Err(err);
    }

    if !target_path.exists() {
        fs::create_dir_all(&target_path).map_err(|e| e.to_string())?;
    }

    if old_path.exists() {
        let old_clone = old_path.clone();
        let target_clone = target_path.clone();

        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            copy_dir_recursive(&old_clone, &target_clone)?;
            fs::remove_dir_all(&old_clone).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| {
            let err = e.to_string();
            log_internal(
                &app,
                "ERROR",
                &format!("Failed to move downloads content: {}", err),
            );
            err
        })??;
    }

    let config_path = get_config_file_path(&app)?;
    let mut config = if config_path.exists() {
        let c = fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&c).unwrap_or(GlobalAppConfig {
            custom_download_path: None,
            custom_library_path: None,
            legacy_migration_done: true,
        })
    } else {
        GlobalAppConfig {
            custom_download_path: None,
            custom_library_path: None,
            legacy_migration_done: true,
        }
    };

    config.custom_download_path = Some(target_path.to_string_lossy().into_owned());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;

    log_internal(&app, "INFO", "Downloads path updated successfully.");
    Ok(())
}

#[tauri::command]
fn open_special_folder(app: AppHandle, folder_type: String) -> Result<(), String> {
    let path = match folder_type.as_str() {
        "downloads" => get_downloads_dir(&app)?,
        "profiles" => get_profiles_dir(&app)?,
        "library" => get_library_dir(&app)?,
        _ => return Err("Unknown folder type".to_string()),
    };
    open::that(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn clean_staging_folder(app: AppHandle) -> Result<usize, String> {
    let staging_dir = get_staging_dir(&app)?;

    if staging_dir.exists() {
        let count = fs::read_dir(&staging_dir)
            .map_err(|e| e.to_string())?
            .count();

        if count > 0 {
            fs::remove_dir_all(&staging_dir).map_err(|e| e.to_string())?;
            fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;
            return Ok(count); // Return the number of deleted items
        }
    }

    Ok(0) // Return 0 if empty
}

#[tauri::command]
fn delete_library_folder(app: AppHandle, zip_filename: String) -> Result<(), String> {
    let library_dir = get_library_dir(&app)?;
    let library_folder_name = format!("{}_unpacked", zip_filename);
    let target_path = library_dir.join(library_folder_name);

    if target_path.exists() {
        fs::remove_dir_all(&target_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_staging_contents(
    app: AppHandle,
    temp_id: String,
    relative_path: String,
) -> Result<Vec<FileNode>, String> {
    // CHANGE: Look in Library Dir now, not Staging
    let library_dir = get_library_dir(&app)?;
    let root_path = library_dir.join(&temp_id);

    // Construct target path
    let target_path = if relative_path.is_empty() {
        root_path.clone()
    } else {
        root_path.join(&relative_path)
    };

    // Security check
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

#[tauri::command]
async fn run_legacy_migration(app: AppHandle) -> Result<(), String> {
    let config_path = get_config_file_path(&app)?;

    // 1. Load Config
    let mut config: GlobalAppConfig = if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;

        // FIX 1: Added custom_library_path here
        serde_json::from_str(&content).unwrap_or(GlobalAppConfig {
            custom_download_path: None,
            custom_library_path: None,
            legacy_migration_done: false,
        })
    } else {
        // FIX 2: Added custom_library_path here
        GlobalAppConfig {
            custom_download_path: None,
            custom_library_path: None,
            legacy_migration_done: false,
        }
    };

    if config.legacy_migration_done {
        return Ok(());
    }

    println!("[MIGRATION] Starting Global Profile Scan...");

    let profiles_dir = get_profiles_dir(&app)?;

    // 2. Build Master Lookup Map from ALL Profiles
    let mut legacy_lookup: HashMap<(String, String), String> = HashMap::new();

    if let Ok(entries) = fs::read_dir(&profiles_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(profile_data) = serde_json::from_str::<ModProfileData>(&content) {
                        for mod_entry in profile_data.mods {
                            let m_id = mod_entry.mod_id.map(|v| v.to_string());
                            let f_id = mod_entry.file_id.map(|v| v.to_string());

                            if let (Some(mid), Some(fid)) = (m_id, f_id) {
                                legacy_lookup.insert((mid, fid), mod_entry.filename);
                            }
                        }
                    }
                }
            }
        }
    }

    println!(
        "[MIGRATION] Built lookup table with {} entries.",
        legacy_lookup.len()
    );

    // 3. Scan Installed Mods in Game Folder
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA/MODS");

        if let Ok(entries) = fs::read_dir(mods_path) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().into_owned();
                    let info_path = entry.path().join("mod_info.json");

                    if info_path.exists() {
                        let mut json: Value = match fs::read_to_string(&info_path)
                            .ok()
                            .and_then(|c| serde_json::from_str(&c).ok())
                        {
                            Some(v) => v,
                            None => continue,
                        };

                        let needs_heal = json
                            .get("installSource")
                            .and_then(|s| s.as_str())
                            .map(|s| s.is_empty())
                            .unwrap_or(true);

                        if needs_heal {
                            let get_val_as_string = |key: &str| -> Option<String> {
                                match json.get(key) {
                                    Some(Value::String(s)) => Some(s.clone()),
                                    Some(Value::Number(n)) => Some(n.to_string()),
                                    _ => None,
                                }
                            };

                            let m_id = get_val_as_string("modId").or(get_val_as_string("id"));
                            let f_id = get_val_as_string("fileId");

                            if let (Some(mid), Some(fid)) = (m_id, f_id) {
                                if let Some(filename) = legacy_lookup.get(&(mid, fid)) {
                                    println!("[MIGRATION] HEALED: {} -> {}", folder_name, filename);

                                    if let Some(obj) = json.as_object_mut() {
                                        obj.insert(
                                            "installSource".to_string(),
                                            Value::String(filename.clone()),
                                        );
                                    }

                                    if let Ok(new_content) = serde_json::to_string_pretty(&json) {
                                        let _ = fs::write(&info_path, new_content);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Update Config
    config.legacy_migration_done = true;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn write_to_log(app: AppHandle, level: String, message: String) -> Result<(), String> {
    log_internal(&app, &level, &message);
    Ok(())
}

#[tauri::command]
async fn set_library_path(app: AppHandle, new_path: String) -> Result<(), String> {
    let old_path = get_library_dir(&app)?;

    let user_selected_root = PathBuf::from(&new_path);
    let target_path = user_selected_root.join("Library");

    // 1. Exact Match: If the calculated path is identical, do nothing.
    if old_path == target_path {
        return Ok(());
    }

    // 2. Recursion Prevention: Cannot move folder into its own subdirectory
    // Example: Moving "C:\Lib" to "C:\Lib\Sub" creates "C:\Lib\Sub\Lib" -> Infinite Loop
    if target_path.starts_with(&old_path) {
        return Err(
            "Cannot move the folder inside itself. Please select a different location.".to_string(),
        );
    }

    if !target_path.exists() {
        fs::create_dir_all(&target_path).map_err(|e| e.to_string())?;
    }

    if old_path.exists() {
        let old_clone = old_path.clone();
        let target_clone = target_path.clone();

        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            copy_dir_recursive(&old_clone, &target_clone)?;
            fs::remove_dir_all(&old_clone).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    let config_path = get_config_file_path(&app)?;
    let mut config = if config_path.exists() {
        let c = fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&c).unwrap_or(GlobalAppConfig {
            custom_download_path: None,
            custom_library_path: None,
            legacy_migration_done: true,
        })
    } else {
        GlobalAppConfig {
            custom_download_path: None,
            custom_library_path: None,
            legacy_migration_done: true,
        }
    };

    config.custom_library_path = Some(target_path.to_string_lossy().into_owned());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_library_path(app: AppHandle) -> Result<String, String> {
    let path = get_library_dir(&app)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn check_library_existence(
    app: AppHandle,
    filenames: Vec<String>,
) -> Result<HashMap<String, bool>, String> {
    let library_dir = get_library_dir(&app)?;
    let mut results = HashMap::new();

    for name in filenames {
        // Recreate the folder naming logic: "Mod.zip" -> "Mod.zip_unpacked"
        let folder_name = format!("{}_unpacked", name);
        let path = library_dir.join(folder_name);
        results.insert(name, path.exists());
    }

    Ok(results)
}

#[tauri::command]
fn check_startup_intent(state: State<'_, StartupState>) -> Option<String> {
    let mut pending = state.pending_nxm.lock().unwrap();
    // Return the link and clear it so it doesn't trigger twice
    pending.take()
}

#[tauri::command]
fn is_app_installed(_app: AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        // 1. Get the path of the currently running executable
        let current_exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return false,
        };

        // 2. Get the folder containing the executable
        if let Some(parent_dir) = current_exe.parent() {
            // 3. Check if "Uninstall.exe" exists in this folder
            let uninstaller = parent_dir.join("Uninstall.exe");

            if uninstaller.exists() {
                return true; // It's an installed version
            }
        }

        // No uninstaller found? Must be Portable.
        return false;
    }

    // For Linux (AppImage), updates work fine in "portable" mode
    #[cfg(target_os = "linux")]
    return true;

    // Fallback for other OS
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return true;
}

/// Configure environment for Steam Deck compatibility
fn configure_steam_deck_environment() {
    // Apply WebKit network fixes for all Linux systems
    #[cfg(target_os = "linux")]
    {
        // WebKit network configuration for better compatibility
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        // Allow network access and disable strict SSL verification for GitHub
        std::env::set_var("WEBKIT_DISABLE_TLS_VERIFICATION", "1");
        std::env::set_var("G_TLS_GNUTLS_PRIORITY", "NORMAL:%COMPAT");

        println!("[INFO] Linux WebKit network compatibility configured");
    }

    // Detect Steam Deck environment
    let is_steam_deck = is_running_on_steam_deck();

    if is_steam_deck {
        println!("[INFO] Steam Deck detected, applying compatibility settings...");

        // Force software rendering as fallback for problematic EGL drivers
        if std::env::var("LIBGL_ALWAYS_SOFTWARE").is_err() {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }

        // Disable hardware acceleration for WebKit if needed
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }

        // Fix for EGL display issues
        if std::env::var("EGL_PLATFORM").is_err() {
            std::env::set_var("EGL_PLATFORM", "x11");
        }

        // Disable ATK bridge to reduce warnings
        std::env::set_var("NO_AT_BRIDGE", "1");

        // Force X11 backend for compatibility
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }

        println!("[INFO] Steam Deck compatibility environment configured");
    }
}

/// Check if the application is running on Steam Deck
fn is_running_on_steam_deck() -> bool {
    std::env::var("STEAM_DECK")
        .map(|v| v == "1")
        .unwrap_or(false) ||
        std::env::var("SteamDeck")
        .map(|v| v == "1")
        .unwrap_or(false) ||
        std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name")
        .map(|s| s.trim().contains("Jupiter") || s.trim().contains("Steam Deck"))
        .unwrap_or(false)
}

// --- MAIN FUNCTION ---
fn main() {
    // Force X11 backend on Linux to avoid Wayland rendering issues with WebKitGTK
    // Skip this for Flatpak - the GNOME runtime's WebKitGTK handles Wayland correctly
    #[cfg(target_os = "linux")]
    {
        let is_flatpak = std::env::var("FLATPAK_ID").is_ok()
            || std::env::var("SINGULARITY_FLATPAK").is_ok();

        if !is_flatpak && std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
            println!("[INFO] Forced GDK_BACKEND=x11 for WebKitGTK compatibility");
        } else if is_flatpak {
            println!("[INFO] Running in Flatpak - using native display backend");
        }
    }

    // Steam Deck compatibility fixes
    configure_steam_deck_environment();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(StartupState {
            pending_nxm: Mutex::new(None),
        })
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

            // --- 1. ROTATE LOGS ON STARTUP ---
            rotate_logs(app_handle);

            log_internal(app_handle, "INFO", "=== SINGULARITY MANAGER STARTUP ===");

            let args: Vec<String> = std::env::args().collect();

            // 2. Capture Cold Start Link
            if let Some(nxm_link) = args.iter().find(|arg| arg.starts_with("nxm://")) {
                log_internal(
                    app_handle,
                    "INFO",
                    &format!("Startup Argument detected (NXM Link): {}", nxm_link),
                );
                if let Some(state) = app.try_state::<StartupState>() {
                    *state.pending_nxm.lock().unwrap() = Some(nxm_link.clone());
                }
            }

            let window = app.get_webview_window("main").unwrap();

            // Steam Deck specific window configuration
            let is_steam_deck = is_running_on_steam_deck();
            if is_steam_deck {
                log_internal(app_handle, "INFO", "Steam Deck detected - applying window configuration");

                // For Steam Deck, ensure window decorations are enabled and transparency is off
                // This helps with visibility issues on the Steam Deck's compositor
                if let Err(e) = window.set_decorations(true) {
                    log_internal(app_handle, "WARN", &format!("Could not enable decorations on Steam Deck: {}", e));
                }
            }

            // --- UPDATED STATE LOADING ---
            if let Ok(state_path) = get_state_file_path(app_handle) {
                if let Ok(state_json) = fs::read_to_string(&state_path) {
                    if let Ok(state) = serde_json::from_str::<WindowState>(&state_json) {
                        log_internal(
                            app_handle,
                            "INFO",
                            &format!(
                                "Attempting to restore Window: X={}, Y={}, Max={}",
                                state.x, state.y, state.maximized
                            ),
                        );

                        // Prevent loading off-screen coordinates
                        if state.x > -10000 && state.y > -10000 {
                            window
                                .set_position(PhysicalPosition::new(state.x, state.y))
                                .unwrap();
                            if state.maximized {
                                window.maximize().unwrap();
                            }
                        } else {
                            log_internal(
                                app_handle,
                                "WARN",
                                "Saved coordinates were invalid (off-screen). Resetting to center.",
                            );
                        }
                    }
                }
            }
            // -----------------------------

            window.show().unwrap();
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::CloseRequested { .. } => {
                let app_handle = window.app_handle();
                let is_minimized = window.is_minimized().unwrap_or(false);
                let is_maximized = window.is_maximized().unwrap_or(false);

                if !is_minimized {
                    if !is_maximized {
                        if let Ok(position) = window.outer_position() {
                            let state = WindowState {
                                x: position.x,
                                y: position.y,
                                maximized: false,
                            };
                            if let Ok(state_json) = serde_json::to_string(&state) {
                                if let Ok(path) = get_state_file_path(app_handle) {
                                    let _ = fs::write(path, state_json);
                                }
                            }
                        }
                    } else {
                        if let Ok(path) = get_state_file_path(app_handle) {
                            if let Ok(state_json) = fs::read_to_string(&path) {
                                if let Ok(mut state) =
                                    serde_json::from_str::<WindowState>(&state_json)
                                {
                                    state.maximized = true;
                                    if let Ok(new_state_json) = serde_json::to_string(&state) {
                                        let _ = fs::write(path, new_state_json);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            check_startup_intent,
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
            get_staging_contents,
            run_legacy_migration,
            write_to_log,
            set_library_path,
            get_library_path,
            delete_library_folder,
            check_library_existence,
            rename_mod_folder,
            is_app_installed,
            http_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
