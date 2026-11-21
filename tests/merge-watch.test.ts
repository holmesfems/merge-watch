import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { decide, intervalMs, mergedPrompt, parseStatus, STATUS_TOOL, type BoundPr } from '../hooks/watch'

const URL1 = 'https://github.com/holmesfems/merge-watch/pull/1'
const URL2 = 'https://github.com/holmesfems/merge-watch/pull/2'

const pr = (state: string, url = URL1): BoundPr => ({
  number: Number(url.split('/').pop()),
  url,
  repo: 'holmesfems/merge-watch',
  title: '最初のリリース',
  state,
  base: 'main',
  head: 'claude/first-release',
})

/** mcp__ccd_pr__get_status の答えの形 */
const statusText = (p: BoundPr | undefined) => JSON.stringify(p ? { bound: true, pr: p } : { bound: false })

// mod の下にいるエンジンの代わり。store・アプリの PR のツール・prompt.submit などに答え、何が起きたかを残す
function boot(on: On, { store = {} as Record<string, unknown>, bound = undefined as BoundPr | undefined | 'no-tool' } = {}) {
  const clock = mock.clock(on, { now: 0 })
  const session = mock.session(on)
  const held = new Map<string, unknown>(Object.entries(store))
  const app = { bound }
  const submitted: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  let calls = 0
  on('session.id', async () => ({ value: 's1' }))
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', async (_$, e) => {
    if (e.tool !== STATUS_TOOL) return { deny: 'unexpected tool' }
    calls++
    if (app.bound === 'no-tool') throw new Error(`No such tool: ${STATUS_TOOL}`)
    return { result: {}, text: statusText(app.bound) }
  })
  return { clock, session, held, app, submitted, toasts, statuses, calls: () => calls }
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })

const run = ($: Engine) =>
  $.command.run({ command: 'merge-watch', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('アプリの答えを読む', () => {
  expect(parseStatus(statusText(pr('open')))?.url).toBe(URL1)
  expect(parseStatus(statusText(undefined))).toBeUndefined()
  expect(parseStatus('not json')).toBeUndefined()
  expect(parseStatus(undefined)).toBeUndefined()
  expect(intervalMs(undefined)).toBe(30_000)
  expect(intervalMs(1)).toBe(10_000)
})

test('開いているのを見た PR がマージされたときだけ後始末を頼む', () => {
  const empty = { open: [], done: [] }
  // 見る前からマージ済み：何もしない
  expect(decide(pr('MERGED'), empty).step.kind).toBe('none')
  // 開いている → マージ
  const a = decide(pr('OPEN'), empty)
  expect(a.step.kind).toBe('watching')
  const b = decide(pr('MERGED'), a.seen)
  expect(b.step.kind).toBe('merged')
  // 二度は頼まない
  expect(decide(pr('MERGED'), b.seen).step.kind).toBe('none')
})

test('知らせの文には PR と後始末の手順が入る', () => {
  const text = mergedPrompt(pr('merged'), '')
  expect(text).toContain(URL1)
  expect(text).toContain('claude/first-release → main')
  expect(text).toContain('git branch -d')
  expect(text).toContain('claude plugin update')
  expect(mergedPrompt(pr('merged'), '独自の手順')).toContain('独自の手順')
})

test('打たなくても bind された PR を見張り、マージされたら後始末を頼む', async ($, on) => {
  const env = boot(on, { bound: pr('open') })
  await start($)

  await env.clock.advance(5_000)
  expect(env.statuses.at(-1)).toBe('merge-watch: #1 を見張り中')
  expect(env.held.get('seen:s1')).toEqual({ open: [URL1], done: [] })

  env.app.bound = pr('merged')
  await env.clock.advance(30_000 + 1_000)
  expect(env.submitted.length).toBe(1)
  expect(env.submitted[0]).toContain(URL1)
  expect(env.toasts.at(-1)).toContain('holmesfems/merge-watch#1 がマージされました')
  expect(env.statuses.at(-1)).toBeUndefined()

  // マージ済みのまま bind が残っていても、二度は頼まない
  await env.clock.advance(5 * 60_000)
  expect(env.submitted.length).toBe(1)
})

test('再開したセッションでも、前に開いているのを見た PR なら頼む', async ($, on) => {
  const env = boot(on, { store: { 'seen:s1': { open: [URL1], done: [] } }, bound: pr('merged') })
  await start($)
  await env.clock.advance(6_000)
  expect(env.submitted.length).toBe(1)
})

test('mod を入れる前にマージ済みだった PR では何もしない', async ($, on) => {
  const env = boot(on, { bound: pr('merged') })
  await start($)
  await env.clock.advance(5 * 60_000)
  expect(env.submitted).toEqual([])
})

test('マージされずに閉じた PR は知らせだけ残す', async ($, on) => {
  const env = boot(on, { bound: pr('open') })
  await start($)
  await env.clock.advance(5_000)
  env.app.bound = pr('closed')
  await env.clock.advance(30_000)
  expect(env.submitted).toEqual([])
  expect(JSON.stringify(env.session.appended())).toContain('マージされずに閉じられました')
})

test('次の PR が bind されたら、そちらを見張る', async ($, on) => {
  const env = boot(on, { bound: pr('open') })
  await start($)
  await env.clock.advance(5_000)
  env.app.bound = pr('merged')
  await env.clock.advance(30_000)
  env.app.bound = pr('open', URL2)
  await env.clock.advance(30_000)
  expect(env.statuses.at(-1)).toBe('merge-watch: #2 を見張り中')
  env.app.bound = pr('merged', URL2)
  await env.clock.advance(30_000 + 1_000)
  expect(env.submitted.length).toBe(2)
  expect(env.submitted[1]).toContain(URL2)
})

test('アプリの外（ツールが無い）では何もしない', async ($, on) => {
  const env = boot(on, { bound: 'no-tool' })
  await start($)
  await env.clock.advance(60_000)
  expect(env.calls()).toBeGreaterThan(0)
  expect(env.submitted).toEqual([])
  expect(env.statuses.every(s => s === undefined)).toBe(true)
  expect((await run($)).text).toContain('見張る PR がありません')
})

test('/merge-watch は様子を答える', async ($, on) => {
  const env = boot(on, { bound: pr('open') })
  await start($)
  expect((await run($)).text).toBe(`${URL1} を見張っています（30 秒おき）`)
  env.app.bound = pr('merged')
  expect((await run($)).text).toContain('後始末を頼みました')
  await env.clock.advance(1_000)
  expect(env.submitted.length).toBe(1)
})

test('間隔は設定の秒おき', { options: { intervalSeconds: 120 } }, async ($, on) => {
  const env = boot(on, { bound: pr('open') })
  await start($)
  await env.clock.advance(5_000)
  const first = env.calls()
  await env.clock.advance(119_000 - 5_000)
  expect(env.calls()).toBe(first)
  await env.clock.advance(1_000)
  expect(env.calls()).toBe(first + 1)
})
