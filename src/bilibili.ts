import type { FetchSubtitleOptions, FetchSubtitleResult, SubtitleCue, SubtitleTrackInfo } from './types'
import { pickTrack, resolveBilibiliShortLink } from './utils'

const API_BASE = 'https://api.bilibili.com'

interface RawSubtitle {
  lan: string
  lan_doc?: string
  subtitle_url: string
  type?: number
  ai_status?: number
}

interface ViewResponse {
  code: number
  message?: string
  data?: {
    aid: number
    bvid: string
    title: string
    desc?: string
    dynamic?: string
    pages?: { page: number; cid: number; part?: string }[]
    cid?: number
  }
}

interface PlayerResponse {
  code: number
  message?: string
  data?: {
    subtitle?: {
      subtitles?: RawSubtitle[]
    }
  }
}

interface SubtitleBody {
  body?: { from: number; to: number; content: string }[]
}

function bilibiliHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
  }
  const raw = process.env.BILIBILI_SESSION_TOKEN
  if (raw) {
    const tokens = raw
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
    const sessdata = tokens[Math.floor(Math.random() * tokens.length)]
    if (sessdata) {
      headers.Cookie = `SESSDATA=${sessdata}`
    }
  }
  return headers
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`B站请求失败 (${response.status}): ${url}`)
  }
  return (await response.json()) as T
}

function normaliseUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

/**
 * Download Bilibili subtitles via the official web APIs:
 *   x/web-interface/view   -> video metadata + multi-part page list
 *   x/player/v2            -> subtitle language list for (aid, cid)
 *   subtitle_url (JSON)    -> timed cue body
 * Mirrors BibiGPT's `fetchBilibiliSubtitleUrls` / `fetchBilibiliSubtitle`.
 */
export async function fetchBilibiliSubtitle(
  videoIdInput: string,
  options: FetchSubtitleOptions = {},
): Promise<FetchSubtitleResult> {
  const headers = bilibiliHeaders()

  let videoId = videoIdInput
  if (videoId.startsWith('short:')) {
    videoId = await resolveBilibiliShortLink(videoId, videoIdInput)
  }

  const params = /^av\d+$/i.test(videoId) ? `?aid=${videoId.slice(2)}` : `?bvid=${videoId}`
  const view = await getJson<ViewResponse>(`${API_BASE}/x/web-interface/view${params}`, headers)

  if (view.code !== 0 || !view.data) {
    throw new Error(`B站 API 错误: ${view.message || view.code}`)
  }

  const { aid, title, desc, dynamic, pages } = view.data
  const descriptionText = desc || dynamic ? `${desc ?? ''} ${dynamic ?? ''}`.trim() : undefined

  const pageNumber = options.pageNumber ? Number(options.pageNumber) : 1
  const page = pages?.find((item) => item.page === pageNumber) ?? pages?.[0]
  const cid = page?.cid ?? view.data.cid
  if (!cid) {
    throw new Error('无法获取视频 CID')
  }

  const player = await getJson<PlayerResponse>(
    `${API_BASE}/x/player/v2?aid=${aid}&cid=${cid}`,
    headers,
  )
  const subtitleList = player.data?.subtitle?.subtitles ?? []

  if (subtitleList.length === 0) {
    const hint = process.env.BILIBILI_SESSION_TOKEN
      ? '该视频未开放字幕（可能是会员/付费视频，或 UP 主未上传字幕）。'
      : '该视频未返回任何字幕。B站字幕接口通常需要登录态，请设置 BILIBILI_SESSION_TOKEN（SESSDATA）。'
    throw new Error(`${hint}(${title})`)
  }

  const availableLanguages: SubtitleTrackInfo[] = subtitleList.map((item) => ({
    language: item.lan,
    label: item.lan_doc || item.lan,
    isAuto: item.type === 1 || item.ai_status === 1,
  }))

  const selected = pickTrack(availableLanguages, options.language)
  const raw = subtitleList.find((item) => item.lan === selected?.language) ?? subtitleList[0]

  const body = await getJson<SubtitleBody>(normaliseUrl(raw.subtitle_url), {
    'User-Agent': headers['User-Agent'],
    Referer: 'https://www.bilibili.com/',
  })

  const cues: SubtitleCue[] = (body.body ?? []).map((item, index) => ({
    index,
    start: item.from,
    end: item.to,
    text: (item.content || '').trim(),
  }))

  if (cues.length === 0) {
    throw new Error(`字幕内容为空: ${title}`)
  }

  return {
    service: 'bilibili',
    videoId,
    sourceUrl: `https://www.bilibili.com/video/${videoId}${pageNumber > 1 ? `?p=${pageNumber}` : ''}`,
    title,
    descriptionText,
    availableLanguages,
    track: {
      language: raw.lan,
      label: raw.lan_doc || raw.lan,
      isAuto: raw.type === 1 || raw.ai_status === 1,
      cues,
    },
  }
}
