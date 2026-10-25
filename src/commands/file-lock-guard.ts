import { logger } from "@/lib/utils";

/**
 * file-lock-guard — Windows 并发 rename 瞬态错误的指数退避重试守卫。
 *
 * 背景：`writeFileAtomic`/`writeFilesAtomic` 经 Tauri invoke 调 Rust
 * `write_file_atomic`（temp 写 + rename 提交，提交阶段为顺序 rename，
 * 微秒窗口）。Windows 下并发 rename 可能撞 sharing violation / EBUSY 类
 * 瞬态错误。TS 侧 choke point（`src/commands/fs.ts`）重试，Rust 侧不动。
 */

/** 默认总尝试次数（含首次）：1 次首试 + 4 次重试。 */
export const FILE_LOCK_MAX_ATTEMPTS = 5;

/** 默认退避基线（毫秒）：第 k 次重试前等待 `random() * base * 2^(k-1)`。 */
export const FILE_LOCK_BASE_DELAY_MS = 5;

/** 瞬态谓词子串（统一小写匹配，大小写不敏感）。 */
const TRANSIENT_PATTERNS = [
  "sharing violation",
  "being used by another",
  "ebusy",
  "etxtbsy",
  "lock conflict",
] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 从未知拒绝值中提取可匹配文本（含 Node `code` / FsError 信封原文）。 */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const codeText = typeof code === "string" ? ` ${code}` : "";
    return `${err.message}${codeText}`;
  }
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object") {
    const maybe = err as { message?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof maybe.message === "string") parts.push(maybe.message);
    if (typeof maybe.code === "string") parts.push(maybe.code);
    if (parts.length > 0) return parts.join(" ");
    try {
      const json = JSON.stringify(err);
      if (typeof json === "string") return json;
    } catch {
      // 落到 String(err) 保底
    }
  }
  return String(err);
}

/**
 * 瞬态文件锁错误谓词：大小写不敏感子串匹配。
 * 仅命中 Windows 并发 rename 文案时返回 true，其余一律 false（绝不吞错）。
 */
export function isTransientFileLockError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return TRANSIENT_PATTERNS.some((pattern) => text.includes(pattern));
}

export interface FileLockRetryOptions {
  /** 总尝试次数（含首次），默认 5。 */
  maxAttempts?: number;
  /** `maxAttempts - 1` 的别名；与 maxAttempts 同时给出时以 maxAttempts 为准。 */
  maxRetries?: number;
  /** 退避基线毫秒，默认 5。 */
  baseDelayMs?: number;
  /** 等待函数（单测注入 fake clock），默认 `setTimeout` promise。 */
  sleep?: (ms: number) => Promise<void>;
  /** `sleep` 的别名；与 sleep 同时给出时以 sleep 为准。 */
  delay?: (ms: number) => Promise<void>;
  /** 抖动随机源（单测注入确定性函数），默认 `Math.random`。 */
  random?: () => number;
}

export interface FileLockRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorText: string;
}

/**
 * 仅对瞬态文件锁错误做指数退避 + 全抖动重试。
 *
 * - 非瞬态错误一次即抛（零重试），从不吞错：原错误引用原样抛出。
 * - 瞬态错误耗尽 `maxAttempts` 后抛出最后一次的原错误。
 * - 退避：`random() * baseDelayMs * 2^(attempt-1)`（Full Jitter），
 *   每次重试前经 `logger.warn("file-lock-guard", …)` 记录。
 */
export async function withFileLockRetry<T>(
  fn: () => Promise<T>,
  opts: FileLockRetryOptions = {},
): Promise<T> {
  const maxAttempts =
    opts.maxAttempts !== undefined
      ? Math.max(1, Math.floor(opts.maxAttempts))
      : opts.maxRetries !== undefined
        ? Math.max(1, Math.floor(opts.maxRetries) + 1)
        : FILE_LOCK_MAX_ATTEMPTS;
  const baseDelayMs =
    opts.baseDelayMs !== undefined
      ? Math.max(0, opts.baseDelayMs)
      : FILE_LOCK_BASE_DELAY_MS;
  const sleep = opts.sleep ?? opts.delay ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientFileLockError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = random() * baseDelayMs * 2 ** (attempt - 1);
      const text = errorText(err);
      const info: FileLockRetryInfo = {
        attempt,
        maxAttempts,
        delayMs,
        errorText: text,
      };
      logger.warn(
        "file-lock-guard",
        `transient file lock, retrying (${attempt}/${maxAttempts}) in ${delayMs}ms`,
        { ...info },
      );
      await sleep(delayMs);
    }
  }
  throw new Error("withFileLockRetry: unreachable");
}
