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
}

#[derive(Deserialize, Debug)]
struct ProfileSaveRequest {
    filename: String,
    mod_id: Option<String>,
    file_id: Option<String>,
    version: Option<String>,
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

const CLEAN_MXML_TEMPLATE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Data template="GcModSettings">
  <Property name="DisableAllMods" value="false" />
  <Property name="Data">
  </Property>
</Data>"#;

// --- HELPER FUNCTIONS ---
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

fn get_state_file_path() -> PathBuf {
    let exe_path = env::current_exe().expect("Failed to find executable path");
    let exe_dir = exe_path
        .parent()
        .expect("Failed to get parent directory of executable");
    exe_dir.join("window-state.json")
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

fn extract_archive_to_temp(archive_path: &Path, mods_path: &Path) -> Result<PathBuf, String> {
    let temp_extract_path =
        mods_path.join(format!("temp_extract_{}", Utc::now().timestamp_millis()));
    fs::create_dir_all(&temp_extract_path)
        .map_err(|e| format!("Could not create temporary extraction directory: {}", e))?;

    let extension = archive_path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();
    match extension.as_str() {
        "zip" => {
            let file = fs::File::open(archive_path).map_err(|e| {
                format!(
                    "Failed to open zip file '{}': {}",
                    archive_path.display(),
                    e
                )
            })?;
            let mut archive = ZipArchive::new(file).map_err(|e| {
                format!(
                    "Failed to read zip archive '{}': {}",
                    archive_path.display(),
                    e
                )
            })?;
            archive.extract(&temp_extract_path).map_err(|e| {
                format!(
                    "Failed to extract zip file '{}': {}",
                    archive_path.display(),
                    e
                )
            })?;
        }
        "rar" => {
            let mut archive = unrar::Archive::new(archive_path)
                .open_for_processing()
                .map_err(|e| {
                    format!(
                        "Failed to open RAR archive '{}': {:?}",
                        archive_path.display(),
                        e
                    )
                })?;
            while let Ok(Some(header)) = archive.read_header() {
                archive = header.extract_to(&temp_extract_path).map_err(|e| {
                    format!(
                        "Failed to extract from RAR archive '{}': {:?}",
                        archive_path.display(),
                        e
                    )
                })?;
            }
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
fn install_mod_from_archive(archive_path_str: String) -> Result<InstallationAnalysis, String> {
    let mut archive_path = PathBuf::from(&archive_path_str);
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("No parent dir")?;
    let downloads_dir = exe_dir.join("downloads");
    
    // Ensure downloads directory exists
    if !downloads_dir.exists() {
        fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?;
    }

    // 1. CHECK: Is this file already in the downloads folder?
    // Compare canonical paths to be sure.
    let in_downloads = if let (Ok(p1), Ok(p2)) = (archive_path.canonicalize(), downloads_dir.canonicalize()) {
        p1.starts_with(p2)
    } else {
        false
    };

    // 2. IF NOT: Copy it there.
    if !in_downloads {
        let file_name = archive_path.file_name().ok_or("Invalid filename")?;
        let target_path = downloads_dir.join(file_name);
        
        // If it exists, it might be overwriting an old manual drop, which is fine.
        fs::copy(&archive_path, &target_path).map_err(|e| format!("Failed to copy to downloads: {}", e))?;
        
        archive_path = target_path;
    }
    let game_path = find_game_path().ok_or_else(|| "Could not find the game installation path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;

    let mut installed_mods_by_id: HashMap<String, String> = HashMap::new();
    if let Ok(entries) = fs::read_dir(&mods_path) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                if let Some(info) = read_mod_info(&path) {
                    if let (Some(mod_id), Some(folder_name)) = (info.mod_id, path.file_name().and_then(|n| n.to_str())) {
                        installed_mods_by_id.insert(mod_id, folder_name.to_string());
                    }
                }
            }
        }
    }

    let temp_extract_path = extract_archive_to_temp(&archive_path, &mods_path)?;

    let folder_entries: Vec<_> = fs::read_dir(&temp_extract_path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect();

    if folder_entries.is_empty() {
        let path_for_cleanup = temp_extract_path.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            if fs::remove_dir_all(&path_for_cleanup).is_ok() {
                println!("Cleaned up empty temp dir: {}", path_for_cleanup.display());
            }
        });
        return Ok(InstallationAnalysis {
            successes: vec![],
            conflicts: vec![],
            messy_archive_path: Some(temp_extract_path.to_string_lossy().into_owned()),
            active_archive_path: Some(archive_path.to_string_lossy().into_owned()),
        });
    }

    let staging_path = mods_path.join(format!("temp_staging_{}", Utc::now().timestamp_millis()));
    let mut successes = Vec::new();
    let mut conflicts = Vec::new();

    for entry in folder_entries {
        let new_mod_path = entry.path();
        let new_mod_name = new_mod_path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let mut conflict_found = false;
        if let Some(info) = read_mod_info(&new_mod_path) {
            if let Some(mod_id) = info.mod_id {
                if let Some(old_folder_name) = installed_mods_by_id.get(&mod_id) {
                    if !staging_path.exists() {
                        fs::create_dir_all(&staging_path).map_err(|e| e.to_string())?;
                    }
                    let staged_mod_path = staging_path.join(&new_mod_name);
                    fs::rename(&new_mod_path, &staged_mod_path).map_err(|e| e.to_string())?;

                    conflicts.push(ModConflictInfo {
                        new_mod_name: new_mod_name.clone(),
                        temp_path: staged_mod_path.to_string_lossy().into_owned(),
                        old_mod_folder_name: old_folder_name.clone(),
                    });
                    conflict_found = true;
                }
            }
        }

        if !conflict_found {
            let final_dest_path = mods_path.join(&new_mod_name);
            if final_dest_path.exists() {
                if !staging_path.exists() {
                    fs::create_dir_all(&staging_path).map_err(|e| e.to_string())?;
                }
                let staged_mod_path = staging_path.join(&new_mod_name);
                fs::rename(&new_mod_path, &staged_mod_path).map_err(|e| e.to_string())?;

                conflicts.push(ModConflictInfo {
                    new_mod_name: new_mod_name.clone(),
                    temp_path: staged_mod_path.to_string_lossy().into_owned(),
                    old_mod_folder_name: new_mod_name.clone(),
                });
            } else {
                fs::rename(&new_mod_path, &final_dest_path).map_err(|e| e.to_string())?;
                successes.push(ModInstallInfo {
                    name: new_mod_name,
                    temp_path: final_dest_path.to_string_lossy().into_owned(),
                });
            }
        }
    }

    let path_for_cleanup = temp_extract_path.clone();
    thread::spawn(move || { thread::sleep(Duration::from_secs(3)); fs::remove_dir_all(&path_for_cleanup).ok(); });

    Ok(InstallationAnalysis {
        successes,
        conflicts,
        messy_archive_path: None,
        active_archive_path: Some(archive_path.to_string_lossy().into_owned()),
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
        fs::rename(&temp_mod_path, &final_new_mod_path)
            .map_err(|e| format!("Failed to move new mod into place: {}", e))?;
    } else {
        fs::remove_dir_all(&temp_mod_path)
            .map_err(|e| format!("Failed to cleanup temp mod folder: {}", e))?;
    }

    if let Some(parent) = temp_mod_path.parent() {
        if parent.exists() && parent.read_dir().map_or(false, |mut i| i.next().is_none()) {
            fs::remove_dir(parent).ok();
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
        obj.insert("modId".to_string(), Value::String(mod_id));
        obj.insert("fileId".to_string(), Value::String(file_id));
        obj.insert("version".to_string(), Value::String(version));
    } else {
        return Err("mod_info.json is not a valid JSON object.".to_string());
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
async fn download_mod_archive(download_url: String, file_name: String) -> Result<DownloadResult, String> {
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or_else(|| "Could not get parent directory of executable.".to_string())?;
    
    let downloads_path = exe_dir.join("downloads");
    fs::create_dir_all(&downloads_path).map_err(|e| format!("Failed to create downloads directory: {}", e))?;
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
fn clear_downloads_folder() -> Result<(), String> {
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or_else(|| "Could not get parent directory of executable.".to_string())?;
    let downloads_path = exe_dir.join("downloads");

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

fn get_profiles_dir() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("No parent dir")?;
    let profiles_dir = exe_dir.join("profiles");
    if !profiles_dir.exists() {
        fs::create_dir_all(&profiles_dir).map_err(|e| e.to_string())?;
    }
    Ok(profiles_dir)
}

#[tauri::command]
fn list_profiles() -> Result<Vec<String>, String> {
    let dir = get_profiles_dir()?;
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
fn save_active_profile(profile_name: String, mods: Vec<ProfileSaveRequest>) -> Result<(), String> {
    let dir = get_profiles_dir()?;
    let json_path = dir.join(format!("{}.json", profile_name));
    let mxml_backup_path = dir.join(format!("{}.mxml", profile_name));
    
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("No parent dir")?;
    let downloads_dir = exe_dir.join("downloads");

    let mut profile_entries = Vec::new();

    for mod_req in mods {
        let path = downloads_dir.join(&mod_req.filename);
        let hash = if path.exists() {
            calculate_file_hash(&path).unwrap_or("HASH_ERROR".to_string())
        } else {
            "MISSING_FILE".to_string()
        };

        profile_entries.push(ProfileModEntry {
            filename: mod_req.filename,
            hash: hash,
            mod_id: mod_req.mod_id,
            file_id: mod_req.file_id,
            version: mod_req.version,
        });
    }

    let data = ModProfileData {
        name: profile_name.clone(),
        mods: profile_entries,
    };
    
    let json_str = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&json_path, json_str).map_err(|e| e.to_string())?;

    if let Some(game_path) = find_game_path() {
        let current_mxml = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");
        if current_mxml.exists() {
            fs::copy(current_mxml, mxml_backup_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn apply_profile(app: tauri::AppHandle, profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir()?;
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

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("No parent dir")?;
    let downloads_dir = exe_dir.join("downloads");

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
                     for fs_entry in fs::read_dir(&temp_path).map_err(|e| e.to_string())? {
                        let fs_entry = fs_entry.map_err(|e| e.to_string())?;
                        let dest = mods_dir.join(fs_entry.file_name());
                        
                        if dest.exists() { fs::remove_dir_all(&dest).ok(); }
                        
                        fs::rename(fs_entry.path(), &dest).map_err(|e| e.to_string())?;

                        if let Some(mid) = &entry.mod_id {
                            let info_path = dest.join("mod_info.json");
                            let info_json = serde_json::json!({
                                "id": mid,
                                "modId": mid,
                                "fileId": entry.file_id,
                                "version": entry.version
                            });
                            if let Ok(json_str) = serde_json::to_string_pretty(&info_json) {
                                fs::write(info_path, json_str).ok();
                            }
                        }
                     }
                     fs::remove_dir_all(temp_path).ok();
                },
                Err(e) => println!("Failed to extract {}: {}", entry.filename, e)
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_profile(profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir()?;
    let json_path = dir.join(format!("{}.json", profile_name));
    let mxml_path = dir.join(format!("{}.mxml", profile_name));
    if json_path.exists() { fs::remove_file(json_path).map_err(|e| e.to_string())?; }
    if mxml_path.exists() { fs::remove_file(mxml_path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn rename_profile(old_name: String, new_name: String) -> Result<(), String> {
    let dir = get_profiles_dir()?;
    let old_json = dir.join(format!("{}.json", old_name));
    let old_mxml = dir.join(format!("{}.mxml", old_name));
    let new_json = dir.join(format!("{}.json", new_name));
    let new_mxml = dir.join(format!("{}.mxml", new_name));
    
    if old_json.exists() { fs::rename(old_json, new_json).map_err(|e| e.to_string())?; }
    if old_mxml.exists() { fs::rename(old_mxml, new_mxml).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn create_empty_profile(profile_name: String) -> Result<(), String> {
    let dir = get_profiles_dir()?;
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
fn get_profile_mod_list(profile_name: String) -> Result<Vec<String>, String> {
    let dir = get_profiles_dir()?;
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
fn copy_profile(source_name: String, new_name: String) -> Result<(), String> {
    let dir = get_profiles_dir()?;
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
            let state_file_path = get_state_file_path();
            if let Ok(state_json) = fs::read_to_string(state_file_path) {
                if let Ok(state) = serde_json::from_str::<WindowState>(&state_json) {
                    window
                        .set_position(PhysicalPosition::new(state.x, state.y))
                        .unwrap();

                    if state.maximized {
                        window.maximize().unwrap();
                    }
                }
            }
            window.show().unwrap();
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::CloseRequested { .. } => {
                    let is_maximized = window.is_maximized().unwrap_or(false);

                    if !is_maximized {
                        let position = window.outer_position().unwrap();
                        let state = WindowState {
                            x: position.x,
                            y: position.y,
                            maximized: false,
                        };
                        if let Ok(state_json) = serde_json::to_string(&state) {
                            fs::write(get_state_file_path(), state_json).ok();
                        }
                    } else {
                        let state_file_path = get_state_file_path();
                        if let Ok(state_json) = fs::read_to_string(&state_file_path) {
                            if let Ok(mut state) = serde_json::from_str::<WindowState>(&state_json) {
                                state.maximized = true;
                                if let Ok(new_state_json) = serde_json::to_string(&state) {
                                    fs::write(state_file_path, new_state_json).ok();
                                }
                            }
                        }
                    }
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
            logout_nexus
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}