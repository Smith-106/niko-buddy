import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createMultiPovMesh,
  detectPovIntersections,
  generateConvergencePack,
  sliceContextForPov,
  type ChapterHistoryEntry,
  type MultiPovMesh,
  type UpcomingSceneDescriptor,
} from "./multi-pov-mesh"

describe("Multi-POV Parallel Mesh Framework", () => {
  describe("createMultiPovMesh", () => {
    it("should initialize a multi-POV mesh with provided characters and defaults", () => {
      const mesh = createMultiPovMesh({
        title: "双城争锋",
        characters: [
          {
            id: "char-1",
            name: "林越",
            role: "潜伏侦探",
            arcTheme: "在暗夜中追寻真相",
            knows: ["密令暗号", "死者身份"],
            doesNotKnow: ["幕后金主的真实面目", "毒药来源"],
          },
          {
            id: "char-2",
            name: "沈清秋",
            role: "财阀继承人",
            // 未提供 arcTheme、knows、doesNotKnow，测试默认降级
          },
        ],
      })

      expect(mesh.title).toBe("双城争锋")
      expect(mesh.threads).toHaveLength(2)

      const t1 = mesh.threads[0]
      expect(t1.id).toBe("pov-char-1")
      expect(t1.characterName).toBe("林越")
      expect(t1.arcTheme).toBe("在暗夜中追寻真相")
      expect(t1.epistemicScope.knows).toEqual(["密令暗号", "死者身份"])
      expect(t1.epistemicScope.doesNotKnow).toEqual(["幕后金主的真实面目", "毒药来源"])
      expect(t1.nodes).toEqual([])
      expect(t1.localSummarySlice).toBe("")

      const t2 = mesh.threads[1]
      expect(t2.id).toBe("pov-char-2")
      expect(t2.characterName).toBe("沈清秋")
      expect(t2.arcTheme).toBe("沈清秋的破局之路")
      expect(t2.epistemicScope.knows).toEqual([])
      expect(t2.epistemicScope.doesNotKnow).toEqual([])

      expect(mesh.intersections).toEqual([])
      expect(mesh.id).toMatch(/^mesh-\d+/)
      expect(mesh.createdAt).toBeTruthy()
      expect(mesh.updatedAt).toBeTruthy()
    })
  })

  describe("sliceContextForPov", () => {
    it("should return empty structure if target POV is not found", () => {
      const mesh = createMultiPovMesh({
        title: "测试",
        characters: [{ id: "c1", name: "角色1", role: "主角" }],
      })

      const res = sliceContextForPov(mesh, "non-existent-pov", 5, [])
      expect(res.directive).toBe("")
      expect(res.ownRecentSummary).toBe("")
      expect(res.observableExternalEvents).toEqual([])
      expect(res.epistemicConstraints).toEqual([])
    })

    it("should handle first appearance without prior slices or history", () => {
      const mesh = createMultiPovMesh({
        title: "测试",
        characters: [{ id: "c1", name: "角色1", role: "主角" }],
      })

      const res = sliceContextForPov(mesh, "pov-c1", 1, [])
      expect(res.ownRecentSummary).toBe("（本视角初次登场，尚无前序独立切片）")
      expect(res.observableExternalEvents).toHaveLength(0)
      expect(res.directive).toContain("此时未与该视点交汇，角色对外界隐秘毫不知情")
    })

    it("should use localSummarySlice if present when no history chapter exists", () => {
      const mesh = createMultiPovMesh({
        title: "测试",
        characters: [{ id: "c1", name: "角色1", role: "主角" }],
      })
      mesh.threads[0].localSummarySlice = "这是角色1初始背景切片"

      const res = sliceContextForPov(mesh, "c1", 1, [])
      expect(res.ownRecentSummary).toBe("这是角色1初始背景切片")
    })

    it("should select the most recent history chapter summary belonging to the target POV", () => {
      const mesh = createMultiPovMesh({
        title: "测试",
        characters: [
          { id: "c1", name: "角色1", role: "主角" },
          { id: "c2", name: "角色2", role: "反派" },
        ],
      })

      const history: ChapterHistoryEntry[] = [
        { chapterNumber: 1, povId: "pov-c1", summary: "第1章林越潜入商会" },
        { chapterNumber: 2, povId: "pov-c2", summary: "第2章沈清秋在公馆下令" }, // 他人视角，隔离
        { chapterNumber: 3, povId: "pov-c1", summary: "第3章林越盗取账本并负伤逃离" },
        { chapterNumber: 5, povId: "pov-c1", summary: "未来章节不可见" },
      ]

      const res = sliceContextForPov(mesh, "pov-c1", 4, history)
      expect(res.ownRecentSummary).toBe("第3章林越盗取账本并负伤逃离")
      expect(res.directive).toContain("第3章林越盗取账本并负伤逃离")
      expect(res.directive).not.toContain("第2章沈清秋在公馆下令")
    })

    it("should include epistemic exchanges and past intersection events for the POV", () => {
      const mesh = createMultiPovMesh({
        title: "测试",
        characters: [
          {
            id: "c1",
            name: "林越",
            role: "侦探",
            doesNotKnow: ["沈清秋是真正的幕后资助者"],
          },
          { id: "c2", name: "沈清秋", role: "总裁" },
        ],
      })

      mesh.intersections.push(
        {
          id: "inter-1",
          chapterNumber: 2,
          involvedPovIds: ["pov-c1", "pov-c2"],
          intersectionType: "direct_encounter",
          description: "林越在雨夜码头偶遇沈清秋的车队",
        },
        {
          id: "inter-2",
          chapterNumber: 3,
          involvedPovIds: ["pov-c1", "pov-c2"],
          intersectionType: "information_leak",
          description: "双方在拍卖行交手",
          epistemicExchange: [
            {
              fromPovId: "pov-c2",
              toPovId: "pov-c1",
              factShared: "沈清秋故意遗留了刻有金蛇印记的打火机",
            },
            {
              fromPovId: "pov-c1",
              toPovId: "pov-c2",
              factShared: "林越展现了军警格斗术",
            },
          ],
        },
        {
          id: "inter-future",
          chapterNumber: 10,
          involvedPovIds: ["pov-c1", "pov-c2"],
          intersectionType: "conflict_collision",
          description: "未来决战",
        },
      )

      const res = sliceContextForPov(mesh, "pov-c1", 4, [])
      expect(res.observableExternalEvents).toContain("[第 2 章交汇事件] 林越在雨夜码头偶遇沈清秋的车队")
      expect(res.observableExternalEvents).toContain(
        "[第 3 章交汇情报] 沈清秋故意遗留了刻有金蛇印记的打火机",
      )
      // 未来章节交汇绝不泄露
      expect(res.observableExternalEvents.some((e) => e.includes("未来决战"))).toBe(false)
      // 认知铁律
      expect(res.epistemicConstraints).toContain("【禁止描写】：林越此时绝对不知晓【沈清秋是真正的幕后资助者】")
      expect(res.directive).toContain("认知视窗防穿帮铁律")
    })
  })

  describe("detectPovIntersections", () => {
    let mesh: MultiPovMesh

    beforeEach(() => {
      mesh = createMultiPovMesh({
        title: "织网测试",
        characters: [
          { id: "c1", name: "林越", role: "主角" },
          { id: "c2", name: "沈清秋", role: "配角" },
          { id: "c3", name: "第三方", role: "路人" },
        ],
      })
    })

    it("should ignore scenes belonging to the same POV", () => {
      const plannedScenes: UpcomingSceneDescriptor[] = [
        { chapterNumber: 1, povId: "pov-c1", location: "藏书阁", eventSummary: "查阅古籍" },
        { chapterNumber: 1, povId: "pov-c1", location: "藏书阁", eventSummary: "触发机关" },
      ]

      const intersections = detectPovIntersections(mesh, plannedScenes)
      expect(intersections).toHaveLength(0)
    })

    it("should detect direct encounter in the same chapter and same location", () => {
      const plannedScenes: UpcomingSceneDescriptor[] = [
        { chapterNumber: 5, povId: "pov-c1", location: "翡翠酒庄", eventSummary: "搜查暗室" },
        { chapterNumber: 5, povId: "pov-c2", location: "翡翠酒庄", eventSummary: "会见神秘线人" },
      ]

      const intersections = detectPovIntersections(mesh, plannedScenes)
      expect(intersections).toHaveLength(1)
      expect(intersections[0].intersectionType).toBe("direct_encounter")
      expect(intersections[0].chapterNumber).toBe(5)
      expect(intersections[0].involvedPovIds).toEqual(["pov-c1", "pov-c2"])
      expect(mesh.intersections).toHaveLength(1)
    })

    it("should detect conflict collision when competing for the same target item or goal", () => {
      const plannedScenes: UpcomingSceneDescriptor[] = [
        {
          chapterNumber: 6,
          povId: "pov-c1",
          // location 省略以覆盖 '同场景' fallback
          targetItemOrGoal: "青铜残片",
          eventSummary: "志在必得举牌",
        },
        {
          chapterNumber: 6,
          povId: "pov-c2",
          targetItemOrGoal: "青铜残片",
          eventSummary: "暗中截胡",
        },
      ]

      const intersections = detectPovIntersections(mesh, plannedScenes)
      expect(intersections).toHaveLength(1)
      expect(intersections[0].intersectionType).toBe("conflict_collision")
      expect(intersections[0].targetItemOrGoal).toBe("青铜残片")
      expect(intersections[0].description).toContain("在 [同场景] 发生对撞")
    })

    it("should detect shared location across adjacent chapters (offset <= 2)", () => {
      const plannedScenes: UpcomingSceneDescriptor[] = [
        { chapterNumber: 3, povId: "pov-c1", location: "荒废古庙", eventSummary: "在此躲避追兵" },
        { chapterNumber: 5, povId: "pov-c2", location: "荒废古庙", eventSummary: "追踪遗留痕迹" },
      ]

      const intersections = detectPovIntersections(mesh, plannedScenes)
      expect(intersections).toHaveLength(1)
      expect(intersections[0].intersectionType).toBe("shared_location")
      expect(intersections[0].chapterNumber).toBe(5) // 取 max(3, 5)
      expect(intersections[0].description).toContain("先后到达 [荒废古庙]")
    })

    it("should not detect intersection if chapter distance > 2 even with same location", () => {
      const plannedScenes: UpcomingSceneDescriptor[] = [
        { chapterNumber: 1, povId: "pov-c1", location: "荒废古庙", eventSummary: "停留" },
        { chapterNumber: 4, povId: "pov-c2", location: "荒废古庙", eventSummary: "停留" },
      ]

      const intersections = detectPovIntersections(mesh, plannedScenes)
      expect(intersections).toHaveLength(0)
    })

    it("should deduplicate existing intersections in mesh", () => {
      const plannedScenes: UpcomingSceneDescriptor[] = [
        { chapterNumber: 5, povId: "pov-c1", location: "大厅", eventSummary: "A" },
        { chapterNumber: 5, povId: "pov-c2", location: "大厅", eventSummary: "B" },
      ]

      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000000)
      const firstPass = detectPovIntersections(mesh, plannedScenes)
      expect(firstPass).toHaveLength(1)
      expect(mesh.intersections).toHaveLength(1)

      // 第二次在相同时间戳调用，生成的 id 相同，不会重复推入 mesh.intersections
      const secondPass = detectPovIntersections(mesh, plannedScenes)
      expect(secondPass).toHaveLength(1)
      expect(mesh.intersections).toHaveLength(1)

      dateSpy.mockRestore()
    })
  })

  describe("generateConvergencePack", () => {
    it("should format convergence directives with characters and P0/P2 rules", () => {
      const mesh = createMultiPovMesh({
        title: "对决",
        characters: [
          { id: "c1", name: "林越", role: "主角" },
          { id: "c2", name: "沈清秋", role: "反派" },
        ],
      })

      const directive = generateConvergencePack(mesh, {
        id: "inter-10",
        chapterNumber: 8,
        involvedPovIds: ["pov-c1", "pov-c2", "unknown-char-id"],
        intersectionType: "conflict_collision",
        location: "九龙码头",
        targetItemOrGoal: "走私密函",
        description: "交锋",
      })

      expect(directive).toContain("【视点交汇硬约束 (Convergence Directive) · 第 8 章】")
      expect(directive).toContain("林越 与 沈清秋 与 unknown-char-id")
      expect(directive).toContain("conflict_collision")
      expect(directive).toContain("九龙码头")
      expect(directive).toContain("走私密函")
      expect(directive).toContain("叙事事实一致性底线（P0）")
      expect(directive).toContain("心理叙事实体分歧（P2）")
    })

    it("should fallback gracefully if location or goal is missing", () => {
      const mesh = createMultiPovMesh({
        title: "偶遇",
        characters: [{ id: "c1", name: "林越", role: "主角" }],
      })

      const directive = generateConvergencePack(mesh, {
        id: "inter-11",
        chapterNumber: 2,
        involvedPovIds: ["pov-c1"],
        intersectionType: "direct_encounter",
        description: "偶遇",
      })

      expect(directive).toContain("发生地点：未知空间")
      expect(directive).toContain("核心冲突目标：无特定物质争夺")
    })
  })
})
