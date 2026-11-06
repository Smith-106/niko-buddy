/** C4 冒烟覆盖：src/lib/novel/data-domain-registry.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DATA_DOMAINS, TRASH_BIN_DIR, trashBinPath, domainRequiresTypedConfirm } from "./data-domain-registry"
describe("data-domain-registry.ts smoke", () => {
  it("exports DATA_DOMAINS", () => {
    expect(DATA_DOMAINS).toBeDefined()
  })
  it("exports TRASH_BIN_DIR", () => {
    expect(TRASH_BIN_DIR).toBeDefined()
  })
  it("exports trashBinPath", () => {
    expect(trashBinPath).toBeDefined()
  })
  it("exports domainRequiresTypedConfirm", () => {
    expect(domainRequiresTypedConfirm).toBeDefined()
  })

  it("trashBinPath 拼出 .trash-bin/<stamp>/<domainId> 的相对路径", () => {
    expect(TRASH_BIN_DIR).toBe(".trash-bin")
    expect(trashBinPath("wiki", "2026-11-06_12-30-45")).toBe(
      ".trash-bin/2026-11-06_12-30-45/wiki",
    )
    // 不同域/时间戳互不影响（无共享可变状态）。
    expect(trashBinPath("chapters", "s2")).toBe(".trash-bin/s2/chapters")
  })

  it("domainRequiresTypedConfirm 只对 risk=user 的域要求键入确认", () => {
    const userDomains = DATA_DOMAINS.filter((d) => d.risk === "user")
    const otherDomains = DATA_DOMAINS.filter((d) => d.risk !== "user")
    // 两种风险等级都必须实际存在，否则下面的断言会退化为空循环
    expect(userDomains.length).toBeGreaterThan(0)
    expect(otherDomains.length).toBeGreaterThan(0)
    for (const d of userDomains) expect(domainRequiresTypedConfirm(d)).toBe(true)
    for (const d of otherDomains) expect(domainRequiresTypedConfirm(d)).toBe(false)
  })
})
