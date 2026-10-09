import type { FetchSubtitleResult } from './types'
import { extensionForFormat, serializeCues, type SubtitleFormat } from './utils'

export interface RenderOptions {
  format?: SubtitleFormat
  showTimestamp?: boolean
}

/** Render a fetched track into the requested textual format. */
export function renderSubtitle(result: FetchSubtitleResult, options: RenderOptions = {}): string {
  const format = options.format ?? 'text'
  if (format === 'text' && options.showTimestamp === true) {
    return serializeCues(result.track.cues, 'timestamped')
  }
  return serializeCues(result.track.cues, format)
}

/** Filesystem-safe file name for a fetched subtitle, e.g. `视频标题.zh-CN.srt`. */
export function defaultFileName(result: FetchSubtitleResult, format: SubtitleFormat = 'text'): string {
  const safeTitle =
    result.title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || result.videoId
  const language = result.track.language ? `.${result.track.language}` : ''
  return `${safeTitle}${language}.${extensionForFormat(format)}`
}
