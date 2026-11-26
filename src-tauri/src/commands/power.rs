// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Wake-lock commands exposed via Tauri IPC.
//!
//! On Windows, prevents the system from entering sleep while a long-running
//! generation/review task is active. The frontend calls `acquire_wake_lock`
//! when a long task starts and `release_wake_lock` when it finishes.
//!
//! Implementation uses `SetThreadExecutionState` (thread-local, no kernel
//! handle to leak). On non-Windows targets these are no-ops that return
//! `false` so callers know the guard is inert (Niko Buddy is Windows-only
//! today, but keeping a graceful fallback avoids a hard failure if the app
//! is ever run elsewhere).

#[cfg(target_os = "macos")]
use std::sync::Mutex;

/// Windows 专用常驻 OS 线程唤醒锁（R2-S10）：
/// `SetThreadExecutionState` 为线程局部 API，若直接在 Tokio async worker 上调用，
/// acquire 与 release 落在不同 OS 线程会导致工作线程永久阻止系统休眠。
/// 此模块在单一常驻 OS 线程 `nb-wake-lock` 内维护 `ref_count` 并串行调用 Win32 API。
#[cfg(target_os = "windows")]
mod win_wake {
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::thread;

    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    enum WakeCmd {
        Acquire(mpsc::Sender<Result<bool, String>>),
        Release(mpsc::Sender<Result<bool, String>>),
        #[cfg(test)]
        DebugState(mpsc::Sender<(usize, thread::ThreadId)>),
    }

    static WAKE_TX: OnceLock<Result<Mutex<mpsc::Sender<WakeCmd>>, String>> = OnceLock::new();

    fn sender() -> Result<mpsc::Sender<WakeCmd>, String> {
        let init = WAKE_TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<WakeCmd>();
            thread::Builder::new()
                .name("nb-wake-lock".to_string())
                .spawn(move || {
                    let mut ref_count: usize = 0;
                    while let Ok(cmd) = rx.recv() {
                        match cmd {
                            WakeCmd::Acquire(reply) => {
                                let res = if ref_count == 0 {
                                    // SAFETY: SetThreadExecutionState is a thread-local kernel32
                                    // call executed exclusively on this dedicated OS thread with
                                    // compile-time constant flags.
                                    let prev = unsafe {
                                        SetThreadExecutionState(
                                            ES_CONTINUOUS
                                                | ES_SYSTEM_REQUIRED
                                                | ES_AWAYMODE_REQUIRED,
                                        )
                                    };
                                    if prev.0 != 0 {
                                        ref_count = 1;
                                        Ok(true)
                                    } else {
                                        Ok(false)
                                    }
                                } else {
                                    ref_count = ref_count.saturating_add(1);
                                    Ok(true)
                                };
                                let _ = reply.send(res);
                            }
                            WakeCmd::Release(reply) => {
                                let res = if ref_count == 0 {
                                    // 幂等释放：引用计数为 0 时仍返回 Ok(true)。
                                    Ok(true)
                                } else {
                                    ref_count -= 1;
                                    if ref_count == 0 {
                                        // SAFETY: ES_CONTINUOUS alone clears execution state flags
                                        // on this exact dedicated OS thread.
                                        let prev =
                                            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                                        Ok(prev.0 != 0)
                                    } else {
                                        Ok(true)
                                    }
                                };
                                let _ = reply.send(res);
                            }
                            #[cfg(test)]
                            WakeCmd::DebugState(reply) => {
                                let _ = reply.send((ref_count, thread::current().id()));
                            }
                        }
                    }
                })
                .map_err(|e| format!("failed to spawn nb-wake-lock thread: {e}"))?;
            Ok(Mutex::new(tx))
        });
        match init {
            Ok(mutex) => mutex
                .lock()
                .map(|g| g.clone())
                .map_err(|_| "nb-wake-lock sender mutex poisoned".to_string()),
            Err(e) => Err(e.clone()),
        }
    }

    pub(super) fn acquire() -> Result<bool, String> {
        let tx = sender()?;
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(WakeCmd::Acquire(reply_tx))
            .map_err(|_| "nb-wake-lock thread disconnected".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "nb-wake-lock thread dropped reply".to_string())?
    }

    pub(super) fn release() -> Result<bool, String> {
        let tx = sender()?;
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(WakeCmd::Release(reply_tx))
            .map_err(|_| "nb-wake-lock thread disconnected".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "nb-wake-lock thread dropped reply".to_string())?
    }

    #[cfg(test)]
    pub(super) fn debug_state() -> Result<(usize, thread::ThreadId), String> {
        let tx = sender()?;
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(WakeCmd::DebugState(reply_tx))
            .map_err(|_| "nb-wake-lock thread disconnected".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "nb-wake-lock thread dropped reply".to_string())
    }
}

/// 平台无关引用计数防休眠状态机（macOS `keepawake` 与跨平台单测共用）：
/// - `acquire`：`ref_count == 0` 时调用 `create()` 建立防休眠守卫并置 `ref_count = 1`；
///   若已持有守卫则仅递增 `ref_count`（`saturating_add(1)`），不重复申请系统句柄。
/// - `release`：`ref_count == 0` 时幂等返回 `true`；否则递减并在归零时释放 `guard`。
#[cfg(any(target_os = "macos", test))]
struct WakeRefCounter<G> {
    guard: Option<G>,
    ref_count: usize,
}

#[cfg(any(target_os = "macos", test))]
impl<G> WakeRefCounter<G> {
    const fn new() -> Self {
        Self {
            guard: None,
            ref_count: 0,
        }
    }

    fn acquire<E>(&mut self, create: impl FnOnce() -> Result<G, E>) -> Result<bool, E> {
        if self.ref_count == 0 {
            let guard = create()?;
            self.guard = Some(guard);
            self.ref_count = 1;
        } else {
            self.ref_count = self.ref_count.saturating_add(1);
        }
        Ok(true)
    }

    fn release(&mut self) -> bool {
        if self.ref_count == 0 {
            return true;
        }
        self.ref_count -= 1;
        if self.ref_count == 0 {
            self.guard = None;
        }
        true
    }

    #[cfg(test)]
    fn ref_count(&self) -> usize {
        self.ref_count
    }

    #[cfg(test)]
    fn is_active(&self) -> bool {
        self.guard.is_some()
    }
}

/// macOS 防休眠句柄与引用计数（keepawake crate；App Nap 节流防护，与 Windows 对称）。
#[cfg(target_os = "macos")]
static MACOS_WAKE_LOCK: Mutex<WakeRefCounter<keepawake::KeepAwake>> =
    Mutex::new(WakeRefCounter::new());

/// Acquire a wake lock so the OS will not sleep while a long task runs.
///
/// Returns `true` on Windows/macOS when the state was applied, `false` on
/// other targets (no-op).
#[tauri::command]
pub async fn acquire_wake_lock() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(win_wake::acquire)
            .await
            .map_err(|e| format!("wake-lock acquire join error: {e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        let mut state = MACOS_WAKE_LOCK
            .lock()
            .map_err(|_| "wake-lock mutex poisoned".to_string())?;
        state.acquire(|| {
            keepawake::Builder::default()
                .display(true)
                .idle(true)
                .sleep(false)
                .reason("Niko Buddy 正在执行长任务")
                .app_name("Niko Buddy")
                .app_reverse_domain("com.niko-buddy.app")
                .create()
                .map_err(|error| format!("无法启用写作防休眠：{error}"))
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(false)
    }
}

/// Release the wake lock, allowing the OS to sleep again.
///
/// Must be called once for every successful `acquire_wake_lock` to avoid
/// permanently keeping the machine awake.
#[tauri::command]
pub async fn release_wake_lock() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(win_wake::release)
            .await
            .map_err(|e| format!("wake-lock release join error: {e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        let mut state = MACOS_WAKE_LOCK
            .lock()
            .map_err(|_| "wake-lock mutex poisoned".to_string())?;
        Ok(state.release())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(false)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn wake_test_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    #[tokio::test]
    async fn acquire_then_release_roundtrip() {
        let _serial = wake_test_lock().lock().await;
        let got = acquire_wake_lock().await.unwrap();
        // On Windows CI we expect true; on non-Windows we accept false.
        assert!(got || cfg!(not(target_os = "windows")));
        let released = release_wake_lock().await.unwrap();
        assert!(released || cfg!(not(target_os = "windows")));
    }

    #[tokio::test]
    async fn release_is_idempotent() {
        let _serial = wake_test_lock().lock().await;
        let r1 = release_wake_lock().await.unwrap();
        let r2 = release_wake_lock().await.unwrap();
        assert!(r1 || cfg!(not(target_os = "windows")));
        assert!(r2 || cfg!(not(target_os = "windows")));
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_wake_lock_uses_single_os_thread_and_ref_count() {
        let _serial = wake_test_lock().lock().await;
        // 确保起点 ref_count 归零
        while win_wake::debug_state().unwrap().0 > 0 {
            release_wake_lock().await.unwrap();
        }
        let (_, tid_initial) = win_wake::debug_state().unwrap();

        // 跨多线程并发/嵌套 acquire，所有操作均应落在同一 nb-wake-lock OS 线程
        let h1 = tokio::spawn(acquire_wake_lock());
        let h2 = tokio::spawn(acquire_wake_lock());
        assert!(h1.await.unwrap().unwrap());
        assert!(h2.await.unwrap().unwrap());
        let (rc_after_two, tid_after_two) = win_wake::debug_state().unwrap();
        assert_eq!(rc_after_two, 2);
        assert_eq!(tid_initial, tid_after_two);

        // 释放一次 → ref_count 降为 1
        assert!(tokio::spawn(release_wake_lock()).await.unwrap().unwrap());
        let (rc_after_one_rel, tid_after_one_rel) = win_wake::debug_state().unwrap();
        assert_eq!(rc_after_one_rel, 1);
        assert_eq!(tid_initial, tid_after_one_rel);

        // 释放第二次 → ref_count 归零
        assert!(tokio::spawn(release_wake_lock()).await.unwrap().unwrap());
        let (rc_zero, tid_zero) = win_wake::debug_state().unwrap();
        assert_eq!(rc_zero, 0);
        assert_eq!(tid_initial, tid_zero);

        // 归零后再次释放保持幂等且返回 Ok(true)
        assert!(release_wake_lock().await.unwrap());
        assert_eq!(win_wake::debug_state().unwrap().0, 0);
    }

    #[test]
    fn wake_ref_counter_tracks_nested_acquires_and_idempotent_releases() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        struct DropTracker(Arc<AtomicUsize>);
        impl Drop for DropTracker {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let created = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut counter = WakeRefCounter::<DropTracker>::new();

        // 初始状态 release 幂等
        assert_eq!(counter.ref_count(), 0);
        assert!(!counter.is_active());
        assert!(counter.release());
        assert_eq!(dropped.load(Ordering::SeqCst), 0);

        // 首次创建失败不得递增计数
        let err = counter.acquire(|| Err::<DropTracker, _>("create failed"));
        assert!(err.is_err());
        assert_eq!(counter.ref_count(), 0);
        assert!(!counter.is_active());

        // 连续两次 acquire：仅创建 1 次 guard，引用计数为 2
        assert!(counter
            .acquire(|| {
                created.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(DropTracker(Arc::clone(&dropped)))
            })
            .unwrap());
        assert!(counter
            .acquire(|| {
                created.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(DropTracker(Arc::clone(&dropped)))
            })
            .unwrap());
        assert_eq!(counter.ref_count(), 2);
        assert!(counter.is_active());
        assert_eq!(created.load(Ordering::SeqCst), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);

        // 第 1 次 release：计数降至 1，守卫保持活跃未释放
        assert!(counter.release());
        assert_eq!(counter.ref_count(), 1);
        assert!(counter.is_active());
        assert_eq!(dropped.load(Ordering::SeqCst), 0);

        // 第 2 次 release：计数归零，守卫释放
        assert!(counter.release());
        assert_eq!(counter.ref_count(), 0);
        assert!(!counter.is_active());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);

        // 多余 release 保持幂等
        assert!(counter.release());
        assert_eq!(counter.ref_count(), 0);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);

        // 释放后再次 acquire 会重新创建守卫
        assert!(counter
            .acquire(|| {
                created.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(DropTracker(Arc::clone(&dropped)))
            })
            .unwrap());
        assert_eq!(counter.ref_count(), 1);
        assert!(counter.is_active());
        assert_eq!(created.load(Ordering::SeqCst), 2);
    }
}
