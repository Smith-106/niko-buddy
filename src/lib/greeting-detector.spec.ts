import { describe, expect, it } from "vitest"
import { isGreeting } from "./greeting-detector"

describe("isGreeting", () => {
  it("returns false for empty and falsy input", () => {
    expect(isGreeting("")).toBe(false)
    expect(isGreeting("   ")).toBe(false)
    expect(isGreeting(null as unknown as string)).toBe(false)
    expect(isGreeting(undefined as unknown as string)).toBe(false)
  })

  it("returns false when only punctuation remains", () => {
    expect(isGreeting("!!!")).toBe(false)
    expect(isGreeting("。。。")).toBe(false)
  })

  it("rejects inputs longer than the hard cap", () => {
    expect(isGreeting("hi".repeat(20))).toBe(false)
  })

  it("matches English casual openers", () => {
    for (const g of ["hi", "hello", "hey", "yo", "sup", "howdy", "hiya", "heya", "hullo", "greetings"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("matches English openers with optional companion words", () => {
    expect(isGreeting("hi there")).toBe(true)
    expect(isGreeting("hello everyone")).toBe(true)
    expect(isGreeting("hey folks")).toBe(true)
    expect(isGreeting("yo y'all")).toBe(true)
  })

  it("matches time-of-day greetings", () => {
    for (const g of ["good morning", "good afternoon", "good evening", "good day", "good night"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("matches what's-up variants", () => {
    for (const g of ["what's up", "wassup", "whaddup"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("matches Chinese greetings and time-of-day phrases", () => {
    for (const g of ["你好", "您好", "大家好", "嗨", "哈喽", "哈啰", "哈囉", "哈罗", "喂"]) {
      expect(isGreeting(g)).toBe(true)
    }
    for (const g of ["早", "早啊", "早安", "早上好", "中午好", "下午好", "晚上好", "晚安"]) {
      expect(isGreeting(g)).toBe(true)
    }
    expect(isGreeting("你好啊")).toBe(true)
  })

  it("matches are-you-there openers", () => {
    for (const g of ["在吗", "在嗎", "在不在", "有人吗", "有人嗎", "有人在吗", "有人在嗎"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("matches Japanese greetings", () => {
    for (const g of ["こんにちは", "こんばんは", "おはよう", "おはようございます", "やあ", "どうも", "はじめまして"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("matches Korean greetings", () => {
    for (const g of ["안녕", "안녕하세요", "안녕하십니까"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("matches European casual openers", () => {
    for (const g of ["hola", "bonjour", "salut", "coucou", "hallo", "servus", "hej", "hejsan", "ciao", "saluton", "ola", "olá", "privet", "привет"]) {
      expect(isGreeting(g)).toBe(true)
    }
  })

  it("strips trailing punctuation before matching", () => {
    expect(isGreeting("hello!")).toBe(true)
    expect(isGreeting("你好！")).toBe(true)
    expect(isGreeting("hi,")).toBe(true)
    expect(isGreeting("good morning ~")).toBe(true)
    expect(isGreeting("hola?")).toBe(true)
  })

  it("is case-insensitive for ASCII", () => {
    expect(isGreeting("HELLO")).toBe(true)
    expect(isGreeting("Good Morning")).toBe(true)
  })

  it("rejects substring matches and informational messages", () => {
    expect(isGreeting("hello, how do I train a transformer?")).toBe(false)
    expect(isGreeting("hi, please write chapter 3")).toBe(false)
    expect(isGreeting("not a greeting")).toBe(false)
    expect(isGreeting(".hi")).toBe(false)
    expect(isGreeting("greetings to all readers of this book")).toBe(false)
  })
})
