import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Block = { type: string; [field: string]: unknown }

// 全部是虛構資料：A123456789 是教科書上的範例身分證字號，4111… 是測試用卡號
const RECORD = [
  '客戶：王小明',
  '聯絡電話：0912345678',
  '電子郵件：wang@example.com',
  '身分證字號：A123456789',
  '所屬公司：範例科技股份有限公司（統編 10000009）',
  '通訊地址：臺北市中正區忠孝東路一段',
  '案由：續約，金額新臺幣 30 萬元，分兩期付款。',
].join('\n')

const MASKED = [
  '客戶：<PERSON_1>',
  '聯絡電話：<TW_MOBILE_1>',
  '電子郵件：<EMAIL_ADDRESS_1>',
  '身分證字號：<TW_NATIONAL_ID_1>',
  '所屬公司：<ORG_1>（統編 <TW_BUSINESS_ID_1>）',
  '通訊地址：<LOCATION_1>',
  '案由：續約，金額新臺幣 30 萬元，分兩期付款。',
].join('\n')

const PANE_PROPS = {
  title: '個資對照表',
  isFocused: false,
  placement: 'inline',
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 14 },
  view: {},
} as const

function quiet(on: On): void {
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
}

const ask = async ($: Engine, text: string): Promise<string | undefined> =>
  (await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })).text

const pii = async ($: Engine, args: string): Promise<string> => (await $.command.run({ command: 'pii', args })).text ?? ''

// 測試工具底下沒有引擎能真的存這一列，所以 append 會以錯誤結束；
// 這裡要看的是「經過 mod 之後、抵達底層的內容」，在最底下的 hook 記下來就好。
// 底層的 hook 要在第一次呼叫 $ 之前註冊，所以分成 watch 和 append 兩步
function watch(on: On): () => Block[] {
  let arrived: Block[] = []
  on('session.append', (_, e, next) => {
    arrived = e.message.content

    return next(e)
  })

  return () => arrived
}

async function append($: Engine, door: 'tool-result' | 'command', text: string): Promise<void> {
  await $.session
    .append({
      door,
      origin: { kind: 'tool', tool: 'Read' },
      uuid: `row-${door}`,
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    })
    .catch(() => undefined)
}

test('預設關閉，不會改動 prompt', async ($, on) => {
  quiet(on)

  expect(await ask($, RECORD)).toBe(RECORD)
})

test('開啟後，一份客戶紀錄裡的個資都換成代號', async ($, on) => {
  quiet(on)
  await pii($, 'on')

  expect(await ask($, RECORD)).toBe(MASKED)
})

test('同一個原文拿到同一個代號，不同的原文往下編號', async ($, on) => {
  quiet(on)
  await pii($, 'on')

  expect(await ask($, '0912345678 和 0987-654-321，再一次 0912345678')).toBe(
    '<TW_MOBILE_1> 和 <TW_MOBILE_2>，再一次 <TW_MOBILE_1>',
  )
})

test('檢查碼不對的號碼和一般數字不會被誤判', async ($, on) => {
  quiet(on)
  await pii($, 'on')
  const harmless = '身分證 A123456788 打錯了；卡號 4111 1111 1111 1112 無效；訂單 20261004；remote 是 git@github.com:me/repo.git'

  expect(await ask($, harmless)).toBe(harmless)
  expect(await ask($, '卡號 4111 1111 1111 1111，市話 (02) 2345-6789')).toBe('卡號 <CREDIT_CARD_1>，市話 <TW_PHONE_1>')
})

test('名單裡的詞會被遮蔽，而且加入名單的那行指令紀錄也不會洩漏', async ($, on) => {
  quiet(on)
  const arrived = watch(on)

  expect(await pii($, 'add 陳美玲')).not.toContain('陳美玲')
  // 即使遮蔽是關閉的，指令紀錄裡的名字也要換掉
  await append($, 'command', '/pii add 陳美玲')
  expect(arrived()).toEqual([{ type: 'text', text: '/pii add <NAME_1>' }])

  await pii($, 'on')
  expect(await ask($, '請寫信給陳美玲，副本給陳美玲的主管')).toBe('請寫信給<NAME_1>，副本給<NAME_1>的主管')
})

test('工具輸出裡的個資在送給模型前換成代號', async ($, on) => {
  quiet(on)
  const arrived = watch(on)
  await pii($, 'on')

  await append($, 'tool-result', RECORD)
  expect(arrived()).toEqual([{ type: 'text', text: MASKED }])
})

test('/pii restore 把檔案裡的代號換回原文，另存新檔', async ($, on) => {
  quiet(on)
  const written: string[] = []
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '敬啟者 <PERSON_1>：續約信已寄往 <EMAIL_ADDRESS_1>。另見 <ORG_9>。' }))
  on('fs.write', (_, e) => {
    written.push(e.path.split('/').pop() ?? '', e.text)

    return { value: undefined }
  })
  await pii($, 'on')
  await ask($, RECORD)

  const reply = await pii($, 'restore 回信.md')

  expect(written).toEqual(['回信.restored.md', '敬啟者 王小明：續約信已寄往 wang@example.com。另見 <ORG_9>。'])
  expect(reply).toContain('已還原 2 處')
  expect(reply).not.toContain('王小明')
})

test('對照表只畫在面板上，指令的文字回覆不含原文', async ($, on) => {
  quiet(on)
  await pii($, 'on')
  await ask($, RECORD)

  const reply = await pii($, '')
  expect(reply).toContain('對照表：7 筆')
  expect(reply).not.toContain('王小明')
  expect(reply).not.toContain('0912345678')

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'pii-mask', surface, component: 'Pane', requestId: 'pii-mask', props: PANE_PROPS })

    expect(await pane.find({ type: 'Text', text: '王小明' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '<TW_MOBILE_1>' })).toBeDefined()
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(2)
  }
})

test('/pii forget 清空對照表後，舊代號不再還原', async ($, on) => {
  quiet(on)
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '<PERSON_1>' }))
  await pii($, 'on')
  await ask($, RECORD)

  expect(await pii($, 'forget')).toContain('已清空')
  expect(await pii($, 'restore 回信.md')).toContain('沒有可還原的代號')
})
