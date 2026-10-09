import type { ParsedVideo, SubtitleCue } from './types'

/**
 * Detect the video service and normalise the input into an id.
 * Accepts full URLs, short links, bare ids and multi-part page markers.
 */
export function parseVideoUrl(input: string): ParsedVideo {
  const raw = (input || '').trim()
  if (!raw) {
    throw new Error('视频 URL 为空')
  }

  const youtube = tryParseYoutube(raw)
  if (youtube) return youtube

  const bilibili = tryParseBilibili(raw)
  if (bilibili) return bilibili

  const generic = tryParseGeneric(raw)
  if (generic) return generic

  throw new Error(`无法识别的视频 URL: ${input}`)
}

/**
 * Anything else that looks like an http(s) URL is handed to the generic yt-dlp
 * engine, which supports ~1800 sites (Twitter/X, TikTok, Vimeo, Weibo, TED, ...).
 */
function tryParseGeneric(raw: string): ParsedVideo | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { service: 'ytdlp', videoId: raw, sourceUrl: raw }
}

function tryParseYoutube(raw: string): ParsedVideo | null {
  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*?\bv=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (match) {
      return { service: 'youtube', videoId: match[1], sourceUrl: raw }
    }
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
    return { service: 'youtube', videoId: raw, sourceUrl: raw }
  }
  return null
}

function tryParseBilibili(raw: string): ParsedVideo | null {
  // Bare BV / av ids
  const bareBv = raw.match(/^(BV[0-9A-Za-z]{8,})$/i)
  if (bareBv) {
    return { service: 'bilibili', videoId: bareBv[1], sourceUrl: raw }
  }
  const bareAv = raw.match(/^av(\d+)$/i)
  if (bareAv) {
    return { service: 'bilibili', videoId: `av${bareAv[1]}`, sourceUrl: raw }
  }

  const bvMatch = raw.match(/BV([0-9A-Za-z]{8,})/i)
  if (bvMatch) {
    return { service: 'bilibili', videoId: `BV${bvMatch[1]}`, pageNumber: extractPage(raw), sourceUrl: raw }
  }
  const avMatch = raw.match(/\/video\/av(\d+)/i) || raw.match(/[?&]aid=(\d+)/)
  if (avMatch) {
    return { service: 'bilibili', videoId: `av${avMatch[1]}`, pageNumber: extractPage(raw), sourceUrl: raw }
  }

  // b23.tv short links are resolved by following the redirect (async, handled by caller)
  const shortMatch = raw.match(/b23\.tv\/([0-9A-Za-z]+)/)
  if (shortMatch) {
    return {
      service: 'bilibili',
      videoId: `short:${shortMatch[1]}`,
      pageNumber: extractPage(raw),
      sourceUrl: raw,
    }
  }

  return null
}

function extractPage(raw: string): string | undefined {
  const match = raw.match(/[?&]p=(\d+)/)
  return match?.[1]
}

/** Resolve a b23.tv short link (or `short:<id>` pseudo id) to its BV id. */
export async function resolveBilibiliShortLink(videoId: string, sourceUrl: string): Promise<string> {
  const url = videoId.startsWith('short:')
    ? `https://b23.tv/${videoId.slice('short:'.length)}`
    : sourceUrl
  const response = await fetch(url, { redirect: 'follow' })
  const finalUrl = response.url || url
  const bvMatch = finalUrl.match(/BV([0-9A-Za-z]{8,})/i)
  if (bvMatch) return `BV${bvMatch[1]}`
  const avMatch = finalUrl.match(/av(\d+)/i)
  if (avMatch) return `av${avMatch[1]}`
  throw new Error(`无法解析 b23.tv 短链接: ${sourceUrl}`)
}

export function formatTimestamp(seconds: number, withMillis = true): string {
  const safe = Math.max(0, seconds || 0)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const base = `${hours > 0 ? `${pad(hours)}:` : ''}${pad(minutes)}:${pad(secs)}`
  return withMillis ? `${base}.${pad(millis, 3)}` : base
}

/** SRT uses a comma decimal separator and always carries an HH:MM:SS,mmm stamp. */
export function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds || 0)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`
}

/**
 * BibiGPT-style grouping: collapse many short cue lines into ~30 readable blocks.
 * Kept for parity with the upstream project's summarisation preprocessing.
 */
export function groupCues(cues: SubtitleCue[], showTimestamp = true): SubtitleCue[] {
  const TOTAL_GROUP_COUNT = 30
  const MINIMUM_COUNT_ONE_GROUP = 7
  const itemsPerGroup =
    cues.length > TOTAL_GROUP_COUNT ? Math.ceil(cues.length / TOTAL_GROUP_COUNT) : MINIMUM_COUNT_ONE_GROUP

  const grouped: SubtitleCue[] = []
  cues.forEach((cue, index) => {
    const groupIndex = Math.floor(index / itemsPerGroup)
    if (!grouped[groupIndex]) {
      grouped[groupIndex] = {
        index: groupIndex,
        start: cue.start,
        end: cue.end,
        text: showTimestamp ? `${formatTimestamp(cue.start, false)} - ` : '',
      }
    }
    grouped[groupIndex].text += `${cue.text} `
    grouped[groupIndex].end = cue.end ?? grouped[groupIndex].end
  })
  return grouped.map((cue) => ({ ...cue, text: cue.text.trim() }))
}

export function toPlainText(cues: SubtitleCue[], showTimestamp = false): string {
  if (showTimestamp) {
    return cues.map((cue) => `[${formatTimestamp(cue.start, false)}] ${cue.text}`).join('\n')
  }
  return cues.map((cue) => cue.text).join('\n')
}

export function toGroupedText(cues: SubtitleCue[], showTimestamp = true): string {
  return groupCues(cues, showTimestamp)
    .map((cue) => cue.text)
    .join('\n\n')
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, index) => {
      const start = formatSrtTimestamp(cue.start)
      const end = formatSrtTimestamp(cue.end ?? cue.start + 2)
      return `${index + 1}\n${start} --> ${end}\n${cue.text}\n`
    })
    .join('\n')
}

export function toVtt(cues: SubtitleCue[]): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const stamp = (seconds: number) => {
    const safe = Math.max(0, seconds || 0)
    const hours = Math.floor(safe / 3600)
    const minutes = Math.floor((safe % 3600) / 60)
    const secs = Math.floor(safe % 60)
    const millis = Math.round((safe - Math.floor(safe)) * 1000)
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`
  }
  const body = cues
    .map((cue) => `${stamp(cue.start)} --> ${stamp(cue.end ?? cue.start + 2)}\n${cue.text}\n`)
    .join('\n')
  return `WEBVTT\n\n${body}`
}

export function toJson(cues: SubtitleCue[]): string {
  return JSON.stringify(cues, null, 2)
}

export type SubtitleFormat = 'text' | 'timestamped' | 'grouped' | 'srt' | 'vtt' | 'json'

export function serializeCues(cues: SubtitleCue[], format: SubtitleFormat): string {
  switch (format) {
    case 'srt':
      return toSrt(cues)
    case 'vtt':
      return toVtt(cues)
    case 'json':
      return toJson(cues)
    case 'timestamped':
      return toPlainText(cues, true)
    case 'grouped':
      return toGroupedText(cues, true)
    case 'text':
    default:
      return toPlainText(cues, false)
  }
}

export function extensionForFormat(format: SubtitleFormat): string {
  switch (format) {
    case 'srt':
      return 'srt'
    case 'vtt':
      return 'vtt'
    case 'json':
      return 'json'
    default:
      return 'txt'
  }
}

type TrackLike = { language: string; label: string; isAuto: boolean }

/**
 * Order every track from most to least preferred.
 *
 * Callers walk the whole list: a preferred language can still be unusable
 * (YouTube answers 429 / an empty body for many auto-translated tracks), so the
 * next candidate is tried instead of giving up.
 *
 * Language codes are normalised because platforms disagree: Bilibili prefixes AI
 * captions (`ai-zh` next to `zh-CN`) while YouTube uses `zh-Hans` / `en-orig`.
 */
export function rankTracks<T extends TrackLike>(tracks: T[], preferred?: string): T[] {
  if (tracks.length === 0) return []
  const normalise = (language: string) => language.toLowerCase().replace(/_/g, '-').replace(/^ai-/, '')
  const wanted = preferred ? normalise(preferred) : undefined
  const base = wanted ? wanted.split('-')[0] : undefined
  const ranked: T[] = []

  const push = (track: T | undefined) => {
    if (track && !ranked.includes(track)) ranked.push(track)
  }

  if (wanted) {
    push(tracks.find((t) => !t.isAuto && normalise(t.language) === wanted))
    push(tracks.find((t) => normalise(t.language) === wanted))
  }
  if (base) {
    push(tracks.find((t) => !t.isAuto && normalise(t.language).startsWith(base)))
    push(tracks.find((t) => normalise(t.language).startsWith(base)))
  }

  push(tracks.find((t) => /^zh/i.test(normalise(t.language)) && !t.isAuto))
  // Chinese before English even when the Chinese track is auto-generated: the
  // retry loop covers tracks that turn out to be unusable.
  push(tracks.find((t) => /^zh/i.test(normalise(t.language))))
  push(tracks.find((t) => /^en/i.test(normalise(t.language)) && !t.isAuto))
  push(tracks.find((t) => /^en/i.test(normalise(t.language))))
  for (const track of tracks) if (!track.isAuto) push(track)
  for (const track of tracks) push(track)

  return ranked
}

/** Pick the best matching track for the requested language. */
export function pickTrack<T extends TrackLike>(tracks: T[], preferred?: string): T | undefined {
  return rankTracks(tracks, preferred)[0]
}
