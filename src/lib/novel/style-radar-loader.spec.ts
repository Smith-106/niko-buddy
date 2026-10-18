// @vitest-environment node
/**
 * 章纲定位子弹解析：模板占位（`1-5`）不是数据。
 *
 * 这条 spec 存在的理由：v2.18.0 的 loader 用 `(\d{1,2})` 抓区间前缀，
 * 把未填写的章纲模板读成「压力级 1 / 情绪强度 1」，等于凭空造目标节奏。
 */
import { describe, expect, it } from "vitest"
import { parseOutlinePositionBullets } from "./style-radar-loader"

describe("parseOutlinePositionBullets", () => {
  it("模板占位区间不产生数值", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：1-5\n- 情绪强度：1-10")
    expect(parsed.pressureLevel).toBeNull()
    expect(parsed.emotionIntensity).toBeNull()
  })

  it("真实数值按标签取值", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：3\n- 情绪强度：7")
    expect(parsed.pressureLevel).toBe(3)
    expect(parsed.emotionIntensity).toBe(7)
  })

  it("超出量纲范围的数值不采纳", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：9\n- 情绪强度：11")
    expect(parsed.pressureLevel).toBeNull()
    expect(parsed.emotionIntensity).toBeNull()
  })

  it("带括号说明的数值仍然可读", () => {
    const parsed = parseOutlinePositionBullets("- 压力级：4（对峙）")
    expect(parsed.pressureLevel).toBe(4)
  })

  it("缺标签即 N/A", () => {
    expect(parseOutlinePositionBullets("本章无定位子弹").pressureLevel).toBeNull()
  })
})
