import type { EngineInterface, Register, Timer } from 'claude-code'

// 每個專案自己的階段設定檔，放在專案根目錄下
const CONFIG_PATH = '.claude/ship.json'
const TICK_MS = 250
const STAGE_TIMEOUT_MS = 10 * 60 * 1000

// 深色面板的配色。固定用色碼，不管終端機是淺色還是深色主題，看起來都一樣
const PANEL = '#2B2F3B'
const INK = '#E6E8EC'
const MUTED = '#7D8494'
const GREEN = '#4CC38A'
const YELLOW = '#E5C07B'
const RED = '#F47067'
const CORAL = '#E8806A'

type StageDef = { name: string; run: string }
type Stage = StageDef & { status: 'waiting' | 'running' | 'done' | 'failed'; ms: number }
type Run = {
  stages: Stage[]
  source: string
  outcome: 'running' | 'done' | 'failed'
  elapsedMs: number
  stageMs: number
  frame: number
  tail: string[]
}
type Found = { stages: StageDef[]; source: string; problem?: string }
type Span = { text: string; color?: string; bold?: boolean }

// 吉祥物：上面兩列是頭和身體，腳有兩格動畫輪流換
const SPRITE_BODY = ['▄█▀████▀█▄', '▀████████▀']
const SPRITE_LEGS = [' █ █  █ █ ', '  ██  ██  ']
const SPRITE_WIDTH = 10
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// 軌道左邊留白讓吉祥物能站在第一個節點正上方，右邊留給最後一個標籤
const MARGIN = 4
const LAST_LABEL = 12
// 面板左右的內距，以及面板寬度的上下限
const PAD = 2
const MIN_WIDTH = 30
const MAX_WIDTH = 110

const DEMO: readonly StageDef[] = [
  { name: '檢查程式碼', run: 'sleep 2' },
  { name: '跑測試', run: 'sleep 4' },
  { name: '打包', run: 'sleep 3' },
  { name: '部署', run: 'sleep 5' },
  { name: '健康檢查', run: 'sleep 1' },
]

// 沒有設定檔時，從 package.json 的 scripts 依這個順序找階段
const NPM_SCRIPTS: readonly (readonly [script: string, name: string])[] = [
  ['lint', '檢查程式碼'],
  ['test', '跑測試'],
  ['build', '打包'],
  ['deploy', '部署'],
]

const HELP = [
  '找不到可以跑的階段。三種方式擇一：',
  '・/ship demo：先看示範動畫',
  '・/ship init：在這個專案建立 .claude/ship.json，再編輯成你的階段',
  '・在 package.json 的 scripts 加上 lint、test、build 或 deploy',
].join('\n')

let run: Run | null = null
let ticker: Timer | null = null
let lastArgs = ''
// 按了「關」之後先收起來，下次 /ship 再出現
let isHidden = false

function isStageDef(value: unknown): value is StageDef {
  const stage = value as StageDef | null

  return typeof stage?.name === 'string' && typeof stage.run === 'string' && stage.run.trim() !== ''
}

function stagesFromConfig(text: string): StageDef[] {
  const list = (JSON.parse(text) as { stages?: unknown }).stages

  return Array.isArray(list) ? list.filter(isStageDef).map(({ name, run }) => ({ name, run })) : []
}

function stagesFromPackage(text: string): StageDef[] {
  const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}

  return NPM_SCRIPTS.filter(([script]) => {
    const body = scripts[script]

    // npm init 預設的 test 只會印錯誤然後失敗，不算真的階段
    return typeof body === 'string' && !body.includes('no test specified')
  }).map(([script, name]) => ({ name, run: `npm run ${script}` }))
}

async function findStages($: EngineInterface, cwd: string): Promise<Found> {
  if (await $.fs.exists(`${cwd}/${CONFIG_PATH}`)) {
    try {
      const stages = stagesFromConfig(await $.fs.read(`${cwd}/${CONFIG_PATH}`))

      return stages.length > 0
        ? { stages, source: CONFIG_PATH }
        : { stages, source: CONFIG_PATH, problem: `${CONFIG_PATH} 裡沒有可用的階段，每一項都要有 name 和 run。` }
    } catch {
      return { stages: [], source: CONFIG_PATH, problem: `${CONFIG_PATH} 不是合法的 JSON，請檢查格式。` }
    }
  }

  if (await $.fs.exists(`${cwd}/package.json`)) {
    try {
      return { stages: stagesFromPackage(await $.fs.read(`${cwd}/package.json`)), source: 'package.json' }
    } catch {
      // package.json 讀不懂就當作沒有
    }
  }

  return { stages: [], source: '' }
}

async function init($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()

  if (await $.fs.exists(`${cwd}/${CONFIG_PATH}`)) {
    return `${CONFIG_PATH} 已經存在，直接編輯它就好。`
  }

  const found = await findStages($, cwd)
  const stages =
    found.stages.length > 0
      ? found.stages
      : [
          { name: '打包', run: 'npm run build' },
          { name: '部署', run: 'npm run deploy' },
        ]
  await $.fs.write(`${cwd}/${CONFIG_PATH}`, `${JSON.stringify({ stages }, null, 2)}\n`)

  return `已建立 ${CONFIG_PATH}（${stages.map(stage => stage.name).join(' → ')}）。name 是顯示的名稱，run 是要執行的指令，改完再輸入 /ship。`
}

function tailOf(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-4)
}

async function work($: EngineInterface, mine: Run, cwd: string): Promise<void> {
  try {
    for (const stage of mine.stages) {
      stage.status = 'running'
      mine.stageMs = 0
      $.ui.invalidate('ui.render')
      const startedAt = await $.clock.now()
      let exitCode = 1
      let output = ''

      try {
        const ran = await $.process.run(['bash', '-c', stage.run], { cwd, timeoutMs: STAGE_TIMEOUT_MS })
        exitCode = ran.exitCode
        output = `${ran.stdout}\n${ran.stderr}`
      } catch (error) {
        output = error instanceof Error ? error.message : String(error)
      }

      stage.ms = (await $.clock.now()) - startedAt

      if (exitCode !== 0) {
        stage.status = 'failed'
        mine.outcome = 'failed'
        mine.tail = tailOf(output)
        $.ui.toast(`${stage.name} 失敗了，流程停在這裡`)

        return
      }

      stage.status = 'done'
    }

    mine.outcome = 'done'
    $.ui.toast(`${mine.stages.length} 個階段全部完成`)
  } finally {
    if (run === mine) {
      ticker?.cancel()
      ticker = null
    }

    $.ui.invalidate('ui.render')
  }
}

async function start($: EngineInterface, args: string): Promise<string> {
  if (run?.outcome === 'running') {
    return '已經有一輪在跑了，等它結束再重跑。'
  }

  const cwd = await $.session.cwd()
  const found: Found = args === 'demo' ? { stages: [...DEMO], source: '示範' } : await findStages($, cwd)

  if (found.problem !== undefined) {
    return found.problem
  }

  if (found.stages.length === 0) {
    return HELP
  }

  const mine: Run = {
    stages: found.stages.map(stage => ({ ...stage, status: 'waiting', ms: 0 })),
    source: found.source,
    outcome: 'running',
    elapsedMs: 0,
    stageMs: 0,
    frame: 0,
    tail: [],
  }
  run = mine
  lastArgs = args
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => {
    mine.elapsedMs += TICK_MS
    mine.stageMs += TICK_MS
    mine.frame += 1
    $.ui.invalidate('ui.render')
  })
  isHidden = false
  $.ui.invalidate('ui.render')
  // 不等它跑完：指令先回覆，階段在背景繼續，面板會跟著更新
  void work($, mine, cwd)

  return `開始跑 ${mine.stages.length} 個階段（來源：${mine.source}）：${mine.stages.map(stage => stage.name).join(' → ')}`
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

// 中文字在終端機佔兩格，排版要用格數而不是字數
function cellsOf(text: string): number {
  let cells = 0

  for (const char of text) {
    cells += isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1
  }

  return cells
}

// 截斷或補空白到剛好 width 格
function fit(text: string, width: number): string {
  let out = ''
  let cells = 0

  for (const char of text) {
    const next = isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1

    if (cells + next > width) {
      break
    }

    out += char
    cells += next
  }

  return out + ' '.repeat(width - cells)
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000)

  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function timer(ms: number): string {
  const total = Math.round(ms / 1000)

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function toneOf(stage: Stage): Span {
  if (stage.status === 'done') {
    return { text: '', color: GREEN }
  }

  if (stage.status === 'running') {
    return { text: '', color: YELLOW, bold: true }
  }

  return stage.status === 'failed' ? { text: '', color: RED, bold: true } : { text: '', color: MUTED }
}

function markOf(now: Run, stage: Stage): string {
  if (stage.status === 'done') {
    return `✓ ${seconds(stage.ms)}`
  }

  if (stage.status === 'running') {
    return `${SPINNER[now.frame % SPINNER.length]} ${seconds(now.stageMs)}`
  }

  return stage.status === 'failed' ? `✗ ${seconds(stage.ms)}` : ''
}

function headlineOf(now: Run): Span {
  if (now.outcome === 'done') {
    return { text: '✓ 全部完成', color: INK, bold: true }
  }

  const stage = now.stages.find(one => one.status === 'running' || one.status === 'failed')

  return now.outcome === 'failed'
    ? { text: `✗ ${stage?.name ?? ''} 失敗`, color: RED, bold: true }
    : { text: `▶ 進行中：${stage?.name ?? ''}`, color: INK, bold: true }
}

function spriteRows(left: number, frame: number, isSad: boolean): Span[][] {
  const rows = [...SPRITE_BODY, SPRITE_LEGS[frame % SPRITE_LEGS.length]]

  return rows.map(row => [{ text: ' '.repeat(left) + row, color: isSad ? MUTED : CORAL }])
}

// 寬的版面：一條橫向軌道，每個階段一個節點，吉祥物走向正在跑的那個節點
function trackRows(now: Run, width: number, gap: number): Span[][] {
  const count = now.stages.length
  const at = now.stages.findIndex(stage => stage.status === 'running' || stage.status === 'failed')
  // 走得越久越慢，快到節點前停住，等階段真的完成才踩上去
  const progress = 0.95 * (1 - 1 / (1 + now.stageMs / 4000))
  const filled = Math.round(progress * (gap - 1))
  const position = at === -1 ? MARGIN + (count - 1) * gap : at === 0 ? MARGIN : MARGIN + (at - 1) * gap + 1 + filled
  const left = Math.max(0, Math.min(position - SPRITE_WIDTH / 2, width - SPRITE_WIDTH))
  const isWalking = now.outcome === 'running'

  const track: Span[] = [{ text: ' '.repeat(MARGIN) }]
  const labels: Span[] = [{ text: ' '.repeat(MARGIN) }]
  const marks: Span[] = [{ text: ' '.repeat(MARGIN) }]

  now.stages.forEach((stage, index) => {
    const isLast = index === count - 1
    const cell = isLast ? LAST_LABEL : gap
    const tone = toneOf(stage)

    track.push({ ...tone, text: stage.status === 'waiting' ? '○' : stage.status === 'failed' ? '✗' : '●' })
    labels.push({ ...tone, text: fit(stage.name, cell - 1) + ' ' })
    marks.push({ ...tone, text: fit(markOf(now, stage), cell - 1) + ' ' })

    if (isLast) {
      return
    }

    // 節點後面這段線，代表下一個階段的進度
    const ahead = now.stages[index + 1]

    if (ahead.status === 'done') {
      track.push({ text: '━'.repeat(gap - 1), color: GREEN })
    } else if (ahead.status === 'waiting') {
      track.push({ text: '─'.repeat(gap - 1), color: MUTED })
    } else {
      track.push({ text: '━'.repeat(filled), color: ahead.status === 'failed' ? RED : YELLOW })
      track.push({ text: '─'.repeat(gap - 1 - filled), color: MUTED })
    }
  })

  return [...spriteRows(left, isWalking ? now.frame : 0, now.outcome === 'failed'), [], track, labels, marks]
}

// 窄的版面（終端機很窄時）：吉祥物在上，階段直向列出
function listRows(now: Run): Span[][] {
  const isWalking = now.outcome === 'running'

  return [
    ...spriteRows(MARGIN, isWalking ? now.frame : 0, now.outcome === 'failed'),
    [],
    ...now.stages.map(stage => {
      const mark = stage.status === 'waiting' ? '○' : markOf(now, stage)

      return [{ text: ' '.repeat(MARGIN) }, { ...toneOf(stage), text: `${fit(mark, 7)} ${stage.name}` }]
    }),
  ]
}

// 把一列補到剛好 width 格：左右各留 PAD，中間不足的用空白填。
// 每一列都一樣寬，面板才會是一塊完整的深色矩形
function padded(spans: readonly Span[], width: number): Span[] {
  const inner = width - PAD * 2
  const kept: Span[] = []
  let used = 0

  for (const span of spans) {
    const text = fit(span.text, Math.max(0, Math.min(cellsOf(span.text), inner - used)))

    if (text !== '') {
      kept.push({ ...span, text })
      used += cellsOf(text)
    }
  }

  return [{ text: ' '.repeat(PAD) }, ...kept, { text: ' '.repeat(inner - used + PAD) }]
}

// 回傳面板的寬度、標題列（右邊要留位置給按鈕）和其餘各列
function draw(now: Run, columns: number, buttonCells: number): { width: number; head: Span[]; rows: Span[][] } {
  const width = Math.max(MIN_WIDTH, Math.min(columns, MAX_WIDTH))
  const inner = width - PAD * 2
  const count = now.stages.length
  const finished = now.stages.filter(stage => stage.status === 'done').length
  const total = now.outcome === 'running' ? now.elapsedMs : now.stages.reduce((sum, stage) => sum + stage.ms, 0)
  const counter = `${finished}/${count}  ${timer(total)}  `
  const headline = headlineOf(now)
  const gap = count > 1 ? Math.floor((inner - MARGIN - LAST_LABEL) / (count - 1)) : 0
  const body = count > 1 && gap >= 9 ? trackRows(now, inner, gap) : listRows(now)
  const headRoom = Math.max(0, inner - buttonCells - MARGIN - cellsOf(counter))

  return {
    width,
    head: [
      { text: ' '.repeat(PAD + MARGIN) },
      { ...headline, text: fit(headline.text, headRoom) },
      { text: counter, color: INK },
    ],
    rows: [
      [],
      ...body,
      ...(now.tail.length > 0 ? [[]] : []),
      ...now.tail.map(line => [{ text: ' '.repeat(MARGIN) }, { text: line, color: RED }]),
      [],
    ].map(spans => padded(spans, width)),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: '依序跑這個專案的階段並顯示進程（/ship demo 看示範，/ship init 建立設定檔）',
    })

    return next(e)
  })

  on('command.run', { command: 'ship' }, async ($, e) => {
    const args = e.args.trim()

    return { text: args === 'init' ? await init($) : await start($, args) }
  })

  // 畫在 prompt 正上方的橫條裡，寬度就是整個終端機，所以軌道一定是橫的
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (run === null || isHidden || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isBusy = run.outcome === 'running'
    // 終端機上的按鈕畫成「[ 文字 ]」，這裡先替它們留好位置
    const view = draw(run, e.props.bodyColumns, isBusy ? 8 : 18)
    const textOf = (span: Span, index: number) =>
      Text({
        key: `span-${index}`,
        color: span.color,
        backgroundColor: PANEL,
        bold: span.bold,
        wrap: 'truncate-end',
        children: span.text,
      })

    return Box({
      flexDirection: 'column',
      width: view.width,
      backgroundColor: PANEL,
      children: [
        Box({ key: 'top', flexDirection: 'row', children: padded([], view.width).map(textOf) }),
        Box({
          key: 'head',
          flexDirection: 'row',
          children: [
            ...view.head.map(textOf),
            ...(isBusy
              ? []
              : [
                  Button({
                    key: 'rerun',
                    label: '重跑',
                    hotkey: 'r',
                    onPress: () => {
                      void start($, lastArgs)
                    },
                  }),
                  Text({ key: 'between', backgroundColor: PANEL, children: ' ' }),
                ]),
            Button({
              key: 'close',
              label: '關',
              hotkey: 'c',
              onPress: () => {
                isHidden = true
                $.ui.invalidate('ui.render')
              },
            }),
          ],
        }),
        ...view.rows.map((spans, row) => Box({ key: `row-${row}`, flexDirection: 'row', children: spans.map(textOf) })),
      ],
    })
  })
}
