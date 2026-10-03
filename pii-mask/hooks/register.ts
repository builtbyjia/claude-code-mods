import type { EngineInterface, Register } from 'claude-code'

const PANE = 'pii-mask'
const STORE_KEY = 'state'

type Block = { type: string; [field: string]: unknown }
type Masked = { text: string; kinds: string[] }
type Saved = { isOn: boolean; names: string[]; map: Record<string, string> }
type Rule = {
  kind: string
  pattern: RegExp
  // 有標籤的規則：第一個括號是要保留的標籤，第二個括號才是要遮的值
  isLabeled?: true
  accept?: (value: string) => boolean
}

// 身分證與居留證的英文字母對應碼：A=10、B=11 …，順序是內政部的編碼表
const LETTER_CODES = 'ABCDEFGHJKLMNPQRSTUVXYWZIO'
const ID_WEIGHTS = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1]

function isTaiwanId(value: string): boolean {
  const first = LETTER_CODES.indexOf(value[0]) + 10
  // 舊式居留證第二碼是英文字母，取對應碼的個位數
  const second = /\d/.test(value[1]) ? Number(value[1]) : (LETTER_CODES.indexOf(value[1]) + 10) % 10
  const digits = [Math.floor(first / 10), first % 10, second, ...[...value.slice(2)].map(Number)]

  return digits.reduce((sum, digit, index) => sum + digit * ID_WEIGHTS[index], 0) % 10 === 0
}

function isLuhn(value: string): boolean {
  const digits = [...value.replace(/\D/g, '')].map(Number).reverse()
  const sum = digits.reduce((total, digit, index) => {
    const doubled = index % 2 === 1 ? digit * 2 : digit

    return total + (doubled > 9 ? doubled - 9 : doubled)
  }, 0)

  return sum % 10 === 0
}

// 正式寫法的臺灣地址：縣市、鄉鎮市區、路街，後面的段巷弄號樓有幾項算幾項
const ADDRESS =
  /(?:[台臺]灣)?[一-鿿]{2}[縣市][一-鿿]{1,3}[鄉鎮市區][一-鿿]{1,6}(?:路|街|大道)(?:[一二三四五六七八九十\d]+段)?(?:\d+巷)?(?:\d+弄)?(?:\d+(?:之\d+)?號)?(?:\d+樓(?:之\d+)?)?/g

// 依序套用。有檢查碼的先驗證，沒通過就不遮，避免把一般數字誤判成個資
const RULES: readonly Rule[] = [
  {
    kind: 'EMAIL_ADDRESS',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    // git@github.com 這類是系統帳號，不是個人信箱
    accept: value => !/^(git|noreply|no-reply)@/i.test(value),
  },
  { kind: 'CREDIT_CARD', pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, accept: isLuhn },
  { kind: 'TW_NATIONAL_ID', pattern: /(?<![A-Za-z0-9])[A-Z][12]\d{8}(?!\d)/g, accept: isTaiwanId },
  { kind: 'TW_ARC', pattern: /(?<![A-Za-z0-9])[A-Z][89A-D]\d{8}(?!\d)/g, accept: isTaiwanId },
  { kind: 'TW_MOBILE', pattern: /(?<!\d)(?:\+886[- ]?9|09)\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/g },
  { kind: 'TW_PHONE', pattern: /(?<!\d)\(?0\d{1,2}\)?[- ]\d{3,4}[- ]?\d{4}(?!\d)/g },
  // 八位數字太常見，只有前面寫明「統編」才當成統一編號
  { kind: 'TW_BUSINESS_ID', pattern: /((?:統一編號|統編)\s*[:：]?\s*)(\d{8})(?!\d)/g, isLabeled: true },
  { kind: 'LOCATION', pattern: ADDRESS },
  { kind: 'ORG', pattern: /[一-鿿A-Za-z0-9]{2,10}(?:股份有限公司|有限公司|企業社|商行|事務所)/g },
  // 人名沒有固定格式，只認得欄位標籤後面的那一個
  {
    kind: 'PERSON',
    pattern:
      /((?:姓名|客戶|聯絡人|收件人|寄件人|負責人|申請人|承辦人)\s*[:：]\s*)([一-鿿]{2,4}?)(?=先生|小姐|女士|經理|[^一-鿿]|$)/gm,
    isLabeled: true,
  },
]

// 送給模型的內容從這些 door 進來；模型自己的回覆和你打的 prompt（另外處理）不在這裡
const MASKED_DOORS = new Set(['tool-result', 'tool-message', 'attachment', 'delivery', 'command', 'hook-context'])

const HELP = [
  '/pii：打開對照表',
  '/pii on、/pii off：開關遮蔽（會記住，跨 session 有效）',
  '/pii add 王小明：把詞加進名單，之後出現就會遮蔽',
  '/pii remove 王小明：從名單移除',
  '/pii restore 檔案路徑：把檔案裡的代號換回原文，另存成 .restored 檔',
  '/pii forget：清空對照表（之前的代號就無法還原了）',
].join('\n')

let isOn = false
let names: string[] = []
// 代號 → 原文。只存在本機，不會出現在送給模型的任何內容裡
let map: Record<string, string> = {}
const codeByValue = new Map<string, string>()
const counters = new Map<string, number>()

function adopt(saved: Saved): void {
  isOn = saved.isOn
  names = [...saved.names]
  map = { ...saved.map }
  codeByValue.clear()
  counters.clear()

  for (const [code, value] of Object.entries(map)) {
    const parts = /^<([A-Z_]+)_(\d+)>$/.exec(code)
    codeByValue.set(value, code)

    if (parts !== null) {
      counters.set(parts[1], Math.max(counters.get(parts[1]) ?? 0, Number(parts[2])))
    }
  }
}

function isSaved(value: unknown): value is Saved {
  const saved = value as Saved | null

  return (
    typeof saved?.isOn === 'boolean' &&
    Array.isArray(saved.names) &&
    typeof saved.map === 'object' &&
    saved.map !== null
  )
}

// 同一個原文永遠拿到同一個代號，模型才看得出「這兩處是同一個人」
function codeFor(kind: string, value: string): string {
  const known = codeByValue.get(value)

  if (known !== undefined) {
    return known
  }

  const next = (counters.get(kind) ?? 0) + 1
  const code = `<${kind}_${next}>`
  counters.set(kind, next)
  map[code] = value
  codeByValue.set(value, code)

  return code
}

function maskText(text: string): Masked {
  const kinds: string[] = []
  const swap = (kind: string, value: string): string => {
    kinds.push(kind)

    return codeFor(kind, value)
  }
  let out = text

  // 名單先處理，長的詞優先，避免「王小明」被「小明」拆開
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(name, () => swap('NAME', name))
  }

  for (const rule of RULES) {
    out = out.replace(rule.pattern, (whole: string, label: string, labeled: string) => {
      const value = rule.isLabeled ? labeled : whole

      if (rule.accept !== undefined && !rule.accept(value)) {
        return whole
      }

      return rule.isLabeled ? label + swap(rule.kind, value) : swap(rule.kind, value)
    })
  }

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

function restoreText(text: string): { text: string; restored: number; unknown: number } {
  let restored = 0
  let unknown = 0
  const out = text.replace(/<[A-Z_]+_\d+>/g, code => {
    const value = map[code]

    if (value === undefined) {
      unknown += 1

      return code
    }

    restored += 1

    return value
  })

  return { text: out, restored, unknown }
}

// report.md → report.restored.md；沒有副檔名就直接加在後面
function restoredPath(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')

  return dot > slash + 1 ? `${path.slice(0, dot)}.restored${path.slice(dot)}` : `${path}.restored`
}

async function save($: EngineInterface): Promise<void> {
  const saved: Saved = { isOn, names, map }
  await $.store.set(STORE_KEY, saved)
  $.ui.status(isOn ? 'PII 遮蔽中' : undefined)
  $.ui.invalidate('ui.render')
}

async function announce($: EngineInterface, where: string, kinds: readonly string[]): Promise<void> {
  await save($)
  $.ui.toast(`已把${where}裡的 ${kinds.length} 處個資換成代號`)
}

async function restoreFile($: EngineInterface, path: string): Promise<string> {
  if (path === '') {
    return '請給檔案路徑，例如 /pii restore 回信.md'
  }

  if (!(await $.fs.exists(path))) {
    return `找不到 ${path}`
  }

  const result = restoreText(await $.fs.read(path))

  if (result.restored === 0) {
    return `${path} 裡沒有可還原的代號。`
  }

  const target = restoredPath(path)
  await $.fs.write(target, result.text)
  const leftover = result.unknown > 0 ? `，另有 ${result.unknown} 個代號不在對照表裡，保持原樣` : ''

  return `已還原 ${result.restored} 處，另存為 ${target}${leftover}。原檔沒有更動。`
}

// 這段文字會進入對話、被模型讀到，所以只能放代號的數量，不能放原文
function summary(): string {
  return [
    `pii-mask 目前${isOn ? '開啟' : '關閉'}`,
    `對照表：${Object.keys(map).length} 筆，名單：${names.length} 個詞（內容只顯示在 /pii 的面板裡）`,
  ].join('\n')
}

async function run($: EngineInterface, args: string): Promise<string> {
  const [action = '', ...rest] = args.trim().split(/\s+/)
  const word = rest.join(' ')

  if (action === '') {
    await $.ui.open({ id: PANE, title: '個資對照表', rows: 14 })

    return summary()
  }

  if (action === 'on' || action === 'off') {
    isOn = action === 'on'
    await save($)

    return summary()
  }

  if (action === 'add' && word !== '') {
    names = [...new Set([...names, word])]
    await save($)

    return `已加入名單，目前共 ${names.length} 個詞。`
  }

  if (action === 'remove' && word !== '') {
    names = names.filter(name => name !== word)
    await save($)

    return `已從名單移除，目前共 ${names.length} 個詞。`
  }

  if (action === 'restore') {
    return restoreFile($, word)
  }

  if (action === 'forget') {
    adopt({ isOn, names, map: {} })
    await save($)

    return '對照表已清空。之前產生的代號無法再還原。'
  }

  return HELP
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY)

    if (isSaved(saved)) {
      adopt(saved)
    }

    await $.command.register({
      name: 'pii',
      description: '個資去識別化的開關與對照表（/pii help 看全部用法）',
    })
    $.ui.status(isOn ? 'PII 遮蔽中' : undefined)

    return next(e)
  })

  on('command.run', { command: 'pii' }, async ($, e) => ({ text: await run($, e.args) }))

  // 你打的或貼上的 prompt
  on('prompt.submit', async ($, e, next) => {
    const result = isOn ? maskText(e.text) : { text: e.text, kinds: [] }

    if (result.kinds.length === 0) {
      return next(e)
    }

    await announce($, ' prompt ', result.kinds)

    return next({ ...e, text: result.text })
  })

  // 工具結果等內容，在存進對話、送給模型之前處理。
  // 指令紀錄（command）不管開關都處理，否則 /pii add 王小明 這一行本身就會把名字送出去
  on('session.append', async ($, e, next) => {
    if (!MASKED_DOORS.has(e.door) || (!isOn && e.door !== 'command')) {
      return next(e)
    }

    const result = maskBlocks(e.message.content)

    if (result.kinds.length === 0) {
      return next(e)
    }

    await announce($, '工具輸出', result.kinds)

    return next({ ...e, message: { ...e.message, content: result.blocks } })
  })

  // 對照表只畫在本機的面板上，不會進入對話
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const entries = Object.entries(map)
    const width = Math.max(20, e.props.bodyColumns - 2)

    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        Text({ key: 'state', bold: true, color: isOn ? 'green' : undefined, children: isOn ? '遮蔽中' : '已關閉' }),
        Text({
          key: 'names',
          dimColor: true,
          wrap: 'truncate-end',
          children: names.length > 0 ? `名單：${names.join('、')}`.slice(0, width) : '名單：還沒有，用 /pii add 加入',
        }),
        ...(entries.length === 0
          ? [Text({ key: 'empty', dimColor: true, children: '對照表是空的。' })]
          : entries.map(([code, value]) =>
              Box({
                key: code,
                flexDirection: 'row',
                gap: 2,
                children: [
                  Text({ key: 'code', color: 'cyan', children: code }),
                  Text({ key: 'value', wrap: 'truncate-end', children: value }),
                ],
              }),
            )),
        Box({
          key: 'buttons',
          flexDirection: 'row',
          gap: 2,
          marginTop: 1,
          children: [
            Button({
              key: 'toggle',
              label: isOn ? '關閉遮蔽' : '開啟遮蔽',
              hotkey: 't',
              onPress: () => {
                void run($, isOn ? 'off' : 'on')
              },
            }),
            Button({
              key: 'close',
              label: '關閉面板',
              hotkey: 'c',
              onPress: () => {
                void $.ui.close({ id: PANE })
              },
            }),
          ],
        }),
      ],
    })
  })
}
