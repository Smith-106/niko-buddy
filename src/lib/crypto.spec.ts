import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: vi.fn(),
}))

// localStorage polyfill for the Node test environment
function makeLocalStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as unknown as Storage
}

const FALLBACK_KEY = "qmai_fallback_fingerprint"

async function loadCrypto() {
  vi.resetModules()
  return await import("./crypto")
}

const hex64 = "a".repeat(64)
const hex64b = "b".repeat(64)

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  vi.mocked(isTauri).mockReset()
  ;(globalThis as { localStorage?: Storage }).localStorage = makeLocalStorage()
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe("getDeviceFingerprint", () => {
  it("prefers a Tauri fingerprint and caches it", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue(hex64)
    const crypto = await loadCrypto()
    expect(await crypto.getDeviceFingerprint()).toBe(hex64)
    // second call returns the cache without re-invoking
    vi.mocked(invoke).mockResolvedValue(hex64b)
    expect(await crypto.getDeviceFingerprint()).toBe(hex64)
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
  })

  it("falls back to localStorage when the Tauri fingerprint is too short", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(invoke).mockResolvedValue("short")
      const crypto = await loadCrypto()
      const fp = await crypto.getDeviceFingerprint()
      expect(fp).toHaveLength(64)
      expect(globalThis.localStorage!.getItem(FALLBACK_KEY)).toBe(fp)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("falls back when the Tauri invoke rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(invoke).mockRejectedValue(new Error("no command"))
      const crypto = await loadCrypto()
      const fp = await crypto.getDeviceFingerprint()
      expect(fp).toHaveLength(64)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("uses the stored fallback when present", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    globalThis.localStorage!.setItem(FALLBACK_KEY, hex64b)
    const crypto = await loadCrypto()
    expect(await crypto.getDeviceFingerprint()).toBe(hex64b)
  })

  it("browser-only environment generates and persists a random fingerprint", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    const fp = await crypto.getDeviceFingerprint()
    expect(fp).toHaveLength(64)
    expect(globalThis.localStorage!.getItem(FALLBACK_KEY)).toBe(fp)
    // not cached: a second call goes through the same path
    expect(await crypto.getDeviceFingerprint()).toBe(fp)
  })
})

describe("encrypt/decrypt round trips", () => {
  it("isEncrypted detects the prefix", async () => {
    const crypto = await loadCrypto()
    expect(crypto.isEncrypted("enc::v1::abc")).toBe(true)
    expect(crypto.isEncrypted("plain")).toBe(false)
    expect(crypto.isEncrypted("")).toBe(false)
  })

  it("encryptString: empty and already-encrypted inputs pass through", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    expect(await crypto.encryptString("")).toBe("")
    expect(await crypto.encryptString("enc::v1::existing")).toBe("enc::v1::existing")
  })

  it("encryptString → decryptString round trip with the device key", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    const encrypted = await crypto.encryptString("sk-secret-123")
    expect(encrypted.startsWith("enc::v1::")).toBe(true)
    expect(await crypto.decryptString(encrypted)).toBe("sk-secret-123")
  })

  it("decryptString: empty and plaintext pass through", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    expect(await crypto.decryptString("")).toBe("")
    expect(await crypto.decryptString("plain-api-key")).toBe("plain-api-key")
  })

  it("decryptString rejects ciphertext shorter than the nonce", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    await expect(crypto.decryptString("enc::v1::AAAA")).rejects.toThrow("Ciphertext too short")
  })

  it("rejects an invalid (non-hex) fingerprint during key derivation", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue("z".repeat(64)) // not hex
    const crypto = await loadCrypto()
    await expect(crypto.encryptString("secret")).rejects.toThrow("Invalid device fingerprint")
  })
})

describe("safe wrappers", () => {
  it("safeEncryptApiKey succeeds on a healthy device", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    const out = await crypto.safeEncryptApiKey("k")
    expect(out.startsWith("enc::v1::")).toBe(true)
  })

  it("safeEncryptApiKey wraps failures and never returns plaintext", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      vi.mocked(isTauri).mockReturnValue(true)
      vi.mocked(invoke).mockResolvedValue("not-hex-".padEnd(64, "x"))
      const crypto = await loadCrypto()
      await expect(crypto.safeEncryptApiKey("secret")).rejects.toThrow("API key encryption failed")
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("safeDecryptApiKey returns the plaintext on success and '' on failure", async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const crypto = await loadCrypto()
    const enc = await crypto.encryptString("sk")
    expect(await crypto.safeDecryptApiKey(enc)).toBe("sk")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await crypto.safeDecryptApiKey("enc::v1::AAAA")).toBe("")
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("decrypting with a mismatched device key yields empty via safeDecryptApiKey", async () => {
    // encrypt under fingerprint A (fresh module)…
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue(hex64)
    const cryptoA = await loadCrypto()
    const enc = await cryptoA.encryptString("secret-data")
    // …then decrypt under fingerprint B (fresh module, different key)
    vi.mocked(invoke).mockResolvedValue(hex64b)
    const cryptoB = await loadCrypto()
    expect(await cryptoB.safeDecryptApiKey(enc)).toBe("")
  })
})

describe("recursive object encryption", () => {
  async function freshCrypto() {
    vi.mocked(isTauri).mockReturnValue(false)
    return await loadCrypto()
  }

  it("encryptApiKeysInObject: scalars and null pass through", async () => {
    const crypto = await freshCrypto()
    expect(await crypto.encryptApiKeysInObject(null)).toBeNull()
    expect(await crypto.encryptApiKeysInObject(undefined)).toBeUndefined()
    expect(await crypto.encryptApiKeysInObject("plain")).toBe("plain")
    expect(await crypto.encryptApiKeysInObject(42)).toBe(42)
  })

  it("encryptApiKeysInObject: arrays, nested objects, and key-name variants", async () => {
    const crypto = await freshCrypto()
    const obj = {
      apiKey: "k1",
      api_key: "k2",
      "api-key": "k3",
      API_KEY: "k4",
      nested: { apiKey: "k5", other: "v" },
      list: [{ apiKey: "k6" }, { plain: "x" }],
      empty: "",
      notAKey: "sk-visible",
    }
    const out = await crypto.encryptApiKeysInObject(obj) as Record<string, unknown>
    expect(out.apiKey).not.toBe("k1")
    expect((out.nested as Record<string, unknown>).apiKey).not.toBe("k5")
    expect((out.list as Array<{ apiKey: string }>)[0]!.apiKey).not.toBe("k6")
    expect(out.empty).toBe("")
    expect(out.notAKey).toBe("sk-visible")
    // round trip
    const back = await crypto.decryptApiKeysInObject(out) as Record<string, unknown>
    expect(back.apiKey).toBe("k1")
    expect(back.api_key).toBe("k2")
    expect(back["api-key"]).toBe("k3")
    expect(back.API_KEY).toBe("k4")
    expect((back.nested as Record<string, unknown>).apiKey).toBe("k5")
    expect((back.list as Array<{ apiKey: string }>)[0]!.apiKey).toBe("k6")
    expect(back.notAKey).toBe("sk-visible")
  })

  it("decryptApiKeysInObject: scalars pass through; corrupt encrypted values become ''", async () => {
    const crypto = await freshCrypto()
    expect(await crypto.decryptApiKeysInObject(null)).toBeNull()
    expect(await crypto.decryptApiKeysInObject("x")).toBe("x")
    expect(await crypto.decryptApiKeysInObject(42)).toBe(42)
    expect(await crypto.decryptApiKeysInObject(true)).toBe(true)
    expect(await crypto.decryptApiKeysInObject([1, 2])).toEqual([1, 2])
    const out = await crypto.decryptApiKeysInObject({ apiKey: "enc::v1::existing", nested: { apiKey: "plain" } })
    expect(out).toEqual({ apiKey: "", nested: { apiKey: "plain" } })
  })

  it("safeEncryptApiKey stringifies non-Error rejections", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      vi.mocked(isTauri).mockReturnValue(false)
      const encryptSpy = vi.spyOn(globalThis.crypto.subtle, "encrypt")
        .mockRejectedValue("cipher backend offline")
      try {
        const crypto = await loadCrypto()
        await expect(crypto.safeEncryptApiKey("secret")).rejects.toThrow(
          "API key encryption failed: cipher backend offline",
        )
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        encryptSpy.mockRestore()
      }
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("countApiKeyStatus", () => {
  it("counts encrypted vs plaintext across nested structures", async () => {
    const crypto = await loadCrypto()
    expect(crypto.countApiKeyStatus(null)).toEqual({ total: 0, encrypted: 0, plaintext: 0 })
    expect(crypto.countApiKeyStatus("str")).toEqual({ total: 0, encrypted: 0, plaintext: 0 })
    expect(crypto.countApiKeyStatus(7)).toEqual({ total: 0, encrypted: 0, plaintext: 0 })

    const status = crypto.countApiKeyStatus({
      apiKey: "enc::v1::x",
      api_key: "plain",
      nested: { apiKey: "enc::v1::y", apiKey2: "plain2" },
      list: [{ apiKey: "plain3" }],
      empty: "",
      // apiKey-named field with an empty string — matched by the field pattern
      // but skipped by the `if (val)` guard (never counted).
      apiKeyEmpty: "",
      other: 1,
    })
    expect(status).toEqual({ total: 5, encrypted: 2, plaintext: 3 })
  })
})
