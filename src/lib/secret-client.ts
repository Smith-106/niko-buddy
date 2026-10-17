/**
 * secret-client.ts — C-011 凭据链的前端接入（B3）。
 *
 * 定位：`src-tauri/src/commands/secret_store.rs` 四个 `secret_*` 命令的 TS 客户端。
 * 本模块**只做**「输入 → IPC → credential_ref 回填」的管道，重新实现的安全判定为零：
 *
 *  - **值永不回读**：这里刻意**不提供** `secret_get` 封装——唯一 secret 值出口
 *    （Rust 命令）只允许传输层（`sync_target.rs` 的 `read_secret_sync`）在推送/拉取
 *    时即时消费；前端一旦有读取面，明文凭据就会流经 webview，攻击面凭空扩大。
 *    未提供 = 刻意设计，不是漏接线（见 `ipc-surface-contract.spec.ts` 白名单）。
 *  - **值不落任何状态**：`secretPut` 的 secret 参数只作为调用实参，不缓存、不记录；
 *    返回值是 `credential_ref`（`nb:<domain>:<account>`），不包含 secret 值。
 *  - **可用性前置**：`secretAvailable()` 为 false 时调用方 MUST 关闭该传输目标
 *    （禁止明文回退）——面板据此禁用控件并给提示，而不是等 IPC 失败才报错。
 *
 * 命名/引用规则与 Rust 侧逐条镜像（`normalize_service` / `resolve_credential_ref` /
 * `build_credential_ref`），两侧必须同步演进。
 */

import { invoke } from "@tauri-apps/api/core"

/** credential_ref 前缀：引用而非密钥本体。 */
export const CREDENTIAL_REF_PREFIX = "nb:"

/** 云端备份默认逻辑域（与面板占位 `nb:webdav:<account>` 一致）。 */
export const DEFAULT_SECRET_DOMAIN = "webdav"

/** 域名字符集（与 Rust `normalize_service` 同判，大小写归一为小写）。 */
const DOMAIN_RE = /^[a-z0-9_-]+$/

/** 解析后的引用：逻辑域 + 逻辑账户（不含设备绑定，引用跨设备可移植）。 */
export interface ParsedCredentialRef {
  domain: string
  account: string
}

/**
 * 解析 `nb:<domain>:<account>`；非该形态返回 null（不猜测、不降级）。
 * 与 Rust `resolve_credential_ref` 同判：前缀必需、domain 匹配 `[a-z0-9_-]`、
 * account 段非空。
 */
export function parseCredentialRef(credentialRef: string): ParsedCredentialRef | null {
  const raw = credentialRef.trim()
  if (!raw.startsWith(CREDENTIAL_REF_PREFIX)) return null
  const rest = raw.slice(CREDENTIAL_REF_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator <= 0) return null
  const domain = rest.slice(0, separator).toLowerCase()
  const account = rest.slice(separator + 1)
  if (!DOMAIN_RE.test(domain) || account.length === 0) return null
  return { domain, account }
}

/**
 * 默认逻辑账户：项目目录名（消毒为 `[A-Za-z0-9_-]`，避免把路径字符带进引用）。
 * 仅当引用尚未建立时用于首次写入；一旦写入成功，面板改用 Rust 返回的引用。
 * `projectPath` 允许缺失（渲染冒烟/无项目路径的调用面），回退 'project'。
 */
export function defaultCredentialAccount(projectPath: string | null | undefined): string {
  const segments = (projectPath ?? "").replace(/\\/g, "/").split("/")
  const basename = segments[segments.length - 1] ?? ""
  const sanitized = basename.replace(/[^A-Za-z0-9_-]/g, "")
  return sanitized.length > 0 ? sanitized : "project"
}

/**
 * 解析写入目标：已有合法引用 → 复用其 domain/account（轮换凭据时引用不变）；
 * 否则回退默认 `webdav` + 项目名派生账户（首次写入）。
 */
export function resolveCredentialTarget(
  credentialRef: string,
  projectPath: string,
): ParsedCredentialRef {
  return (
    parseCredentialRef(credentialRef) ?? {
      domain: DEFAULT_SECRET_DOMAIN,
      account: defaultCredentialAccount(projectPath),
    }
  )
}

/** OS 凭据库是否可用；false 时调用方 MUST 关闭该传输目标（禁止明文回退）。 */
export async function secretAvailable(): Promise<boolean> {
  return await invoke<boolean>("secret_available")
}

/**
 * 写入（或轮换）凭据，返回 `credential_ref`。
 * **返回值不含 secret 值**（Rust 契约）；secret 参数只作为本次调用的实参。
 */
export async function secretPut(domain: string, account: string, secret: string): Promise<string> {
  return await invoke<string>("secret_put", { service: domain, account, secret })
}

/**
 * 删除本机凭据；返回是否确实删除了既有条目（`false` = 原本不存在）。
 * 只删除 OS 凭据库条目，不改动项目配置（引用由调用方决定是否清空）。
 */
export async function secretDelete(domain: string, account: string): Promise<boolean> {
  return await invoke<boolean>("secret_delete", { service: domain, account })
}
