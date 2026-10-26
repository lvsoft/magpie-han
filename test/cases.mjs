// node --test  test/cases.mjs
// 行为用例：四种协议的请求体、流式事件、非流式回复、options 开关。
import { test } from "node:test"
import assert from "node:assert/strict"
import * as mw from "../dist/han.middleware.js"

const req = (body, protocol, options = {}) =>
  mw.onRequest(body, { protocol, options }) ?? body
const ev = (e, protocol, options = {}) =>
  mw.onEvent(e, { protocol, options }) ?? e
const res = (body, protocol, options = {}) =>
  mw.onResponse(body, { protocol, options }) ?? body

// —— 词级正确性 ——
test("s2t 词级：字级会错的那些", () => {
  assert.equal(req({ messages: [{ role: "user", content: "头发很干燥，后面再说" }] }, "anthropic").messages[0].content,
    "頭髮很乾燥，後面再說")
  assert.equal(req({ messages: [{ role: "user", content: "整个中文传播" }] }, "anthropic").messages[0].content,
    "整個中文傳播")
  assert.equal(req({ messages: [{ role: "user", content: "一出一剧" }] }, "anthropic").messages[0].content,
    "一齣一劇")
})

test("t2s 把繁体收回简体", () => {
  const b = res({ content: [{ type: "text", text: "頭髮和乾燥的後面" }] }, "anthropic", { reply: "t2s" })
  assert.equal(b.content[0].text, "头发和干燥的后面")
})

// —— 四种协议的请求体 ——
test("anthropic：user 消息与 system", () => {
  const body = { system: [{ type: "text", text: "头发" }], messages: [{ role: "user", content: "头发" }] }
  assert.equal(req(body, "anthropic").messages[0].content, "頭髮")
  assert.equal(req(body, "anthropic").system[0].text, "头发", "system 默认不转")
  assert.equal(req(body, "anthropic", { system: true }).system[0].text, "頭髮")
})

test("chat：messages 里的 user 与 system", () => {
  const body = { messages: [{ role: "system", content: "头发" }, { role: "user", content: "头发" }] }
  assert.equal(req(body, "chat").messages[1].content, "頭髮")
  assert.equal(req(body, "chat").messages[0].content, "头发")
  assert.equal(req(body, "chat", { system: true }).messages[0].content, "頭髮")
})

test("responses：input 数组与字符串", () => {
  assert.equal(req({ input: "头发" }, "responses").input, "頭髮")
  const b = req({ input: [{ role: "user", content: [{ type: "input_text", text: "头发" }] }] }, "responses")
  assert.equal(b.input[0].content[0].text, "頭髮")
})

test("gemini：contents 与 systemInstruction", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "头发" }] }] }
  assert.equal(req(body, "gemini").contents[0].parts[0].text, "頭髮")
  const s = { systemInstruction: { parts: [{ text: "头发" }] }, contents: [] }
  assert.equal(req(s, "gemini", { system: true }).systemInstruction.parts[0].text, "頭髮")
})

test("scope=last 只转最后一条 user", () => {
  const body = { messages: [
    { role: "user", content: "头发" },
    { role: "assistant", content: "头发" },
    { role: "user", content: "头发" },
  ] }
  const b = req(body, "anthropic", { scope: "last" })
  assert.equal(b.messages[0].content, "头发")
  assert.equal(b.messages[1].content, "头发")
  assert.equal(b.messages[2].content, "頭髮")
})

test("scope=all 连 assistant 历史一起转", () => {
  const body = { messages: [
    { role: "user", content: "头发" },
    { role: "assistant", content: "头发" },
  ] }
  assert.equal(req(body, "anthropic").messages[1].content, "頭髮")
})

// —— 不该动的东西 ——
test("工具调用参数与工具结果一律不碰", () => {
  const body = { messages: [
    { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "头发" }] }] },
    { role: "assistant", content: [{ type: "tool_use", name: "f", input: { s: "头发" } }] },
  ] }
  const b = req(body, "anthropic")
  assert.equal(b.messages[0].content[0].content[0].text, "头发")
  assert.equal(b.messages[1].content[0].input.s, "头发")
})

test("image / base64 不碰，纯英文请求原样返回（undefined）", () => {
  assert.equal(mw.onRequest({ messages: [{ role: "user", content: "hello world" }] }, { protocol: "anthropic", options: {} }), undefined)
  const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "iVBORw0KGgo=" } }] }] }
  assert.equal(mw.onRequest(body, { protocol: "anthropic", options: {} }), undefined)
})

// —— 流式 ——
test("流式：四种协议各自的文本增量", () => {
  assert.deepEqual(ev({ type: "content_block_delta", delta: { type: "text_delta", text: "頭髮" } }, "anthropic", { reply: "t2s" }).delta.text, "头发")
  assert.equal(ev({ choices: [{ delta: { content: "頭髮" } }] }, "chat", { reply: "t2s" }).choices[0].delta.content, "头发")
  assert.equal(ev({ type: "response.output_text.delta", delta: "頭髮" }, "responses", { reply: "t2s" }).delta, "头发")
  assert.equal(ev({ candidates: [{ content: { parts: [{ text: "頭髮" }] } }] }, "gemini", { reply: "t2s" }).candidates[0].content.parts[0].text, "头发")
})

test("流式：切在两条事件里的词由管道接上", () => {
  const ctx = { protocol: "chat", options: { reply: "s2t" }, state: {} }
  const a = mw.onEvent({ choices: [{ delta: { content: "头" } }] }, ctx).choices[0].delta.content
  const b = mw.onEvent({ choices: [{ delta: { content: "发" } }] }, ctx).choices[0].delta.content
  assert.equal(a, "", "半个词先扣住，不发出去")
  assert.equal(a + b, "頭髮")
})

test("流式：以标点结尾时管道会清空，一个字都不留", () => {
  const ctx = { protocol: "chat", options: { reply: "s2t" }, state: {} }
  const a = mw.onEvent({ choices: [{ delta: { content: "头" } }] }, ctx).choices[0].delta.content
  const b = mw.onEvent({ choices: [{ delta: { content: "发。" } }] }, ctx).choices[0].delta.content
  assert.equal(a + b, "頭髮。")
})

test("流式：stream=char 关掉管道，退回逐事件转换", () => {
  const ctx = { protocol: "chat", options: { reply: "s2t", stream: "char" }, state: {} }
  const a = mw.onEvent({ choices: [{ delta: { content: "头" } }] }, ctx).choices[0].delta.content
  const b = mw.onEvent({ choices: [{ delta: { content: "发" } }] }, ctx).choices[0].delta.content
  assert.equal(a + b, "頭發")
})

test("流式：reasoning 默认转，tool_calls 不碰", () => {
  const e = ev({ choices: [{ delta: { reasoning_content: "头发", tool_calls: [{ function: { arguments: '{"a":"头发"}' } }] } }] }, "chat", { reply: "s2t" })
  assert.equal(e.choices[0].delta.reasoning_content, "頭髮")
  assert.equal(e.choices[0].delta.tool_calls[0].function.arguments, '{"a":"头发"}')
})

// —— 非流式回复 ——
test("非流式：四种协议的正文", () => {
  const s2t = { reply: "s2t" }
  assert.equal(res({ content: [{ type: "text", text: "头发" }] }, "anthropic", s2t).content[0].text, "頭髮")
  assert.equal(res({ choices: [{ message: { content: "头发" } }] }, "chat", s2t).choices[0].message.content, "頭髮")
  assert.equal(res({ output: [{ type: "message", content: [{ type: "output_text", text: "头发" }] }] }, "responses", s2t).output[0].content[0].text, "頭髮")
  assert.equal(res({ candidates: [{ content: { parts: [{ text: "头发" }] } }] }, "gemini", s2t).candidates[0].content.parts[0].text, "頭髮")
})

// —— options ——
test("两侧可分别关闭", () => {
  const body = { messages: [{ role: "user", content: "头发" }] }
  assert.equal(req(body, "anthropic", { request: "off" }).messages[0].content, "头发")
  assert.equal(mw.onResponse({ content: [{ type: "text", text: "頭髮" }] }, { protocol: "anthropic", options: { reply: "off" } }), undefined)
})

test("反方向：请求繁→简、回复简→繁", () => {
  const b = req({ messages: [{ role: "user", content: "頭髮很乾燥" }] }, "anthropic", { request: "t2s", reply: "s2t" })
  assert.equal(b.messages[0].content, "头发很干燥")
})
