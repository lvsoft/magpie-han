// 从 OpenCC 原始字典生成单文件 middleware 的构建脚本。
// 用法：node build.mjs  →  dist/han.middleware.js
//
// 字典只从 vendor/opencc/*.txt 读取，不许手改（唯一契约来源 = OpenCC 原始数据）。
// 压缩策略是「无损」的：凡是逐字转换就能得到同样结果的词条一律丢弃，
// 因为运行时未命中词表会退回逐字表，结果相同。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dirname;
const V = (f) => join(ROOT, "vendor/opencc", f + ".txt");

// 基本区、扩展 A、兼容区、扩展 B 及以后（按码点，含代理对）
const CJK = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+$/u;
const cpLen = (s) => [...s].length;

// 读一个 OpenCC 字典：key \t value1 value2 …；取第一个候选（OpenCC 的默认行为）
function readDict(file) {
  const out = [];
  for (const line of readFileSync(V(file), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab);
    const vals = line.slice(tab + 1).trim().split(/\s+/);
    if (!key || !vals[0]) continue;
    out.push([key, vals[0]]);
  }
  return out;
}

const stChars = readDict("STCharacters");
const stPhrases = readDict("STPhrases");
const tsChars = readDict("TSCharacters");
const tsPhrases = readDict("TSPhrases");

const charMap = new Map(tidyChars(stChars));
const tCharMap = new Map(tidyChars(tsChars));

// 逐字转换（不查词表）
function charwise(word, map) {
  let s = "";
  for (const ch of word) s += map.get(ch) ?? ch;
  return s;
}

// 字符表：丢掉非单字、非中文、以及 key == value 的条目
function tidyChars(list) {
  const seen = new Map();
  for (const [k, v] of list) {
    if (cpLen(k) !== 1 || cpLen(v) !== 1) continue;
    if (!CJK.test(k) || !CJK.test(v)) continue;
    if (k === v) continue;
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen];
}

// —— 无损压缩的判据 ——
// 词条 A 能丢，当且仅当「丢掉 A 之后，A 自己仍被转成 A 的译文」，
// 且 A 的每个真后缀都不落在别的词条的前缀路径上。两个条件分别堵两个漏洞：
//
// 1) 丢掉 A 后，从 A 的头一个字符开始会匹配到 A 的某个更短的前缀词条
//    （「巡回法庭」丢了以后会落到「巡回 → 巡迴」）。用模拟器把整个 A 这一步
//    排除掉、重新走一遍，结果不同就不能丢。
// 2) 丢掉 A 后，从 A 中间某个字符开始的词条会被匹配到并伸出 A 之外
//    （「整个中文」里的「个中」）。A 的真后缀只要是某个词条的前缀，就不能丢。
function buildTrie(list) {
  const t = Object.create(null);
  for (const [k, v] of list) {
    let n = t;
    for (const c of k) n = n[c] || (n[c] = Object.create(null));
    n.$ = v;
  }
  return t;
}

function prefixesOf(list) {
  const s = new Set();
  for (const [k] of list) for (let i = 1; i <= k.length; i++) s.add(k.slice(0, i));
  return s;
}

function blocked(k, prefixes) {
  for (let i = 1; i < k.length; i++) if (prefixes.has(k.slice(i))) return true;
  return false;
}

// simulateOutside: 转换 w，但不允许第一步就把整个 w 当成一个词条
function simulateOutside(w, trie, chars) {
  let out = "";
  let i = 0;
  while (i < w.length) {
    let n = trie, j = i, best = 0, val = "";
    while (j < w.length) {
      n = n[w[j]];
      if (n === undefined) break;
      j++;
      if (n.$ !== undefined && !(i === 0 && j === w.length)) { best = j - i; val = n.$; }
    }
    if (best !== 0) { out += val; i += best; }
    else { out += chars.get(w[i]) ?? w[i]; i++; }
  }
  return out;
}

function tidyPhrases(list, chars, prefixes) {
  const full = list.filter(([k, v]) => CJK.test(k) && CJK.test(v));
  const trie = buildTrie(full);
  const seen = new Map();
  for (const [k, v] of full) {
    if (!blocked(k, prefixes) && simulateOutside(k, trie, chars) === v) continue;
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen];
}

const s2tC = tidyChars(stChars);
const t2sC = tidyChars(tsChars);
const s2tP = tidyPhrases(stPhrases, charMap, prefixesOf(stPhrases));
const t2sP = tidyPhrases(tsPhrases, tCharMap, prefixesOf(tsPhrases));

// 字符对连成一个字符串：key,value,key,value…
const charString = (list) => list.map(([k, v]) => k + "\t" + v).join("\n");
const phraseString = (list) => list.map(([k, v]) => k + "\t" + v).join("\n");

const dicts = {
  s2t: { c: charString(s2tC), p: phraseString(s2tP) },
  t2s: { c: charString(t2sC), p: phraseString(t2sP) },
};

// 模板字面量里不能出现反引号、反斜杠、${
for (const [name, d] of Object.entries(dicts)) {
  for (const s of [d.c, d.p]) {
    if (/[`\\]/.test(s) || s.includes("${"))
      throw new Error(name + " 的字典里出现了会破坏模板字面量的字符");
  }
}

const core = readFileSync(join(ROOT, "src/core.js"), "utf8");
const block = [
  "// —— 以下四段由 build.mjs 从 OpenCC 数据生成，勿手改 ——",
  "const S2T_CHARS = `" + dicts.s2t.c + "`",
  "const S2T_PHRASES = `" + dicts.s2t.p + "`",
  "const T2S_CHARS = `" + dicts.t2s.c + "`",
  "const T2S_PHRASES = `" + dicts.t2s.p + "`",
  "",
].join("\n");

if (!core.includes("/*__DICT__*/")) throw new Error("src/core.js 缺少 /*__DICT__*/ 占位");
const out = core.replace("/*__DICT__*/", block);

mkdirSync(join(ROOT, "dist"), { recursive: true });
writeFileSync(join(ROOT, "dist/han.middleware.js"), out);

const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1);
console.log("字符表 s2t %d 条 / t2s %d 条", s2tC.length, t2sC.length);
console.log("词表   s2t %d 条（原始 %d）/ t2s %d 条（原始 %d）",
  s2tP.length, stPhrases.length, t2sP.length, tsPhrases.length);
console.log("产物 %s KB（字典 %s + 逻辑 %s）", kb(out), kb(block), kb(core));
