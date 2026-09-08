const fs = require("fs")
const content = fs.readFileSync("E:/写作_old/8人-全文-v3.txt", "utf8")
const chapterRegex = /第[一二三四五六七八九十百千0-9]+章[^\n]*/gi
const matches = Array.from(content.matchAll(chapterRegex))
console.log("matches:", matches.length)
for (const m of matches) {
  const line = content.slice(0, m.index).split("\n").length
  console.log(`L${line}: ${m[0].slice(0, 40)}`)
}
