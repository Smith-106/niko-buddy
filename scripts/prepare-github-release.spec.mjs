import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// DEBT-10-A regression guard: the local GitHub preparation script must address the
// version-bearing release asset through the immutable tag path, never through
// GitHub's moving `releases/latest` alias.
//
// The production module is deliberately NOT imported or executed here: running it
// deletes the local staging directory and invokes the signing helper. Only its one
// public updater URL template is extracted from source and evaluated in isolation.
const here = dirname(fileURLToPath(import.meta.url))
const productionSource = readFileSync(resolve(here, "prepare-github-release.mjs"), "utf8")

const extractUpdaterUrlTemplate = (source) => {
  const matches = [...source.matchAll(/url:\s*`([^`]*)`/g)]
  expect(matches).toHaveLength(1)
  const [match] = matches
  // Bounded structural sanity: the single url template lives in the updater
  // platform block, so evaluating it as the manifest URL is faithful.
  expect(source.slice(0, match.index)).toContain('"windows-x86_64"')
  return match[1]
}

const updaterUrlTemplate = extractUpdaterUrlTemplate(productionSource)

const renderUpdaterUrl = (version, releaseAssetName) => {
  const render = new Function(
    "pkg",
    "releaseAssetName",
    `return \`${updaterUrlTemplate.replaceAll("`", "\\`")}\``,
  )
  return render({ version }, releaseAssetName)
}

const TAGGED_RELEASE_BASE = "https://github.com/Smith-106/niko-buddy/releases/download/v"

describe("local GitHub release manifest updater URL", () => {
  it("addresses the asset through the immutable tagged release path", () => {
    expect(updaterUrlTemplate).not.toContain("/releases/latest/download/")
    expect(updaterUrlTemplate).toContain(
      "https://github.com/Smith-106/niko-buddy/releases/download/v${pkg.version}/",
    )
    expect(updaterUrlTemplate).toMatch(/\$\{releaseAssetName\}$/)
  })

  it.each(["exe", "msi", "zip"])(
    "pins a stable version and the %s asset filename to the exact tag",
    (extension) => {
      const version = "2.27.2"
      const releaseAssetName = `niko-buddy_${version}_windows_X64.${extension}`

      expect(renderUpdaterUrl(version, releaseAssetName)).toBe(
        `${TAGGED_RELEASE_BASE}${version}/${releaseAssetName}`,
      )
    },
  )

  it.each(["exe", "msi", "zip"])(
    "pins a prerelease version and the %s asset filename to the exact tag",
    (extension) => {
      const version = "2.28.0-beta.1"
      const releaseAssetName = `niko-buddy_${version}_windows_X64.${extension}`

      expect(renderUpdaterUrl(version, releaseAssetName)).toBe(
        `${TAGGED_RELEASE_BASE}${version}/${releaseAssetName}`,
      )
    },
  )

  it("does not let a moving GitHub Latest change the tagged version path", () => {
    const versions = ["2.26.5", "2.27.2", "2.28.0-beta.1"]
    const urls = versions.map((version) =>
      renderUpdaterUrl(version, `niko-buddy_${version}_windows_X64.exe`),
    )

    expect(new Set(urls).size).toBe(versions.length)
    for (const [index, url] of urls.entries()) {
      const version = versions[index]
      expect(url).not.toContain("/releases/latest/")
      expect(url).toContain(`/releases/download/v${version}/`)
      expect(url.endsWith(`/niko-buddy_${version}_windows_X64.exe`)).toBe(true)
    }
  })
})
