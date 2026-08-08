// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Application entry point for Niko Buddy desktop client.

// Hide the console window in release builds on Windows.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    niko_buddy_lib::run();
}
