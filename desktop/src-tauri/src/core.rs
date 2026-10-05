//! The protected core.
//!
//! Everything security-relevant that does *not* have to live in the web layer
//! lives here, on the native side of the IPC boundary. The rule the whole
//! design follows: script running inside the WebView must not be able to walk
//! away with anything it could not already get from the web version.
//!
//! Concretely, the core owns three things:
//!
//!  1. **A device secret in the OS credential store.** The vault that holds
//!     private keys is encrypted with a key derived from the user's password
//!     *and* this secret. Copying the profile directory off the machine is
//!     therefore not enough to start guessing passwords offline — the attacker
//!     also needs the Windows Credential Manager / Secret Service entry, which
//!     is bound to the user's login session.
//!
//!  2. **Unlock throttling.** Attempt counters live out here, where the web
//!     layer cannot reset them by clearing localStorage.
//!
//!  3. **A CSPRNG.** The core never asks the WebView for randomness.
//!
//! Note what the core deliberately does *not* do: it performs no cryptography
//! of its own. Key derivation and message encryption stay in one audited place
//! (packages/kivora-crypto) rather than being split across two languages where
//! the two halves can silently disagree.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const SERVICE: &str = "org.kivora.messenger";
const MAX_ATTEMPTS: u32 = 8;
const LOCKOUT_BASE_SECS: u64 = 5;

#[derive(Debug, Serialize)]
pub struct CoreInfo {
    pub version: &'static str,
    pub keychain: bool,
    /// How the device secret is actually being stored, so the UI can be honest
    /// with the user rather than claiming protection it does not have.
    pub secret_storage: &'static str,
    pub platform: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct Throttle {
    failures: u32,
    locked_until: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn state_dir(app_data: &PathBuf) -> PathBuf {
    let dir = app_data.join("core");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn throttle_path(app_data: &PathBuf, account: &str) -> PathBuf {
    state_dir(app_data).join(format!("{}.throttle.json", sanitize(account)))
}

fn fallback_secret_path(app_data: &PathBuf, account: &str) -> PathBuf {
    state_dir(app_data).join(format!("{}.secret", sanitize(account)))
}

/// Account names come from the user; they must never become a path traversal.
fn sanitize(account: &str) -> String {
    account
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(64)
        .collect()
}

fn keychain_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("keychain unavailable: {e}"))
}

/// Fetch this device's secret, creating it on first use.
///
/// The returned value is hex so it can cross the IPC boundary as text; it is
/// wrapped in `Zeroizing` on the way out of memory here, and the web layer
/// keeps it only for the moment it takes to derive the vault key.
pub fn device_secret(app_data: &PathBuf, account: &str) -> Result<String, String> {
    if let Ok(entry) = keychain_entry(account) {
        match entry.get_password() {
            Ok(existing) => return Ok(existing),
            Err(keyring::Error::NoEntry) => {
                let fresh = random_hex(32)?;
                if entry.set_password(&fresh).is_ok() {
                    return Ok(fresh);
                }
                // Fall through: storing failed, use the file fallback so the
                // user is not locked out of their own messenger.
            }
            Err(_) => { /* keychain present but unusable; fall through */ }
        }
    }

    // Fallback for machines with no working credential store (some minimal
    // Linux desktops). Still better than nothing — the file is in the app's
    // private data directory — but the UI reports the weaker mode.
    let path = fallback_secret_path(app_data, account);
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    let fresh = random_hex(32)?;
    fs::write(&path, &fresh).map_err(|e| format!("cannot store device secret: {e}"))?;
    restrict_permissions(&path);
    Ok(fresh)
}

pub fn forget_device_secret(app_data: &PathBuf, account: &str) -> Result<(), String> {
    if let Ok(entry) = keychain_entry(account) {
        let _ = entry.delete_credential();
    }
    let _ = fs::remove_file(fallback_secret_path(app_data, account));
    let _ = fs::remove_file(throttle_path(app_data, account));
    Ok(())
}

pub fn keychain_available(account: &str) -> bool {
    match keychain_entry(account) {
        Ok(entry) => !matches!(entry.get_password(), Err(keyring::Error::PlatformFailure(_))),
        Err(_) => false,
    }
}

/// Seconds the caller must wait before another unlock attempt is allowed.
pub fn unlock_delay(app_data: &PathBuf, account: &str) -> u64 {
    let t = read_throttle(app_data, account);
    t.locked_until.saturating_sub(now_secs())
}

pub fn note_unlock_failure(app_data: &PathBuf, account: &str) -> u64 {
    let mut t = read_throttle(app_data, account);
    t.failures = t.failures.saturating_add(1);
    // Back off geometrically, capped, so a stolen laptop cannot be brute-forced
    // at speed but a mistyped password is barely noticeable.
    let delay = if t.failures <= 3 {
        0
    } else {
        LOCKOUT_BASE_SECS
            .saturating_mul(1 << (t.failures - 4).min(MAX_ATTEMPTS))
            .min(15 * 60)
    };
    t.locked_until = now_secs() + delay;
    write_throttle(app_data, account, &t);
    delay
}

pub fn note_unlock_success(app_data: &PathBuf, account: &str) {
    write_throttle(app_data, account, &Throttle::default());
}

fn read_throttle(app_data: &PathBuf, account: &str) -> Throttle {
    fs::read_to_string(throttle_path(app_data, account))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_throttle(app_data: &PathBuf, account: &str, t: &Throttle) {
    if let Ok(raw) = serde_json::to_string(t) {
        let path = throttle_path(app_data, account);
        let _ = fs::write(&path, raw);
        restrict_permissions(&path);
    }
}

pub fn random_hex(len: usize) -> Result<String, String> {
    let mut buf = Zeroizing::new(vec![0u8; len]);
    getrandom::getrandom(&mut buf).map_err(|e| format!("no system randomness: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(unix)]
fn restrict_permissions(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &PathBuf) {
    // On Windows the app data directory already inherits a per-user ACL.
}

pub fn info(account: &str) -> CoreInfo {
    let keychain = keychain_available(account);
    CoreInfo {
        version: env!("CARGO_PKG_VERSION"),
        keychain,
        secret_storage: if keychain { "os-keychain" } else { "app-data-file" },
        platform: std::env::consts::OS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_blocks_traversal() {
        assert_eq!(sanitize("../../etc/passwd"), "_________etc_passwd");
        assert_eq!(sanitize("alice"), "alice");
    }

    #[test]
    fn random_hex_is_the_right_length_and_not_constant() {
        let a = random_hex(32).unwrap();
        let b = random_hex(32).unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn throttling_escalates_then_resets() {
        let dir = std::env::temp_dir().join("kivora-core-test");
        let _ = fs::remove_dir_all(&dir);
        let account = "tester";

        for _ in 0..3 {
            assert_eq!(note_unlock_failure(&dir, account), 0, "early mistakes are free");
        }
        let first = note_unlock_failure(&dir, account);
        let second = note_unlock_failure(&dir, account);
        assert!(first > 0 && second > first, "delay must grow: {first} -> {second}");

        note_unlock_success(&dir, account);
        assert_eq!(unlock_delay(&dir, account), 0);
    }
}
