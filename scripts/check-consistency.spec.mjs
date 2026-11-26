import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  collectTsListenTopicsFromEntries,
  isSpec,
  isTestOrHelper,
  parseCommandSignaturesFromSource,
  parseHandlerRegistrationsFromSource,
  parseTsInvocationsFromSource,
  stripRustComments,
  validateIpcParams,
} from "./check-consistency.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

describe("check-consistency: Rust generate_handler! 解析与注释剥离", () => {
  it("剥离 // 行注释与嵌套 /* */ 块注释中的逗号、路径和方括号", () => {
    const libSource = `
      fn build() {
        let _lifetime: &'static str = "keep /* not a comment */ // still string";
        let _ch = ']';
        let _raw = r#"raw /* comment */ ]"#;
        tauri::generate_handler![
          // commands::fake_commented_out, another_fake, [bracket]
          commands::fs::read_file,
          /* block comment with comma, commands::ghost_cmd,
             /* nested rust block comment ] */
          */
          commands::project::open_project, // trailing comment, fake_trailing
          canon::commands::canon_query,
        ]
      }
    `
    expect(parseHandlerRegistrationsFromSource(libSource)).toEqual([
      "read_file",
      "open_project",
      "canon_query",
    ])
  })

  it("保留生命周期 'a 与原始字符串内容不被误当字符/注释剥离", () => {
    const stripped = stripRustComments(`fn foo<'a>(s: &'a str) { let a = "x // y"; /* z */ let b = r#"// ok"#; }`)
    expect(stripped).toContain("fn foo<'a>(s: &'a str)")
    expect(stripped).toContain('"x // y"')
    expect(stripped).toContain('r#"// ok"#')
    expect(stripped).not.toContain("/* z */")
  })
})

describe("check-consistency: TS invoke 字符级扫描（嵌套泛型、别名、argsKind）", () => {
  it("正确跨越任意嵌套泛型与函数类型箭头 =>", () => {
    const code = `
      async function run() {
        await invoke<Record<string, Array<Foo>>>("nested_generic_cmd", { a, b: 1 })
        await invoke<Map<string, (x: number) => Promise<void>>>("arrow_generic_cmd", { id: "1" })
      }
    `
    const sites = parseTsInvocationsFromSource(code, "src/lib/sample.ts")
    expect(sites).toEqual([
      { name: "nested_generic_cmd", keys: ["a", "b"], spread: false, argsKind: "object", file: "src/lib/sample.ts" },
      { name: "arrow_generic_cmd", keys: ["id"], spread: false, argsKind: "object", file: "src/lib/sample.ts" },
    ])
  })

  it("精确区分 argsKind: none / object / dynamic 与 spread 标记", () => {
    const code = `
      await invoke("zero_arg_cmd")
      await invoke("undef_arg_cmd", undefined)
      await invoke("empty_obj_cmd", {})
      await invoke("object_cmd", { path, exactUtf8: true, "quoted-key": 2 })
      await invoke("spread_cmd", { path, ...(flag ? { extra: 1 } : {}) })
      await invoke("dynamic_var_cmd", payload)
      await invoke("dynamic_call_cmd", buildArgs())
    `
    const sites = parseTsInvocationsFromSource(code, "src/lib/sample.ts")
    expect(sites).toEqual([
      { name: "zero_arg_cmd", keys: [], spread: false, argsKind: "none", file: "src/lib/sample.ts" },
      { name: "undef_arg_cmd", keys: [], spread: false, argsKind: "none", file: "src/lib/sample.ts" },
      { name: "empty_obj_cmd", keys: [], spread: false, argsKind: "object", file: "src/lib/sample.ts" },
      { name: "object_cmd", keys: ["path", "exactUtf8", "quoted-key"], spread: false, argsKind: "object", file: "src/lib/sample.ts" },
      { name: "spread_cmd", keys: ["path"], spread: true, argsKind: "object", file: "src/lib/sample.ts" },
      { name: "dynamic_var_cmd", keys: [], spread: false, argsKind: "dynamic", file: "src/lib/sample.ts" },
      { name: "dynamic_call_cmd", keys: [], spread: false, argsKind: "dynamic", file: "src/lib/sample.ts" },
    ])
  })

  it("支持条件表达式命令名并忽略注释、字符串与成员方法调用", () => {
    const code = `
      // invoke("commented_cmd", { a: 1 })
      const text = 'invoke("string_cmd", { a: 1 })'
      obj.invoke("member_cmd", { a: 1 })
      await invoke(grant ? "mcp_session_grant_full" : "mcp_session_revoke_full", { sessionId })
    `
    const sites = parseTsInvocationsFromSource(code, "src/components/settings/sections/external-control-section.tsx")
    expect(sites).toEqual([
      {
        name: "mcp_session_grant_full",
        keys: ["sessionId"],
        spread: false,
        argsKind: "object",
        file: "src/components/settings/sections/external-control-section.tsx",
      },
      {
        name: "mcp_session_revoke_full",
        keys: ["sessionId"],
        spread: false,
        argsKind: "object",
        file: "src/components/settings/sections/external-control-section.tsx",
      },
    ])
  })

  it("识别受控白名单别名 invokeFs / invokeCanon，要求引号字面量且跳过 wrapper 与动态透传", () => {
    const fsCode = `
      async function invokeFs<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        return args === undefined ? await invoke<T>(command) : await invoke<T>(command, args)
      }
      export async function a(path: string) {
        return invokeFs<string>("read_file", { path })
      }
      export async function b(cmd: string) {
        return invokeFs(cmd, { path: "x" })
      }
    `
    const fsSites = parseTsInvocationsFromSource(fsCode, "src/commands/fs.ts")
    expect(fsSites).toEqual([
      { name: "read_file", keys: ["path"], spread: false, argsKind: "object", file: "src/commands/fs.ts" },
    ])

    const canonCode = `
      async function invokeCanon<T>(command: "canon_query", args: Record<string, unknown>, fallback: T): Promise<T> {
        return await invoke<T>(command, args)
      }
      export async function q(projectId: string, filter: unknown) {
        return invokeCanon<Array<Record<string, unknown>>>("canon_query", { projectId, filter }, [])
      }
    `
    const canonSites = parseTsInvocationsFromSource(canonCode, "src/lib/novel/canon-graph-client.ts")
    expect(canonSites).toEqual([
      {
        name: "canon_query",
        keys: ["projectId", "filter"],
        spread: false,
        argsKind: "object",
        file: "src/lib/novel/canon-graph-client.ts",
      },
    ])

    // 非白名单文件中不把 invokeFs / invokeCanon 当作 IPC 别名
    expect(parseTsInvocationsFromSource(`invokeFs("read_file", { path })`, "src/lib/other.ts")).toEqual([])
    expect(parseTsInvocationsFromSource(`invokeCanon("canon_query", { projectId }, [])`, "src/lib/other.ts")).toEqual([])
  })

  it("覆盖真实 src/commands/fs.ts（21 处 invokeFs + 2 处 invoke）与 src/lib/novel/canon-graph-client.ts（4 处 invokeCanon）", () => {
    const fsSource = readFileSync(join(ROOT, "src/commands/fs.ts"), "utf8")
    const fsSites = parseTsInvocationsFromSource(fsSource, "src/commands/fs.ts")
    expect(fsSites).toHaveLength(23)
    expect(fsSites.map((s) => s.name)).toContain("read_file")
    expect(fsSites.map((s) => s.name)).toContain("get_executable_dir")
    expect(fsSites.map((s) => s.name)).toContain("write_files_atomic")

    const canonSource = readFileSync(join(ROOT, "src/lib/novel/canon-graph-client.ts"), "utf8")
    const canonSites = parseTsInvocationsFromSource(canonSource, "src/lib/novel/canon-graph-client.ts")
    expect(canonSites.map((s) => s.name)).toEqual([
      "canon_facts_known_by",
      "canon_query",
      "canon_query_batch",
      "canon_query_episodes",
    ])
  })
})

describe("check-consistency: IPC 实参与必填形参漏传拦截", () => {
  const rustSource = `
    #[tauri::command]
    pub async fn read_item(
      app: tauri::AppHandle,
      path: String,
      exact_utf8: Option<bool>,
    ) -> Result<String, String> { todo!() }

    #[tauri::command]
    pub fn ping_only(state: tauri::State<'_, AppState>) -> bool { true }
  `
  const commands = parseCommandSignaturesFromSource(rustSource, "src-tauri/src/commands/demo.rs")

  it("零参调用或空对象 {} 漏传必填形参时报错拦截", () => {
    const sites = parseTsInvocationsFromSource(
      `
        await invoke("read_item")
        await invoke("read_item", {})
        await invoke("read_item", { exactUtf8: true })
        await invoke("ping_only")
      `,
      "src/lib/demo.ts",
    )
    const problems = validateIpcParams(sites, commands)
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain("read_item")
    expect(problems[0]).toContain("缺实参 path")
    expect(problems[1]).toContain("缺实参 path")
    expect(problems[2]).toContain("缺实参 path")
  })

  it("argsKind=dynamic 豁免缺失检查；spread 豁免缺失检查但仍拦截显式拼写错误", () => {
    const sites = parseTsInvocationsFromSource(
      `
        await invoke("read_item", dynamicPayload)
        await invoke("read_item", { ...dynamicPayload })
        await invoke("read_item", { ...dynamicPayload, wrongParam: 1 })
        await invoke("read_item", { path: "/a.md" })
      `,
      "src/lib/demo.ts",
    )
    const problems = validateIpcParams(sites, commands)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("多余实参 wrongParam")
  })
})

describe("check-consistency: collectTsListenTopics 忽略测试与脚手架", () => {
  it("忽略 .spec. / .test. / .bench. / test-helpers 并过滤注释内 listen", () => {
    expect(isSpec("src/a.spec.ts")).toBe(true)
    expect(isTestOrHelper("src/test-helpers/chat-panel/chat-panel-test-setup.tsx")).toBe(true)
    expect(isTestOrHelper("src/test-helpers/startup.bench.ts")).toBe(true)
    expect(isTestOrHelper("src/components/novel/backup-export-view.tsx")).toBe(false)

    const topics = collectTsListenTopicsFromEntries([
      {
        file: "src/components/novel/backup-export-view.tsx",
        code: `
          // listen("ghost:commented")
          listen("backup:progress", handler)
          listen("tauri://close-requested", handler)
          listen("plugin:updater:check", handler)
        `,
      },
      {
        file: "src/components/novel/backup-export-view.spec.tsx",
        code: `listen("spec:only:mock", handler)`,
      },
      {
        file: "src/test-helpers/chat-panel/chat-panel-test-setup.tsx",
        code: `listen("helper:only:mock", handler)`,
      },
    ])

    expect([...topics.values()].map((entry) => entry.raw)).toEqual(["backup:progress"])
  })
})
