// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! 前端诊断日志桥（审计 30 项 ②-1）。
//!
//! TS 侧 `lib/reasoning-replay-debug.ts` 与 `lib/agent/runner.ts` 在每 agent
//! 工具轮次 `invoke("log_diagnostic")`，把 reasoning 回放日志桥接进 Rust 侧
//! 日志文件。用 `log::debug!` 而非 `println!`/`log::info!`：默认 release 构建
//! 的 debug 级被过滤，避免「每个 agent 轮次写一条」的刷屏问题（②-1 防刷屏
//! 要求；排查时打开 debug 级日志即可恢复完整桥接）。

/// 桥接前端诊断消息到 tauri-plugin-log（debug 级，防刷屏）。
#[tauri::command]
pub fn log_diagnostic(message: String) {
    log::debug!("[diagnostic] {message}");
}
