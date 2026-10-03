import type { EngineInterface, Register } from 'claude-code'

type Block = { type: string; [field: string]: unknown }
type Masked = { text: string; kinds: string[] }

// 格式固定、一看就知道是金鑰的字串：整段遮掉
const TOKEN_RULES: readonly { kind: string; pattern: RegExp }[] = [
  { kind: '私鑰', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Stripe key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
]

// .env 風格的一行：名稱裡有 SECRET、TOKEN、PASSWORD、KEY 的大寫變數，只遮等號後面的值。
// 開頭容許行號或「- 」，因為工具輸出常帶這些前綴
const ENV_LINE =
  /^([ \t]*(?:\d+[\t→ ]+)?(?:-[ \t]+)?(?:export[ \t]+)?(?:[A-Z0-9]+_)*(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY|APIKEY)(?:_[A-Z0-9]+)*[ \t]*=[ \t]*["']?)([^\s"'#]+)/gm

// JSON、YAML、程式碼裡帶引號的值，例如 "apiKey": "…"；值要像隨機字串才遮，避免誤傷一般程式碼
const QUOTED_VALUE =
  /((?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)["']?[ \t]*[:=][ \t]*["'])([^"'\s]+)(?=["'])/gi

const ENV_FILE = /(^|\/)\.env(\.[\w-]+)*$/
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/
const KEY_FILE =
  /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pgpass|credentials(\.json)?|[^/]+\.(pem|p12|pfx|keystore|jks))$/

// 這些 door 進來的內容會送給模型：工具結果、附件、其他 session 傳來的訊息等。
// 模型自己的回覆（response）和你打的 prompt（另外在 prompt.submit 處理）不在這裡
const MASKED_DOORS = new Set(['tool-result', 'tool-message', 'attachment', 'delivery', 'command', 'hook-context'])

let isOn = true
let blocked = 0
const masked = new Map<string, number>()

function tag(kind: string): string {
  return `[已遮蔽:${kind}]`
}

function looksRandom(value: string): boolean {
  return (
    value.length >= 12 &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !/^(process\.env|import\.meta|\$\{|<|\[已遮蔽)/.test(value)
  )
}

function maskText(text: string): Masked {
  const kinds: string[] = []
  let out = text

  for (const rule of TOKEN_RULES) {
    out = out.replace(rule.pattern, () => {
      kinds.push(rule.kind)

      return tag(rule.kind)
    })
  }

  out = out.replace(ENV_LINE, (whole: string, head: string, value: string) => {
    if (value.length < 6 || value.startsWith('[已遮蔽')) {
      return whole
    }

    kinds.push('環境變數')

    return head + tag('環境變數')
  })

  out = out.replace(QUOTED_VALUE, (whole: string, head: string, value: string) => {
    if (!looksRandom(value)) {
      return whole
    }

    kinds.push('設定值')

    return head + tag('設定值')
  })

  return { text: out, kinds }
}

function maskBlocks(blocks: readonly Block[]): { blocks: Block[]; kinds: string[] } {
  const kinds: string[] = []
  const scrub = (text: string): string => {
    const result = maskText(text)
    kinds.push(...result.kinds)

    return result.text
  }
  const scrubBlock = (block: Block): Block =>
    block.type === 'text' && typeof block.text === 'string' ? { ...block, text: scrub(block.text) } : block

  const out = blocks.map(block => {
    if (block.type !== 'tool_result') {
      return scrubBlock(block)
    }

    if (typeof block.content === 'string') {
      return { ...block, content: scrub(block.content) }
    }

    return Array.isArray(block.content) ? { ...block, content: (block.content as Block[]).map(scrubBlock) } : block
  })

  return { blocks: out, kinds }
}

function isProtected(path: string): boolean {
  return (ENV_FILE.test(path) && !ENV_TEMPLATE.test(path)) || KEY_FILE.test(path)
}

// 回傳這個 shell 指令為什麼不能跑；沒問題就回傳 null。
// 這是盡力而為的字面檢查，繞得過去；真正的後盾是工具輸出的遮蔽
function bashProblem(command: string): string | null {
  if (/(^|[;&|(]\s*)(printenv|env)\s*($|[;&|)>])/.test(command)) {
    return '這個指令會印出所有環境變數'
  }

  const words = command.split(/[\s'"`()<>;|&=,]+/).filter(Boolean)

  for (const [index, word] of words.entries()) {
    // --env-file=.env 只是讓程式載入設定，內容不會印出來
    const isEnvFileFlag = /^--?env[-_]?file$/.test(words[index - 1] ?? '')

    if (isProtected(word) && !isEnvFileFlag) {
      return `這個指令會碰到 ${word}`
    }
  }

  return null
}

function refusal(reason: string): string {
  return `secret-guard 擋下了這個動作：${reason}，裡面可能有金鑰，內容不能送到雲端。請不要改用別的方式讀取；需要其中的設定時，請使用者自己處理，或改看 .env.example 這類範本檔。`
}

function tally($: EngineInterface, where: string, kinds: readonly string[]): void {
  for (const kind of kinds) {
    masked.set(kind, (masked.get(kind) ?? 0) + 1)
  }

  $.ui.toast(`已遮蔽${where}裡的 ${[...new Set(kinds)].join('、')}`)
}

function deny($: EngineInterface, reason: string): { deny: string } {
  blocked += 1
  $.ui.toast(`已擋下：${reason}`)

  return { deny: refusal(reason) }
}

function status(): string {
  const lines = [...masked.entries()].map(([kind, count]) => `・${kind}：${count} 次`)

  return [
    `secret-guard 目前${isOn ? '開啟' : '關閉'}（/guard on、/guard off 切換，只影響這個 session）`,
    `擋下的檔案與指令：${blocked} 次`,
    lines.length > 0 ? `遮蔽的內容：\n${lines.join('\n')}` : '遮蔽的內容：還沒有',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard',
      description: '金鑰守門的狀態與統計（/guard on、/guard off 切換）',
    })

    return next(e)
  })

  on('command.run', { command: 'guard' }, (_, e) => {
    const args = e.args.trim()

    if (args === 'on' || args === 'off') {
      isOn = args === 'on'
    }

    return { text: status() }
  })

  // 你打的或貼上的 prompt：送出前把金鑰換成標記
  on('prompt.submit', ($, e, next) => {
    const result = isOn ? maskText(e.text) : { text: e.text, kinds: [] }

    if (result.kinds.length === 0) {
      return next(e)
    }

    tally($, ' prompt ', result.kinds)

    return next({ ...e, text: result.text })
  })

  // 工具結果等內容：存進對話、送給模型之前把金鑰換成標記
  on('session.append', ($, e, next) => {
    if (!isOn || !MASKED_DOORS.has(e.door)) {
      return next(e)
    }

    const result = maskBlocks(e.message.content)

    if (result.kinds.length === 0) {
      return next(e)
    }

    tally($, '工具輸出', result.kinds)

    return next({ ...e, message: { ...e.message, content: result.blocks } })
  })

  on('tool.call', { tool: 'Read' }, ($, e, next) =>
    isOn && isProtected(e.file_path) ? deny($, `讀取 ${e.file_path}`) : next(e),
  )

  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    isOn && isProtected(e.file_path) ? deny($, `修改 ${e.file_path}`) : next(e),
  )

  on('tool.call', { tool: 'Write' }, ($, e, next) =>
    isOn && isProtected(e.file_path) ? deny($, `覆寫 ${e.file_path}`) : next(e),
  )

  on('tool.call', { tool: 'Grep' }, ($, e, next) =>
    isOn && typeof e.path === 'string' && isProtected(e.path) ? deny($, `搜尋 ${e.path}`) : next(e),
  )

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const problem = isOn ? bashProblem(e.command) : null

    return problem === null ? next(e) : deny($, problem)
  })
}
