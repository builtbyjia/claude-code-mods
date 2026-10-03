import type { EngineInterface, Register, TurnCompleteReason } from 'claude-code'

// 回合至少跑這麼久才通知；短回合你人還在螢幕前，不用吵你
const MIN_SECONDS = 60

type Mood = 'snack' | 'tea' | 'marathon' | 'oops'
type Card = { title: string; body: string }
type Preview = { mood: Mood; seconds: number }
// 至少有一個元素的陣列，取第一個時型別不會是 undefined
type NonEmpty<T> = readonly [T, ...T[]]

// 每種心情的文案，通知時隨機抽一張。想改語氣，改這裡就好
const CARDS: Record<Mood, NonEmpty<Card>> = {
  // 1 到 3 分鐘
  snack: [
    { title: '叮咚！出爐囉', body: '熱騰騰的，趁熱回來看 ٩(ˊᗜˋ*)و' },
    { title: '好了好了～', body: '我有乖乖做完，快來誇我 (｡•̀ᴗ-)✧' },
    { title: '報告長官', body: '任務完成，請回來驗收！' },
  ],
  // 3 到 10 分鐘
  tea: [
    { title: '你的茶泡好了嗎', body: '我這邊收工囉，慢慢走回來就好' },
    { title: '呼～做完了', body: '慢工出細活，回來看看成果吧 ₍ᐢ. .ᐢ₎' },
    { title: '下課鐘響', body: '作業寫完了，可以來檢查了' },
  ],
  // 10 分鐘以上
  marathon: [
    { title: '馬拉松跑完了', body: '腿好痠，給我一點掌聲' },
    { title: '我還活著！', body: '這回合好長，但我撐到終點了' },
    { title: '大工程竣工', body: '先伸個懶腰再回來看' },
  ],
  // 出錯或被拒絕
  oops: [
    { title: '呱…卡住了', body: '這回合沒有順利結束，回來救我一下 (；ω；)' },
    { title: '嗚嗚出包了', body: '我跌倒了，需要你回來看看' },
  ],
}

// macOS 內建音效，檔案在 /System/Library/Sounds
const SOUNDS: Record<Mood, string> = {
  snack: 'Pop',
  tea: 'Glass',
  marathon: 'Hero',
  oops: 'Frog',
}

// /ding 預覽時輪流展示的心情，秒數是示範用的假時長
const PREVIEWS: NonEmpty<Preview> = [
  { mood: 'snack', seconds: 95 },
  { mood: 'tea', seconds: 320 },
  { mood: 'marathon', seconds: 1260 },
  { mood: 'oops', seconds: 75 },
]

function moodOf(reason: TurnCompleteReason, seconds: number): Mood {
  if (reason !== 'answer') {
    return 'oops'
  }

  if (seconds < 180) {
    return 'snack'
  }

  return seconds < 600 ? 'tea' : 'marathon'
}

function pickCard(mood: Mood): Card {
  const cards = CARDS[mood]

  return cards[Math.floor(Math.random() * cards.length)] ?? cards[0]
}

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours > 0) {
    return `${hours} 小時 ${minutes} 分`
  }

  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}

function folderOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

async function send($: EngineInterface, mood: Mood, card: Card, seconds: number, tools: number): Promise<void> {
  const folder = folderOf(await $.session.cwd())
  const subtitle = `${folder} · ${clock(seconds)} · ${tools} 次工具`
  const notifier = `${$.plugin.root}/notifier`

  try {
    // 首選：透過 DingDong.app 發通知，圖示才會是橘色吉祥物。
    // app 讀同資料夾的 message.txt，四行依序是標題、副標題、內文、音效
    if (await $.fs.exists(`${notifier}/DingDong.app`)) {
      await $.fs.write(`${notifier}/message.txt`, [card.title, subtitle, card.body, SOUNDS[mood]].join('\n'))
      const opened = await $.process.run(['open', '-g', '-n', '-a', `${notifier}/DingDong.app`], { timeoutMs: 5000 })

      if (opened.exitCode === 0) {
        return
      }
    }

    // 備援：沒有 app 時直接用 osascript，圖示會是系統的「工序指令編寫程式」。
    // 文字用 argv 傳給 AppleScript，不拼進腳本字串，引號和反斜線就不必跳脫
    const sent = await $.process.run(
      [
        'osascript',
        '-e',
        'on run argv',
        '-e',
        'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name (item 4 of argv)',
        '-e',
        'end run',
        card.body,
        card.title,
        subtitle,
        SOUNDS[mood],
      ],
      { timeoutMs: 5000 },
    )

    if (sent.exitCode === 0) {
      return
    }
  } catch {
    // 兩種都發不出去（例如不是 macOS）時，改用下面的 toast
  }

  $.ui.toast(`${card.title} ${card.body}`)
}

export const register: Register = on => {
  let tools = 0
  let previews = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ding',
      description: '預覽回合完成通知，每次換一種心情',
    })

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    tools = 0

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    // 只算主對話的工具，subagent 的不算
    if (e.agentId === undefined) {
      tools += 1
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const seconds = Math.round(e.durationMs / 1000)
    // 被你中斷的回合不通知：你人就在現場
    const isWorthIt = e.agentId === undefined && !e.isAborted && seconds >= MIN_SECONDS

    if (isWorthIt) {
      const mood = moodOf(e.reason, seconds)
      await send($, mood, pickCard(mood), seconds, tools)
    }

    return done
  })

  on('command.run', { command: 'ding' }, async $ => {
    const { mood, seconds } = PREVIEWS[previews % PREVIEWS.length] ?? PREVIEWS[0]
    const card = pickCard(mood)
    previews += 1
    await send($, mood, card, seconds, 7)

    return { text: `已送出預覽通知（${mood}）：${card.title}` }
  })
}
