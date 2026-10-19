/**
 * help-view.tsx — 帮助视图（纯静态内容）。
 *
 * ## 职责
 *   - 静态帮助：功能导航 / 操作说明 / 常见问题，文案全部写死在组件内；
 *   - 本地关键词过滤（纯前端过滤，无磁盘/网络 IO）。
 *
 * ## 数据源
 *   - 无：静态文案（`HELP_SECTIONS`）。刻意不断言未经核实的快捷键与外部链接；
 *     未引用 i18n（不新增 i18n key，见任务约束）。
 *
 * 中文 UI；只读；与项目无关（`projectPath` 保留统一签名，内部 void 以过 lint）。
 *
 * @license MIT © Niko Buddy
 */

import { useState } from "react"
import { LifeBuoy } from "lucide-react"

export interface HelpItem {
  readonly q: string
  readonly a: string
}

export interface HelpSection {
  readonly id: string
  readonly title: string
  readonly items: readonly HelpItem[]
}

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: "nav",
    title: "功能导航",
    items: [
      {
        q: "各视图是什么关系？",
        a: "左侧面板在各功能视图间切换：题材基底库/写法引擎等为只读浏览或受控操作；备份导出负责项目备份包，导出中心负责书稿导出（Word/EPUB），两者不要混用。",
      },
      {
        q: "只读视图会改我的文稿吗？",
        a: "不会。标注「只读」的视图只展示磁盘与配置现状，不写盘、不调模型；凡涉及写盘的操作都有明确按钮与二次确认。",
      },
      {
        q: "工作流页为什么不能编辑？",
        a: "仓库内没有可写工作流 DSL，工作流页只展示模板登记与运行事件账本，写回一律不做，这是刻意的设计约束而非缺失。",
      },
    ],
  },
  {
    id: "ops",
    title: "操作说明",
    items: [
      {
        q: "如何导出书稿？",
        a: "打开导出中心：先确认 final 章节计数大于 0，再点「导出 Word」或「导出 EPUB」，按界面显示的默认路径落盘；导出记录仅保留在本次会话内，不落盘。",
      },
      {
        q: "MCP 服务如何启停？",
        a: "打开 MCP 服务管理：开关立即落盘到全局配置；状态列只反映配置开关，不代表服务进程存活，增删与改命令请走设置页 MCP 分区。",
      },
      {
        q: "操作以按钮为准还是快捷键为准？",
        a: "以界面按钮与菜单操作为准；如无特别说明，不依赖记忆中的快捷键，具体以当前版本界面公告为准。",
      },
    ],
  },
  {
    id: "faq",
    title: "常见问题",
    items: [
      {
        q: "页面显示「未指定项目路径」怎么办？",
        a: "先在应用内打开一个项目再进入该视图；项目级视图需要项目路径才能装载磁盘数据。",
      },
      {
        q: "页面显示「暂无」「未生成」「数据未接入」是故障吗？",
        a: "不是故障，是诚实空态：对应数据在磁盘或配置中确实缺失，本应用不编造占位数据。按文案指引先完成上游步骤（如先生成题材基底、接入数据源）。",
      },
      {
        q: "页面显示「读取失败」怎么办？",
        a: "先检查项目文件权限与磁盘空间后重试；账本类失败会展示原始错误行，便于定位到具体损坏文件。",
      },
    ],
  },
]

/** 纯函数：关键词过滤（标题/问/答包含即保留；空关键词返回全量）。 */
export function filterHelpSections(
  sections: readonly HelpSection[],
  keyword: string,
): readonly HelpSection[] {
  const normalized = keyword.trim().toLowerCase()
  if (normalized === "") return sections
  const kept: HelpSection[] = []
  for (const section of sections) {
    if (section.title.toLowerCase().includes(normalized)) {
      kept.push(section)
      continue
    }
    const items = section.items.filter(
      (item) =>
        item.q.toLowerCase().includes(normalized) || item.a.toLowerCase().includes(normalized),
    )
    if (items.length > 0) kept.push({ ...section, items })
  }
  return kept
}

export interface HelpViewProps {
  /** 项目根路径（统一签名；帮助为静态内容，与项目无关）。 */
  readonly projectPath: string
}

export function HelpView({ projectPath }: HelpViewProps) {
  void projectPath
  const [keyword, setKeyword] = useState("")
  const visible = filterHelpSections(HELP_SECTIONS, keyword)

  return (
    <section data-testid="help-view" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <LifeBuoy className="h-4 w-4" />
        帮助
      </h2>
      <div className="flex items-center gap-2">
        <label htmlFor="help-search" className="text-xs text-muted-foreground">
          搜索帮助
        </label>
        <input
          id="help-search"
          data-testid="help-search"
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="输入关键词过滤，如：导出"
          className="w-64 rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </div>

      {visible.length === 0 ? (
        <p data-testid="help-no-match" className="text-xs text-muted-foreground">
          无匹配的帮助条目（关键词：{keyword.trim()}），请换个关键词再试。
        </p>
      ) : (
        <div data-testid="help-sections" className="flex flex-col gap-3">
          {visible.map((section) => (
            <div
              key={section.id}
              data-testid={`help-section-${section.id}`}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <p className="text-sm font-medium text-foreground">{section.title}</p>
              <dl className="mt-1 flex flex-col gap-2">
                {section.items.map((item) => (
                  <div key={item.q} data-testid="help-item">
                    <dt className="text-xs font-medium text-foreground">问：{item.q}</dt>
                    <dd className="mt-0.5 text-xs leading-5 text-muted-foreground">答：{item.a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
