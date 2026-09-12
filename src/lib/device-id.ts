/**
 * 本机标识（`deviceId`）——F-004 云端备份的冲突副本命名输入。
 *
 * 存在的理由：Rust 侧 `commands/sync_target.rs::conflict_file_name` 与本侧
 * `lib/novel/sync-client.ts::conflictFileName` 都需要一个**设备标识**才能生成
 * `.conflict-<device>-<timestamp>`，但移植前**前端没有任何来源**（该参数一直是纯入参），
 * 导致 `CloudBackupPanel` 无法被壳层挂载。本模块补的就是这一个缺口。
 *
 * 边界（写在这里以免后人误改）：
 * - **绝不复用 `lib/crypto.ts::getDeviceFingerprint()`**：那个指纹**就是** AES-256 的
 *   密钥材料（`getDeviceKey` 直接 raw import，无 KDF）。把它当 `deviceId` 会让密钥
 *   出现在**远端工件的冲突文件名**里（`WebDAV` 上）并显示在设置界面 ⇒ 直接泄露。
 * - 本标识**不是身份、不是账号**：只是让同一份远端工件在两台机器上的冲突副本可区分，
 *   因此随机生成、本地持久化即可，绝不上云、绝不参与鉴权。
 * - 清洗规则与 Rust/前端既有判定一致（`[A-Za-z0-9_-]` 之外一律剔除），
 *   保证 `conflictFileName` 不会返回 `null`。
 */

const STORAGE_KEY = "qmai.deviceId"

/** 清洗为两侧 `conflict_file_name` / `conflictFileName` 都接受的安全片段。 */
export function sanitizeDeviceId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
}

function randomToken(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `dev-${uuid}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
}

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null // 隐私模式等禁用 storage 的环境
  }
}

/** 无 storage 环境（如 Node 测试/受限 WebView）下的进程内稳定值。 */
let fallbackToken = ""

/**
 * 读取本机标识；不存在则生成并持久化。同一进程内恒定（即使 storage 不可用）。
 *
 * @param existingOverride 显式覆盖值（优先级最高，仍会被清洗）；
 *   主要用于把已确定的值传给无状态调用方。
 */
export function getDeviceId(existingOverride?: string): string {
  const explicit = existingOverride === undefined ? "" : sanitizeDeviceId(existingOverride)
  if (explicit) return explicit

  const s = store()
  if (!s) {
    if (!fallbackToken) fallbackToken = randomToken()
    return fallbackToken
  }
  const stored = sanitizeDeviceId(s.getItem(STORAGE_KEY) ?? "")
  if (stored) return stored

  const created = randomToken()
  s.setItem(STORAGE_KEY, created)
  return created
}

/** 覆盖本机标识（用户可改）；清洗后为空则保持现值不变，返回最终生效值。 */
export function setDeviceId(raw: string): string {
  const next = sanitizeDeviceId(raw)
  if (!next) return getDeviceId()
  store()?.setItem(STORAGE_KEY, next)
  return next
}
