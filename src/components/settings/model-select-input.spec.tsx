// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/model-select-input.tsx

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { buildModelSelectOptions, ModelSelectInput } from "./model-select-input"

afterEach(() => {
  cleanup()
})

describe("buildModelSelectOptions", () => {
  it("dedupes + trims + filters fetched models; no current → plain ordered list", () => {
    expect(buildModelSelectOptions("", ["  a ", "a", "b", " ", "c"])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
      { value: "c", label: "c" },
    ])
  })

  it("current inside fetched → current first, rest ordered without duplicates", () => {
    expect(buildModelSelectOptions("b", ["a", "b", "c"])).toEqual([
      { value: "b", label: "b" },
      { value: "a", label: "a" },
      { value: "c", label: "c" },
    ])
  })

  it("current not in fetched but fetched exists → annotated current entry prepended", () => {
    expect(buildModelSelectOptions("z", ["a", "b"])).toEqual([
      { value: "z", label: "当前填写：z（不在已拉取模型中）" },
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ])
  })

  it("current set but no fetched models → single current option", () => {
    expect(buildModelSelectOptions("  only  ", [])).toEqual([{ value: "only", label: "only" }])
  })

  it("empty current + no fetched models → empty list", () => {
    expect(buildModelSelectOptions("", [])).toEqual([])
  })
})

describe("ModelSelectInput", () => {
  it("renders the input and calls onChange on typing", () => {
    const onChange = vi.fn()
    render(
      <ModelSelectInput
        value=""
        options={[]}
        selectPlaceholder="select…"
        inputPlaceholder="type…"
        onChange={onChange}
      />,
    )
    const input = screen.getByPlaceholderText("type…") as HTMLInputElement
    fireEvent.change(input, { target: { value: "gpt-4o" } })
    expect(onChange).toHaveBeenCalledWith("gpt-4o")
  })

  it("renders the select only when options exist; placeholder option when value empty", () => {
    const onChange = vi.fn()
    render(
      <ModelSelectInput
        value=""
        options={["a", "b"]}
        selectPlaceholder="select…"
        inputPlaceholder="type…"
        onChange={onChange}
      />,
    )
    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.value).toBe("__empty__")
    expect(screen.getByText("select…")).toBeInTheDocument()
    expect(select.options).toHaveLength(3) // placeholder + a + b
  })

  it("selecting a real option calls onChange; selecting the placeholder does not", () => {
    const onChange = vi.fn()
    render(
      <ModelSelectInput
        value="a"
        options={["a", "b"]}
        selectPlaceholder="select…"
        inputPlaceholder="type…"
        onChange={onChange}
      />,
    )
    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.value).toBe("a")

    fireEvent.change(select, { target: { value: "b" } })
    expect(onChange).toHaveBeenCalledWith("b")

    fireEvent.change(select, { target: { value: "__empty__" } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("select value falls back to __empty__ when value is whitespace-only", () => {
    render(
      <ModelSelectInput
        value="   "
        options={["a"]}
        selectPlaceholder="select…"
        inputPlaceholder="type…"
        onChange={vi.fn()}
      />,
    )
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("__empty__")
  })
})
