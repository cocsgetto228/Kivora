// Prevents a console window from flashing up on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kivora_desktop_lib::run()
}
