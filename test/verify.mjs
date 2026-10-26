// 对照验证：压缩后的字典必须与「完整 OpenCC 字典 + 同一算法」逐字一致。
// 参考实现直接读 vendor 原始字典，不做任何压缩。
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as mw from "../dist/han.middleware.js"

const ROOT = join(import.meta.dirname, "..")
const CJK = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+$/u
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/gu

function read(file) {
  const out = []
  for (const line of readFileSync(join(ROOT, "vendor/opencc", file + ".txt"), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue
    const tab = line.indexOf("\t")
    if (tab < 0) continue
    const k = line.slice(0, tab)
    const v = line.slice(tab + 1).trim().split(/\s+/)[0]
    if (k && v && CJK.test(k) && CJK.test(v)) out.push([k, v])
  }
  return out
}

function build(list, chars) {
  const trie = Object.create(null)
  for (const [k, v] of list) {
    let n = trie
    for (const c of k) n = n[c] || (n[c] = Object.create(null))
    n.$ = v
  }
  return (s) =>
    s.replace(CJK_RUN, (run) => {
      const cs = [...run]
      let out = ""
      let i = 0
      while (i < cs.length) {
        let n = trie, j = i, best = 0, val = ""
        while (j < cs.length) {
          n = n[cs[j]]
          if (n === undefined) break
          j++
          if (n.$ !== undefined) { best = j - i; val = n.$ }
        }
        if (best !== 0) { out += val; i += best }
        else { out += chars.get(cs[i]) ?? cs[i]; i++ }
      }
      return out
    })
}

const s2tChars = new Map(read("STCharacters"))
const t2sChars = new Map(read("TSCharacters"))
const refS2T = build(read("STPhrases"), s2tChars)
const refT2S = build(read("TSPhrases"), t2sChars)

const got = (fn) => (s) => fn(s)
const mwS2T = (s) => {
  const b = mw.onRequest({ messages: [{ role: "user", content: s }] }, { protocol: "anthropic", options: {} })
  return b ? b.messages[0].content : s
}
const mwT2S = (s) => {
  const b = mw.onResponse({ content: [{ type: "text", text: s }] }, { protocol: "anthropic", options: {} })
  return b ? b.content[0].text : s
}

// 样本不依赖任何语料：
//   1) 每个词条 key 本身（覆盖词内转换）
//   2) key 接一个常见字/词（覆盖跨词边界，例如「整个中文」里的「个中」）
//   3) 常用字的两两组合（覆盖没进词表的字）
const phraseKeys = read("STPhrases").map(([k]) => k)
const tail = ["中", "国", "的", "人", "文", "时", "我", "们"]
const samples = []
for (const k of phraseKeys) {
  samples.push(k)
  samples.push(k + tail[k.length % tail.length])
}
const chars = [...new Set(read("STCharacters").map(([k]) => k))]
for (let i = 0; i < chars.length - 1; i++) samples.push(chars[i] + chars[i + 1])

let bad = 0
function check(input, want, gotv, tag) {
  if (want === gotv) return
  if (bad++ < 10) console.log("[%s] 输入 %s\n  want %s\n  got  %s", tag, input.slice(0, 40), want.slice(0, 40), gotv.slice(0, 40))
}

for (const s of samples) check(s, refS2T(s), mwS2T(s), "s2t")
for (const s of samples) {
  const t = refS2T(s)
  check(t, refT2S(t), mwT2S(t), "t2s")
}

console.log("对照样本：%d 条（词条 %d）", samples.length, phraseKeys.length)
console.log(bad === 0 ? "✓ 压缩无损：与完整字典逐字一致" : "✗ 有 " + bad + " 处不一致")
process.exit(bad === 0 ? 0 : 1)
