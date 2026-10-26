# han — magpie 网关中间件：中文简繁字形转换

一个 magpie gateway middleware：把经过 magpie 网关的 LLM 流量按「字形」在简繁之间转换。

默认行为（对应你选的 C 方案）：

| 方向 | 做什么 |
| :-- | :-- |
| 请求（agent → 模型） | 简体 → 繁体：模型全程读到繁体 |
| 回复（模型 → agent） | 繁体 → 简体：你读到的是简体 |

两侧方向可以用选项对调或单独关闭。

## 安装

```sh
magpie plugin add /path/to/han.middleware.js
magpie plugin                      # 应显示于 on / gateway middleware onRequest, onEvent, onResponse
```

单文件即可，不需要 npm、不需要 Bun、不需要联网。

## 选项

存在 `plugins.json` 的 `options` 里，改完 1 秒内热加载（进行中的请求不受影响）。

```sh
magpie plugin options han.middleware.js '{"reply":"off"}'
magpie plugin options han.middleware.js off        # 恢复全部默认
```

| 键 | 默认 | 取值 |
| :-- | :-- | :-- |
| `request` | `"s2t"` | `"s2t"` / `"t2s"` / `"off"` —— 请求侧的方向 |
| `reply` | `"t2s"` | `"s2t"` / `"t2s"` / `"off"` —— 回复侧的方向 |
| `scope` | `"all"` | `"all"`：所有 user 与 assistant 消息；`"last"`：只转最后一条 user 消息 |
| `system` | `false` | 是否连 system / instructions 一起转 |
| `reasoning` | `true` | 是否转 thinking / reasoning 文本 |
| `stream` | `"pipe"` | `"pipe"`：流式时用一条滑动管道接住被切成两半的词；`"char"`：逐事件转换，无缓冲 |

注意：插件的短名是文件全名 `han.middleware.js`（magpie 对单文件插件就是这么取名的），不是 `han`。

## 转什么、不转什么

会转：

- 请求：`messages[].content`（user 与 assistant）、`system`（需打开）、四种协议各自的字段（`input` / `instructions` / `contents` / `systemInstruction`）；
- 回复：正文文本、thinking/reasoning 文本；流式与非流式都覆盖，四种协议各自的事件形状都认。

**不会转**（这些地方常是代码和文件内容，转了会改坏东西）：

- 工具调用的参数（`tool_use.input`、`tool_calls[].function.arguments`、`input_json_delta`）；
- 工具结果（`tool_result` 的内容）；
- 图片、base64、任何非中文片段。

不保证「只转中文」的外壳：它只对 `[\u3400-\u4DBF\u4E00-\u9FFF]+` 的连续中文片段做替换，其余字节原样。

## 流式管道

流式回复的事件是逐片到达的，一个词可能被切在两条事件之间（`头` | `发`）。默认的 `stream: "pipe"` 在 `ctx.state` 里给每条文本流维护一条缓冲：

1. 把这次事件的文字接进缓冲；
2. 从缓冲尾部找出「还没走完的词」（即尾部是某个词条的真前缀），把它留住；
3. 其余部分转换后发出去。

所以 `头` 这个事件发出去的是空串，`发` 到达时缓冲拼成 `头发`，一次性发出 `頭髮`。管道只保留真正需要等的字符（通常 0–2 个），不是固定长度，所以延迟就是那一个事件，不会越积越多。

**终止时会强制冲出**。管道不是只等下一个事件：终止事件一到，缓冲里的半个词就当场放出去。能不能放出去取决于协议有没有位置承载：

| 协议 | 终止事件 | 结果 |
| :-- | :-- | :-- |
| Chat Completions | 带 `finish_reason` 的 chunk | 塞进该 chunk 的 `delta.content`，客户端会累积 ✓ |
| Gemini | 带 `finishReason` 的 chunk | 塞进该 chunk 的 `content.parts[]` ✓ |
| Anthropic Messages | `content_block_stop` / `message_stop` | 没有正文位置，半个词丢弃（状态清空） |
| Responses | `response.output_text.done` / `response.completed` | 同上（`done` 的 `text` 是全文，追加会重复） |

错误事件（`type: "error"`）也一样清空管道，不会把半个词留在 `ctx.state` 里。

**仍然存在的缺口**：`data: [DONE]` 不进 `onEvent`，`Run.End` 也不回调 JS，所以「只发 `[DONE]`、不发 finish chunk」的上游没有冲出时机；上游在流中途直接断开也一样。这两种情况下丢掉的是缓冲里的 1–2 个字。以标点或空白结尾的流不受影响——那些字符不在任何词条的路径上，缓冲当场就清空了。在意的话把 `stream` 设为 `"char"`：退回逐事件转换，绝不丢字，代价是被切开的词按单字转（`頭`+`發`）。

顺带一提：默认方向（回复侧 t2s）里这个代价几乎为零——繁体到简体基本是单字映射，`頭`+`髮` 逐字转出来就是 `头发`。只有 `reply: "s2t"` 才真的需要管道。

## 已知限制

1. **流式尾部半个词**：见上一节。
2. **上游回复带 `Content-Encoding` 时原样通过**（magpie 的约定），转换看不到内容。
3. 只作用于**经过 magpie 网关的 agent 请求**；magpie 自己的辅助请求（会话标题、意图路由分类器、搜索/视觉替身）不经过中间件。
4. 字形档不是台湾用语档：`软件 → 軟件`，不是 `軟體`。要台湾用语需要再加 `TWPhrases` 表（另做）。

## 构建与测试

```sh
node build.mjs                  # vendor/opencc/*.txt → dist/han.middleware.js
node --test test/cases.mjs      # 行为用例：四种协议、流式、选项
node test/verify.mjs            # 与「完整 OpenCC 字典 + 同一算法」逐字对照
node test/compare.mjs           # 与 opencc-js（OpenCC 官方实现的 JS 版）对照
```

`test/fake-upstream.py` 是一个假的 OpenAI 兼容上游，配合 `magpie serve` 可做端到端验证。

### 实测数据（本机，magpie 0.1.1604）

| 项 | 数值 |
| :-- | :-- |
| 产物 | 1032 KB（字典 1021 + 逻辑 11） |
| moejs 内建表耗时 | 68–76 ms（加载上限 1 s） |
| 转换 80 KB 请求体 | 4.6 ms（上限 250 ms） |
| 单个流式事件 | 约 2 µs（上限 50 ms） |
| 字典规模 | s2t 3874 字 + 47906 词；t2s 3220 字 + 407 词 |

### 字典压缩

原始 OpenCC 词表 s2t 有 49238 条。逐字转换已经能给出同样结果的条目可以丢掉，但**不能随便丢**：丢掉的词条如果其真后缀落在别的词条的前缀路径上，那个词条会被从词中间匹配出来（`整个中文` 里的 `个中` 就会把 `整个` 变成 `整箇`）。现在的判据有两条：丢掉 A 之后 A 自己仍得到同样的译文（用模拟器把「整个 A 一步」排除掉重走），**且** A 的任何真后缀都不落在别的词条的前缀路径上。两条合起来才不改变任何输入的结果——`test/verify.mjs` 拿全部 49225 条词条、它们的右接变体、以及全部单字两两组合（共 10 万条样本）逐字对照验证。

## 数据来源与许可

字典来自 [OpenCC](https://github.com/BYVoid/OpenCC) `data/dictionary/`（Apache-2.0），只从 `vendor/opencc/*.txt` 读取，由 `build.mjs` 生成，**不要手改 `dist/`**。
