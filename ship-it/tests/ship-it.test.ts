import { expect, mock, test } from 'claude-code/testing'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const PANEL = '#2B2F3B'
const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('/ship demo 跑完五個階段，畫出深色的橫式面板', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/project' }))
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
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, bodyColumns: 100 },
  })
  expect((await wide.find({ type: 'Text', text: '全部完成' }))?.text).toContain('✓ 全部完成')
  expect(await wide.findAll({ type: 'Button' })).toHaveLength(2)
  expect(await wide.find({ type: 'Text', text: '━' })).toBeDefined()

  // 面板本身和每一段文字都要有深色底，而且每一列一樣寬，才會是一塊完整的矩形
  const boxes = await wide.findAll({ type: 'Box' })
  expect(boxes[0]?.props).toMatchObject({ backgroundColor: PANEL, width: 100 })
  const texts = await wide.findAll({ type: 'Text' })
  expect(texts.every(text => text.props.backgroundColor === PANEL)).toBe(true)

  // 終端機很窄時改成直向清單，同時驗證桌面版也畫得出來
  const narrow = await $.ui.mount({
    plugin: 'ship-it',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, bodyColumns: 36 },
  })
  expect(await narrow.find({ type: 'Text', text: '健康檢查' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: '━' })).toBeUndefined()
})

test('階段失敗時流程停下來，並顯示失敗的輸出', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('.claude/ship.json') }))
  on('fs.read', () => ({
    value: JSON.stringify({ stages: [{ name: '打包', run: 'npm run build' }, { name: '部署', run: 'npm run deploy' }] }),
  }))
  on('process.run', (_, e) => ({
    value: e.argv.includes('npm run build') ? { ...ok, exitCode: 1, stderr: 'error TS2304: Cannot find name' } : ok,
  }))

  await $.command.run({ command: 'ship', args: '' })
  await clock.advance(1000)

  const band = await $.ui.mount({
    plugin: 'ship-it',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, bodyColumns: 100 },
  })
  expect(await band.find({ type: 'Text', text: '打包 失敗' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'TS2304' })).toBeDefined()
})

test('沒有設定檔也沒有 package.json 時，回覆使用說明', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', () => ({ value: false }))

  const answer = await $.command.run({ command: 'ship', args: '' })

  expect(answer.text).toContain('/ship init')
})
