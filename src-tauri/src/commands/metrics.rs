use serde::Serialize;

/// Process memory information exposed to the frontend for benchmarking.
///
/// On Windows, reads from the current process's working-set size via
/// `GetProcessMemoryInfo`. On other platforms, falls back to reading
/// `/proc/self/status` (Linux) or returns zeros (macOS fallback).
#[derive(Debug, Clone, Serialize)]
pub struct MemoryInfo {
    /// Resident Set Size (working set on Windows) in bytes.
    pub rss_bytes: u64,
    /// Total heap allocated by the process (approximation).
    pub heap_total_bytes: u64,
    /// Currently-used heap (approximation).
    pub heap_used_bytes: u64,
}

/// Return process memory metrics. Lightweight — called from benchmarks only.
#[tauri::command]
pub fn get_process_memory() -> MemoryInfo {
    #[cfg(target_os = "windows")]
    {
        use std::mem::MaybeUninit;
        #[repr(C)]
        struct ProcessMemoryCounters {
            cb: u32,
            page_fault_count: u32,
            peak_working_set_size: usize,
            working_set_size: usize,
            quota_peak_paged_pool_usage: usize,
            quota_paged_pool_usage: usize,
            quota_peak_non_paged_pool_usage: usize,
            quota_non_paged_pool_usage: usize,
            pagefile_usage: usize,
            peak_pagefile_usage: usize,
        }

        extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32GetProcessMemoryInfo(
                process: isize,
                counters: *mut ProcessMemoryCounters,
                cb: u32,
            ) -> i32;
        }

        let mut counters = MaybeUninit::<ProcessMemoryCounters>::uninit();
        let cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        unsafe {
            let handle = GetCurrentProcess();
            let ok = K32GetProcessMemoryInfo(handle, counters.as_mut_ptr(), cb);
            if ok != 0 {
                let c = counters.assume_init();
                MemoryInfo {
                    rss_bytes: c.working_set_size as u64,
                    heap_total_bytes: c.pagefile_usage as u64,
                    heap_used_bytes: c.working_set_size as u64,
                }
            } else {
                MemoryInfo {
                    rss_bytes: 0,
                    heap_total_bytes: 0,
                    heap_used_bytes: 0,
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Best-effort: read VmRSS from /proc/self/status (Linux).
        // macOS and other platforms return zeros.
        let rss = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find(|l| l.starts_with("VmRSS:"))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|kb| kb * 1024)
            })
            .unwrap_or(0);

        MemoryInfo {
            rss_bytes: rss,
            heap_total_bytes: rss,
            heap_used_bytes: rss,
        }
    }
}
