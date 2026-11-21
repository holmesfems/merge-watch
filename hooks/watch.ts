// 見張りの中身のうち、$ を使わない部分（URL の読み取り・知らせの文面など）

export type Watch = {
  /** https://github.com/<owner>/<repo>/pull/<n> */
  url: string
  /** 見張りに加えた時刻（ISO） */
  addedAt: string
  /** 続けて失敗した回数（gh が動かない・ネットワークなど） */
  failures?: number
}

export type PrView = {
  state: 'OPEN' | 'CLOSED' | 'MERGED' | string
  mergedAt?: string | null
  number?: number
  title?: string
  headRefName?: string
  baseRefName?: string
  url?: string
}

export const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

/** 文の中の PR の URL を、重ならないように取り出す */
export function prUrls(text: string): string[] {
  return [...new Set(text.match(PR_URL) ?? [])]
}

/** `gh pr create` を動かすコマンドか */
export function isPrCreate(command: string): boolean {
  return /\bgh(\.exe)?\s+pr\s+create\b/.test(command)
}

/** `owner/repo#n` の短い呼び名 */
export function shortName(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  return m ? `${m[1]}#${m[2]}` : url
}

/** 見張りの一覧に足す（同じ URL があれば足さない） */
export function addWatch(list: readonly Watch[], url: string, now: Date): Watch[] {
  if (list.some(w => w.url === url)) return [...list]
  return [...list, { url, addedAt: now.toISOString() }]
}

/** 間隔（分）をミリ秒に。1〜120 分におさめる */
export function intervalMs(minutes: unknown): number {
  const n = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 5
  return Math.min(120, Math.max(1, n)) * 60_000
}

export const DEFAULT_CLEANUP = [
  '1. `git status` で、まだコミットしていない変更が無いか確かめる。あれば何もせずに、どうするかユーザーに聞く。',
  '2. いまのブランチを覚えておき、マージ先のブランチ（ふつうは main）に切り替えて `git pull` する。',
  '3. マージされた PR のローカルブランチを `git branch -d` で消す（`-D` は使わない。消せなければそのままにして伝える）。ワークツリーの中で作業しているときは、ブランチの切り替えも削除もせず、そのことだけ伝える。',
  '4. pull の前と後で `.claude-plugin/plugin.json` の version が変わっていたら、`claude plugin update <name>`（name は plugin.json の name）で入れ直せることを伝える。自分では動かさない。',
  '5. やったことを 2〜3 行でまとめる。',
].join('\n')

/** マージされた PR について、Claude に頼む文 */
export function mergedPrompt(
  merged: readonly { url: string; view: PrView }[],
  cleanup: string,
): string {
  const lines = merged.map(({ url, view }) => {
    const title = view.title ? `「${view.title}」` : ''
    const branch = view.headRefName ? `（${view.headRefName} → ${view.baseRefName ?? '?'}）` : ''
    const when = view.mergedAt ? ` ${view.mergedAt} にマージ` : ' マージ済み'
    return `- ${url} ${title}${branch}${when}`
  })
  const steps = cleanup.trim() === '' ? DEFAULT_CLEANUP : cleanup.trim()
  return [
    merged.length === 1
      ? 'このセッションで見張っていた PR がマージされました。'
      : `このセッションで見張っていた PR が ${merged.length} 件マージされました。`,
    ...lines,
    '',
    '次の後始末をしてください（どれかが思いどおりにいかなければ、そこで止めてユーザーに伝えること）。',
    steps,
  ].join('\n')
}

/** `gh pr view --json` の出力を読む。読めなければ undefined */
export function parseView(stdout: string): PrView | undefined {
  try {
    const v = JSON.parse(stdout) as PrView
    return typeof v?.state === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

export const VIEW_FIELDS = 'state,mergedAt,number,title,headRefName,baseRefName,url'
