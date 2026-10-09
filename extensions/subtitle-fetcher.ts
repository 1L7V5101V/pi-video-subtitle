/**
 * video-subtitle extension
 *
 * Extracts subtitles from Bilibili and YouTube videos — plus any other site
 * supported by yt-dlp — and can download them to disk (txt / srt / vtt / json).
 * Ported from JimmyLv/BibiGPT-v1's subtitle pipeline, extended with SRT/VTT
 * rendering and the generic yt-dlp engine.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { defaultFileName, renderSubtitle } from '../src/download'
import { fetchSubtitle } from '../src/fetchSubtitle'
import type { FetchSubtitleResult } from '../src/types'
import type { SubtitleFormat } from '../src/utils'

const FORMATS = ['text', 'timestamped', 'grouped', 'srt', 'vtt', 'json'] as const
const SERVICES = ['bilibili', 'youtube', 'ytdlp'] as const

const params = Type.Object({
  url: Type.String({
    description:
      'Video URL or id (BV/av id, bilibili/b23.tv URL, YouTube watch/youtu.be/shorts URL, or any other video URL supported by yt-dlp).',
  }),
  service: Type.Optional(
    StringEnum(SERVICES, { description: 'Force a platform instead of auto-detecting (ytdlp = generic engine).' }),
  ),
  language: Type.Optional(
    Type.String({ description: 'Preferred subtitle language code, e.g. zh-CN or en. Defaults to zh > en > first.' }),
  ),
  format: Type.Optional(
    StringEnum(FORMATS, {
      description:
        'Output format: text (plain), timestamped, grouped (BibiGPT-style 30 blocks), srt, vtt, json. Default text.',
    }),
  ),
  showTimestamp: Type.Optional(
    Type.Boolean({ description: 'Prefix each line with its timestamp (text format only).' }),
  ),
  dedupe: Type.Optional(
    Type.Boolean({
      description:
        'Remove the duplicated words that rolling auto-generated (ASR) captions repeat on every line. Defaults to auto: only applied when 20%+ of the lines overlap, so hand-written subtitles are never touched.',
    }),
  ),
  savePath: Type.Optional(
    Type.String({
      description:
        'Write the subtitle to this file (relative to the working directory). Pass a directory to auto-name the file.',
    }),
  ),
  pageNumber: Type.Optional(Type.String({ description: 'Bilibili multi-part page number (P). Defaults to 1.' })),
})

interface ToolDetails {
  title: string
  service: string
  videoId: string
  sourceUrl: string
  language: string
  languageLabel: string
  isAuto: boolean
  cueCount: number
  availableLanguages: { language: string; label: string; isAuto: boolean }[]
  dedupe?: { removedCues: number; removedWords: number; overlapRatio: number }
  savedPath?: string
  truncated?: boolean
  fullOutputPath?: string
}

function describe(result: FetchSubtitleResult): string {
  const langs = result.availableLanguages.map((track) => `${track.language}${track.isAuto ? '(auto)' : ''}`)
  const shown = langs.slice(0, 8).join(', ')
  const summary = langs.length > 8 ? `${shown} … 共 ${langs.length} 种` : shown
  return [
    `标题: ${result.title}`,
    `平台: ${result.service}`,
    `语言: ${result.track.language} — ${result.track.label}${result.track.isAuto ? ' (自动生成)' : ''}`,
    `字幕条数: ${result.track.cues.length}`,
    `可用语言: ${summary || '无'}`,
    result.dedupe
      ? `已去除滚动重复: -${result.dedupe.removedCues} 行 / -${result.dedupe.removedWords} 词（重复率 ${Math.round(result.dedupe.overlapRatio * 100)}%）`
      : '',
    `来源: ${result.sourceUrl}`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function resolveSaveTarget(
  rawSavePath: string,
  result: FetchSubtitleResult,
  format: SubtitleFormat,
  cwd: string,
): Promise<string> {
  const looksLikeDir = /[\\/]$/.test(rawSavePath)
  const base = isAbsolute(rawSavePath) ? rawSavePath : resolve(cwd, rawSavePath)
  if (looksLikeDir) {
    return join(base, defaultFileName(result, format))
  }
  // No extension -> treat a bare directory-like path as a folder too.
  if (!/\.[a-z0-9]{1,5}$/i.test(base)) {
    return join(base, defaultFileName(result, format))
  }
  return base
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'fetch_subtitle',
    label: 'Fetch Subtitle',
    description: [
      'Extract subtitles/transcripts from a video: Bilibili and YouTube natively, and any other site yt-dlp supports (Twitter/X, TikTok, Vimeo, Weibo, TED, ...) via the generic engine.',
      'Use when the user provides a video URL and wants the subtitles, a transcript, or a downloadable subtitle file.',
      `Output is truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}; the complete text is saved to a temp file when truncated.`,
    ].join(' '),
    parameters: params,

    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const format = (args.format ?? 'text') as SubtitleFormat

      const result = await fetchSubtitle(args.url, {
        service: args.service,
        language: args.language,
        showTimestamp: args.showTimestamp,
        pageNumber: args.pageNumber ?? undefined,
        dedupe: args.dedupe,
      })

      const rendered = renderSubtitle(result, { format, showTimestamp: args.showTimestamp })

      const details: ToolDetails = {
        title: result.title,
        service: result.service,
        videoId: result.videoId,
        sourceUrl: result.sourceUrl,
        language: result.track.language,
        languageLabel: result.track.label,
        isAuto: result.track.isAuto,
        cueCount: result.track.cues.length,
        availableLanguages: result.availableLanguages,
        dedupe: result.dedupe,
      }

      if (args.savePath) {
        const target = await resolveSaveTarget(args.savePath, result, format, ctx.cwd)
        await mkdir(dirname(target), { recursive: true })
        await withFileMutationQueue(target, async () => {
          await writeFile(target, rendered, 'utf8')
        })
        details.savedPath = target
      }

      const truncation = truncateHead(rendered, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
      let body = truncation.content
      const notes: string[] = []
      if (truncation.truncated) {
        let fullPath = details.savedPath
        if (!fullPath) {
          const dir = await mkdtemp(join(tmpdir(), 'pi-subtitle-'))
          const generated = join(dir, defaultFileName(result, format))
          await withFileMutationQueue(generated, async () => {
            await writeFile(generated, rendered, 'utf8')
          })
          fullPath = generated
        }
        details.truncated = true
        details.fullOutputPath = fullPath
        body += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Full subtitle: ${fullPath}]`
      }

      if (details.savedPath) notes.push(`已保存字幕文件: ${details.savedPath}`)
      else if (details.fullOutputPath) notes.push(`完整字幕文件: ${details.fullOutputPath}`)

      const text = [describe(result), notes.length ? `\n${notes.join('\n')}` : '', '', body].join('\n')

      return { content: [{ type: 'text', text }], details }
    },

    renderCall(args, theme) {
      let text = theme.fg('toolTitle', theme.bold('fetch_subtitle '))
      text += theme.fg('accent', args.url)
      if (args.format) text += theme.fg('dim', ` --${args.format}`)
      if (args.language) text += theme.fg('dim', ` lang=${args.language}`)
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as ToolDetails | undefined
      const first = result.content.find((part) => part.type === 'text')
      const fallback = first?.type === 'text' ? first.text : ''
      if (!details) {
        return new Text(`${theme.fg('error', '✗ ')}${fallback}`, 0, 0)
      }
      const prefix = context?.isError ? theme.fg('error', '✗ ') : theme.fg('success', '✓ ')
      const head =
        prefix + theme.fg('muted', `${details.service} `) + theme.fg('text', details.title)
      const meta = theme.fg('dim', ` · ${details.language}${details.isAuto ? '(auto)' : ''} · ${details.cueCount} cues`)
      let out = head + meta
      if (details.dedupe) out += theme.fg('dim', ` · deduped -${details.dedupe.removedWords}w`)
      if (details.savedPath) out += `\n  ${theme.fg('dim', `saved: ${details.savedPath}`)}`
      if (expanded && fallback) out += `\n${theme.fg('dim', fallback)}`
      return new Text(out, 0, 0)
    },
  })

  pi.registerCommand('subtitle', {
    description:
      'Download subtitles for a video (Bilibili/YouTube/any yt-dlp site): /subtitle <url> [--format srt] [--lang zh-CN] [--out path] [--no-dedupe]',
    handler: async (rawArgs, ctx) => {
      const tokens = (rawArgs || '').split(/\s+/).filter(Boolean)
      if (tokens.length === 0) {
        ctx.ui.notify(
          '用法: /subtitle <video-url> [--format srt|vtt|json|text] [--lang <code>] [--out <path>] [--no-dedupe]',
          'error',
        )
        return
      }

      let format: SubtitleFormat = 'text'
      let language: string | undefined
      let outPath: string | undefined
      let dedupe: boolean | 'auto' = 'auto'
      const positional: string[] = []

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token === '--format' || token === '-f') format = (tokens[++i] as SubtitleFormat) ?? 'text'
        else if (token === '--lang' || token === '-l') language = tokens[++i]
        else if (token === '--out' || token === '-o') outPath = tokens[++i]
        else if (token === '--dedupe') dedupe = true
        else if (token === '--no-dedupe') dedupe = false
        else if (token.startsWith('--format=')) format = token.slice(9) as SubtitleFormat
        else if (token.startsWith('--lang=')) language = token.slice(7)
        else if (token.startsWith('--out=')) outPath = token.slice(6)
        else positional.push(token)
      }

      const url = positional[0]
      if (!url) {
        ctx.ui.notify('缺少视频 URL', 'error')
        return
      }

      try {
        const result = await fetchSubtitle(url, {
          language,
          showTimestamp: format === 'timestamped',
          dedupe,
        })
        const target = await resolveSaveTarget(
          outPath ?? defaultFileName(result, format),
          result,
          format,
          ctx.cwd,
        )
        const rendered = renderSubtitle(result, { format, showTimestamp: format === 'timestamped' })
        await mkdir(dirname(target), { recursive: true })
        await withFileMutationQueue(target, async () => {
          await writeFile(target, rendered, 'utf8')
        })
        const dedupeNote = result.dedupe
          ? `（已去重 -${result.dedupe.removedCues} 行 / -${result.dedupe.removedWords} 词）`
          : ''
        ctx.ui.notify(
          `已保存 ${result.track.cues.length} 条字幕 (${result.track.language})${dedupeNote} → ${target}`,
          'info',
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`字幕提取失败: ${message}`, 'error')
      }
    },
  })
}
