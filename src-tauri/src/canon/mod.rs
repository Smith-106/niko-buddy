// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 域（T11/T12/T13）——结构化时态/认知记忆存储、混合检索、
//! 项目备份/恢复导出与数据面 IPC 命令。
//! 由 `lib.rs` 注册 `mod canon;`（P2-5 Rust 分域移动）。

pub mod commands;
pub mod export;
pub mod search;
pub mod store;
pub mod types;
