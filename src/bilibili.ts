import { createHash } from 'node:crypto'

import type { FetchSubtitleOptions, FetchSubtitleResult, SubtitleCue, SubtitleTrackInfo } from './types'
import { pickTrack, resolveBilibiliShortLink } from './utils'

const API_BASE = 'https://api.bilibili.com'

/**
 * Permutation table of Bilibili's WBI signature scheme. Signing is not optional
 * here: the unsigned `x/player/v2` endpoint answers with either an empty list or
 * a cached `subtitle_url` that belongs to a *different* video, while the signed
 * `x/player/wbi/v2` endpoint reliably reports the tracks of this exact video.
 */
const WBI_MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

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

interface NavResponse {
  data?: {
    wbi_img?: {
      img_url?: string
      sub_url?: string
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

function wbiKeyFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('.')[0]
}

/** Derive the 32-char mixin key from the two `wbi_img` URLs reported by `x/web-interface/nav`. */
export function bilibiliMixinKey(imgUrl: string, subUrl: string): string {
  const source = wbiKeyFromUrl(imgUrl) + wbiKeyFromUrl(subUrl)
  return WBI_MIXIN_KEY_TAB.map((index) => source[index] ?? '')
    .join('')
    .slice(0, 32)
}

/** Append `wts` + `w_rid` to query params, as Bilibili's WBI scheme requires. */
export function signWbiQuery(
  params: Record<string, string | number>,
  mixinKey: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const query = [...new URLSearchParams({ ...params, wts: String(timestamp) }).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

async function fetchMixinKey(headers: Record<string, string>): Promise<string | null> {
  try {
    const nav = await getJson<NavResponse>(`${API_BASE}/x/web-interface/nav`, headers)
    const imgUrl = nav.data?.wbi_img?.img_url
    const subUrl = nav.data?.wbi_img?.sub_url
    return imgUrl && subUrl ? bilibiliMixinKey(imgUrl, subUrl) : null
  } catch {
    return null
  }
}

async function fetchSubtitleList(
  headers: Record<string, string>,
  aid: number,
  cid: number,
): Promise<RawSubtitle[]> {
  const mixinKey = await fetchMixinKey(headers)
  if (mixinKey) {
    const query = signWbiQuery({ aid, cid }, mixinKey)
    const player = await getJson<PlayerResponse>(`${API_BASE}/x/player/wbi/v2?${query}`, headers)
    // A signed response is authoritative: an empty list means this video really
    // has no subtitles, so never fall through to the unsigned endpoint here.
    return player.data?.subtitle?.subtitles ?? []
  }
  const player = await getJson<PlayerResponse>(`${API_BASE}/x/player/v2?aid=${aid}&cid=${cid}`, headers)
  return player.data?.subtitle?.subtitles ?? []
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

  const subtitleList = await fetchSubtitleList(headers, aid, cid)

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
