import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { isPrCreate, mergedPrompt, prUrls, intervalMs } from '../hooks/watch'

const PR = 'https://github.com/holmesfems/clawd-parade/pull/73'
const PR2 = 'https://github.com/holmesfems/clawd-parade/pull/74'

type Gh = Record<string, { state: string; mergedAt?: string; title?: string; headRefName?: string; baseRefName?: string } | 'fail'>

// mod の下にいるエンジンの代わり。store・gh・prompt.submit などに答え、何が起きたかを残す
function boot(on: On, { store = {}, gh = {} as Gh } = {}) {
  const clock = mock.clock(on, { now: 0 })
  const session = mock.session(on)
  const held = new Map<string, unknown>(Object.entries(store))
  const submitted: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const ghCalls: string[][] = []
  on('session.id', async () => ({ value: 's1' }))
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    held.delete(e.key)
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
  on('process.run', async (_$, e) => {
    ghCalls.push([...e.argv])
    const pr = gh[e.argv[3] ?? '']
    if (pr === undefined || pr === 'fail') {
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway\n', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(pr), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, session, held, submitted, toasts, statuses, ghCalls, gh }
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'merge-watch', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('PR の URL を文から取り出す', () => {
  expect(prUrls(`Created ${PR}\nsee also ${PR} and ${PR2}.`)).toEqual([PR, PR2])
  expect(prUrls('no url here')).toEqual([])
  expect(isPrCreate('gh pr create --title x --body y')).toBe(true)
  expect(isPrCreate('gh.exe pr create -f')).toBe(true)
  expect(isPrCreate('gh pr view 73')).toBe(false)
  expect(intervalMs(0)).toBe(60_000)
  expect(intervalMs(undefined)).toBe(300_000)
})

test('知らせの文には PR と後始末の手順が入る', () => {
  const text = mergedPrompt([{ url: PR, view: { state: 'MERGED', title: 'README', headRefName: 'claude/readme', baseRefName: 'main' } }], '')
  expect(text).toContain(PR)
  expect(text).toContain('claude/readme → main')
  expect(text).toContain('git branch -d')
  expect(text).toContain('claude plugin update')
  expect(mergedPrompt([{ url: PR, view: { state: 'MERGED' } }], '独自の手順')).toContain('独自の手順')
})

test('gh pr create で出した PR を見張り、マージされたら後始末を頼む', async ($, on) => {
  const env = boot(on, { gh: { [PR]: { state: 'OPEN' } } })
  on('tool.call', async () => ({ result: { stdout: PR }, text: `Creating pull request\n${PR}\n` }))
  await start($)

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(env.held.get('watches:s1')).toEqual([expect.objectContaining({ url: PR })])
  expect(env.toasts.at(-1)).toContain('clawd-parade#73')

  // まだ開いている
  await env.clock.advance(5 * 60_000)
  expect(env.ghCalls.length).toBe(1)
  expect(env.ghCalls[0]?.slice(0, 4)).toEqual(['gh', 'pr', 'view', PR])
  expect(env.submitted).toEqual([])

  // マージされた
  env.gh[PR] = { state: 'MERGED', mergedAt: '2026-11-21T10:00:00Z', title: 'README', headRefName: 'claude/readme', baseRefName: 'main' }
  await env.clock.advance(5 * 60_000 + 1_000)
  expect(env.submitted.length).toBe(1)
  expect(env.submitted[0]).toContain(PR)
  expect(env.held.has('watches:s1')).toBe(false)
  expect(env.statuses.at(-1)).toBeUndefined()

  // 見張りをやめたので、もう見に行かない
  await env.clock.advance(15 * 60_000)
  expect(env.ghCalls.length).toBe(2)
  expect(env.submitted.length).toBe(1)
})

test('gh pr create 以外のコマンドの出力にある URL は見張らない', async ($, on) => {
  const env = boot(on)
  on('tool.call', async () => ({ result: {}, text: PR }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: `gh pr view ${PR}` })
  expect(env.held.has('watches:s1')).toBe(false)
})

test('デスクトップアプリで bind した PR も見張る', async ($, on) => {
  const env = boot(on)
  on('tool.call', async () => ({ result: {}, text: 'bound' }))
  await start($)
  await $.tool.call({ tool: 'mcp__ccd_pr__bind_pr', url: PR } as never)
  expect(env.held.get('watches:s1')).toEqual([expect.objectContaining({ url: PR })])
})

test('autoWatch を切ると、自動では見張らない', { options: { autoWatch: false } }, async ($, on) => {
  const env = boot(on)
  on('tool.call', async () => ({ result: {}, text: PR }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(env.held.has('watches:s1')).toBe(false)
})

test('マージされずに閉じた PR は、知らせだけ残して見張りをやめる', async ($, on) => {
  const env = boot(on, { store: { 'watches:s1': [{ url: PR, addedAt: 'x' }] }, gh: { [PR]: { state: 'CLOSED' } } })
  await start($)
  // 再開したセッションは 15 秒後に一度見る
  await env.clock.advance(15_000)
  expect(env.submitted).toEqual([])
  expect(env.held.has('watches:s1')).toBe(false)
  expect(JSON.stringify(env.session.appended())).toContain('マージされずに閉じられた')
})

test('gh が失敗しても見張りは続け、続けて失敗したらやめる', async ($, on) => {
  const env = boot(on, { store: { 'watches:s1': [{ url: PR, addedAt: 'x' }] }, gh: { [PR]: 'fail' } })
  await start($)
  await env.clock.advance(15_000)
  expect(env.held.get('watches:s1')).toEqual([expect.objectContaining({ url: PR, failures: 1 })])
  await env.clock.advance(5 * 5 * 60_000)
  expect(env.held.has('watches:s1')).toBe(false)
  expect(JSON.stringify(env.session.appended())).toContain('見張りをやめました')
})

test('/merge-watch で足す・一覧・今すぐ見る・やめる', async ($, on) => {
  const env = boot(on, { gh: { [PR]: { state: 'OPEN' }, [PR2]: { state: 'MERGED' } } })
  await start($)

  expect((await run($, '')).text).toBe('見張っている PR はありません')
  expect((await run($, `${PR} ${PR2}`)).text).toContain('#73, holmesfems/clawd-parade#74 を見張ります')
  expect((await run($, PR)).text).toBe('もう見張っています')
  expect((await run($, '')).text).toContain(PR2)

  const checked = (await run($, 'check')).text ?? ''
  expect(checked).toContain('マージ済み: holmesfems/clawd-parade#74')
  await env.clock.advance(1_000)
  expect(env.submitted.length).toBe(1)

  expect((await run($, 'stop #73')).text).toContain('見張りをやめました')
  expect(env.held.has('watches:s1')).toBe(false)
  expect((await run($, 'not a url')).text).toContain('URL')
})

test('間隔は設定の分おき', { options: { intervalMinutes: 30 } }, async ($, on) => {
  const env = boot(on, { gh: { [PR]: { state: 'OPEN' } } })
  await start($)
  await run($, PR)
  await env.clock.advance(29 * 60_000)
  expect(env.ghCalls.length).toBe(0)
  await env.clock.advance(60_000)
  expect(env.ghCalls.length).toBe(1)
})
