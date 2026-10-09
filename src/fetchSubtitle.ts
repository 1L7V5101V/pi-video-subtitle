import { fetchBilibiliSubtitle } from './bilibili'
import type { FetchSubtitleOptions, FetchSubtitleResult, VideoService } from './types'
import { DEDUPE_MIN_OVERLAP_RATIO, dedupeRollingCues, parseVideoUrl } from './utils'
import { fetchYoutubeSubtitle } from './youtube'
import { fetchWithYtDlp, hasYtDlp, ytDlpHint } from './ytdlp'

/**
 * Rolling auto-captions repeat their predecessor's tail on every line. Left
 * alone that duplication inflates a transcript by roughly a quarter to a third,
 * which the summarising model then pays for. `'auto'` needs a fifth of the cues
 * to overlap before it touches anything, so hand-written tracks pass through.
 */
function applyDedupe(
  result: FetchSubtitleResult,
  mode: FetchSubtitleOptions['dedupe'],
): FetchSubtitleResult {
  if (mode === false) return result
  const { cues, report } = dedupeRollingCues(result.track.cues)
  if (report.removedWords === 0) return result
  if (mode !== true && report.overlapRatio < DEDUPE_MIN_OVERLAP_RATIO) return result
  return { ...result, track: { ...result.track, cues }, dedupe: report }
}

/**
 * Fetch subtitles for any supported video URL.
 * Service is auto-detected; pass `service` to force a platform.
 */
export async function fetchSubtitle(
  input: string,
  options: FetchSubtitleOptions & { service?: VideoService } = {},
): Promise<FetchSubtitleResult> {
  const parsed = options.service
    ? { ...parseVideoUrl(input), service: options.service }
    : parseVideoUrl(input)

  if (parsed.service === 'youtube') {
    return applyDedupe(await fetchYoutubeSubtitle(parsed.videoId, options), options.dedupe)
  }
  if (parsed.service === 'bilibili') {
    const result = await fetchBilibiliSubtitle(parsed.videoId, {
      ...options,
      pageNumber: options.pageNumber ?? parsed.pageNumber,
    })
    return applyDedupe(result, options.dedupe)
  }

  if (!hasYtDlp()) {
    throw new Error(
      `该站点需要 yt-dlp 才能提取字幕，但未找到 yt-dlp 可执行文件。请先安装 yt-dlp（pip install -U yt-dlp），` +
        '或设置 YT_DLP_PATH 指向可执行文件。',
    )
  }
  try {
    return applyDedupe(await fetchWithYtDlp(parsed.sourceUrl, options, 'ytdlp'), options.dedupe)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}${ytDlpHint()}`)
  }
}

export { parseVideoUrl, serializeCues, extensionForFormat, dedupeRollingCues } from './utils'
export type { SubtitleFormat } from './utils'
export * from './types'
