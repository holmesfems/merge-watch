// 見張りの中身のうち、$ を使わない部分（アプリの答えの読み取り・知らせの文面など）

/** デスクトップアプリの PR のツール（セッションに bind された PR の状態を、アプリの手元から返す） */
export const STATUS_TOOL = 'mcp__ccd_pr__get_status'

/** mcp__ccd_pr__get_status の答えのうち、使うところ */
export type BoundPr = {
  number?: number
  url: string
  repo?: string
  title?: string
  /** open / merged / closed（大文字・小文字はアプリしだいなので、読むときにそろえる） */
  state: string
  base?: string
  head?: string
}

export type PrState = 'open' | 'merged' | 'closed' | 'other'

/** アプリの答え（JSON の文）を読む。bind された PR が無い・読めないときは undefined */
export function parseStatus(text: string | undefined): BoundPr | undefined {
  if (!text) return undefined
  try {
    const v = JSON.parse(text) as { bound?: boolean; pr?: Partial<BoundPr> | null }
    const pr = v?.pr
    if (v?.bound === false || !pr || typeof pr.url !== 'string' || typeof pr.state !== 'string') return undefined
    return pr as BoundPr
  } catch {
    return undefined
  }
}

export function stateOf(pr: BoundPr): PrState {
  const s = pr.state.toLowerCase()
  if (s === 'open' || s === 'draft') return 'open'
  if (s === 'merged') return 'merged'
  if (s === 'closed') return 'closed'
  return 'other'
}

/** `owner/repo#n` の短い呼び名 */
export function shortName(pr: Pick<BoundPr, 'url'>): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr.url)
  return m ? `${m[1]}#${m[2]}` : pr.url
}

/** 間隔（秒）をミリ秒に。10〜600 秒におさめる */
export function intervalMs(seconds: unknown): number {
  const n = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 30
  return Math.min(600, Math.max(10, n)) * 1000
}

export const DEFAULT_CLEANUP = [
  '1. このセッションの作業フォルダが、この PR のリポジトリのものか確かめる。違えば、後始末をどのフォルダでするかを探すかユーザーに聞く。',
  '2. `git status` で、まだコミットしていない変更が無いか確かめる。あれば何もせずに、どうするかユーザーに聞く。',
  '3. マージ先のブランチ（ふつうは main）に切り替えて `git pull` する。ワークツリーの中で作業しているときは、切り替えずにそのことだけ伝える。',
  '4. マージされた PR のローカルブランチを `git branch -d` で消す（`-D` は使わない。消せなければそのままにして伝える）。',
  '5. pull の前と後で `.claude-plugin/plugin.json` の version が変わっていたら、`claude plugin update <name>`（name は plugin.json の name）で入れ直せることを伝える。自分では動かさない。',
  '6. やったことを 2〜3 行でまとめる。',
].join('\n')

/** マージされた PR について、Claude に頼む文 */
export function mergedPrompt(pr: BoundPr, cleanup: string): string {
  const title = pr.title ? `「${pr.title}」` : ''
  const branch = pr.head ? `（${pr.head} → ${pr.base ?? '?'}）` : ''
  const steps = cleanup.trim() === '' ? DEFAULT_CLEANUP : cleanup.trim()
  return [
    'このセッションに bind されている PR がマージされました。',
    `- ${pr.url} ${title}${branch}`,
    '',
    '次の後始末をしてください（どれかが思いどおりにいかなければ、そこで止めてユーザーに伝えること）。',
    steps,
  ].join('\n')
}

/**
 * 見張りの記録（セッションごとに store に残す）。
 * - open: 開いているのを見た PR の URL。これが merged になったときだけ後始末を頼む
 *   （mod を入れる前にマージ済みだった PR で、古いセッションが急に動き出さないように）
 * - done: 知らせ終えた PR の URL（同じ PR で二度頼まない）
 */
export type Seen = { open: string[]; done: string[] }

export type Step =
  | { kind: 'none' }
  | { kind: 'watching'; pr: BoundPr }
  | { kind: 'merged'; pr: BoundPr }
  | { kind: 'closed'; pr: BoundPr }

/** アプリの答えと記録から、次にすることを決める。記録の更新もここで */
export function decide(pr: BoundPr | undefined, seen: Seen): { step: Step; seen: Seen } {
  if (!pr) return { step: { kind: 'none' }, seen }
  const state = stateOf(pr)
  const wasOpen = seen.open.includes(pr.url)
  const isDone = seen.done.includes(pr.url)
  if (state === 'open') {
    return {
      step: { kind: 'watching', pr },
      seen: wasOpen ? seen : { ...seen, open: [...seen.open, pr.url] },
    }
  }
  if ((state === 'merged' || state === 'closed') && wasOpen && !isDone) {
    return {
      step: { kind: state, pr },
      seen: { open: seen.open.filter(u => u !== pr.url), done: [...seen.done, pr.url].slice(-20) },
    }
  }
  return { step: { kind: 'none' }, seen }
}

export function readSeen(v: unknown): Seen {
  const o = (v ?? {}) as Partial<Seen>
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((u): u is string => typeof u === 'string') : [])
  return { open: list(o.open), done: list(o.done) }
}
