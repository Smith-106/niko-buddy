import { describe, expect, it } from "vitest"
import {
  AZURE_OPENAI_API_VERSION,
  buildAzureOpenAiUrl,
  isAzureOpenAiEndpoint,
  parseAzureOpenAiEndpoint,
} from "./azure-openai"

describe("isAzureOpenAiEndpoint", () => {
  it("accepts azure openai hosts", () => {
    expect(isAzureOpenAiEndpoint("https://my-resource.openai.azure.com")).toBe(true)
    expect(isAzureOpenAiEndpoint("https://my-resource.openai.azure.com/openai/deployments/gpt-4")).toBe(true)
    expect(isAzureOpenAiEndpoint("http://my-resource.openai.azure.com")).toBe(true)
    expect(isAzureOpenAiEndpoint("my-resource.openai.azure.com")).toBe(true)
    expect(isAzureOpenAiEndpoint("  https://x.openai.azure.com  ")).toBe(true)
  })

  it("rejects non-azure hosts and empty input", () => {
    expect(isAzureOpenAiEndpoint("https://api.openai.com/v1")).toBe(false)
    expect(isAzureOpenAiEndpoint("https://openai.azure.com.evil.com")).toBe(false)
    expect(isAzureOpenAiEndpoint("")).toBe(false)
    expect(isAzureOpenAiEndpoint("   ")).toBe(false)
  })

  it("falls back to a regex match for unparseable URLs", () => {
    expect(isAzureOpenAiEndpoint("not a url .openai.azure.com:8080/path")).toBe(true)
    expect(isAzureOpenAiEndpoint("garbage")).toBe(false)
  })

  it("is case-insensitive on the host", () => {
    expect(isAzureOpenAiEndpoint("https://MY-RESOURCE.OPENAI.AZURE.COM")).toBe(true)
  })
})

describe("parseAzureOpenAiEndpoint", () => {
  it("parses a bare resource host with a fallback deployment", () => {
    const parsed = parseAzureOpenAiEndpoint(
      "https://my-resource.openai.azure.com",
      "gpt-4o",
      "2024-01-01",
    )
    expect(parsed).toEqual({
      resourceBase: "https://my-resource.openai.azure.com",
      deployment: "gpt-4o",
      apiVersion: "2024-01-01",
    })
  })

  it("parses a resource host with an /openai suffix", () => {
    const parsed = parseAzureOpenAiEndpoint(
      "https://my-resource.openai.azure.com/openai",
      "gpt-4o",
      "2024-01-01",
    )
    expect(parsed?.resourceBase).toBe("https://my-resource.openai.azure.com")
    expect(parsed?.deployment).toBe("gpt-4o")
  })

  it("prefers the deployment embedded in the URL path", () => {
    const parsed = parseAzureOpenAiEndpoint(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-35-turbo/chat/completions",
      "fallback-dep",
      "2024-01-01",
    )
    expect(parsed?.deployment).toBe("gpt-35-turbo")
    expect(parsed?.resourceBase).toBe("https://my-resource.openai.azure.com")
  })

  it("reads api-version from the query string and decodes it", () => {
    const parsed = parseAzureOpenAiEndpoint(
      "https://my-resource.openai.azure.com/openai/deployments/dep?api-version=2024-02-15",
      "dep",
      "default-version",
    )
    expect(parsed?.apiVersion).toBe("2024-02-15")

    const encoded = parseAzureOpenAiEndpoint(
      "https://my-resource.openai.azure.com?api-version=2024-02-15-preview",
      "dep",
      "",
    )
    expect(encoded?.apiVersion).toBe("2024-02-15-preview")
  })

  it("uses the fallback api version when absent", () => {
    const parsed = parseAzureOpenAiEndpoint(
      "https://my-resource.openai.azure.com",
      "dep",
      "",
    )
    expect(parsed?.apiVersion).toBe(AZURE_OPENAI_API_VERSION)
  })

  it("returns null when the endpoint is not azure", () => {
    expect(parseAzureOpenAiEndpoint("https://api.openai.com", "dep", "v")).toBeNull()
  })

  it("returns null when the resource has no deployment and no fallback", () => {
    expect(parseAzureOpenAiEndpoint("https://my-resource.openai.azure.com", "  ", "v")).toBeNull()
  })

  it("returns null for unrecognized azure URL shapes", () => {
    expect(parseAzureOpenAiEndpoint("https://my-resource.openai.azure.com/other/path", "dep", "v")).toBeNull()
  })

  it("decodes percent-encoded deployments", () => {
    const parsed = parseAzureOpenAiEndpoint(
      "https://r.openai.azure.com/openai/deployments/gpt%204",
      "dep",
      "v",
    )
    expect(parsed?.deployment).toBe("gpt 4")
  })
})

describe("buildAzureOpenAiUrl", () => {
  it("builds the full chat URL from a parsed endpoint", () => {
    expect(
      buildAzureOpenAiUrl(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        "ignored",
        "2024-10-21",
      ),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    )
  })

  it("builds the URL from scratch when the endpoint cannot be parsed", () => {
    expect(
      buildAzureOpenAiUrl("https://not-azure.example.com", "dep name", "2024-01-01"),
    ).toBe(
      "https://not-azure.example.com/openai/deployments/dep%20name/chat/completions?api-version=2024-01-01",
    )
  })

  it("strips trailing slashes from unparseable endpoints and defaults the version", () => {
    expect(buildAzureOpenAiUrl("https://not-azure.example.com/", "dep", "")).toBe(
      "https://not-azure.example.com/openai/deployments/dep/chat/completions?api-version=2024-10-21",
    )
  })
})
