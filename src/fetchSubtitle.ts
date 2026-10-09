import { fetchBilibiliSubtitle } from './bilibili'
import type { FetchSubtitleOptions, FetchSubtitleResult, VideoService } from './types'
import { parseVideoUrl } from './utils'
import { fetchYoutubeSubtitle } from './youtube'
import { fetchWithYtDlp, hasYtDlp, ytDlpHint } from './ytdlp'

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
    return fetchYoutubeSubtitle(parsed.videoId, options)
  }
  if (parsed.service === 'bilibili') {
    return fetchBilibiliSubtitle(parsed.videoId, {
      ...options,
      pageNumber: options.pageNumber ?? parsed.pageNumber,
    })
  }

  if (!hasYtDlp()) {
    throw new Error(
      `该站点需要 yt-dlp 才能提取字幕，但未找到 yt-dlp 可执行文件。请先安装 yt-dlp（pip install -U yt-dlp），` +
        '或设置 YT_DLP_PATH 指向可执行文件。',
    )
  }
  try {
    return await fetchWithYtDlp(parsed.sourceUrl, options, 'ytdlp')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}${ytDlpHint()}`)
  }
}

export { parseVideoUrl, serializeCues, extensionForFormat } from './utils'
export type { SubtitleFormat } from './utils'
export * from './types'
