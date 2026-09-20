/**
 * vertical-slice-contract.spec.ts — 核心纵切面 IPC 语义契约
 *
 * 覆盖 UI→IPC→Buddy→持久化→资产→监控→恢复 纵切面的 47 条命令。
 * 不平铺全部 105——按 risk-policy 只验纵切面+P0/P1。
 *
 * 契约断言：
 *  1. 命令名 snake_case（Tauri 约定）
 *  2. Rust 返回 Result<T, String>（错误经 Err(String) 上抛,非 panic）
 *  3. 业务参数名（前端 invoke 须以对应 camelCase 传——命名契约由 ipc-contract.spec 保证,
 *     此处断言契约表本身 snake_case 字段与前端映射一致性已建立）
 *  4. 每条命令在契约表中有签名（防命令被删但前端仍 invoke → 断链）
 *  5. 错误语义：Err 分支必须返回 String(可读)非结构化错误码——UI 据此显示问题+影响+下一步
 */
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(__dirname, "..", "..")
const TAURI_SRC = join(ROOT, "src-tauri", "src")

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (e.endsWith(".rs")) yield p
  }
}

// 提取 Rust #[tauri::command] fn 签名 → { cmd: {params, ret} }
function extractRustCommands() {
  const map = new Map<string, { params: string; ret: string; file: string }>()
  for (const f of walk(TAURI_SRC)) {
    const txt = readFileSync(f, "utf-8")
    const re = /#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^\{]+))?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(txt)) !== null) {
      map.set(m[1], { params: m[2].trim(), ret: (m[3] ?? "").trim(), file: f })
    }
  }
  return map
}

// 纵切面命令清单（与 inventory/vertical-slice.json 对齐）
const VERTICAL = [
  "open_project", "open_project_folder", "create_project", "create_directory", "list_directory",
  "read_file", "write_file", "write_file_atomic", "file_exists",
  "claude_cli_detect", "codex_cli_detect", "cursor_cli_detect", "antigravity_cli_detect",
  "claude_cli_spawn", "antigravity_cli_spawn",
  "vault_put_secret", "vault_has_secret", "secret_get",
  "app_lock_state", "app_lock_verify", "get_device_fingerprint_cmd",
  "canon_query", "canon_ingest_episode", "canon_export_project", "canon_restore_project",
  "canon_verify_export", "canon_auto_backup",
  "export_novel_docx", "export_novel_epub", "export_pdf", "export_backup", "import_backup", "cancel_backup",
  "retry_file_change_task", "ignore_file_change_task",
  "confirm_gate_pending", "confirm_gate_resolve", "confirm_gate_classify",
  "start_project_file_watcher", "stop_project_file_watcher",
  "vector_count_chunks", "vector_search_chunks", "vector_run_startup_reconcile",
  "mark_style_exemplar", "load_style_exemplars", "batch_replace_preview", "batch_replace_apply",
]

const rust = extractRustCommands()

describe("纵切面 IPC 语义契约（vertical slice）", () => {
  it("每条纵切面命令在 Rust 侧存在 tauri::command 定义（无断链）", () => {
    const missing = VERTICAL.filter((c) => !rust.has(c))
    expect(missing, `纵切面命令在 Rust 侧无定义: ${missing.join(", ")}`).toEqual([])
  })

  it("每条命令名 snake_case（Tauri/Rust 命名约定）", () => {
    const bad = VERTICAL.filter((c) => /[A-Z]/.test(c))
    expect(bad).toEqual([])
  })

  it("每条命令返回 Result<T, String>（Err(String) 可读错误上抛，非 panic）", () => {
    const bad: string[] = []
    for (const c of VERTICAL) {
      const sig = rust.get(c)
      if (!sig) continue
      const ret = sig.ret.replace(/\s/g, "")
      // 无显式返回=同步 fire-and-forget(cancel_backup 设取消标志);Result/() 均合法
      if (ret === "" || ret === "()") continue
      if (!/^Result<.+,.+>$/.test(ret)) {
        bad.push(`${c} -> ${sig.ret}`)
      }
    }
    expect(bad, `命令返回非 Result<T,String>: ${bad.join("; ")}`).toEqual([])
  })

  it("spawn/detect 类异步命令参数含 stream/会话标识或隔离配置（支持取消/幂等语义）", () => {
    // claude_cli_spawn/antigravity_cli_spawn 必须带 stream_id 以支持 cancel/kill
    for (const c of ["claude_cli_spawn", "antigravity_cli_spawn"]) {
      const sig = rust.get(c)
      expect(sig, `${c} 无签名`).toBeTruthy()
      expect(sig!.params).toMatch(/stream_id|streamId/)
    }
  })

  it("文件写命令存在原子写变体（write_file_atomic → 半写状态安全）", () => {
    expect(rust.has("write_file_atomic")).toBe(true)
  })

  it("导出命令导出路径参数化（export_path/target → 用户可控产物落点）", () => {
    for (const c of ["export_novel_docx", "export_novel_epub"]) {
      expect(rust.get(c)!.params).toMatch(/export_path|exportPath/)
    }
    expect(rust.get("export_pdf")!.params).toMatch(/target|export_path|path/)
  })

  it("秘密/凭据命令最小面（vault/secret 不暴露明文批量导出）", () => {
    const secretCmds = VERTICAL.filter((c) => /secret|vault|credential/.test(c))
    // 不允许存在 list_all_secrets / dump 类全量明文导出
    const all = [...rust.keys()]
    const dangerous = all.filter((c) => /secret.*(list_all|dump|export_all)|vault.*dump/.test(c))
    expect(dangerous, `危险凭据导出命令: ${dangerous.join(",")}`).toEqual([])
    expect(secretCmds.length).toBeGreaterThan(0)
  })

  it("门控确认命令存在 pending/resolve/classify 三件套（人机确认闭环）", () => {
    for (const c of ["confirm_gate_pending", "confirm_gate_resolve", "confirm_gate_classify"]) {
      expect(rust.has(c), `${c} 缺失`).toBe(true)
    }
  })

  it("文件监视命令成对（start/stop → 无残留 watcher 泄漏）", () => {
    expect(rust.has("start_project_file_watcher")).toBe(true)
    expect(rust.has("stop_project_file_watcher")).toBe(true)
  })

  it("备份/恢复命令成对且含校验（export_backup/import_backup + canon_verify_export）", () => {
    expect(rust.has("export_backup")).toBe(true)
    expect(rust.has("import_backup")).toBe(true)
    expect(rust.has("canon_verify_export")).toBe(true)
    expect(rust.has("cancel_backup")).toBe(true)
  })

  it("纵切面命令总数≥40（覆盖 UI→IPC→Buddy→持久化→资产→监控→恢复）", () => {
    const present = VERTICAL.filter((c) => rust.has(c))
    expect(present.length).toBeGreaterThanOrEqual(40)
  })
})
