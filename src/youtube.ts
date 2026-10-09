import type { FetchSubtitleOptions, FetchSubtitleResult } from './types'
import { rankTracks } from './utils'
import { fetchWithYtDlp, hasYtDlp, parseJson3, ytDlpHint } from './ytdlp'

const WATCH_URL = 'https://www.youtube.com/watch?v='
const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string
  name?: { simpleText?: string; runs?: { text: string }[] }
}

interface PlayerResponse {
  videoDetails?: { title?: string; shortDescription?: string }
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } }
}

/** Collect every error so the final message explains what each engine tried. */
function combineErrors(errors: { engine: string; error: unknown }[]): Error {
  const details = errors
    .map(({ engine, error }) => `- ${engine}: ${error instanceof Error ? error.message : String(error)}`)
    .join('\n')
  return new Error(`YouTube 字幕获取失败：\n${details}${ytDlpHint()}`)
}

function trackLabel(track: CaptionTrack): string {
  return track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode
}

function parseJson3Payload(payload: { events?: unknown[] }): ReturnType<typeof parseJson3> {
  return parseJson3(payload as Parameters<typeof parseJson3>[0])
}

// ---------------------------------------------------------------------------
// Engine A: yt-dlp (see src/ytdlp.ts). It is the primary engine — it keeps up
// with YouTube's anti-bot changes, honours HTTPS_PROXY/--proxy, and can be
// pointed at browser cookies. The same module also serves every non-YouTube URL.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Engine B: built-in fetch. Works where YouTube still serves timedtext without a
// proof-of-origin token; throws a clear error otherwise so engine A takes over.
// ---------------------------------------------------------------------------

const KEY_MARKER = '"INNERTUBE_API_KEY":"'

/**
 * Read the Innertube API key out of the watch page instead of hardcoding it.
 * The value is a public web-client key that ships in every youtube.com page,
 * but hardcoding it trips secret scanners and breaks whenever Google rotates it.
 */
function extractInnertubeKey(html: string): string | null {
  const start = html.indexOf(KEY_MARKER)
  if (start === -1) return null
  const valueStart = start + KEY_MARKER.length
  const end = html.indexOf('"', valueStart)
  return end === -1 ? null : html.slice(valueStart, end)
}

/** Extract the balanced JSON object that follows `marker` inside a JS payload. */
function extractJsonObject(source: string, marker: string): unknown | null {
  const start = source.indexOf(marker)
  if (start === -1) return null
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = braceStart; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(braceStart, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function fetchPlayerResponse(videoId: string): Promise<PlayerResponse> {
  const response = await fetch(`${WATCH_URL}${videoId}&hl=en&bpctr=9999999999&has_verified=1`, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'CONSENT=YES+cb; SOCS=CAI',
    },
  })
  if (!response.ok) throw new Error(`观看页请求失败 (HTTP ${response.status})`)

  const html = await response.text()
  const parsed = extractJsonObject(html, 'ytInitialPlayerResponse') as PlayerResponse | null
  if (!parsed) throw new Error('无法从观看页解析 ytInitialPlayerResponse。')

  const tracks = parsed.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (!tracks?.length) {
    const status = (parsed as { playabilityStatus?: { status?: string; reason?: string } }).playabilityStatus
    if (status?.status && status.status !== 'OK') {
      throw new Error(`YouTube 拒绝播放该视频：${status.status}${status.reason ? ` - ${status.reason}` : ''}`)
    }
    try {
      return await fetchInnertubePlayer(videoId, extractInnertubeKey(html))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`该 YouTube 视频没有可用字幕轨道（Innertube 回退也失败：${reason}）`)
    }
  }
  return parsed
}

async function fetchInnertubePlayer(videoId: string, apiKey: string | null): Promise<PlayerResponse> {
  if (!apiKey) throw new Error('无法从观看页解析 Innertube API key。')
  const response = await fetch(`${INNERTUBE_URL}?key=${apiKey}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', hl: 'en', androidSdkVersion: 30 } },
    }),
  })
  const text = await response.text()
  if (!text) throw new Error(`Innertube 返回空响应 (HTTP ${response.status})。`)
  return JSON.parse(text) as PlayerResponse
}

async function downloadCaptionCues(baseUrl: string): Promise<ReturnType<typeof parseJson3>> {
  const url = baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=json3`
  const response = await fetch(url, { headers: { 'User-Agent': UA } })
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`字幕接口返回空内容 (HTTP ${response.status})，YouTube 现在通常要求 proof-of-origin token。`)
  }
  return parseJson3Payload(JSON.parse(text) as { events?: unknown[] })
}

async function fetchViaNative(
  videoId: string,
  options: FetchSubtitleOptions,
): Promise<FetchSubtitleResult> {
  const player = await fetchPlayerResponse(videoId)
  const rawTracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  const tracks = rawTracks.map((track) => ({
    language: track.languageCode,
    label: trackLabel(track),
    isAuto: track.kind === 'asr',
    baseUrl: track.baseUrl,
  }))
  if (tracks.length === 0) throw new Error('该 YouTube 视频没有可用字幕轨道。')

  const failures: string[] = []
  for (const candidate of rankTracks(tracks, options.language)) {
    try {
      const cues = await downloadCaptionCues(candidate.baseUrl)
      if (cues.length === 0) throw new Error('字幕内容为空')
      return {
        service: 'youtube',
        videoId,
        sourceUrl: `${WATCH_URL}${videoId}`,
        title: player.videoDetails?.title || videoId,
        descriptionText: player.videoDetails?.shortDescription?.slice(0, 2000),
        availableLanguages: tracks.map(({ language, label, isAuto }) => ({ language, label, isAuto })),
        track: { language: candidate.language, label: candidate.label, isAuto: candidate.isAuto, cues },
      }
    } catch (error) {
      failures.push(`${candidate.language}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`所有字幕轨道均下载失败：\n  ${failures.join('\n  ')}`)
}

// ---------------------------------------------------------------------------

export async function fetchYoutubeSubtitle(
  videoId: string,
  options: FetchSubtitleOptions = {},
): Promise<FetchSubtitleResult> {
  // yt-dlp first when installed: it survives YouTube's anti-bot changes and is
  // the only engine on this machine that returns captions at all.
  const engines: { engine: string; run: () => Promise<FetchSubtitleResult> }[] = []
  if (hasYtDlp()) {
    engines.push({ engine: 'yt-dlp', run: () => fetchWithYtDlp(`${WATCH_URL}${videoId}`, options, 'youtube') })
  }
  engines.push({ engine: '内置 fetch', run: () => fetchViaNative(videoId, options) })

  const errors: { engine: string; error: unknown }[] = []
  for (const { engine, run } of engines) {
    try {
      return await run()
    } catch (error) {
      errors.push({ engine, error })
    }
  }
  throw combineErrors(errors)
}
