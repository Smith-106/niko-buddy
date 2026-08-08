// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { readFile } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { webSearch, type WebSearchResult } from "@/lib/web-search"
import { useWikiStore } from "@/stores/wiki-store"
import type {
  CustomCharacterAuraSkillInput,
  CustomCharacterAuraGenerationInput,
  LocalDocumentImportResult,
  UrlDocumentImportResult,
  SearchDocumentImportResult,
  AuraInjectedConfig,
} from "./character-aura-types"
import { splitSourceLines, htmlToPlainText } from "./character-aura-utils"

export async function readCustomAuraLocalDocuments(
  input: CustomCharacterAuraSkillInput,
): Promise<Pick<CustomCharacterAuraGenerationInput, "importedDocuments" | "failedDocuments">> {
  const importedDocuments: LocalDocumentImportResult[] = []
  const failedDocuments: string[] = []
  for (const path of splitSourceLines(input.localDocumentPaths)) {
    try {
      const content = await readFile(path)
      importedDocuments.push({ path, content })
    } catch {
      failedDocuments.push(path)
    }
  }
  return { importedDocuments, failedDocuments }
}

export async function readCustomAuraUrls(
  input: CustomCharacterAuraSkillInput,
): Promise<Pick<CustomCharacterAuraGenerationInput, "importedUrls" | "failedUrls">> {
  const importedUrls: UrlDocumentImportResult[] = []
  const failedUrls: string[] = []
  const urls = splitSourceLines(input.sourceUrls)
  if (urls.length === 0) return { importedUrls, failedUrls }
  let httpFetch: typeof fetch
  try {
    httpFetch = await getHttpFetch()
  } catch {
    return { importedUrls, failedUrls: urls }
  }
  for (const url of urls) {
    try {
      const response = await httpFetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = await response.text()
      const content = htmlToPlainText(raw)
      if (!content) throw new Error("empty content")
      importedUrls.push({ url, content })
    } catch {
      failedUrls.push(url)
    }
  }
  return { importedUrls, failedUrls }
}

export async function collectCustomAuraWebSearch(
  input: CustomCharacterAuraSkillInput,
  injectedConfig: AuraInjectedConfig = {},
): Promise<Pick<CustomCharacterAuraGenerationInput, "searchQueries" | "webSearchResults" | "importedSearchDocuments" | "failedSearchUrls" | "generationNotes">> {
  const generationNotes: string[] = []
  const searchQueries = planCustomAuraSearchQueries(input)
  const webSearchResults: WebSearchResult[] = []
  const searchApiConfig = injectedConfig.searchApiConfig ?? useWikiStore.getState().searchApiConfig
  const failedSearchUrls: string[] = []
  const importedSearchDocuments: SearchDocumentImportResult[] = []
  if (searchQueries.length === 0) {
    return { searchQueries, webSearchResults, importedSearchDocuments, failedSearchUrls, generationNotes }
  }

  for (const query of searchQueries.slice(0, 3)) {
    try {
      const results = await webSearch(query, searchApiConfig, 4)
      webSearchResults.push(...results.map((result) => ({ ...result, snippet: result.snippet.trim() })))
    } catch (error) {
      generationNotes.push(`AI 搜索「${query}」失败：${error instanceof Error ? error.message : "未知错误"}`)
      if (String(error).includes("not configured")) break
    }
  }

  const uniqueResults = dedupeWebSearchResults(webSearchResults).slice(0, 6)
  const imported = await readWebSearchDocuments(uniqueResults, searchQueries)
  importedSearchDocuments.push(...imported.importedSearchDocuments)
  failedSearchUrls.push(...imported.failedSearchUrls)
  if (uniqueResults.length === 0) {
    generationNotes.push("AI 搜索没有拿到可用结果，本次继续只使用你提供的资料。")
  }
  return { searchQueries, webSearchResults: uniqueResults, importedSearchDocuments, failedSearchUrls, generationNotes }
}

function planCustomAuraSearchQueries(input: CustomCharacterAuraSkillInput): string[] {
  const subject = [input.name.trim(), input.category?.trim()].filter(Boolean).join(" ")
  const prompt = (input.generationPrompt ?? "").trim()
  const promptPart = prompt ? ` ${prompt}` : ""
  const queries = [
    `${subject}${promptPart} 公开资料 人物经历`,
    `${subject}${promptPart} 说话风格 评价`,
    `${subject}${promptPart} 关键事件 时间线 决策`,
  ]
  return [...new Set(queries.map((item) => item.trim()).filter(Boolean))]
}

function dedupeWebSearchResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>()
  const output: WebSearchResult[] = []
  for (const result of results) {
    const key = result.url.trim() || `${result.title}-${result.source}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(result)
  }
  return output
}

async function readWebSearchDocuments(
  results: WebSearchResult[],
  searchQueries: string[],
): Promise<Pick<CustomCharacterAuraGenerationInput, "importedSearchDocuments" | "failedSearchUrls">> {
  const importedSearchDocuments: SearchDocumentImportResult[] = []
  const failedSearchUrls: string[] = []
  if (results.length === 0) return { importedSearchDocuments, failedSearchUrls }
  let httpFetch: typeof fetch
  try {
    httpFetch = await getHttpFetch()
  } catch {
    return { importedSearchDocuments, failedSearchUrls: results.map((result) => result.url) }
  }

  for (const result of results.slice(0, 4)) {
    try {
      const response = await httpFetch(result.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = await response.text()
      const content = htmlToPlainText(raw)
      if (!content) throw new Error("empty content")
      importedSearchDocuments.push({
        query: searchQueries.find((query) => result.title.includes(query) || result.snippet.includes(query)) ?? searchQueries[0] ?? "",
        title: result.title,
        url: result.url,
        source: result.source,
        snippet: result.snippet,
        content,
      })
    } catch {
      failedSearchUrls.push(result.url)
    }
  }
  return { importedSearchDocuments, failedSearchUrls }
}
