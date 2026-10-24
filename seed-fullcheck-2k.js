// 全量2K视觉取证 seed：包装 __TAURI_INTERNALS__.invoke，提供富 wiki 树 + .novel 台账。
(() => {
  const P = "C:/mock/proj"
  const md = (type, title, body) =>
    `---\ntype: ${type}\n---\n\n# ${title}\n\n${body}\n`
  const FILES = {
    [`${P}/wiki/chapters/chapter-001.md`]: md("chapter", "第一章 初见", "夜色沉静，少年推开旧宅的门。[[林烬]]在月光下看到了[[大战]]遗留的[[血玉佩]]。"),
    [`${P}/wiki/chapters/chapter-002.md`]: md("chapter", "第二章 夜宴", "灯火通明的夜宴上，[[林烬]]与[[苏菀]]相遇，席间有人传递了一封[[密信]]。[[夜宴]]暗藏杀机。"),
    [`${P}/wiki/chapters/chapter-003.md`]: md("chapter", "第三章 抉择", "[[林烬]]随[[莫老]]回到[[小镇]]，面对[[正邪之争]]，他必须做出抉择。"),
    [`${P}/wiki/characters/lin-jin.md`]: md("character", "林烬", "出身寒微的少年，亲历[[大战]]，在[[第一章 初见]]中拾得[[血玉佩]]，与[[苏菀]]结识于[[夜宴]]。"),
    [`${P}/wiki/characters/su-wan.md`]: md("character", "苏菀", "将门之女，与[[林烬]]在[[夜宴]]上相识。"),
    [`${P}/wiki/characters/mo-lao.md`]: md("character", "莫老", "隐居[[小镇]]的老者，持[[断剑]]，是[[林烬]]的引路人。"),
    [`${P}/wiki/characters/gu-ying.md`]: md("character", "孤影", "来历不明的独行客，尚未织入主线。"),
    [`${P}/wiki/events/war.md`]: md("event", "大战", "十年前的那场[[大战]]改变了一切，[[林烬]]的村庄在[[第一章 初见]]的回忆中被提及。"),
    [`${P}/wiki/events/feast.md`]: md("event", "夜宴", "[[苏菀]]主持的[[夜宴]]，[[第二章 夜宴]]的核心场景。"),
    [`${P}/wiki/locations/town.md`]: md("location", "小镇", "[[第三章 抉择]]发生之地，[[莫老]]隐居处。"),
    [`${P}/wiki/items/sword.md`]: md("item", "断剑", "[[莫老]]的佩剑，与[[血玉佩]]同出一源。"),
    [`${P}/wiki/foreshadowing/fo-a.md`]: md("foreshadowing", "血玉佩", "[[林烬]]在[[第一章 初见]]拾得的玉佩，与[[断剑]]呼应，尚未揭晓来历。"),
    [`${P}/wiki/foreshadowing/fo-b.md`]: md("foreshadowing", "断头设定", "一条尚未接入任何章节的废弃伏笔线。"),
    [`${P}/wiki/foreshadowing/fo-c.md`]: md("foreshadowing", "密信", "[[第二章 夜宴]]上出现的密信，写信人未知。"),
    [`${P}/wiki/secrets/sc-1.md`]: md("secret", "身世", "[[林烬]]的身世之谜。"),
    [`${P}/wiki/conflicts/cf-1.md`]: md("conflict", "正邪之争", "围绕[[大战]]余波展开的[[第三章 抉择]]核心冲突。"),
    [`${P}/.novel/foreshadowing-tracker.json`]: JSON.stringify({
      lastUpdated: new Date().toISOString(),
      items: [
        { id: "f1", name: "血玉佩", description: "林烬拾得的玉佩，来历未揭晓", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: ["林烬"], relatedEvents: ["大战"], notes: "" },
        { id: "f2", name: "密信", description: "夜宴上的密信，写信人未知", status: "advanced", plantedChapter: 2, advancedChapters: [2], relatedCharacters: ["苏菀"], relatedEvents: ["夜宴"], notes: "" },
        { id: "f3", name: "断头伏笔", description: "尚未接入任何章节的废弃线", status: "planted", plantedChapter: 3, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        { id: "f4", name: "身世", description: "林烬身世已揭晓", status: "resolved", plantedChapter: 1, advancedChapters: [2], resolvedChapter: 3, relatedCharacters: ["林烬"], relatedEvents: [], notes: "" },
        { id: "f5", name: "旧伤", description: "已废弃的旧设定", status: "abandoned", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
    }),
    [`${P}/.novel/emotion-ledger.json`]: JSON.stringify({
      lastUpdated: new Date().toISOString(),
      entries: [
        { characterName: "林烬", netValue: -0.68, valence: -0.6, arousal: 0.5, dominance: -0.4, lastUpdatedChapter: 3, history: [] },
        { characterName: "苏菀", netValue: 0.32, valence: 0.4, arousal: 0.2, dominance: 0.1, lastUpdatedChapter: 2, history: [] },
        { characterName: "莫老", netValue: -0.12, valence: -0.1, arousal: -0.2, dominance: 0.3, lastUpdatedChapter: 3, history: [] },
      ],
    }),
    [`${P}/.novel/status.json`]: JSON.stringify({
      schema_version: "1",
      session_id: "seed-fullcheck-2k",
      source: "deep_chapter_generation",
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-24T00:00:00.000Z",
      status: "completed",
      active_step_index: null,
      current_task: {
        task_id: "t1", conversation_id: "c1", user_request: "seed",
        chapter_number: 3, checkpoint_stage: "completed", status: "completed",
      },
      draft: { draft_id: "d1", file_path: "draft.md", draft_status: "accepted", updated_at: "2026-10-24T00:00:00.000Z" },
      decision_gates: {
        consistency: { status: "passed", verdict: "passed", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "passed", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "passed", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "passed",
      },
      evidence_refs: [],
      chase_debt: {
        debts: [
          { id: "cd1", debt_type: "hook_strength", original_amount: 10, current_amount: 12.5, interest_rate: 0.25, source_chapter: 1, due_chapter: 3, status: "overdue" },
          { id: "cd2", debt_type: "micropayoff", original_amount: 6, current_amount: 6, interest_rate: 0.1, source_chapter: 2, due_chapter: 5, status: "active" },
          { id: "cd3", debt_type: "coolpoint", original_amount: 8, current_amount: 8, interest_rate: 0.15, source_chapter: 1, due_chapter: 2, status: "paid" },
        ],
        debt_events: [
          { debt_id: "cd1", event_type: "created", amount: 10, chapter: 1 },
          { debt_id: "cd1", event_type: "interest_accrued", amount: 2.5, chapter: 3 },
          { debt_id: "cd3", event_type: "full_payment", amount: 8, chapter: 2 },
        ],
      },
    }),
  }
  const child = (dir, name, isDir, kids) => ({ name, path: `${P}/wiki/${dir ? dir + "/" : ""}${name}`, is_dir: isDir, ...(kids ? { children: kids } : {}) })
  const mdFile = (dir, name) => ({ name, path: `${P}/wiki/${dir}/${name}`, is_dir: false })
  const TREE = [
    child("", "chapters", true, ["chapter-001.md", "chapter-002.md", "chapter-003.md"].map((n) => mdFile("chapters", n))),
    child("", "characters", true, ["lin-jin.md", "su-wan.md", "mo-lao.md", "gu-ying.md"].map((n) => mdFile("characters", n))),
    child("", "events", true, ["war.md", "feast.md"].map((n) => mdFile("events", n))),
    child("", "locations", true, [mdFile("locations", "town.md")]),
    child("", "items", true, [mdFile("items", "sword.md")]),
    child("", "foreshadowing", true, ["fo-a.md", "fo-b.md", "fo-c.md"].map((n) => mdFile("foreshadowing", n))),
    child("", "secrets", true, [mdFile("secrets", "sc-1.md")]),
    child("", "conflicts", true, [mdFile("conflicts", "cf-1.md")]),
  ]
  const findDir = (segs) => {
    let level = TREE
    for (const s of segs) {
      const d = level.find((n) => n.is_dir && n.name === s)
      if (!d) return null
      level = d.children || []
    }
    return level
  }
  const internals = window.__TAURI_INTERNALS__
  const origInvoke = internals.invoke.bind(internals)
  internals.invoke = async (cmd, args) => {
    if (cmd === "list_directory") {
      const p = String((args && args.path) || "").replace(/\\/g, "/")
      const idx = p.indexOf("/wiki")
      if (idx >= 0) {
        const rest = p.slice(idx + "/wiki".length).split("/").filter(Boolean)
        if (rest.length === 0) return TREE
        const level = findDir(rest)
        if (level) return level
      }
      return origInvoke(cmd, args)
    }
    if (cmd === "read_file") {
      const p = String((args && args.path) || "").replace(/\\/g, "/")
      if (FILES[p] !== undefined) return FILES[p]
      return origInvoke(cmd, args)
    }
    return origInvoke(cmd, args)
  }
  window.__FULLCHECK_SEED__ = { fileCount: Object.keys(FILES).length }
})()
