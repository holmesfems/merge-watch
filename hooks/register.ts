import type { EngineInterface, Register } from 'claude-code'
import {
  decide,
  intervalMs,
  mergedPrompt,
  parseStatus,
  readSeen,
  shortName,
  STATUS_TOOL,
  type BoundPr,
  type Seen,
  type Step,
} from './watch'

type Engine = EngineInterface

// reload で消えてよい、いまの写しのものだけ
let isPolling = false
let key: string | undefined

async function storeKey($: Engine): Promise<string> {
  key ??= `seen:${await $.session.id()}`
  return key
}

async function loadSeen($: Engine): Promise<Seen> {
  return readSeen(await $.store.get(await storeKey($)))
}

async function saveSeen($: Engine, seen: Seen): Promise<void> {
  await $.store.set(await storeKey($), seen)
}

/** アプリに、このセッションに bind された PR を聞く。ツールが無い（アプリの外）・bind が無いときは undefined */
async function boundPr($: Engine): Promise<BoundPr | undefined> {
  try {
    const r = await $.tool.call({ tool: STATUS_TOOL } as never)
    if (r.deny !== undefined || r.isError === true) return undefined
    return parseStatus(r.text)
  } catch {
    return undefined
  }
}

function showStatus($: Engine, step: Step): void {
  $.ui.status(step.kind === 'watching' ? `merge-watch: #${step.pr.number ?? shortName(step.pr)} を見張り中` : undefined)
}

async function note($: Engine, text: string): Promise<void> {
  await $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: `merge-watch: ${text}` }] } })
    .catch(() => undefined)
}

async function submit($: Engine, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await note($, `後始末を頼めませんでした（${why}）\n${text}`)
  }
}

/** bind された PR を 1 回見る。開いているのを見たことのある PR がマージされていれば、後始末を頼む */
async function poll($: Engine, cleanup: string): Promise<Step> {
  if (isPolling) return { kind: 'none' }
  isPolling = true
  try {
    const pr = await boundPr($)
    const before = await loadSeen($)
    const { step, seen } = decide(pr, before)
    if (seen !== before) await saveSeen($, seen)
    showStatus($, step)
    if (step.kind === 'merged') {
      $.ui.toast(`merge-watch: ${shortName(step.pr)} がマージされました`)
      // コマンドの中からは送れない（そのコマンドのターンを待ってしまう）ので、少しあとのタイマーから送る
      const text = mergedPrompt(step.pr, cleanup)
      $.clock.after(1_000, () => void submit($, text))
    } else if (step.kind === 'closed') {
      await note($, `${shortName(step.pr)} はマージされずに閉じられました`)
    }
    return step
  } finally {
    isPolling = false
  }
}

export const register: Register = (on, options) => {
  const every = intervalMs(options.intervalSeconds)
  const cleanup = typeof options.cleanup === 'string' ? options.cleanup : ''

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    key = undefined
    await $.command.register({
      name: 'merge-watch',
      description: 'このセッションに bind された PR の見張りの様子を見る（いま見に行く）',
    })
    // MCP のつながりを少し待ってから一度見て、あとは決まった間隔で
    $.clock.after(5_000, () => void poll($, cleanup))
    $.clock.every(every, () => void poll($, cleanup))
    return result
  })

  on('command.run', { command: 'merge-watch' }, async ($) => {
    const step = await poll($, cleanup)
    const text =
      step.kind === 'watching'
        ? `${step.pr.url} を見張っています（${every / 1000} 秒おき）`
        : step.kind === 'merged'
          ? `${shortName(step.pr)} がマージされたので、後始末を頼みました`
          : step.kind === 'closed'
            ? `${shortName(step.pr)} はマージされずに閉じられました`
            : '見張る PR がありません（このセッションに開いている PR が bind されていないか、デスクトップアプリの外です）'
    return { text, isTextDisplayOnly: true }
  })
}
