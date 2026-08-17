import { describe, expect, it } from "vitest"
import { detectLanguage } from "./detect-language"

describe("detect-language", () => {
  it("detects Chinese (CJK without kana)", () => {
    expect(detectLanguage("这是一个测试。")).toBe("Chinese")
    expect(detectLanguage("汉字的 Unicode 范围测试")).toBe("Chinese")
  })

  it("detects CJK Compatibility Ideographs as Chinese", () => {
    expect(detectLanguage("测试\uF900\uFAFF")).toBe("Chinese")
  })

  it("detects CJK Extension B astral-plane characters as Chinese", () => {
    expect(detectLanguage("𠀀𠀀𠀀 汉字")).toBe("Chinese")
  })

  it("detects Japanese when kana co-occurs with kanji", () => {
    expect(detectLanguage("これは日本語のテストです。漢字もあります。")).toBe("Japanese")
    expect(detectLanguage("私は学生です。学校に行きます。")).toBe("Japanese")
  })

  it("detects Japanese with katakana only", () => {
    expect(detectLanguage("テストコード")).toBe("Japanese")
  })

  it("detects halfwidth katakana as Japanese", () => {
    expect(detectLanguage("ﾃｽﾄ\uFF9F")).toBe("Japanese")
  })

  it("detects Korean", () => {
    expect(detectLanguage("이것은 한국어 테스트입니다.")).toBe("Korean")
  })

  it("detects Hangul Compatibility Jamo as Korean", () => {
    expect(detectLanguage("한글\u3131\u318F")).toBe("Korean")
  })

  it("detects Russian / Cyrillic", () => {
    expect(detectLanguage("Это тест на русском языке.")).toBe("Russian")
  })

  it("detects Greek", () => {
    expect(detectLanguage("Αυτό είναι ένα τεστ στα ελληνικά.")).toBe("Greek")
  })

  it("detects Thai", () => {
    expect(detectLanguage("นี่คือการทดสอบภาษาไทย")).toBe("Thai")
  })

  it("detects Arabic", () => {
    expect(detectLanguage("هذا اختبار باللغة العربية")).toBe("Arabic")
  })

  it("detects Arabic Presentation Forms as Arabic", () => {
    expect(detectLanguage("\uFDF2\uFDF2")).toBe("Arabic")
    expect(detectLanguage("\uFE70\uFE70")).toBe("Arabic")
  })

  it("detects Persian via Persian-only letters", () => {
    expect(detectLanguage("این یک تست فارسی است")).toBe("Persian")
  })

  it("resolves Persian vocabulary boost", () => {
    expect(detectLanguage("این است که برای من")).toBe("Persian")
  })

  it("scores Persian-specific letters پچژگ", () => {
    expect(detectLanguage("پچژگ کتاب")).toBe("Persian")
  })

  it("counts Arabic kaf ك as an Arabic letter", () => {
    expect(detectLanguage("ك هذا من الذي")).toBe("Arabic")
  })

  it("returns Arabic when Arabic outvotes strong Persian letters", () => {
    expect(detectLanguage("پچژگ ةإأؤئي ةإأؤئي")).toBe("Arabic")
  })

  it("resolves Arabic when Arabic letters outvote Persian", () => {
    expect(detectLanguage("هذا هو الاختبار الذي تم")).toBe("Arabic")
  })

  it("detects Hebrew", () => {
    expect(detectLanguage("זוהי בדיקה בעברית")).toBe("Hebrew")
  })

  it("detects Hebrew Presentation Forms as Hebrew", () => {
    expect(detectLanguage("עברית\uFB21\uFB4F")).toBe("Hebrew")
  })

  it("detects Hindi / Devanagari", () => {
    expect(detectLanguage("यह हिंदी में एक परीक्षण है")).toBe("Hindi")
  })

  it("detects Bengali", () => {
    expect(detectLanguage("এটি বাংলায় একটি পরীক্ষা")).toBe("Bengali")
  })

  it("detects Tamil", () => {
    expect(detectLanguage("இது தமிழில் ஒரு சோதனை")).toBe("Tamil")
  })

  it("detects Telugu", () => {
    expect(detectLanguage("ఇది తెలుగులో పరీక్ష")).toBe("Telugu")
  })

  it("detects Kannada", () => {
    expect(detectLanguage("ಇದು ಕನ್ನಡದಲ್ಲಿ ಪರೀಕ್ಷೆ")).toBe("Kannada")
  })

  it("detects Malayalam", () => {
    expect(detectLanguage("ഇത് മലയാളത്തിൽ പരീക്ഷ")).toBe("Malayalam")
  })

  it("detects Gujarati", () => {
    expect(detectLanguage("આ ગુજરાતીમાં પરીક્ષા છે")).toBe("Gujarati")
  })

  it("detects Punjabi / Gurmukhi", () => {
    expect(detectLanguage("ਇਹ ਪੰਜਾਬੀ ਵਿੱਚ ਟੈਸਟ ਹੈ")).toBe("Punjabi")
  })

  it("detects Georgian", () => {
    expect(detectLanguage("ეს არის ტესტი ქართულ ენაზე")).toBe("Georgian")
  })

  it("detects Armenian", () => {
    expect(detectLanguage("Սա թեստ է հայերեն լեզվով")).toBe("Armenian")
  })

  it("detects Amharic / Ethiopic", () => {
    expect(detectLanguage("ይህ በአማርኛ ቋንቋ ፈተና ነው")).toBe("Amharic")
  })

  it("detects Tibetan", () => {
    expect(detectLanguage("འདི་བོད་སྐད་ཀྱི་ཚོད་ལྟ་ཞིག་རེད།")).toBe("Tibetan")
  })

  it("detects Sinhala", () => {
    expect(detectLanguage("මෙය සිංහල භාෂාවෙන් පරීක්ෂණයකි")).toBe("Sinhala")
  })

  it("detects Burmese / Myanmar", () => {
    expect(detectLanguage("ဒါက မြန်မာဘာသာနဲ့ စမ်းသပ်မှုပါ")).toBe("Burmese")
  })

  it("detects Khmer", () => {
    expect(detectLanguage("នេះជាការសាកល្បងជាភាសាខ្មែរ")).toBe("Khmer")
  })

  it("detects Lao", () => {
    expect(detectLanguage("ນີ້ແມ່ນການທົດສອບພາສາລາວ")).toBe("Lao")
  })

  it("detects Vietnamese via tone marks", () => {
    expect(detectLanguage("Đây là một bài kiểm tra tiếng Việt")).toBe("Vietnamese")
  })

  it("detects Turkish via ğ/ı/ş + vocab", () => {
    expect(detectLanguage("Bu bir testtir ve için şimdi")).toBe("Turkish")
  })

  it("detects Polish", () => {
    expect(detectLanguage("To jest test w języku polskim")).toBe("Polish")
  })

  it("detects Czech / Slovak", () => {
    expect(detectLanguage("Toto je test v češtině")).toBe("Czech")
  })

  it("detects Romanian", () => {
    expect(detectLanguage("Acesta este un test în limba română")).toBe("Romanian")
  })

  it("detects Hungarian", () => {
    expect(detectLanguage("Ez egy teszt magyar nyelven törődés")).toBe("Hungarian")
  })

  it("detects German", () => {
    expect(detectLanguage("Das ist ein Test auf Deutsch über und")).toBe("German")
  })

  it("detects French", () => {
    expect(detectLanguage("Ceci est un test en français le")).toBe("French")
  })

  it("detects Portuguese before Spanish", () => {
    expect(detectLanguage("Este é um teste em português não")).toBe("Portuguese")
  })

  it("detects Spanish", () => {
    expect(detectLanguage("Esta es una prueba en español ¿qué")).toBe("Spanish")
  })

  it("detects Spanish via the el/los/las sub-branch", () => {
    expect(detectLanguage("el gato de la casa")).toBe("Spanish")
  })

  it("evaluates the Spanish inner ñ branch without matching", () => {
    expect(detectLanguage("una prueba de es")).toBe("English")
  })

  it("detects Italian", () => {
    expect(detectLanguage("Questo il test che funziona")).toBe("Italian")
  })

  it("detects Dutch", () => {
    expect(detectLanguage("Dit is een test in het Nederlands")).toBe("Dutch")
  })

  it("detects Swedish", () => {
    expect(detectLanguage("Detta är ett test på svenska och")).toBe("Swedish")
  })

  it("detects Norwegian", () => {
    expect(detectLanguage("Dette er norsk tekst og så videre")).toBe("Norwegian")
  })

  it("detects Danish", () => {
    expect(detectLanguage("blød kage til mig nu")).toBe("Danish")
  })

  it("detects Finnish", () => {
    expect(detectLanguage("Tämä on testi suomeksi ja")).toBe("Finnish")
  })

  it("detects Indonesian", () => {
    expect(detectLanguage("Ini adalah tes dalam bahasa Indonesia")).toBe("Indonesian")
  })

  it("detects Swahili", () => {
    expect(detectLanguage("Hii ni jaribio katika Kiswahili")).toBe("Swahili")
  })

  it("falls back to English for ASCII", () => {
    expect(detectLanguage("this is a plain english sentence")).toBe("English")
    expect(detectLanguage("")).toBe("English")
    expect(detectLanguage("123 456 789")).toBe("English")
  })

  it("falls back to English for weak Latin signals", () => {
    expect(detectLanguage("xylophone zephyr")).toBe("English")
  })

  it("handles mixed-script tallies favoring the majority non-Latin script", () => {
    expect(detectLanguage("中文 test 中文 中文")).toBe("Chinese")
  })

  it("picks the largest script tally when multiple scripts coexist", () => {
    expect(detectLanguage("中文中文한")).toBe("Chinese")
  })
})
