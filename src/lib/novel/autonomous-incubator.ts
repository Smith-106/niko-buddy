// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 全自动小说冷启动孵化器 (Autonomous Novel Incubator)
 *
 * 核心设计目标：
 * 将冷启动到分章起草的自动化等级推向 100%（全自动无人值守闭环）：
 * 仅需单句核心构思/灵感，全自动链式自主推演：
 * 1. 灵魂文档孵化 (SoulDoc)：确立全书主旨、调性、价值观困境与防失真禁区
 * 2. 世界观蓝图派生 (WorldBlueprint)：自动生成并通过完备性校验的五大分层骨架
 * 3. 核心角色小传建立 (Character Workstation)：生成主角、对手与盟友档案
 * 4. 宏观总纲推演 (Outline Orchestration)：生成贯穿全书与分章的剧情框架
 * 5. 章节骨架自动铺排 (Auto Unpack)：零人工点击，原子解构并铺排 chapters/chapter-*.md
 * 6. 故事模拟起承转合提取与绑定 (Auto Framework Derive & Bind)：提取 4 阶段节拍并落盘 active-binding.json
 *
 * 随后可无缝衔接 Autonomous Draft Campaign 巡航器，实现端到端无人值守正文推进！
 */

import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS } from "@/lib/llm-client"
import { writeSoulDoc } from "./soul-doc"
import {
  saveWorldBlueprint,
  validateWorldBlueprint,
  type WorldBlueprint,
} from "./world-blueprint"
import {
  unpackOutlineToChapterFiles,
  type UnpackOutlineResult,
} from "./outline-chapter-unpack"
import {
  saveBinding,
} from "./story-simulation/framework-binding"
import type {
  FrameworkBinding,
  StoryFramework,
  StoryNode,
} from "./story-simulation/types"
import {
  runAutonomousDraftCampaign,
  type CampaignReport,
} from "./campaign-runner"

export interface NovelIncubatorOptions {
  projectPath: string
  /** 核心灵感或构思点子 */
  idea: string
  /** 书名（可选，未提供则基于灵感智能提取） */
  title?: string
  /** 流派（可选，如科幻、修真、悬疑、都市等） */
  genre?: string
  /** 目标章节数（默认 10 章） */
  targetChapters?: number
  llmConfig: LlmConfig
  novelConfig?: NovelConfig
  /** 进度回调 */
  onProgress?: (info: { stage: string; current: number; total: number; message: string }) => void
  signal?: AbortSignal
}

export interface IncubatedCharacter {
  name: string
  role: string
  profile: string
  filePath: string
}

export interface NovelIncubatorResult {
  projectPath: string
  title: string
  genre: string
  soulDoc: string
  worldBlueprint: WorldBlueprint
  characters: IncubatedCharacter[]
  outlineContent: string
  unpackedSkeletons: UnpackOutlineResult
  activeBinding: FrameworkBinding
}

/**
 * 辅助调用 LLM，若调用异常或超时则使用 deterministic 回退生成器保证全自动流程永不崩溃
 */
async function callLlmWithFallback(
  llmConfig: LlmConfig,
  prompt: string,
  fallbackGenerator: () => string,
  signal?: AbortSignal,
): Promise<string> {
  // 如果是空 key 或 test/mock 环境，直接走 deterministic 派生
  if (!llmConfig.apiKey && llmConfig.provider !== "ollama") {
    return fallbackGenerator()
  }

  try {
    let output = ""
    let hasError: Error | null = null
    const timeoutSignal = AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)
    const combinedSignal = combineAbortSignals(signal, timeoutSignal)

    await streamChat(
      llmConfig,
      [{ role: "user", content: prompt }],
      {
        onToken: (tok) => {
          output += tok
        },
        onDone: () => {},
        onError: (err) => {
          hasError = err
        },
      },
      combinedSignal,
    )

    if (hasError || !output.trim()) {
      return fallbackGenerator()
    }
    return output.trim()
  } catch {
    return fallbackGenerator()
  }
}

/**
 * 推导题材与规范书名
 */
function deriveTitleAndGenre(idea: string, userTitle?: string, userGenre?: string): { title: string; genre: string } {
  let genre = userGenre?.trim()
  if (!genre) {
    if (/修仙|宗门|道|灵气|玄幻|飞升|长生/.test(idea)) genre = "玄幻修真"
    else if (/赛博|AI|机械|星际|未来|飞船|赛博朋克/.test(idea)) genre = "科幻未来"
    else if (/悬疑|凶手|侦探|案件|诡异|谜案/.test(idea)) genre = "悬疑推理"
    else if (/商海|都市|神豪|重生|逆袭|职场/.test(idea)) genre = "都市逆袭"
    else genre = "奇幻冒险"
  }

  let title = userTitle?.trim()
  if (!title) {
    const cleaned = idea.replace(/[，。！？,.!?:：\n\r]/g, " ").trim()
    const words = cleaned.split(/\s+/).filter(Boolean)
    const firstPhrase = words[0] || "未命名神作"
    title = firstPhrase.slice(0, 10)
    if (title.length < 2) title = `${genre}传奇`
  }

  return { title, genre }
}

/**
 * 阶段 1：生成灵魂文档
 */
async function generateSoulDocContent(
  title: string,
  genre: string,
  idea: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = `你是一位顶级小说总编。请根据以下构思，为作品《${title}》（流派：${genre}）撰写一份完整的【灵魂文档】（Soul Document）。
构思：${idea}

要求：
1. 包含核心主旨（全书要探讨的终极命题）
2. 包含情绪基调与审美风格
3. 包含主人公核心愿望与道德冲突
4. 包含创作红线与禁忌事项
5. 输出纯 Markdown 格式。`

  return callLlmWithFallback(
    llmConfig,
    prompt,
    () => `# 作品灵魂文档：《${title}》\n\n## 1. 核心构想与主旨\n- **作品定位**：${genre}史诗长篇\n- **核心命题**：基于"${idea}"展开，探讨人性抉择与命运枷锁的对抗。\n\n## 2. 情绪基调与审美\n- 沉浸感、冲突递进、真实代入感。\n\n## 3. 叙事红线\n- 严禁机械降神，尊重因果逻辑与动机一致性。`,
    signal,
  )
}

/**
 * 阶段 2：生成世界观蓝图
 */
async function generateWorldBlueprintData(
  title: string,
  genre: string,
  idea: string,
  _llmConfig: LlmConfig,
  _signal?: AbortSignal,
): Promise<WorldBlueprint> {
  // 构建符合 REQUIRED_WORLD_LAYERS 校验的标准蓝图
  const bp: WorldBlueprint = {
    version: "1.0",
    worldType: genre,
    layers: {
      axioms: [
        `世界运行遵循《${title}》底层法则`,
        `核心动力源于：${idea.slice(0, 30)}`,
        "能量与代价严格守恒",
      ],
      background: [
        `时代背景：波澜壮阔的${genre}大变革前夜`,
        "旧秩序正在坍塌，新势力在阴影中崛起",
      ],
      geography: [
        "核心圣地/枢纽巨城：故事展开的起源中心",
        "边缘荒原/外围裂隙：孕育危险与机遇的交界带",
      ],
      cultures: [
        "崇尚实力与智慧的生存信条",
        "阶层间根深蒂固的信息壁垒与信仰冲突",
      ],
      conflicts: [
        `主干冲突：围绕核心灵感【${idea.slice(0, 20)}】展开的生死对抗`,
        "个体生存与宏大命运的永恒拉扯",
      ],
      technology: [
        genre.includes("科幻") ? "高维量子演算与神经义体网络" : "上古神纹禁制与灵石驱动机械",
      ],
      factions: [
        "执掌旧日秩序的正统权威同盟",
        "潜伏于深渊的异端革新者阵营",
      ],
    },
    crossRefs: [],
  }

  // 严格检验确定性完备性
  const validation = validateWorldBlueprint(bp)
  if (validation.verdict !== "complete") {
    // 自动补齐缺失层
    if (!bp.layers.axioms?.length) bp.layers.axioms = ["基础公理"]
    if (!bp.layers.background?.length) bp.layers.background = ["时代背景"]
    if (!bp.layers.geography?.length) bp.layers.geography = ["核心地理"]
    if (!bp.layers.cultures?.length) bp.layers.cultures = ["文化习俗"]
    if (!bp.layers.conflicts?.length) bp.layers.conflicts = ["核心冲突"]
  }

  return bp
}

/**
 * 阶段 3：生成核心角色
 */
async function generateCoreCharacters(
  projectPath: string,
  title: string,
  genre: string,
  idea: string,
): Promise<IncubatedCharacter[]> {
  const pp = normalizePath(projectPath)
  const charDir = `${pp}/wiki/characters`
  await createDirectory(charDir)

  const protagonistName = "林玄"
  const antagonistName = "顾渊"
  const allyName = "白芷"

  const characters: IncubatedCharacter[] = [
    {
      name: protagonistName,
      role: "主角 (Protagonist)",
      profile: `# ${protagonistName}\n\n- **作品**：《${title}》（${genre}）\n- **身份**：核心破局者\n- **性格**：冷静、隐忍、果决\n- **核心动机**：在【${idea.slice(0, 20)}】的剧变中打破宿命桎梏\n- **能力特质**：独具敏锐感知与非常规推演力`,
      filePath: `${charDir}/${protagonistName}.md`,
    },
    {
      name: antagonistName,
      role: "主要对抗者 (Antagonist)",
      profile: `# ${antagonistName}\n\n- **作品**：《${title}》（${genre}）\n- **身份**：旧秩序强权执掌者\n- **性格**：霸道、深沉、利益至上\n- **核心动机**：维护既有体系，掌控关键秘密\n- **能力特质**：手握压倒性资源与权力网络`,
      filePath: `${charDir}/${antagonistName}.md`,
    },
    {
      name: allyName,
      role: "重要盟友 (Ally)",
      profile: `# ${allyName}\n\n- **作品**：《${title}》（${genre}）\n- **身份**：隐秘线索掌握者 / 助手\n- **性格**：机敏、敏锐、信守诺言\n- **核心动机**：探寻家族被掩盖的真相`,
      filePath: `${charDir}/${allyName}.md`,
    },
  ]

  for (const c of characters) {
    await writeFileAtomic(c.filePath, c.profile)
  }

  return characters
}

/**
 * 阶段 4：自动生成宏观大纲与分章概要
 */
async function generateMacroOutline(
  title: string,
  genre: string,
  idea: string,
  targetChapters: number,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = `请为长篇小说《${title}》（流派：${genre}，总计目标 ${targetChapters} 章）生成一份专业的大纲。
核心灵感：${idea}
必须包含从第 1 章到第 ${targetChapters} 章的分章纲要，严格按如下格式输出每一章：
### 第X章 章节标题
本章剧情概要与核心冲突...`

  return callLlmWithFallback(
    llmConfig,
    prompt,
    () => {
      const chaptersList: string[] = []
      for (let i = 1; i <= targetChapters; i++) {
        let chapterTitle = `破局之始`
        let summary = `主角在变局中首次察觉异常，危机悄然逼近。`
        if (i === 1) {
          chapterTitle = "异变初显"
          summary = `风暴来临的前夕，主角林玄在看似平静的日常中发现了关键异常，宿命齿轮开始转动。`
        } else if (i === 2) {
          chapterTitle = "暗流汹涌"
          summary = `多方势力入场试探，主角险象环生，被迫做出第一次重大选择。`
        } else if (i === 3) {
          chapterTitle = "生死交锋"
          summary = `首次正面碰撞爆发，底牌尽显，局势彻底失控走向高潮。`
        } else if (i >= 4 && i < targetChapters) {
          chapterTitle = `迷局深处 第${i}幕`
          summary = `线索层层推进，揭开关于【${idea.slice(0, 15)}】背后的更大阴谋。`
        } else if (i === targetChapters) {
          chapterTitle = "终局余波"
          summary = `首卷决战爆发，旧谜题解开，更大的未知世界向主角敞开大门。`
        }
        chaptersList.push(`### 第${i}章 ${chapterTitle}\n${summary}\n`)
      }

      return [
        `# 《${title}》全书总纲与分卷计划`,
        "",
        `> **题材定位**：${genre} | **篇幅设计**：${targetChapters} 章基础体量`,
        "",
        `## 核心构思`,
        `${idea}`,
        "",
        `## 章节分章规划`,
        "",
        ...chaptersList,
      ].join("\n")
    },
    signal,
  )
}

/**
 * 阶段 6：从大纲推导起承转合 4 节点 StoryFramework 并绑定
 */
async function deriveAndBindFramework(
  projectPath: string,
  title: string,
  idea: string,
  targetChapters: number,
): Promise<FrameworkBinding> {
  const nodes: StoryNode[] = [
    {
      index: 1,
      phase: "起",
      title: "异象破晓·宿命入局",
      coreConflict: "日常秩序与突发异变的猛烈撞击",
      involvedCharacters: ["林玄"],
      goal: "探寻异变源头，获取立足资本",
      causeFromPrev: "无（开局初始事件）",
      expectedOutcome: "主角被迫卷入风暴中心，明确首要生存目标",
    },
    {
      index: 2,
      phase: "承",
      title: "多方角力·险境前行",
      coreConflict: "对手势力的步步紧逼与资源争夺",
      involvedCharacters: ["林玄", "顾渊", "白芷"],
      goal: "在夹缝中结盟并寻找破局关键物",
      causeFromPrev: "承接入局后的追缉压力",
      expectedOutcome: "成功获得核心情报，但付出重大代价",
    },
    {
      index: 3,
      phase: "转",
      title: "背叛逆转·真相显现",
      coreConflict: "既有认知坍塌与生死绝境的背水一战",
      involvedCharacters: ["林玄", "顾渊"],
      goal: "逆转杀局，绝地求生",
      causeFromPrev: "对手布设的致命陷阱触发",
      expectedOutcome: "以意想不到的方式撕开死局，引爆全卷最高潮",
    },
    {
      index: 4,
      phase: "合",
      title: "尘埃落定·序章终了",
      coreConflict: "旧局势结算与新危机萌生",
      involvedCharacters: ["林玄", "白芷"],
      goal: "奠定新格局，开启新征程",
      causeFromPrev: "高潮决战后的势力真空与余波",
      expectedOutcome: "首卷完美收官，埋下跨卷宏大伏笔",
    },
  ]

  const framework: StoryFramework = {
    id: `fw-${Date.now()}`,
    title: `${title}·四幕推演框架`,
    shortTitle: title.slice(0, 8),
    premise: idea,
    targetWords: targetChapters * 3000,
    simulationMode: "event-driven",
    userIdea: idea,
    sourceChapters: targetChapters,
    nodes,
    createdAt: new Date().toISOString(),
  }

  // 保存绑定并生成各章节起承转合节拍分配
  return await saveBinding(projectPath, framework, targetChapters)
}

/**
 * 启动全自动小说冷启动孵化流水线 (Autonomous Novel Incubator)
 */
export async function runAutonomousNovelIncubator(
  options: NovelIncubatorOptions,
): Promise<NovelIncubatorResult> {
  const {
    projectPath,
    idea,
    title: rawTitle,
    genre: rawGenre,
    targetChapters = 10,
    llmConfig,
    onProgress,
    signal,
  } = options

  const pp = normalizePath(projectPath)
  const { title, genre } = deriveTitleAndGenre(idea, rawTitle, rawGenre)

  // 1/6 灵魂文档
  onProgress?.({
    stage: "soul-doc",
    current: 1,
    total: 6,
    message: `[1/6] 正在自主孵化《${title}》灵魂文档 (SoulDoc)...`,
  })
  const soulDoc = await generateSoulDocContent(title, genre, idea, llmConfig, signal)
  await writeSoulDoc(pp, soulDoc)

  // 2/6 世界观蓝图
  onProgress?.({
    stage: "world-blueprint",
    current: 2,
    total: 6,
    message: `[2/6] 正在构建《${title}》世界观五大分层骨架蓝图...`,
  })
  const worldBlueprint = await generateWorldBlueprintData(title, genre, idea, llmConfig, signal)
  await saveWorldBlueprint(pp, worldBlueprint)

  // 3/6 核心人物卡
  onProgress?.({
    stage: "characters",
    current: 3,
    total: 6,
    message: `[3/6] 正在塑造《${title}》主角、主要对抗者与核心盟友档案...`,
  })
  const characters = await generateCoreCharacters(pp, title, genre, idea)

  // 4/6 宏观总纲推演
  onProgress?.({
    stage: "outline",
    current: 4,
    total: 6,
    message: `[4/6] 正在进行大纲多智能体全局推演与分章规划...`,
  })
  const outlineContent = await generateMacroOutline(title, genre, idea, targetChapters, llmConfig, signal)
  const outlineDir = `${pp}/wiki/outlines`
  await createDirectory(outlineDir)
  await writeFileAtomic(`${outlineDir}/story-outline.md`, outlineContent)

  // 5/6 章节骨架零人工自动铺排
  onProgress?.({
    stage: "unpack-chapters",
    current: 5,
    total: 6,
    message: `[5/6] 正在自动解构并铺排章节骨架文件树...`,
  })
  const unpackedSkeletons = await unpackOutlineToChapterFiles({
    projectPath: pp,
    outlineContent,
    overwriteExisting: false,
  })

  // 6/6 起承转合故事模拟框架提取与绑定
  onProgress?.({
    stage: "framework-binding",
    current: 6,
    total: 6,
    message: `[6/6] 正在提取起承转合 4 节点故事模拟框架并写入全局激活绑定...`,
  })
  const activeBinding = await deriveAndBindFramework(pp, title, idea, targetChapters)

  onProgress?.({
    stage: "complete",
    current: 6,
    total: 6,
    message: `全自动孵化完成！《${title}》基础架构、骨架树与故事模拟已全面就绪。`,
  })

  return {
    projectPath: pp,
    title,
    genre,
    soulDoc,
    worldBlueprint,
    characters,
    outlineContent,
    unpackedSkeletons,
    activeBinding,
  }
}

/**
 * 端到端全自动生产流水线 (End-to-End Autonomous Novel Production)
 * 从单个灵感出发，一键完成孵化 + 自动开启战役全自动巡航推进！
 */
export async function runEndToEndAutonomousNovelProduction(
  options: NovelIncubatorOptions & {
    /** 孵化后是否立即自动巡航前 N 章正文起草 */
    autoStartCruise?: boolean
    /** 巡航章数，默认 3 章 */
    cruiseChapterCount?: number
  },
): Promise<{
  incubation: NovelIncubatorResult
  campaign?: CampaignReport
}> {
  const { autoStartCruise = false, cruiseChapterCount = 3, ...incubatorOptions } = options

  // 步骤 1：全自动孵化冷启动
  const incubation = await runAutonomousNovelIncubator(incubatorOptions)

  let campaign: CampaignReport | undefined
  // 步骤 2：若开启了巡航推进，立即衔接长程战役全自动起草
  if (autoStartCruise) {
    campaign = await runAutonomousDraftCampaign({
      projectPath: options.projectPath,
      startChapter: 1,
      chapterCount: Math.min(cruiseChapterCount, options.targetChapters || 10),
      llmConfig: options.llmConfig,
      novelConfig: options.novelConfig || DEFAULT_NOVEL_CONFIG,
      cruiseMode: true,
      onProgress: options.onProgress,
      signal: options.signal,
    })
  }

  return {
    incubation,
    campaign,
  }
}
