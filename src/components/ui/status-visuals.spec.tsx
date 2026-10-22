// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@/test-helpers/component-test-utils"
import { MeterBar, StatusChip } from "./status-visuals"

describe("status-visuals", () => {
  it("chip keeps the label as text", () => {
    render(<StatusChip label="orphan 2" tone="warning" />)
    expect(screen.getByText("orphan 2")).toBeInTheDocument()
  })

  it("meter shows the numeric value, not color alone", () => {
    render(<MeterBar label="设定自治" value={8.5} max={10} />)
    expect(screen.getByText("设定自治 8.5/10")).toBeInTheDocument()
    const meter = screen.getByLabelText("设定自治 8.5/10")
    expect(meter.tagName).toBe("METER")
    expect(meter).toHaveAttribute("value", "8.5")
    expect(meter).toHaveAttribute("max", "10")
  })

  it("clamps a value above max", () => {
    render(<MeterBar label="命中" value={9} max={4} />)
    expect(screen.getByText("命中 4/4")).toBeInTheDocument()
  })
})
