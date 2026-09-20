// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/**
 * 工作台总览页（T1 底座）— niko-buddy 一体化工作台入口。
 *
 * 需求：所有功能经 UI 点击可达；UX 友好；资产/工作监控高效可视化。
 * 设计：模块卡片网格（点击切到对应 activeView）+ 顶部项目/生产状态条。
 * 复用：卡片→setActiveView 跳现有视图；后续新模块注册进 MODULE_CARDS 即可上卡。
 */

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  ArchiveRestore,
  BookOpen,
  BookMarked,
  Brain,
  Clapperboard,
  Database,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  Network,
  PenTool,
  Radar,
  ScrollText,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiState } from "@/stores/wiki-store"

type NavView = WikiState["activeView"]

interface ModuleCard {
  /** 跳转的 activeView；尚未实现的模块给目标视图名+disabled。 */
  view: NavView
  icon: LucideIcon
  labelKey: string
  descKey: string
  /** true=未实现，显示"即将上线"置灰。 */
  planned?: boolean
  /** 分组：production 生产链 / assets 资产库 / config 配置 / data 数据。 */
  group: "production" | "assets" | "config" | "data"
}

const GROUP_ORDER: ModuleCard["group"][] = ["production", "assets", "config", "data"]

const MODULE_CARDS: ModuleCard[] = [
  // 生产链
  { view: "director", icon: Clapperboard, labelKey: "wb.card.director", descKey: "wb.card.directorDesc", group: "production" },
  { view: "bookAnalysis", icon: BookOpen, labelKey: "wb.card.dismantling", descKey: "wb.card.dismantlingDesc", group: "production" },
  { view: "reviewCenter", icon: LayoutDashboard, labelKey: "wb.card.reviewCenter", descKey: "wb.card.reviewCenterDesc", group: "production" },
  { view: "graph", icon: Network, labelKey: "wb.card.graph", descKey: "wb.card.graphDesc", group: "production" },
  { view: "storySimulation", icon: Sparkles, labelKey: "wb.card.simulation", descKey: "wb.card.simulationDesc", group: "production" },
  { view: "followUpCenter", icon: ListChecks, labelKey: "wb.card.followUp", descKey: "wb.card.followUpDesc", group: "production", planned: true },
  { view: "liveExecution", icon: Radar, labelKey: "wb.card.live", descKey: "wb.card.liveDesc", group: "production", planned: true },
  { view: "bookshelf", icon: BookMarked, labelKey: "wb.card.bookshelf", descKey: "wb.card.bookshelfDesc", group: "production", planned: true },
  { view: "creativeHub", icon: PenTool, labelKey: "wb.card.creativeHub", descKey: "wb.card.creativeHubDesc", group: "production", planned: true },
  // 资产库
  { view: "skillLibrary", icon: Sparkles, labelKey: "wb.card.skillLibrary", descKey: "wb.card.skillLibraryDesc", group: "assets" },
  { view: "canonEditor", icon: ScrollText, labelKey: "wb.card.canonEditor", descKey: "wb.card.canonEditorDesc", group: "assets" },
  { view: "knowledgeLibrary", icon: BookOpen, labelKey: "wb.card.knowledge", descKey: "wb.card.knowledgeDesc", group: "assets", planned: true },
  { view: "worldLibrary", icon: FolderOpen, labelKey: "wb.card.worldLibrary", descKey: "wb.card.worldLibraryDesc", group: "assets", planned: true },
  { view: "genreLibrary", icon: FolderOpen, labelKey: "wb.card.genreLibrary", descKey: "wb.card.genreLibraryDesc", group: "assets", planned: true },
  { view: "storyModeLibrary", icon: FolderOpen, labelKey: "wb.card.storyMode", descKey: "wb.card.storyModeDesc", group: "assets", planned: true },
  { view: "titleStudio", icon: PenTool, labelKey: "wb.card.titleStudio", descKey: "wb.card.titleStudioDesc", group: "assets", planned: true },
  { view: "styleEngine", icon: Sparkles, labelKey: "wb.card.styleEngine", descKey: "wb.card.styleEngineDesc", group: "assets", planned: true },
  { view: "antiAiRules", icon: Brain, labelKey: "wb.card.antiAi", descKey: "wb.card.antiAiDesc", group: "assets", planned: true },
  // 配置
  { view: "settings", icon: Settings, labelKey: "wb.card.settings", descKey: "wb.card.settingsDesc", group: "config" },
  { view: "modelRoutes", icon: Network, labelKey: "wb.card.modelRoutes", descKey: "wb.card.modelRoutesDesc", group: "config", planned: true },
  { view: "mcpManager", icon: Network, labelKey: "wb.card.mcp", descKey: "wb.card.mcpDesc", group: "config", planned: true },
  { view: "workflowEditor", icon: Workflow, labelKey: "wb.card.workflowEditor", descKey: "wb.card.workflowEditorDesc", group: "config", planned: true },
  { view: "marketRadar", icon: Radar, labelKey: "wb.card.marketRadar", descKey: "wb.card.marketRadarDesc", group: "config", planned: true },
  { view: "help", icon: BookOpen, labelKey: "wb.card.help", descKey: "wb.card.helpDesc", group: "config", planned: true },
  // 数据
  { view: "backupExport", icon: ArchiveRestore, labelKey: "wb.card.backup", descKey: "wb.card.backupDesc", group: "data" },
  { view: "dataManager", icon: Database, labelKey: "wb.card.dataManager", descKey: "wb.card.dataManagerDesc", group: "data" },
  { view: "exportCenter", icon: ArchiveRestore, labelKey: "wb.card.exportCenter", descKey: "wb.card.exportCenterDesc", group: "data", planned: true },
]

export function WorkbenchView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const novelMode = useWikiStore((s) => s.novelMode)
  const setActiveView = useWikiStore((s) => s.setActiveView)

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((g) => ({
        group: g,
        cards: MODULE_CARDS.filter((c) => c.group === g),
      })),
    [],
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6" data-testid="workbench-view">
      {/* 顶部状态条：项目/模式 */}
      <div className="mb-5 flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">{t("wb.title")}</h1>
          <p className="text-xs text-muted-foreground">
            {project ? project.name : t("wb.noProject")}
            {novelMode ? ` · ${t("wb.novelMode")}` : ""}
          </p>
        </div>
        <LayoutDashboard className="h-6 w-6 text-muted-foreground" />
      </div>

      {/* 分组模块卡片 */}
      {groups.map(({ group, cards }) => (
        <section key={group} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            {t(`wb.group.${group}`)}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {cards.map((card) => {
              const Icon = card.icon
              return (
                <button
                  key={card.labelKey}
                  type="button"
                  disabled={card.planned}
                  onClick={() => setActiveView(card.view)}
                  data-workbench-card={card.view}
                  className={`group flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors ${
                    card.planned
                      ? "cursor-not-allowed opacity-50"
                      : "hover:border-primary/50 hover:bg-accent/50"
                  }`}
                >
                  <div className="flex w-full items-center justify-between">
                    <Icon className="h-5 w-5 text-muted-foreground group-hover:text-primary" />
                    {card.planned && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("wb.planned")}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-medium">{t(card.labelKey)}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {t(card.descKey)}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
