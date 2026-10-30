import { describe, expect, it } from "vitest"
import { missingIdeaFields } from "./director-view-helpers"

const labels: Record<string, string> = {
  "directorPanel.ideaTitleField": "书名",
  "directorPanel.ideaGenreField": "题材",
  "directorPanel.ideaConflictField": "核心冲突",
}
const t = (key: string) => labels[key] ?? key

describe("missingIdeaFields", () => {
  it("按表单顺序列出空白必填项（空格视为未填）", () => {
    expect(missingIdeaFields({ title: " ", genre: "悬疑", coreConflict: "" }, t)).toEqual(["书名", "核心冲突"])
  })

  it("全部填写时为空数组；缺失立意对象时三项都缺", () => {
    expect(missingIdeaFields({ title: "雾都", genre: "悬疑", coreConflict: "连环失踪" }, t)).toEqual([])
    expect(missingIdeaFields(null, t)).toEqual(["书名", "题材", "核心冲突"])
  })
})
