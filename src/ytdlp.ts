import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    'YT_DLP_COOKIES_FROM_BROWSER=chrome 或 YT_DLP_COOKIES=/path/cookies.txt。'
  )
}

export function hasYtDlp(): boolean {
  if (ytDlpAvailable !== undefined) return ytDlpAvailable
  ytDlpAvailable = spawnSync(ytDlpBinary(), ['--version'], { encoding: 'utf8' }).status === 0
  return ytDlpAvailable
}

function ytDlpArgs(extra: string[]): string[] {
  const args = ['--no-warnings', '--no-playlist']
  if (process.env.PI_SUBTITLE_PROXY) args.push('--proxy', process.env.PI_SUBTITLE_PROXY)
  if (process.env.YT_DLP_COOKIES) args.push('--cookies', process.env.YT_DLP_COOKIES)
  else if (process.env.YT_DLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', process.env.YT_DLP_COOKIES_FROM_BROWSER)
  }
  return [...args, ...extra]
}

function runYtDlp(args: string[]): string {
  const result = spawnSync(ytDlpBinary(), ytDlpArgs(args), {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim()
    throw new Error(stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown yt-dlp error')
  }
  return result.stdout ?? ''
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

export function ytDlpInfo(url: string): YtDlpInfo {
  return parseLastJsonLine(runYtDlp(['--dump-single-json', '--skip-download', '--list-subs', url]))
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
    runYtDlp([
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
  const info = ytDlpInfo(url)
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
