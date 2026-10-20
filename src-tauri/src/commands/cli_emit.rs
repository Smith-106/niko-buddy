//! P1-10：CLI stdout 行聚合刷。
//!
//! 三路 CLI（antigravity/claude/codex）曾每 stdout 行即一次 `emit`，
//! 高速流式时 IPC 事件数量级爆炸。`EmitBatcher` 在后端按 24ms/8KB 窗口
//! 把多行并为一次 emit（`\n` 连接）；前端三 transport 的 data 监听
//! 按行拆分后再走各自的 parse，语义与逐行 emit 完全一致。
//! `emit_done` 不变；控制标记行（如 claude 的 stdout-buffer-overflow）
//! 仍走即时 emit，不经过 batcher。

use std::time::{Duration, Instant};

/// 聚合窗口：与前端 32ms 批刷同量级，取其中位。
pub const EMIT_FLUSH_INTERVAL: Duration = Duration::from_millis(24);
/// 单次 emit 上限：超限即刷，避免超大单包。
pub const EMIT_MAX_BATCH_BYTES: usize = 8192;

pub struct EmitBatcher {
    buf: String,
    last_flush: Instant,
}

impl EmitBatcher {
    pub fn new() -> Self {
        Self {
            buf: String::new(),
            last_flush: Instant::now(),
        }
    }

    /// 缓入一行（不含换行符，存时补 `\n`）。
    pub fn push(&mut self, line: &str) {
        self.buf.push_str(line);
        self.buf.push('\n');
    }

    /// 是否达到刷出阈值（空缓冲永不刷）。
    pub fn should_flush(&self) -> bool {
        !self.buf.is_empty()
            && (self.buf.len() >= EMIT_MAX_BATCH_BYTES
                || self.last_flush.elapsed() >= EMIT_FLUSH_INTERVAL)
    }

    /// 取走缓冲（含末尾 `\n`，前端按行拆分时尾空行被 parse 判空跳过）。
    /// 取后重置窗口计时。
    pub fn take(&mut self) -> String {
        self.last_flush = Instant::now();
        std::mem::take(&mut self.buf)
    }
}

impl Default for EmitBatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_never_flushes() {
        let batcher = EmitBatcher::new();
        assert!(!batcher.should_flush());
    }

    #[test]
    fn size_threshold_flushes() {
        let mut batcher = EmitBatcher::new();
        batcher.push(&"x".repeat(EMIT_MAX_BATCH_BYTES));
        assert!(batcher.should_flush());
        let payload = batcher.take();
        assert!(payload.ends_with('\n'));
        assert!(!batcher.should_flush());
    }

    #[test]
    fn take_resets_window() {
        let mut batcher = EmitBatcher::new();
        batcher.push("a");
        let first = batcher.take();
        batcher.push("b");
        let second = batcher.take();
        assert_eq!(first, "a\n");
        assert_eq!(second, "b\n");
    }
}
