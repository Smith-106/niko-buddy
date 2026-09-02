/**
 * 共享 Tauri mock：注入 window.__TAURI_INTERNALS__，让纯 vite dev（无 Tauri shell）
 * 环境下的应用走 Tauri IPC 路径。
 *
 * - plugin:store → window.__MOCK_STORE__（内存 KV；llmConfig 预置 claude-code provider）
 * - plugin:event|listen → 按事件名记录 transformCallback id（E 表），供 spawn 回放
 * - claude_cli_spawn → 回放 token（assistant JSON 行）+ done 事件（code 0）
 * - read/write_file → 内存文件表往返（写入后可读回，验证持久化调用链）
 * - canon_* / export_novel_docx → 合法空结构
 * - 未覆盖命令 → console.log("UNHANDLED_CMD", cmd) 便于迭代扩展
 */
export const MOCK_INIT = `
(() => {
  let _cbId = 0
  const _cbs = new Map()
  const S = window.__MOCK_STORE__ || (window.__MOCK_STORE__ = {})
  const E = window.__MOCK_EVENTS__ || (window.__MOCK_EVENTS__ = {})
  const F = window.__MOCK_FILES__ || (window.__MOCK_FILES__ = {})
  // 预置 LLM 配置：claude-code provider → 走 claude_cli_spawn mock 回放
  if (S.llmConfig === undefined) {
    S.llmConfig = {
      provider: "claude-code", apiKey: "", model: "mock-claude",
      maxContextSize: 204800, ollamaUrl: "http://localhost:11434",
      customEndpoint: "", azureApiVersion: "2024-10-21", azureModelFamily: "auto",
      reasoning: { mode: "auto" }, localCliIsolation: false,
    }
  }
  const post = (handlerId, event, payload) => {
    const entry = _cbs.get(handlerId)
    if (!entry) return
    if (entry.once) _cbs.delete(handlerId)
    try { entry.cb({ event, id: 0, payload }) } catch {}
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb, once) => { const id = ++_cbId; _cbs.set(id, { cb, once }); return id },
    unregisterCallback: (id) => { _cbs.delete(id) },
    postMessage: (msg) => {
      if (msg && typeof msg.callback === "number" && _cbs.has(msg.callback)) {
        const { cb, once } = _cbs.get(msg.callback)
        if (once) _cbs.delete(msg.callback)
        try { cb(msg.payload) } catch {}
      }
    },
    invoke: async (cmd, args) => {
      const UNHANDLED = new Set([
        "plugin:store|load", "plugin:store|get", "plugin:store|set", "plugin:store|save",
        "plugin:path|join", "plugin:event|listen", "plugin:event|unlisten",
        "plugin:dialog|open", "open_project", "list_directory", "read_file",
        "write_file", "write_file_atomic", "file_exists", "create_directory",
        "claude_cli_spawn",
      ])
      if (!UNHANDLED.has(cmd)) console.log("UNHANDLED_CMD", cmd)
      switch (cmd) {
        case "plugin:store|load": return "mock-rid";
        case "plugin:store|get": {
          const v = S[args && args.key];
          return v === undefined ? [null, false] : [v, true];
        }
        case "plugin:store|set": S[args && args.key] = args && args.value; return null;
        case "plugin:store|save": return null;
        case "plugin:path|join": return (args && args.paths || []).join("/");
        case "plugin:event|listen": {
          const hid = args && args.handler;
          if (args && args.event && typeof hid === "number") E[args.event] = hid;
          return ++_cbId;
        }
        case "plugin:event|unlisten": return null;
        case "plugin:dialog|open": return "C:/mock/proj";
        case "plugin:dialog|save": return "C:/mock/proj/backup.zip";
        case "open_project": return { path: "C:/mock/proj", name: "测试项目", type: "novel" };
        case "create_project": return { path: (args && args.path) || "C:/mock/proj", name: (args && args.name) || "测试项目", type: "novel" };
        case "list_directory": {
          const p = args && args.path || "";
          const chap = { name: "chapter-001.md", path: "C:/mock/proj/wiki/chapters/chapter-001.md", is_dir: false };
          if (p === "C:/mock/proj" || p.endsWith("mock/proj")) {
            return [{ name: "wiki", path: "C:/mock/proj/wiki", is_dir: true, children: [
              { name: "chapters", path: "C:/mock/proj/wiki/chapters", is_dir: true, children: [chap] },
            ] }];
          }
          if (p.endsWith("/wiki")) return [{ name: "chapters", path: "C:/mock/proj/wiki/chapters", is_dir: true, children: [chap] }];
          if (p.endsWith("chapters")) return [chap];
          return [];
        }
        case "file_exists": return true;
        case "create_directory": return null;
        case "get_file_size": return 0;
        case "get_file_modified_time": return 0;
        case "get_file_md5": return "mock-md5";
        case "read_file": {
          const p = args && args.path || "";
          if (F[p] !== undefined) return F[p];
          if (p.includes("chapter-001.md")) {
            return "---\\nchapter_number: 1\\nchapter_name: 第一章 初见\\nchapter_status: final\\n---\\n\\n夜色沉静，少年推开旧宅的门，尘埃在月光里浮起。这是一段用于 UI 实操检验的正文。";
          }
          return p.includes(".qmai") ? "[]" : "";
        }
        case "write_file":
        case "write_file_atomic": {
          const p = args && args.path || "";
          F[p] = args && args.contents;
          (window.__MOCK_WRITES__ || (window.__MOCK_WRITES__ = [])).push({ cmd, path: p });
          return null;
        }
        case "claude_cli_spawn": {
          const sid = args && args.streamId;
          const text = window.__MOCK_REPLY__ || "第一章 初见\\n\\n夜色沉静，少年推开旧宅的门，尘埃在月光里浮起。";
          const token = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
          setTimeout(() => {
            if (E["claude-cli:" + sid] !== undefined) post(E["claude-cli:" + sid], "claude-cli:" + sid, token);
            if (E["claude-cli:" + sid + ":done"] !== undefined) post(E["claude-cli:" + sid + ":done"], "claude-cli:" + sid + ":done", { code: 0, stderr: "" });
          }, 30);
          return null;
        }
        case "claude_cli_terminate":
        case "claude_cli_kill":
        case "stop_project_file_watcher": return null;
        case "start_project_file_watcher": return { version: 0, tasks: [] };
        case "rescan_project_files": return { queue: { version: 0, tasks: [] }, changedTasks: [] };
        case "ignore_file_change_task":
        case "retry_file_change_task": return { version: 0, tasks: [] };
        case "canon_query": return { edges: [], total: 0, max_revision: 0 };
        case "canon_facts_known_by": return { edges: [], total: 0, max_revision: 0 };
        case "canon_query_batch": return { results: [], totals: [], max_revision: 0 };
        case "canon_get_revision": return { max_revision: 0 };
        case "canon_ingest_episode": return { inserted: true, max_revision: 1 };
        case "canon_supersede_edges": return { result: null, max_revision: 1 };
        case "canon_save_divergence_trace": return null;
        case "export_novel_docx": return { success: true, exportedPath: "C:/mock/proj/export.docx", chapterCount: 1, message: "mock export ok" };
        case "canon_export_project": return { success: true, warnings: [], fileCount: 5, totalSize: 1024, checksumSha256: "mock-sha256", sidecarPath: null, error: null };
        case "canon_verify_export": return { success: true, containerChecksumMatches: true, computedChecksum: "mock-sha256", manifestFound: true, fileCount: 5, contentDigestVerified: true, warnings: [], error: null };
        case "canon_auto_backup": return { success: true, backupPath: "C:/mock/proj/backups/auto/mock.zip", checksumSha256: "mock-sha256", warnings: [], error: null };
        case "export_backup": return { success: true, warnings: [], fileCount: 5, totalSize: 1024 };
        case "cancel_backup": return null;
        case "find_related_wiki_pages": return [];
        case "load_style_exemplars": return [];
        case "mark_style_exemplar":
        case "delete_style_exemplar":
        case "open_file_location":
        case "open_project_folder": return null;
        case "copy_directory": return [];
        case "preprocess_file": return "";
        case "read_file_as_base64": return { path: args && args.path, base64: "" };
        case "get_executable_dir": return "C:/mock/exe";
        case "get_resource_dir": return "C:/mock/res";
        default: return null;
      }
    }
  }
})()
`

/** mock 环境预期降级：产品代码已 catch 的路径（mock 数据不完整时必然触发，非产品缺陷）。 */
export const KNOWN_MOCK_DEGRADATION = [
  "persist: JSON 解析失败",
  "启动项目文件同步失败",
]

export const isKnownDegradation = (msg: string) =>
  KNOWN_MOCK_DEGRADATION.some((p) => msg.includes(p))

export function collectErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error" && !isKnownDegradation(m.text())) errors.push(m.text())
  })
  page.on("pageerror", (e) => errors.push(String(e)))
  return errors
}
