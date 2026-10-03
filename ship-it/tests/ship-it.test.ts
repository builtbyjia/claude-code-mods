import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: '進程',
  isFocused: false,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('/ship demo 跑完五個階段，寬窄兩種版面都畫得出來', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => {
    commands.push(e.argv.join(' '))

    return { value: ok }
  })

  const answer = await $.command.run({ command: 'ship', args: 'demo' })
  await clock.advance(1000)

  expect(answer.text).toContain('開始跑 5 個階段')
  expect(toasts).toEqual(['5 個階段全部完成'])
  expect(commands).toEqual(['bash -c sleep 2', 'bash -c sleep 4', 'bash -c sleep 3', 'bash -c sleep 5', 'bash -c sleep 1'])

  const wide = await $.ui.mount({
    plugin: 'ship-it',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ship-it',
    props: { ...PANE_PROPS, bodyColumns: 100 },
  })
  expect((await wide.find({ type: 'Text', text: '全部完成' }))?.text).toContain('✓ 全部完成')
  expect(await wide.findAll({ type: 'Button' })).toHaveLength(2)
  expect(await wide.find({ type: 'Text', text: '━' })).toBeDefined()

  // 同一個 pane 在一個 surface 只能掛一次，窄版順便驗證桌面版也畫得出來
  const narrow = await $.ui.mount({
    plugin: 'ship-it',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'ship-it',
    props: { ...PANE_PROPS, placement: 'dock', bodyColumns: 36 },
  })
  expect(await narrow.find({ type: 'Text', text: '健康檢查' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: '━' })).toBeUndefined()
})

test('階段失敗時流程停下來，並顯示失敗的輸出', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('.claude/ship.json') }))
  on('fs.read', () => ({
    value: JSON.stringify({ stages: [{ name: '打包', run: 'npm run build' }, { name: '部署', run: 'npm run deploy' }] }),
  }))
  on('process.run', (_, e) => ({
    value: e.argv.includes('npm run build') ? { ...ok, exitCode: 1, stderr: 'error TS2304: Cannot find name' } : ok,
  }))

  await $.command.run({ command: 'ship', args: '' })
  await clock.advance(1000)

  const pane = await $.ui.mount({
    plugin: 'ship-it',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ship-it',
    props: { ...PANE_PROPS, bodyColumns: 100 },
  })
  expect(await pane.find({ type: 'Text', text: '打包 失敗' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'TS2304' })).toBeDefined()
})

test('沒有設定檔也沒有 package.json 時，回覆使用說明', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))

  const answer = await $.command.run({ command: 'ship', args: '' })

  expect(answer.text).toContain('/ship init')
})
