// han.middleware.js — magpie 网关中间件：中文简繁「字形」转换
// 由 build.mjs 从 OpenCC 数据生成，请勿手改本文件；改 src/core.js 后重新构建。
//
// 默认行为（与 options 无关的约定）：
//   请求侧：简体 → 繁体（让模型全程读到繁体）
//   回复侧：繁体 → 简体（让你读到简体）
// 方向可用 options 对调；"off" 关闭某一侧。
//
// 只转换自然语言文本：用户/助手消息文本、可选的 system、回复正文与推理。
// 工具调用的参数与工具结果一律不动（里面常是代码和文件内容）。

/*__DICT__*/

// —— 字典表 ——
// 字符表是一串交替字符「简繁简繁…」；词表每行「词\t词」。
// 词表用前缀树（$ 存该节点的转换结果），未命中退回字符表 —— 与 OpenCC 的规则一致。
function table(charsStr, phraseStr) {
  const chars = new Map()
  for (const line of charsStr.split("\n")) {
    const tab = line.indexOf("\t")
    if (tab > 0) chars.set(line.slice(0, tab), line.slice(tab + 1))
  }
  const trie = Object.create(null)
  let n = 0
  for (const line of phraseStr.split("\n")) {
    if (!line) continue
    const tab = line.indexOf("\t")
    if (tab < 0) continue
    const key = line.slice(0, tab)
    const val = line.slice(tab + 1)
    let node = trie
    for (const c of key) {
      let next = node[c]
      if (next === undefined) next = node[c] = Object.create(null)
      node = next
    }
    node.$ = val
    n++
  }
  return { chars, trie, words: n }
}

const T_BUILD = Date.now()
const S2T = table(S2T_CHARS, S2T_PHRASES)
const T2S = table(T2S_CHARS, T2S_PHRASES)

// 只扫中文片段：非中文区间交给正则引擎跳过，避免逐字符处理整段 base64/代码。
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+/gu

// conv 把一个字符串里的中文按表转换：片段内前缀树最长匹配，未命中查字符表。
// 不跨字符串保留状态，所以流式事件被切开时最坏退化为逐字转换，不会丢字。
function conv(s, tbl) {
  if (typeof s !== "string" || s === "") return s
  return s.replace(CJK_RUN, (run) => {
    const chars = tbl.chars
    const trie = tbl.trie
    // 按码点切分，扩展 B 区（代理对）才不会把一个字当成两个
    const cs = [...run]
    let out = ""
    let i = 0
    const n = cs.length
    while (i < n) {
      let node = trie
      let j = i
      let best = 0
      let val = ""
      while (j < n) {
        node = node[cs[j]]
        if (node === undefined) break
        j++
        if (node.$ !== undefined) {
          best = j - i
          val = node.$
        }
      }
      if (best !== 0) {
        out += val
        i += best
      } else {
        const c = cs[i]
        const v = chars.get(c)
        out += v === undefined ? c : v
        i++
      }
    }
    return out
  })
}

// safeLen：buf 里可以安全输出的前缀长度（按码点）。
// 从末尾往前看，只要尾部是一个还没走完的词，就不输出它 —— 等下一个事件把字补齐。
// 尾部是完整词（或根本不在任何词条路径上）时全部输出。
const MAX_WORD = 16

function safeLen(cs, trie) {
  let i = 0
  while (i < cs.length) {
    let node = trie
    let j = i
    let best = 0
    while (j < cs.length) {
      node = node[cs[j]]
      if (node === undefined) break
      j++
      if (node.$ !== undefined) best = j - i
    }
    if (j >= cs.length) {
      // 走到了缓冲区末尾：完整词可以输出，半个词要留住
      return best !== 0 && i + best >= cs.length ? cs.length : i
    }
    i += best !== 0 ? best : 1
  }
  return cs.length
}

// pipeText：把这次事件的文本接进该流自己的缓冲，输出安全的部分。
// 尾部的半个词留到下一个事件；流在这些字上正好结束时，它们不会被发出去
// （magpie 没有流结束钩子，这是已知且被接受的代价）。
function pipeText(s, slot, st, tbl) {
  const pipes = st.pipes || (st.pipes = Object.create(null))
  const buf = (pipes[slot] || "") + s
  const cs = [...buf]
  const k = safeLen(cs, tbl.trie)
  pipes[slot] = cs.slice(k).join("")
  return conv(cs.slice(0, k).join(""), tbl)
}

// takePipe 取走并清空一条流的缓冲
function takePipe(st, slot) {
  const pipes = st.pipes
  if (!pipes || !pipes[slot]) return ""
  const b = pipes[slot]
  pipes[slot] = ""
  return b
}

function clearPipes(st) {
  const pipes = st.pipes
  if (!pipes) return false
  let had = false
  for (const k in pipes) {
    if (pipes[k]) {
      pipes[k] = ""
      had = true
    }
  }
  return had
}

// flushOnTerminal：终止事件（正常结束、错误、上游断开）到来时把管道里剩下的
// 半个词就地放出去。能否放出去取决于协议有没有位置承载：
//   Chat      终止 chunk 的 choices[].delta.content  —— 客户端会累积，放得出去
//   Gemini    终止 chunk 的 candidates[].content.parts[].text —— 同上
//   Anthropic content_block_stop / message_stop 没有正文位置，只会留下半个词
//   Responses response.output_text.done 的 text 是全文，追加会重复
// 放不出去的协议就丢掉这 1–2 个字，并记下这次丢弃。
function flushOnTerminal(ev, tbl, st) {
  if (!st || !st.pipes) return false
  if (Array.isArray(ev.choices)) {
    for (const c of ev.choices) {
      if (!c || !c.finish_reason) continue
      const b = takePipe(st, "c")
      if (!b) continue
      if (!c.delta) c.delta = {}
      const had = typeof c.delta.content === "string" ? c.delta.content : ""
      c.delta.content = had + conv(b, tbl)
      return true
    }
    return false
  }
  if (Array.isArray(ev.candidates)) {
    for (const c of ev.candidates) {
      if (!c || !c.finishReason) continue
      const b = takePipe(st, "g")
      if (!b) continue
      if (!c.content) c.content = {}
      if (!Array.isArray(c.content.parts)) c.content.parts = []
      c.content.parts.push({ text: conv(b, tbl) })
      return true
    }
    return false
  }
  const t = ev.type
  if (
    t === "content_block_stop" ||
    t === "message_delta" ||
    t === "message_stop" ||
    t === "response.completed" ||
    t === "response.output_text.done" ||
    t === "error"
  ) {
    if (clearPipes(st)) st.dropped = (st.dropped || 0) + 1
  }
  return false
}

// —— options ——
// 全部可省略；省略时用下面的默认值（C 方案：请求简→繁、回复繁→简）。
const DEF = { request: "s2t", reply: "t2s", scope: "all", system: false, reasoning: true }

// dirOf 读一个方向："s2t" / "t2s" / 关闭（"off"、false、null）
function dirOf(v, dflt) {
  if (v === undefined) return dflt
  if (v === false || v === null || v === "off" || v === "none") return null
  if (v === "s2t" || v === "c2t" || v === "cn2tw") return "s2t"
  if (v === "t2s" || v === "t2c" || v === "tw2cn") return "t2s"
  return dflt
}

function opts(ctx) {
  const o = ctx && ctx.options
  return o && typeof o === "object" ? o : {}
}

// —— 请求侧 ——
export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return
  const o = opts(ctx)
  const dir = dirOf(o.request, DEF.request)
  if (!dir) return
  const tbl = dir === "s2t" ? S2T : T2S
  const all = o.scope !== "last"
  const withSystem = o.system === true
  let changed = false
  const fix = (obj, k) => {
    if (!obj) return
    const s = obj[k]
    if (typeof s !== "string" || s === "") return
    const u = conv(s, tbl)
    if (u !== s) {
      obj[k] = u
      changed = true
    }
  }
  const p = ctx && ctx.protocol
  if (p === "gemini") reqGemini(body, fix, all, withSystem)
  else if (p === "responses") reqResponses(body, fix, all, withSystem)
  else if (p === "chat") reqChat(body, fix, all, withSystem)
  else reqAnthropic(body, fix, all, withSystem)
  return changed ? body : undefined
}

function reqAnthropic(body, fix, all, withSystem) {
  if (withSystem) {
    if (typeof body.system === "string") fix(body, "system")
    else if (Array.isArray(body.system))
      for (const b of body.system) if (b && b.type === "text") fix(b, "text")
  }
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = lastIndex(msgs, (m) => m && m.role === "user")
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || (!all && i !== last)) continue
    if (m.role !== "user" && m.role !== "assistant") continue
    if (typeof m.content === "string") fix(m, "content")
    else if (Array.isArray(m.content))
      for (const b of m.content) if (b && b.type === "text") fix(b, "text")
  }
}

function reqChat(body, fix, all, withSystem) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = lastIndex(msgs, (m) => m && m.role === "user")
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || (!all && i !== last)) continue
    if (m.role === "system" || m.role === "developer") {
      if (withSystem) fixTexts(m, fix)
      continue
    }
    if (m.role !== "user" && m.role !== "assistant") continue
    fixTexts(m, fix)
  }
}

function reqResponses(body, fix, all, withSystem) {
  if (withSystem) fix(body, "instructions")
  if (typeof body.input === "string") {
    fix(body, "input")
    return
  }
  const items = Array.isArray(body.input) ? body.input : []
  const last = lastIndex(items, (m) => m && m.role === "user")
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it || (!all && i !== last)) continue
    if (it.role !== "user" && it.role !== "assistant") continue
    if (typeof it.content === "string") {
      fix(it, "content")
      continue
    }
    if (!Array.isArray(it.content)) continue
    for (const part of it.content) {
      if (!part) continue
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") fix(part, "text")
    }
  }
}

function reqGemini(body, fix, all, withSystem) {
  if (withSystem) {
    const si = body.systemInstruction
    if (typeof si === "string") fix(body, "systemInstruction")
    else if (si && Array.isArray(si.parts)) for (const p of si.parts) if (p) fix(p, "text")
  }
  const contents = Array.isArray(body.contents) ? body.contents : []
  const last = lastIndex(contents, (c) => c && (c.role === "user" || !c.role))
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]
    if (!c || (!all && i !== last)) continue
    if (c.role !== "user" && c.role !== "model" && c.role) continue
    if (!Array.isArray(c.parts)) continue
    for (const p of c.parts) if (p && typeof p.text === "string") fix(p, "text")
  }
}

// fixTexts 处理一条消息的 content：字符串，或 [{type:"text", text}]
function fixTexts(m, fix) {
  if (typeof m.content === "string") {
    fix(m, "content")
    return
  }
  if (!Array.isArray(m.content)) return
  for (const part of m.content) if (part && part.type === "text") fix(part, "text")
}

function lastIndex(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i
  return -1
}

// —— 回复侧：流式事件 ——
export function onEvent(ev, ctx) {
  if (!ev || typeof ev !== "object") return
  const o = opts(ctx)
  const dir = dirOf(o.reply, DEF.reply)
  if (!dir) return
  const tbl = dir === "s2t" ? S2T : T2S
  const reasoning = o.reasoning !== false
  const st = ctx && ctx.state ? ctx.state : {}
  const usePipe = o.stream !== "char"
  let changed = false
  const fix = (obj, k, slot) => {
    if (!obj) return
    const s = obj[k]
    if (typeof s !== "string" || s === "") return
    const u = usePipe ? pipeText(s, slot, st, tbl) : conv(s, tbl)
    if (u !== s) {
      obj[k] = u
      changed = true
    }
  }
  const t = ev.type
  if (t === "content_block_delta") {
    const d = ev.delta
    const slot = "a" + (ev.index === undefined ? 0 : ev.index)
    if (d && d.type === "text_delta") fix(d, "text", slot)
    else if (d && d.type === "thinking_delta" && reasoning) fix(d, "thinking", "k" + slot)
  } else if (t === "response.output_text.delta") {
    fix(ev, "delta", "out")
  } else if (t === "response.output_text.done") {
    fix(ev, "text", "out")
  } else if (
    reasoning &&
    (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta")
  ) {
    fix(ev, "delta", "reason")
  } else if (Array.isArray(ev.choices)) {
    for (const c of ev.choices) {
      const d = c && c.delta
      if (!d) continue
      fix(d, "content", "c")
      if (reasoning) fix(d, "reasoning_content", "cr")
    }
  } else if (Array.isArray(ev.candidates)) {
    for (const c of ev.candidates) {
      const parts = c && c.content && c.content.parts
      if (!Array.isArray(parts)) continue
      for (const p of parts) fix(p, "text", "g")
    }
  }
  if (usePipe) changed = flushOnTerminal(ev, tbl, st) || changed
  return changed ? ev : undefined
}

// —— 回复侧：非流式整体 ——
export function onResponse(body, ctx) {
  if (!body || typeof body !== "object") return
  const o = opts(ctx)
  const dir = dirOf(o.reply, DEF.reply)
  if (!dir) return
  const tbl = dir === "s2t" ? S2T : T2S
  const reasoning = o.reasoning !== false
  let changed = false
  const fix = (obj, k) => {
    if (!obj) return
    const s = obj[k]
    if (typeof s !== "string" || s === "") return
    const u = conv(s, tbl)
    if (u !== s) {
      obj[k] = u
      changed = true
    }
  }
  const p = ctx && ctx.protocol
  if (p === "gemini") {
    for (const c of body.candidates || []) {
      const parts = c && c.content && c.content.parts
      if (!Array.isArray(parts)) continue
      for (const part of parts) fix(part, "text")
    }
  } else if (p === "responses") {
    for (const it of body.output || []) {
      if (!it) continue
      if (it.type === "message" && Array.isArray(it.content))
        for (const part of it.content)
          if (part && (part.type === "output_text" || part.type === "text")) fix(part, "text")
      if (reasoning && it.type === "reasoning" && Array.isArray(it.summary))
        for (const s of it.summary) fix(s, "text")
    }
  } else if (p === "chat") {
    for (const c of body.choices || []) {
      const m = c && c.message
      if (!m) continue
      if (typeof m.content === "string") fix(m, "content")
      else if (Array.isArray(m.content))
        for (const part of m.content) if (part && part.type === "text") fix(part, "text")
      if (reasoning) fix(m, "reasoning_content")
    }
  } else {
    for (const b of body.content || []) {
      if (!b) continue
      if (b.type === "text") fix(b, "text")
      else if (b.type === "thinking" && reasoning) fix(b, "thinking")
    }
  }
  return changed ? body : undefined
}

console.log("[han] 字典就绪：s2t " + S2T.chars.size + " 字 / " + S2T.words +
  " 词，t2s " + T2S.chars.size + " 字 / " + T2S.words + " 词，建表 " + (Date.now() - T_BUILD) + " ms")
