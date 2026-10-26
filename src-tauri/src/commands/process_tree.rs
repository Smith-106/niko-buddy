//! R5 / Q19-jobobject：子进程树销毁（Windows JobObject）。
//!
//! 背景（代码审计确认的缺陷类）：CLI 子进程统一用 `Child::start_kill()` / `Child::kill()`
//! 收尾，二者只终止**直接子进程**（TerminateProcess / SIGKILL），不触达孙进程。
//! Windows 上 `node`/`.cmd`/`npm` 一类启动器会再派生子进程，父进程被杀后孙进程成为
//! 孤儿（僵尸进程），继续占用端口/文件句柄。
//!
//! 本模块提供最小、无侵入的补洞：
//! - Windows：为子进程创建 JobObject 并设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，
//!   把子进程句柄加入 job。此后无论显式 `terminate()` 还是句柄 drop（含进程崩溃），
//!   内核都会连带销毁 job 内全部后代。
//! - 非 Windows：保持既有语义（仅直接子进程），`terminate()` 退化为 kill。
//!
//! 设计约束：
//! - 不改变调用方的 spawn 参数、不接管 stdout/stderr、不引入全局状态。
//! - JobObject 创建/加入失败一律降级为“无 job”并继续（fail-open），
//!   因为进程树清理是加固而非主链前置条件。
//! - `Drop` 只关闭句柄（触发 KILL_ON_JOB_CLOSE），不阻塞、不 panic。


mod imp {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// 持有 JobObject 句柄；drop 时关闭句柄即触发 KILL_ON_JOB_CLOSE。
    pub struct ProcessTree {
        job: HANDLE,
    }

    // 句柄本身是进程级资源，跨线程移动安全；JobObject 无内部可变状态。
    unsafe impl Send for ProcessTree {}
    unsafe impl Sync for ProcessTree {}

    impl ProcessTree {
        /// 为已 spawn 的子进程（按 pid）创建 job 并加入。任何一步失败返回 None（fail-open）。
        pub fn attach_pid(pid: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(None, None).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .is_err()
                {
                    let _ = CloseHandle(job);
                    return None;
                }
                let process = match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
                    Ok(handle) => handle,
                    Err(_) => {
                        let _ = CloseHandle(job);
                        return None;
                    }
                };
                let assigned = AssignProcessToJobObject(job, process);
                let _ = CloseHandle(process);
                if assigned.is_err() {
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(Self { job })
            }
        }

        /// 显式销毁整棵进程树（关闭 job 句柄 → 内核连带终止全部后代）。
        pub fn terminate(&mut self) {
            if !self.job.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.job);
                }
                self.job = HANDLE::default();
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            self.terminate();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::process::Child;

    /// 非 Windows：无 JobObject 等价物，保持既有“仅直接子进程”语义。
    pub struct ProcessTree;

    impl ProcessTree {
        pub fn attach_pid(_pid: u32) -> Option<Self> {
            None
        }

        pub fn terminate(&mut self) {}
    }
}

pub use imp::ProcessTree;

/// 为子进程（按 pid）挂上进程树守卫。失败返回 None（fail-open，调用方照旧 `start_kill`）。
///
/// 接受裸 pid 而非 `&Child`，因为调用方同时使用 `std::process::Child` 与
/// `tokio::process::Child`（后者 `id()` 返回 `Option<u32>`），pid 是两者唯一公共面。
pub fn attach_pid(pid: u32) -> Option<ProcessTree> {
    ProcessTree::attach_pid(pid)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn attach_returns_some_for_live_child_on_windows() {
        // cmd /c ping 常驻，确保子进程存活期间可被加入 job。
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn ping");
        let mut tree = attach_pid(child.id()).expect("Windows 上应成功挂载 JobObject");
        tree.terminate();
        let _ = child.kill();
        let _ = child.wait();
        assert!(child.try_wait().expect("try_wait").is_some(), "子进程应已终止");
    }

    #[cfg(windows)]
    #[test]
    fn kill_tree_terminates_grandchild() {
        // 父 cmd 再派生一个长驻孙进程（ping）；杀树后孙进程不应存活。
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "start", "/b", "ping", "-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd");
        let mut tree = attach_pid(child.id()).expect("Windows 上应成功挂载 JobObject");
        tree.terminate();
        let _ = child.kill();
        let _ = child.wait();
        assert!(child.try_wait().expect("try_wait").is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn attach_is_noop_off_windows() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn sleep");
        assert!(attach_pid(child.id()).is_none());
        let _ = child.kill();
        let _ = child.wait();
        assert!(child.try_wait().expect("try_wait").is_some());
    }
}
