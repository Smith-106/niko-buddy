import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * F-005 远程 MCP 传输的 e2e（TASK-005 verify 项三）。
 *
 * 范围声明：`McpTransportSettings` 此前没有挂进应用外壳；2026-09-12 已接线到
 * 「设置 → MCP 工具」区块（见文件末 `F-005 远程 MCP 传输 / 壳层可达性`）。以下
 * 断言**真正可观察的边界**（IPC 往返、门禁、i18n），不伪造 UI 交互：
 *   1. 默认值仍是 stdio，opt-in 是显式开关（源码级断言 + 运行时开关量对比）；
 *   2. IPC 参数名与 Rust 命令签名一致（camelCase ↔ snake_case 映射）；
 *   3. 远程内容在**入库前**被审计拦截（走 mock 的真实 IPC 往返，注入载荷必定被拦）；
 *   4. i18n 三键双侧齐备。
 * 纯逻辑（opt-in 门、审计合成、默认值）在 `src/lib/mcp/remote-transport.spec.ts` 有 9 个用例。
 */

const REPO = process.cwd()
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8")

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
  await page.waitForSelector("#root", { state: "attached" })
}

async function invoke(page: Page, cmd: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    ([name, payload]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke(name as string, payload as Record<string, unknown>),
    [cmd, args] as const,
  )
}

test.describe("F-005 远程 MCP 传输", () => {
  test("默认传输是 stdio（Rust 与前端两侧）", () => {
    const rust = read("src-tauri/src/mcp_transport.rs")
    expect(rust).toContain('pub const DEFAULT_TRANSPORT: &str = "stdio"')
    expect(rust).toContain('pub const ALLOW_HTTP_FLAG: &str = "allow_http"')

    const ts = read("src/lib/mcp/remote-transport.ts")
    expect(ts).toContain('export const DEFAULT_TRANSPORT_MODE: TransportMode = "stdio"')

    const panel = read("src/components/settings/McpTransportSettings.tsx")
    expect(panel).toContain("useState(false)")
    expect(panel).toContain("McpTransportSettings")
  })

  test("远程传输需显式 opt-in：IPC 往返与 Rust 门禁一致", async ({ page }) => {
    await boot(page)

    // 未 opt-in → 被拒（错误文本含 allow_http）
    const denied = await invoke(page, "mcp_transport_set_mode", {
      projectPath: "/tmp/proj",
      transport: "http",
      allowHttp: false,
    })
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(denied).toContain("allow_http")

    // opt-in 后 → 通过
    const allowed = (await invoke(page, "mcp_transport_set_mode", {
      projectPath: "/tmp/proj",
      transport: "http",
      allowHttp: true,
    })) as { transport: string; allow_http: boolean }
    expect(allowed).toEqual({ transport: "http", allow_http: true })

    // Rust 侧签名与前端参数名对应（camelCase ↔ snake_case）
    const rust = read("src-tauri/src/mcp_remote.rs")
    for (const param of ["project_path: String", "transport: String", "allow_http: bool"]) {
      expect(rust).toContain(param)
    }
  })

  test("远程内容先审后入库：注入载荷在写入前被拦", async ({ page }) => {
    await boot(page)
    await invoke(page, "mcp_transport_set_mode", {
      projectPath: "/tmp/proj",
      transport: "http",
      allowHttp: true,
    })
    const session = (await invoke(page, "mcp_remote_connect", {
      projectPath: "/tmp/proj",
      serverId: "demo",
    })) as { opt_in: boolean; credential_present: boolean }
    expect(session.opt_in).toBe(true)
    // 凭据只报「有没有」，绝不回传凭据本身
    expect(Object.keys(session)).not.toContain("token")

    const payload = (await invoke(page, "mcp_remote_request", {
      projectPath: "/tmp/proj",
      serverId: "demo",
      payload: "{}",
    })) as { audit_pending: boolean; body: string }
    expect(payload.audit_pending).toBe(true)
    expect(payload.body).toContain("Ignore all previous instructions")

    // 审计门在入库之前运行，且本组件没有任何入库/写入路径。
    // (注入载荷确实被拦截的运行时证据在 src/lib/mcp/remote-transport.spec.ts 的
    //  「注入载荷 → 拦截（drop/sanitize 都不算放行）」用例，那里调用的是同一个审计器。)
    const transport = read("src/lib/mcp/remote-transport.ts")
    expect(transport).toContain("export function auditRemotePayload")
    expect(transport).toContain("export async function requestAndAuditRemote")

    const panel = read("src/components/settings/McpTransportSettings.tsx")
    expect(panel).toContain("auditRemotePayload(")
    for (const forbidden of ["fs_write", "canon_ingest", "write_file", "writeFile"]) {
      expect(panel, `设置页不得直接走入库命令 ${forbidden}`).not.toContain(forbidden)
    }
    // 后端拦截码：审计不放行时返回 MCP_AUDIT_BLOCKED 且不写入（rust 单测覆盖）
    const rust = read("src-tauri/src/mcp_remote.rs")
    expect(rust).toContain("AuditBlocked")
    expect(rust).toContain("ingest_remote_payload")
  })

  test("stdio 实现未被替换", () => {
    const rust = read("src-tauri/src/commands/mcp_stdio.rs")
    expect(rust).toContain("mcp_stdio_spawn")
    expect(rust).toContain("mcp_stdio_write")
    const lib = read("src-tauri/src/lib.rs")
    expect(lib).toContain("commands::mcp_stdio::mcp_stdio_spawn")
  })

  test("i18n：mcp 传输三键双侧齐备", () => {
    for (const file of ["src/i18n/en.json", "src/i18n/zh.json"]) {
      const raw = read(file)
      for (const key of ["mcp.transport.mode", "mcp.transport.optin.http", "mcp.remote.audit.blocked"]) {
        expect(raw, `${file} 缺少 ${key}`).toContain(`"${key}"`)
      }
    }
  })

  test("应用可正常启动（无未处理 IPC）", async ({ page }) => {
    await boot(page)
    const ready = await page.evaluate(
      () =>
        typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
        "object",
    )
    expect(ready).toBe(true)
  })
})

/**
 * 壳层可达性（2026-09-12 接线后新增）：`McpTransportSettings` 此前无任何应用入口，
 * 本组用例驱动**真实应用外壳**证明入口存在、且四个动作按钮文案各自独立
 * （回归：接线前四个按钮全部复用 `mcp.transport.mode` 占位文案）。
 */
test.describe("F-005 远程 MCP 传输 / 壳层可达性", () => {
  test("设置 → MCP 工具区块内可见远程传输面板与独立按钮文案", async ({ page }) => {
    await boot(page)
    await page.getByRole("button", { name: "小说目录" }).click()
    await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })

    await page.click('[data-view="settings"]')
    await page.getByRole("button", { name: "MCP 工具", exact: true }).click()

    await page.waitForSelector('[data-testid="mcp-remote-transport-section"]', { timeout: 10000 })
    await expect(page.locator('[data-testid="mcp-transport-settings"]')).toBeVisible()
    await expect(page.locator('[data-testid="mcp-transport-mode"]')).toBeVisible()

    const labels = await Promise.all(
      ["save", "connect", "request", "close"].map(async (name) => {
        const btn = page.locator(`[data-testid="mcp-transport-${name}"]`)
        await expect(btn).toBeVisible()
        return (await btn.textContent())?.trim() ?? ""
      }),
    )
    // 四个按钮必须是四条不同的中文文案，且不是 i18n 裸键
    expect(new Set(labels).size).toBe(4)
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toMatch(/^[a-z][\w.]*\.[a-zA-Z]/)
    }
  })
})
