/**
 * `bilibili` and `youtube` have dedicated implementations; `ytdlp` is the
 * generic engine used for every other site (~1800 extractors).
 */
export type VideoService = 'bilibili' | 'youtube' | 'ytdlp'

/** A single subtitle line with its timing. `start`/`end` are seconds. */
export interface SubtitleCue {
  index: number
  start: number
  end?: number
  text: string
}

/** Public metadata describing one downloadable subtitle track. */
export interface SubtitleTrackInfo {
  language: string
  label: string
  /** true when the track was machine-generated (auto captions / AI subtitles). */
  isAuto: boolean
}

export interface SubtitleTrack extends SubtitleTrackInfo {
  cues: SubtitleCue[]
}

export interface ParsedVideo {
  service: VideoService
  videoId: string
  /** Bilibili multi-part videos: which page/P to fetch. */
  pageNumber?: string
  sourceUrl: string
}

export interface FetchSubtitleResult {
  service: VideoService
  videoId: string
  sourceUrl: string
  title: string
  descriptionText?: string
  /** The (preferred) track that was downloaded. */
  track: SubtitleTrack
  /** Every subtitle language/revision advertised by the platform. */
  availableLanguages: SubtitleTrackInfo[]
}

export interface FetchSubtitleOptions {
  /** Preferred language, e.g. `zh-CN`, `zh-Hans`, `en`. Falls back sensibly when absent. */
  language?: string
  /** Include timestamps in the plain-text renderings. */
  showTimestamp?: boolean
  /** Bilibili multi-part page number. */
  pageNumber?: string | null
}
