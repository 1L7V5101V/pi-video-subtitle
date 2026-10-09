import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clashEnabled, clashGroup, clashPickNext, clashRoutingGroup, clashSelectNode, discoverClashController } from './clash'
import type { ClashController } from './clash'
import type { FetchSubtitleOptions, FetchSubtitleResult, SubtitleCue, SubtitleTrackInfo, VideoService } from './types'
import { rankTracks } from './utils'

/**
 * Generic yt-dlp engine.
 *
 * Two reasons it exists:
 *  1. YouTube: it is the only client that keeps working now that the plain
 *     `timedtext` endpoint answers 200 with an empty body (proof-of-origin gate).
 *  2. Everything else: yt-dlp supports ~1800 sites, so any URL the built-in
 *     parsers do not recognise can still be transcribed.
 *
 * yt-dlp does the HTTP itself, which is also what makes proxies work: it honours
 * HTTPS_PROXY and the explicit `--proxy` we pass from PI_SUBTITLE_PROXY.
 */

export interface YtDlpInfo {
  id?: string
  title?: string
  description?: string
  extractor_key?: string
  subtitles?: Record<string, unknown>
  automatic_captions?: Record<string, unknown>
}

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  segs?: { utf8?: string }[]
}

/** `HH:MM:SS,mmm` / `MM:SS.mmm` / `HH:MM:SS.mmm` (SRT and WebVTT both arrive here). */
function parseTimestamp(value: string): number {
  const match = value.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/)
  if (!match) return 0
  const [, hours, minutes, seconds, millis] = match
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis.padEnd(3, '0')) / 1000
}

export function parseJson3(payload: { events?: Json3Event[] }): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const event of payload.events ?? []) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\n/g, ' ')
      .trim()
    if (!text) continue
    const start = (event.tStartMs ?? 0) / 1000
    cues.push({ index: cues.length, start, end: start + (event.dDurationMs ?? 0) / 1000, text })
  }
  return cues
}

/** Shared by SRT and WebVTT: timed blocks separated by blank lines. */
function parseTimedBlocks(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = content.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue
    const arrowIndex = lines.findIndex((line) => line.includes('-->'))
    if (arrowIndex === -1) continue // WEBVTT header, NOTE/STYLE blocks, cue ids
    const [from, to] = lines[arrowIndex].split('-->')
    // VTT cue settings (`align:start position:10%`) follow the end timestamp.
    const text = lines
      .slice(arrowIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (!text) continue
    cues.push({ index: cues.length, start: parseTimestamp(from), end: parseTimestamp(to), text })
  }
  return cues
}

/**
 * Sites differ wildly in what they serve, so accept whatever yt-dlp handed us:
 * json3 (YouTube), SRT, or WebVTT.
 */
export function parseSubtitleFile(fileName: string, content: string): SubtitleCue[] {
  if (fileName.endsWith('.json') || fileName.endsWith('.json3')) {
    return parseJson3(JSON.parse(content) as { events?: Json3Event[] })
  }
  return parseTimedBlocks(content)
}

let ytDlpAvailable: boolean | undefined

export function ytDlpBinary(): string {
  return process.env.YT_DLP_PATH || 'yt-dlp'
}

/** Shared troubleshooting hint for every yt-dlp failure path. */
export function ytDlpHint(): string {
  return (
    '\n\n提示：若所在网络无法直连，可设置代理后重试：PI_SUBTITLE_PROXY=http://127.0.0.1:7890（yt-dlp 亦会读取 HTTPS_PROXY）。' +
    '若站点要求登录（例如 YouTube 提示 “Sign in to confirm you’re not a bot”），请为 yt-dlp 配置 cookies：' +
    'YT_DLP_COOKIES=/path/cookies.txt（推荐，Netscape 格式）。注意 Chrome 127+ / Edge 的 cookies 在 Windows 上' +
    '常见无法解密（DPAPI / app-bound encryption），此时 YT_DLP_COOKIES_FROM_BROWSER 会失败，扩展会自动回退到无 cookies 重试。' +
    '扩展默认会重试 3 次，且若检测到本机 Clash 控制器，会自动轮换代理节点（PI_SUBTITLE_RETRIES 可调，PI_SUBTITLE_CLASH=0 可关闭轮换）。'
  )
}

export function hasYtDlp(): boolean {
  if (ytDlpAvailable !== undefined) return ytDlpAvailable
  ytDlpAvailable = spawnSync(ytDlpBinary(), ['--version'], { encoding: 'utf8' }).status === 0
  return ytDlpAvailable
}

function ytDlpArgs(extra: string[], withCookies = true): string[] {
  const args = ['--no-warnings', '--no-playlist']
  if (process.env.PI_SUBTITLE_PROXY) args.push('--proxy', process.env.PI_SUBTITLE_PROXY)
  if (withCookies) {
    if (process.env.YT_DLP_COOKIES) args.push('--cookies', process.env.YT_DLP_COOKIES)
    else if (process.env.YT_DLP_COOKIES_FROM_BROWSER) {
      args.push('--cookies-from-browser', process.env.YT_DLP_COOKIES_FROM_BROWSER)
    }
  }
  return [...args, ...extra]
}

/**
 * Chrome 127+ (and Edge) encrypt their cookie database with app-bound
 * encryption, so `--cookies-from-browser` dies with a DPAPI error on a lot of
 * Windows machines. yt-dlp treats that as fatal, which would cost us the video
 * as well as the cookies — so recognise it and retry without cookies.
 */
const COOKIE_FAILURE =
  /Failed to decrypt with DPAPI|Could not copy Chrome cookie database|could not find .{0,40}cookies database|unsupported browser/i

function lastLine(text: string | null | undefined): string {
  return (text ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown yt-dlp error'
}

function spawnYtDlp(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(ytDlpBinary(), args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runYtDlp(args: string[]): string {
  const first = spawnYtDlp(ytDlpArgs(args))
  if (first.status === 0) return first.stdout

  const cookieFailure = COOKIE_FAILURE.test(first.stderr)
  const hadCookies = Boolean(process.env.YT_DLP_COOKIES || process.env.YT_DLP_COOKIES_FROM_BROWSER)
  if (hadCookies && cookieFailure) {
    const retry = spawnYtDlp(ytDlpArgs(args, false))
    if (retry.status === 0) return retry.stdout
    throw new Error(`${lastLine(retry.stderr)}（已回退到无 cookies 重试；cookies 读取失败：${lastLine(first.stderr)}）`)
  }
  throw new Error(lastLine(first.stderr))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Total download attempts, `PI_SUBTITLE_RETRIES` (default 3, max 6). */
function retryAttempts(): number {
  const raw = Number(process.env.PI_SUBTITLE_RETRIES)
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 6) : 3
}

/** Base backoff between attempts, `PI_SUBTITLE_RETRY_BASE_MS` (default 2000). */
function retryBaseMs(): number {
  const raw = Number(process.env.PI_SUBTITLE_RETRY_BASE_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2000
}

const RETRYABLE_ERROR =
  /Sign in to confirm|HTTP Error (?:429|[5-9]\d\d)|ConnectionResetError|Connection aborted|Unable to download|timed? ?out|Temporary failure|Could not write|socket hang up|empty reply|Remote end closed|ECONNRESET/i

export function isRetryableError(message: string): boolean {
  return RETRYABLE_ERROR.test(message)
}

interface ClashRotation {
  rotating: boolean
  tried: string[]
  rotate(): Promise<string | null>
  restore(): Promise<void>
}

const noRotation: ClashRotation = {
  rotating: false,
  tried: [],
  rotate: async () => null,
  restore: async () => {},
}

/**
 * Set up node rotation for this request: find the Clash controller, the group
 * the traffic actually routes through, and remember the user's selected node
 * so it can be restored when we are done.
 */
async function makeClashRotation(): Promise<ClashRotation> {
  if (!clashEnabled()) return noRotation
  let ctrl: ClashController | null = null
  try {
    ctrl = await discoverClashController()
  } catch {
    return noRotation
  }
  if (!ctrl) return noRotation
  try {
    const group = await clashRoutingGroup(ctrl)
    if (!group) return noRotation
    const info = await clashGroup(ctrl, group)
    if (!info || info.all.length < 2) return noRotation
    const tried = new Set<string>()
    const triedList: string[] = []
    const original = info.now
    let restored = false
    return {
      rotating: true,
      tried: triedList,
      async rotate() {
        const fresh = await clashGroup(ctrl, group).catch(() => null)
        const node = clashPickNext(fresh?.all ?? info.all, fresh?.now, tried)
        if (!node) return null
        const ok = await clashSelectNode(ctrl, group, node).catch(() => false)
        if (!ok) return null
        tried.add(node)
        triedList.push(node)
        await sleep(1200) // let the new node come up before retrying
        return node
      },
      async restore() {
        if (restored || triedList.length === 0 || !original) return
        restored = true
        await clashSelectNode(ctrl, group, original).catch(() => {})
      },
    }
  } catch {
    return noRotation
  }
}

/**
 * Run one yt-dlp command with retry + exponential backoff, rotating the Clash
 * proxy node between attempts so a bot-gated node gets a chance to be replaced
 * by a working one. The user's original node is restored afterwards.
 */
async function executeYtDlp(args: string[]): Promise<string> {
  const attempts = retryAttempts()
  const rotation = await makeClashRotation()
  const backoff = (attempt: number): number => retryBaseMs() * 2 ** (attempt - 2)
  let lastError: unknown = new Error('yt-dlp 未返回输出。')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(backoff(attempt))
    try {
      const stdout = runYtDlp(args)
      await rotation.restore()
      return stdout
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === attempts || !isRetryableError(message)) {
        await rotation.restore()
        throw error
      }
      await rotation.rotate()
    }
  }
  const rotated = rotation.tried.length > 0 ? `，已切换 Clash 节点：${rotation.tried.join(' → ')}` : ''
  throw new Error(`${lastError instanceof Error ? lastError.message : String(lastError)}（第 ${attempts} 次尝试仍失败${rotated}）`)
}

/**
 * `--list-subs` is not decoration: some extractors (PeerTube, for one) only
 * populate the subtitle list when yt-dlp is in listing mode. It prints a human
 * table before the JSON dump, so read the last JSON-looking line.
 */
function parseLastJsonLine(output: string): YtDlpInfo {
  const lines = output.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) return JSON.parse(line) as YtDlpInfo
  }
  throw new Error('yt-dlp 未返回可解析的视频信息。')
}

export async function ytDlpInfo(url: string): Promise<YtDlpInfo> {
  return parseLastJsonLine(await executeYtDlp(['--dump-single-json', '--skip-download', '--list-subs', url]))
}

export function ytDlpTracks(info: YtDlpInfo): SubtitleTrackInfo[] {
  const manual = Object.keys(info.subtitles ?? {})
  const manualSet = new Set(manual)
  // An automatic track is redundant when a human-made one exists for the same language.
  const auto = Object.keys(info.automatic_captions ?? {}).filter((language) => !manualSet.has(language))
  return [
    ...manual.map((language) => ({ language, label: language, isAuto: false })),
    ...auto.map((language) => ({ language, label: language, isAuto: true })),
  ]
}

async function ytDlpDownloadCues(url: string, language: string): Promise<SubtitleCue[]> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ytdlp-'))
  try {
    await executeYtDlp([
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      language,
      '--sub-format',
      'json3/srt/vtt/best',
      '-o',
      join(dir, '%(id)s.%(ext)s'),
      url,
    ])
    const files = (await readdir(dir)).filter((name) => /\.(json3?|srt|vtt)$/i.test(name))
    if (files.length === 0) throw new Error(`yt-dlp 未生成 ${language} 的字幕文件。`)
    return parseSubtitleFile(files[0], await readFile(join(dir, files[0]), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Walk every candidate track until one actually downloads.
 *
 * Needed because a language can be advertised and still fail: YouTube lists ~150
 * auto-translated tracks and answers HTTP 429 for most of them.
 */
export async function fetchWithYtDlp(
  url: string,
  options: FetchSubtitleOptions = {},
  service: VideoService = 'ytdlp',
): Promise<FetchSubtitleResult> {
  const info = await ytDlpInfo(url)
  const tracks = ytDlpTracks(info)
  if (tracks.length === 0) {
    throw new Error('该视频没有字幕轨道（subtitles / automatic_captions 均为空）。')
  }

  const failures: string[] = []
  for (const candidate of rankTracks(tracks, options.language)) {
    try {
      const cues = await ytDlpDownloadCues(url, candidate.language)
      if (cues.length === 0) throw new Error('字幕内容为空')
      return {
        service,
        videoId: info.id || url,
        sourceUrl: url,
        title: info.title || info.id || url,
        descriptionText: info.description?.slice(0, 2000),
        availableLanguages: tracks,
        track: { ...candidate, cues },
      }
    } catch (error) {
      failures.push(`${candidate.language}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`所有字幕轨道均下载失败：\n  ${failures.join('\n  ')}`)
}
