import type { EngineInterface, Register } from 'claude-code'
import {
  addWatch,
  intervalMs,
  isPrCreate,
  mergedPrompt,
  parseView,
  prUrls,
  shortName,
  VIEW_FIELDS,
  type PrView,
  type Watch,
} from './watch'

type Engine = EngineInterface

const BIND_TOOL = 'mcp__ccd_pr__bind_pr'
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/** gh が続けてこの回数失敗した PR は見張りをやめる */
const MAX_FAILURES = 6

// reload で消えてよい、いまの写しのものだけ
let isPolling = false
let key: string | undefined

async function storeKey($: Engine): Promise<string> {
  key ??= `watches:${await $.session.id()}`
  return key
}

async function load($: Engine): Promise<Watch[]> {
  const v = await $.store.get(await storeKey($))
  return Array.isArray(v) ? (v as Watch[]).filter(w => typeof w?.url === 'string') : []
}

async function save($: Engine, list: readonly Watch[]): Promise<void> {
  const k = await storeKey($)
  if (list.length === 0) await $.store.delete(k)
  else await $.store.set(k, list)
  showStatus($, list)
}

function showStatus($: Engine, list: readonly Watch[]): void {
  $.ui.status(
    list.length === 0
      ? undefined
      : `merge-watch: ${list.map(w => '#' + w.url.split('/').pop()).join(' ')} を見張り中`,
  )
}

async function watch($: Engine, urls: readonly string[]): Promise<string[]> {
  let list = await load($)
  const added: string[] = []
  for (const url of urls) {
    const next = addWatch(list, url, new Date())
    if (next.length > list.length) added.push(url)
    list = next
  }
  if (added.length > 0) {
    await save($, list)
    $.ui.toast(`merge-watch: ${added.map(shortName).join(', ')} のマージを見張ります`)
  }
  return added
}

async function view($: Engine, url: string): Promise<PrView | string> {
  try {
    const r = await $.process.run(['gh', 'pr', 'view', url, '--json', VIEW_FIELDS], {
      timeoutMs: 30_000,
    })
    if (r.exitCode !== 0) return r.stderr.trim().split('\n')[0] || `gh が ${r.exitCode} で終わりました`
    return parseView(r.stdout) ?? 'gh の出力が読めませんでした'
  } catch (err) {
    return `gh を動かせませんでした（${err instanceof Error ? err.message : String(err)}）`
  }
}

/** 見張っている PR を 1 回ずつ見に行く。マージされたものがあれば Claude に頼む */
async function submit($: Engine, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await $.session
      .append({ message: { type: 'system', content: [{ type: 'text', text: `merge-watch: 後始末を頼めませんでした（${why}）\n${text}` }] } })
      .catch(() => undefined)
  }
}

async function poll($: Engine, cleanup: string): Promise<string> {
  if (isPolling) return 'いま見に行っているところです'
  isPolling = true
  try {
    const list = await load($)
    if (list.length === 0) {
      showStatus($, list)
      return '見張っている PR はありません'
    }
    const keep: Watch[] = []
    const merged: { url: string; view: PrView }[] = []
    const notes: string[] = []
    for (const w of list) {
      const v = await view($, w.url)
      if (typeof v === 'string') {
        const failures = (w.failures ?? 0) + 1
        if (failures >= MAX_FAILURES) notes.push(`${shortName(w.url)}: 続けて読めないので見張りをやめました（${v}）`)
        else keep.push({ ...w, failures })
        if (failures === 1 || failures >= MAX_FAILURES) notes.push(`${shortName(w.url)}: ${v}`)
        continue
      }
      if (v.state === 'MERGED') merged.push({ url: w.url, view: v })
      else if (v.state === 'CLOSED') notes.push(`${shortName(w.url)} はマージされずに閉じられたので、見張りをやめました`)
      else keep.push({ ...w, failures: 0 })
    }
    await save($, keep)
    for (const text of notes) {
      await $.session
        .append({ message: { type: 'system', content: [{ type: 'text', text: `merge-watch: ${text}` }] } })
        .catch(() => undefined)
    }
    if (merged.length > 0) {
      $.ui.toast(`merge-watch: ${merged.map(m => shortName(m.url)).join(', ')} がマージされました`)
      // コマンドの中からは送れない（そのコマンドのターンを待ってしまう）ので、少しあとのタイマーから送る
      const text = mergedPrompt(merged, cleanup)
      $.clock.after(1_000, () => void submit($, text))
    }
    return [
      merged.length > 0 ? `マージ済み: ${merged.map(m => shortName(m.url)).join(', ')}（後始末を頼みました）` : '',
      keep.length > 0 ? `見張り中: ${keep.map(w => shortName(w.url)).join(', ')}` : '見張っている PR はありません',
      ...notes,
    ]
      .filter(Boolean)
      .join('\n')
  } finally {
    isPolling = false
  }
}

export const register: Register = (on, options) => {
  const every = intervalMs(options.intervalMinutes)
  const autoWatch = options.autoWatch !== false
  const cleanup = typeof options.cleanup === 'string' ? options.cleanup : ''

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'merge-watch',
      description: 'PR のマージを見張る（引数なしで一覧、URL で追加、stop <URL|番号> でやめる、check で今すぐ見る）',
      argumentHint: '[<PR の URL> | stop <URL|番号> | check]',
    })
    key = undefined
    const list = await load($)
    showStatus($, list)
    // 再開したセッションでは、寝ているあいだにマージされているかもしれないので、すぐに一度見る
    if (list.length > 0) $.clock.after(15_000, () => void poll($, cleanup))
    $.clock.every(every, () => void poll($, cleanup))
    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!autoWatch || ran.deny !== undefined || ran.isError === true) return ran
    let urls: string[] = []
    if (SHELL_TOOLS.has(e.tool)) {
      const command = (e as { command?: unknown }).command
      if (typeof command === 'string' && isPrCreate(command)) urls = prUrls(ran.text ?? '')
    } else if (e.tool === BIND_TOOL) {
      const url = (e as { url?: unknown }).url
      if (typeof url === 'string') urls = prUrls(url)
    }
    if (urls.length > 0) await watch($, urls).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e)) // 見張りに加えるのに失敗しても、ツールの結果はそのまま返す

  on('command.run', { command: 'merge-watch' }, async ($, e) => {
    const args = e.args.trim()
    const [verb, ...rest] = args.split(/\s+/)
    let text: string
    if (args === '') {
      const list = await load($)
      text =
        list.length === 0
          ? '見張っている PR はありません'
          : `見張り中（${every / 60_000} 分おき）:\n${list.map(w => `- ${w.url}`).join('\n')}`
    } else if (verb === 'check') {
      text = await poll($, cleanup)
    } else if (verb === 'stop') {
      const target = rest.join(' ')
      const list = await load($)
      const keep = list.filter(
        w => !(w.url === target || w.url.endsWith(`/pull/${target.replace(/^#/, '')}`)),
      )
      await save($, keep)
      text =
        keep.length < list.length ? `${target} の見張りをやめました` : `${target} は見張っていません`
    } else {
      const urls = prUrls(args)
      if (urls.length === 0) {
        text = 'PR の URL（https://github.com/<owner>/<repo>/pull/<番号>）を渡してください'
      } else {
        const added = await watch($, urls)
        text =
          added.length > 0
            ? `${added.map(shortName).join(', ')} を見張ります（${every / 60_000} 分おき）`
            : 'もう見張っています'
      }
    }
    return { text, isTextDisplayOnly: true }
  })
}
