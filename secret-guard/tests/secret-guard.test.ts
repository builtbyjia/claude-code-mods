import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試用的假金鑰，格式對但不是真的
const GITHUB = `ghp_${'a1B2'.repeat(9)}`
const ANTHROPIC = `sk-ant-${'x9'.repeat(15)}`

type Block = { type: string; [field: string]: unknown }

// 測試工具底下沒有引擎能真的存這一列，所以 append 會以錯誤結束；
// 這裡要看的是「經過 mod 之後、抵達底層的內容」，在最底下的 hook 記下來就好
async function appended($: Engine, on: On, row: Parameters<Engine['session']['append']>[0]): Promise<Block[]> {
  let arrived: Block[] = []
  on('session.append', (_, e, next) => {
    arrived = e.message.content

    return next(e)
  })
  await $.session.append(row).catch(() => undefined)

  return arrived
}

test('prompt 裡的金鑰在送出前被換成標記', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const entered = await $.prompt.submit({
    text: `我的 token 是 ${GITHUB}，另一把是 ${ANTHROPIC}`,
    wait: false,
    origin: { kind: 'composer' },
  })

  expect(entered.text).toBe('我的 token 是 [已遮蔽:GitHub token]，另一把是 [已遮蔽:Anthropic API key]')
})

test('一般的 prompt 和程式碼不會被誤傷', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const text = [
    '幫我把 const token = "placeholder" 改成從 process.env.API_KEY 讀',
    'input type="password" 要加 autocomplete',
    'KEYBOARD_LAYOUT=us',
  ].join('\n')

  const entered = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  expect(entered.text).toBe(text)
})

test('讀寫 .env 和私鑰被擋下，範本檔和一般檔案放行', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))

  for (const file_path of ['/project/.env', '/project/.env.local', '/Users/me/.ssh/id_ed25519', '/project/server.pem']) {
    expect(JSON.stringify(await $.tool.call({ tool: 'Read', file_path }))).toContain('secret-guard')
  }

  expect(JSON.stringify(await $.tool.call({ tool: 'Write', file_path: '/project/.env', content: 'A=1' }))).toContain(
    'secret-guard',
  )

  for (const file_path of ['/project/.env.example', '/project/src/env.ts', '/Users/me/.ssh/id_ed25519.pub']) {
    expect(await $.tool.call({ tool: 'Read', file_path })).toMatchObject({ result: 'ok' })
  }
})

test('會洩漏金鑰的 shell 指令被擋下，一般指令放行', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))

  for (const command of ['cat .env', 'grep KEY ./config/.env.production', 'printenv', 'env | sort', `python -c "print(open('.env').read())"`]) {
    expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command }))).toContain('secret-guard')
  }

  for (const command of ['npm test', 'node --env-file=.env server.js', 'cat .env.example', 'printenv HOME', 'env NODE_ENV=test npm run build']) {
    expect(await $.tool.call({ tool: 'Bash', command })).toMatchObject({ result: 'ok' })
  }
})

test('工具輸出裡的金鑰在存進對話前被遮蔽', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))

  const arrived = await appended($, on, {
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'row-1',
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: [
            { type: 'text', text: `DATABASE_PASSWORD=hunter22\nPORT=3000\n     3→  "apiKey": "abc123def456ghi789",\n${GITHUB}` },
          ],
        },
      ],
    },
  })

  expect(arrived).toEqual([
    {
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: [
        {
          type: 'text',
          text: 'DATABASE_PASSWORD=[已遮蔽:環境變數]\nPORT=3000\n     3→  "apiKey": "[已遮蔽:設定值]",\n[已遮蔽:GitHub token]',
        },
      ],
    },
  ])
})

test('模型自己的回覆不會被改寫', async ($, on) => {
  const content = [{ type: 'text', text: `範例：${GITHUB}` }]

  const arrived = await appended($, on, {
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-2',
    message: { type: 'assistant', role: 'assistant', content },
  })

  expect(arrived).toEqual(content)
})

test('/guard off 之後不再遮蔽，/guard on 恢復', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const prompt = { text: GITHUB, wait: false, origin: { kind: 'composer' } } as const

  expect((await $.command.run({ command: 'guard', args: 'off' })).text).toContain('關閉')
  expect((await $.prompt.submit(prompt)).text).toBe(GITHUB)

  expect((await $.command.run({ command: 'guard', args: 'on' })).text).toContain('開啟')
  expect((await $.prompt.submit(prompt)).text).toBe('[已遮蔽:GitHub token]')
})
