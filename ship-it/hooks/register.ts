import type { EngineInterface, Register, Timer } from 'claude-code'

const PANE = 'ship-it'
// 每個專案自己的階段設定檔，放在專案根目錄下
const CONFIG_PATH = '.claude/ship.json'
const TICK_MS = 250
const STAGE_TIMEOUT_MS = 10 * 60 * 1000
const CORAL = '#D97757'

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
type Span = { text: string; color?: string; dim?: boolean; bold?: boolean }

// 吉祥物：上面兩列是頭和身體，腳有兩格動畫輪流換
const SPRITE_BODY = ['▄█▀████▀█▄', '▀████████▀']
const SPRITE_LEGS = [' █ █  █ █ ', '  ██  ██  ']
const SPRITE_WIDTH = 10
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// 軌道左邊留白讓吉祥物能站在第一個節點正上方，右邊留給最後一個標籤
const MARGIN = 4
const LAST_LABEL = 12

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
  await $.ui.open({ id: PANE, title: '進程', rows: 12 })
  // 不等它跑完：指令先回覆，階段在背景繼續，pane 會跟著更新
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

function colorOf(stage: Stage): Span {
  if (stage.status === 'done') {
    return { text: '', color: 'green' }
  }

  if (stage.status === 'running') {
    return { text: '', color: 'yellow', bold: true }
  }

  return stage.status === 'failed' ? { text: '', color: 'red', bold: true } : { text: '', dim: true }
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
    return { text: '✓ 全部完成', color: 'green', bold: true }
  }

  const stage = now.stages.find(one => one.status === 'running' || one.status === 'failed')

  return now.outcome === 'failed'
    ? { text: `✗ ${stage?.name ?? ''} 失敗`, color: 'red', bold: true }
    : { text: `▶ 進行中：${stage?.name ?? ''}`, bold: true }
}

function spriteRows(left: number, frame: number, isDim: boolean): Span[][] {
  const rows = [...SPRITE_BODY, SPRITE_LEGS[frame % SPRITE_LEGS.length]]

  return rows.map(row => [{ text: ' '.repeat(left) + row, color: CORAL, dim: isDim }])
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
    const tone = colorOf(stage)

    track.push({ ...tone, text: stage.status === 'waiting' ? '○' : stage.status === 'failed' ? '✗' : '●' })
    labels.push({ ...tone, text: fit(stage.name, cell - 1) + ' ' })
    marks.push({ ...tone, text: fit(markOf(now, stage), cell - 1) + ' ' })

    if (isLast) {
      return
    }

    // 節點後面這段線，代表下一個階段的進度
    const ahead = now.stages[index + 1]

    if (ahead.status === 'done') {
      track.push({ text: '━'.repeat(gap - 1), color: 'green' })
    } else if (ahead.status === 'waiting') {
      track.push({ text: '─'.repeat(gap - 1), dim: true })
    } else {
      track.push({ text: '━'.repeat(filled), color: ahead.status === 'failed' ? 'red' : 'yellow' })
      track.push({ text: '─'.repeat(gap - 1 - filled), dim: true })
    }
  })

  return [...spriteRows(left, isWalking ? now.frame : 0, now.outcome === 'failed'), track, labels, marks]
}

// 窄的版面（例如 pane 停靠在側邊）：吉祥物在上，階段直向列出
function listRows(now: Run, width: number): Span[][] {
  const isWalking = now.outcome === 'running'

  return [
    ...spriteRows(1, isWalking ? now.frame : 0, now.outcome === 'failed'),
    ...now.stages.map(stage => {
      const mark = stage.status === 'waiting' ? '○' : markOf(now, stage)

      return [{ ...colorOf(stage), text: fit(`${fit(mark, 7)} ${stage.name}`, width) }]
    }),
  ]
}

function draw(now: Run, columns: number): Span[][] {
  const width = Math.max(24, Math.min(columns - 2, 96))
  const count = now.stages.length
  const finished = now.stages.filter(stage => stage.status === 'done').length
  const total = now.outcome === 'running' ? now.elapsedMs : now.stages.reduce((sum, stage) => sum + stage.ms, 0)
  const counter = `${finished}/${count}  ${timer(total)}`
  const headline = headlineOf(now)
  const gap = count > 1 ? Math.floor((width - MARGIN - LAST_LABEL) / (count - 1)) : 0
  const body = count > 1 && gap >= 9 ? trackRows(now, width, gap) : listRows(now, width)

  const rows: Span[][] = [
    [{ ...headline, text: fit(headline.text, width - cellsOf(counter)) }, { text: counter, dim: true }],
    ...body,
    ...now.tail.map(line => [{ text: fit(line, width), color: 'red', dim: true }]),
  ]

  // 空字串的片段不畫
  return rows.map(spans => spans.filter(span => span.text !== ''))
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

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    if (run === null) {
      return Text({ dimColor: true, children: '還沒跑過，輸入 /ship 開始。' })
    }

    const isBusy = run.outcome === 'running'
    const rows = draw(run, e.props.bodyColumns)

    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        ...rows.map((spans, row) =>
          Box({
            key: `row-${row}`,
            flexDirection: 'row',
            children: spans.map((span, index) =>
              Text({
                key: `span-${index}`,
                color: span.color,
                dimColor: span.dim,
                bold: span.bold,
                wrap: 'truncate-end',
                children: span.text,
              }),
            ),
          }),
        ),
        Box({
          key: 'buttons',
          flexDirection: 'row',
          gap: 2,
          marginTop: 1,
          children: [
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
                ]),
            Button({
              key: 'close',
              label: '關閉',
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
