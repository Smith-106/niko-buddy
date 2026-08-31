// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! 架构-1（审计 30 §6 链路级断点 1）：`{project}/.novel/status.json` 独立监听器。
//!
//! 背景：status.json 是会话状态唯一真源（HARD-1），但 `project-file-sync`
//! 只监视源/wiki 文件，外部/跨进程写入 status.json 不可感知，需重开项目或手动
//! 刷新。本模块提供独立 notify watcher：
//!   - 只盯 `{project}/.novel/status.json` 单文件（NonRecursive）。
//!   - 500ms 去抖（文件系统事件合并窗口）。
//!   - 内容 diff：与上次已发出的内容相同则不再 emit，防止「前端监听到事件 → 写回
//!     相同内容 → 事件再触发」的自写循环（防自写循环要求）。
//!   - 变更时向前端 emit `novel-status-changed` `{projectId, mtime}`。
//!
//! 生命周期：`open_project` 时启动（先停旧后启新，天然覆盖切项目）；进程退出
//! （RunEvent::Exit）停止。`.novel` 目录尚不存在（惰性生成）时退化为监视项目根
//! 目录，待 `.novel` 出现后动态补挂 watch。
//!
//! `projectId` 语义：后端在 open_project 时只掌握项目路径（前端 projectId 是
//! 其 `.qmai/project.json` 里生成的 UUID，属前端域），故事件里的 `projectId`
//! 取归一化（`\`→`/`）后的项目路径；前端订阅方可经 project-registry 反查真实
//! 项目 id 后过滤。

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// `novel-status-changed` 事件名（前端订阅契约）。
pub const EVENT_STATUS_CHANGED: &str = "novel-status-changed";

/// status.json 文件名。
const STATUS_FILE_NAME: &str = "status.json";
/// `.novel` 目录名。
const NOVEL_DIR_NAME: &str = ".novel";
/// 去抖窗口（毫秒）：文件系统事件合并期。
const DEBOUNCE_MS: Duration = Duration::from_millis(500);

/// `novel-status-changed` 事件负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelStatusChangedPayload {
    /// 项目路径（归一化 `\`→`/`；前端可经 project-registry 反查真实 id）。
    pub project_id: String,
    /// status.json 修改时间（epoch 毫秒）。
    pub mtime: i64,
}

/// status.json 监听器管理状态（由 `lib.rs` setup 经 `app.manage` 注册）。
///
/// `inner` 持有当前生效 watcher 的共享句柄；置 `None` / 替换即停止旧监听
/// （drop watcher → 事件回调链断开 → 工作线程收到 Disconnected 退出）。
#[derive(Default)]
pub struct StatusWatcherState {
    inner: Mutex<Option<Arc<Mutex<Option<RecommendedWatcher>>>>>,
}

/// 启动（或切换）`{project}/.novel/status.json` 监听。已存在的旧监听先停止。
/// 启动失败仅返回 Err，由调用方决定日志降级（不阻断项目打开）。
pub fn start_status_watcher(app: &AppHandle, project_path: &str) -> Result<(), String> {
    let project = Path::new(project_path);
    let novel_dir = project.join(NOVEL_DIR_NAME);
    let status_path = novel_dir.join(STATUS_FILE_NAME);

    let state: tauri::State<StatusWatcherState> = app.state();
    // 停掉旧监听（切项目场景：旧 watcher 先释放，新 worker 启动）。
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "status watcher state poisoned")?;
    *inner = None;
    drop(inner);

    let (tx, rx) = mpsc::channel::<PathBuf>();
    let app_for_worker = app.clone();
    let novel_for_worker = novel_dir.clone();
    let status_for_worker = status_path.clone();
    let holder: Arc<Mutex<Option<RecommendedWatcher>>> = Arc::new(Mutex::new(None));
    let holder_weak = Arc::downgrade(&holder);

    // ── 工作线程：500ms 去抖 + 内容 diff 防自写循环 ──
    std::thread::spawn(move || {
        let mut dirty = false;
        let mut last_content: Option<Vec<u8>> = None;
        loop {
            match rx.recv_timeout(DEBOUNCE_MS) {
                Ok(path) => {
                    // `.novel` 目录创建事件：动态补挂 NonRecursive watch（惰性生成场景）。
                    if path == novel_for_worker {
                        if let Some(holder) = holder_weak.upgrade() {
                            if let Ok(mut guard) = holder.lock() {
                                if let Some(w) = guard.as_mut() {
                                    let _ = w.watch(&novel_for_worker, RecursiveMode::NonRecursive);
                                }
                            }
                        }
                    }
                    dirty = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if dirty {
                        dirty = false;
                        emit_if_changed(
                            &app_for_worker,
                            &novel_for_worker,
                            &status_for_worker,
                            &mut last_content,
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    // ── notify 事件回调：只放行 status.json 与 `.novel` 目录事件 ──
    let tx_for_handler = tx.clone();
    let status_for_handler = status_path.clone();
    let novel_for_handler = novel_dir.clone();
    let watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            let Ok(event) = result else {
                log::warn!("[status-watcher] notify error: {result:?}");
                return;
            };
            let relevant = event.paths.iter().any(|p| {
                *p == status_for_handler || *p == novel_for_handler
            });
            if !relevant {
                return;
            }
            for p in event.paths {
                let _ = tx_for_handler.send(p);
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create status watcher: {e}"))?;

    {
        let mut guard = holder.lock().map_err(|_| "status watcher holder poisoned")?;
        *guard = Some(watcher);
    }

    // ── watch 路径：`.novel` 存在则单文件目录 NonRecursive；根目录 NonRecursive
    //    兜底捕获 `.novel` 惰性创建（worker 动态补挂）。 ──
    let watch_root_result = {
        let mut guard = holder.lock().map_err(|_| "status watcher holder poisoned")?;
        let w = guard.as_mut().ok_or("status watcher not initialized")?;
        if novel_dir.is_dir() {
            w.watch(&novel_dir, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Failed to watch '{}': {e}", novel_dir.display()))?;
        }
        w.watch(project, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch '{}': {e}", project.display()))
    };
    watch_root_result?;

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "status watcher state poisoned")?;
    *inner = Some(holder);
    Ok(())
}

/// 停止当前 status.json 监听（App 退出 / 关闭项目时调用）。
pub fn stop_status_watcher(app: &AppHandle) {
    let state: tauri::State<StatusWatcherState> = app.state();
    let Ok(mut inner) = state.inner.lock() else {
        log::warn!("[status-watcher] stop: state poisoned");
        return;
    };
    *inner = None;
}

/// 去抖后处理：读 status.json，内容与上次已发出的一致则不 emit（防自写循环），
/// 否则 emit `novel-status-changed` {projectId, mtime}。
fn emit_if_changed(
    app: &AppHandle,
    novel_dir: &Path,
    status_path: &Path,
    last_content: &mut Option<Vec<u8>>,
) {
    let current = match std::fs::read(status_path) {
        Ok(bytes) => bytes,
        Err(_) => return, // 文件暂缺（删除/未生成）→ 不发事件。
    };
    if last_content.as_deref() == Some(current.as_slice()) {
        return;
    }
    let mtime = std::fs::metadata(status_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let project_id = novel_dir
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let _ = app.emit(
        EVENT_STATUS_CHANGED,
        NovelStatusChangedPayload { project_id, mtime },
    );
    *last_content = Some(current);
}
