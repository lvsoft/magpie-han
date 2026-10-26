// 与 OpenCC 官方实现（opencc-js）对照。样本取自字典本身，不依赖外部语料。
// opencc-js 用的是 opencc-data 的发布版字典，与 vendor 的 master 可能有版本差，
// 所以这里只作交叉检查；压缩无损的严格判据在 test/verify.mjs。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import OpenCC from "opencc-js"
import * as mw from "../dist/han.middleware.js"

const ROOT = join(import.meta.dirname, "..")
const read = (f) =>
  readFileSync(join(ROOT, "vendor/opencc", f + ".txt"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("\t"); return [l.slice(0, i), l.slice(i + 1).trim().split(/\s+/)[0]] })
    .filter(([k, v]) => k && v)

const s2t = OpenCC.Converter({ from: "cn", to: "t" })
const t2s = OpenCC.Converter({ from: "t", to: "cn" })

const keys = read("STPhrases").map(([k]) => k)
const pick = []
for (let i = 0; i < keys.length; i += 7) pick.push(keys[i])
for (let i = 0; i < keys.length; i += 11) pick.push(keys[i] + "中")
const chars = [...new Set(read("STCharacters").map(([k]) => k))]
for (let i = 0; i < chars.length - 1; i += 3) pick.push(chars[i] + chars[i + 1])

const mwS2T = (s) => {
  const b = mw.onRequest({ messages: [{ role: "user", content: s }] }, { protocol: "anthropic", options: {} })
  return b ? b.messages[0].content : s
}
const mwT2S = (s) => {
  const b = mw.onResponse({ content: [{ type: "text", text: s }] }, { protocol: "anthropic", options: {} })
  return b ? b.content[0].text : s
}

let d1 = 0, d2 = 0
for (const s of pick) {
  if (s2t(s) !== mwS2T(s)) {
    if (d1++ < 8) console.log("[s2t] %s  opencc-js=%s  ours=%s", s, s2t(s), mwS2T(s))
  }
  const t = s2t(s)
  if (t2s(t) !== mwT2S(t)) {
    if (d2++ < 8) console.log("[t2s] %s  opencc-js=%s  ours=%s", t, t2s(t), mwT2S(t))
  }
}
console.log("样本 %d 条；与 opencc-js 的差异：s2t %d 条，t2s %d 条", pick.length, d1, d2)
