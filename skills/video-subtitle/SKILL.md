---
name: video-subtitle
description: Extract or download subtitles/transcripts from videos — Bilibili and YouTube natively, plus any other site yt-dlp supports (Twitter/X, TikTok, Vimeo, PeerTube, Weibo, TED, …). Use when the user gives a video URL or id (BV/av id, bilibili.com, b23.tv, youtube.com, youtu.be, shorts, or any other video link) and wants the subtitle text, a transcript, a summary/translation of the spoken content, or a downloadable .txt/.srt/.vtt/.json subtitle file.
license: GPL-3.0-or-later
compatibility: Requires the `pi-video-subtitle` package (extension `fetch_subtitle`). Bilibili subtitles usually need a logged-in SESSDATA cookie; YouTube needs no credentials. Non-Bilibili/YouTube sites require `yt-dlp` on PATH (or `YT_DLP_PATH`).
---

# Video Subtitle

Fetch subtitles from Bilibili and YouTube with the `fetch_subtitle` tool, and from any other site through `yt-dlp`.

## When to use

- The user provides a Bilibili URL / BV id / av id / `b23.tv` short link.
- The user provides a YouTube watch / `youtu.be` / Shorts URL or an 11-char video id.
- The user provides any other video URL (Twitter/X, TikTok, Vimeo, PeerTube, Weibo, TED, …) and wants its subtitles.
- The user asks to "下载字幕", "提取字幕", "字幕", "transcript", "summarize this video", or "translate this video".
- The user wants a `.srt` / `.vtt` subtitle file to download.

## Call the tool

```
fetch_subtitle(url, service?, language?, format?, showTimestamp?, savePath?, pageNumber?)
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `url` | yes | Full URL or bare id. Auto-detects the platform. |
| `service` | no | Force `bilibili`, `youtube` or `ytdlp` when detection is ambiguous. |
| `language` | no | Preferred language code, e.g. `zh-CN`, `zh-Hans`, `en`. Default preference: Chinese → English → first track. |
| `format` | no | `text` (default), `timestamped`, `grouped`, `srt`, `vtt`, `json`. Use `srt`/`vtt` for player-ready subtitle files. |
| `showTimestamp` | no | Adds a `[mm:ss]` prefix per line in `text` format. |
| `savePath` | no | Write the subtitle to disk. A file path, or a directory (auto-names `标题.语言.ext`). |
| `pageNumber` | no | Bilibili multi-part `P` number. Defaults to 1. |

## Typical workflows

**Download an SRT**

```
fetch_subtitle(url="https://www.bilibili.com/video/BV1fX4y1Q7Ux", format="srt", savePath="D:/subs/")
```

**Get a transcript for summarising**

```
fetch_subtitle(url="https://youtu.be/dQw4w9WgXcQ", format="grouped")
```

`grouped` collapses the transcript into ~30 blocks (the BibiGPT preprocessing style) which is cheaper to summarise.

**Pick a specific language**

```
fetch_subtitle(url="BV1xx411c7mD", language="en", format="vtt", savePath="talk.vtt")
```

**A site other than Bilibili / YouTube**

```
fetch_subtitle(url="https://framatube.org/videos/watch/<uuid>", format="srt", savePath="talk.srt")
```

Detected as `ytdlp` and handed to the generic engine; requires `yt-dlp` on PATH.

## Output

The tool reports the title, platform, chosen language, cue count, the list of available languages, and (when truncated) the path to the full subtitle file. The rendered subtitle follows. When `savePath` is used, the file path is reported and no temp file is written.

## Configuration

| Variable | Needed for | How to get it |
| --- | --- | --- |
| `BILIBILI_SESSION_TOKEN` | Bilibili subtitles | Log in on bilibili.com → DevTools → Application → Cookies → copy `SESSDATA`. Comma-separate several accounts. |
| `YT_DLP_PATH` | Non-Bilibili/YouTube sites, YouTube fallback | Optional. Path to `yt-dlp` if it is not on `PATH`. |
| `PI_SUBTITLE_PROXY` | Reaching blocked sites | Optional, e.g. `http://127.0.0.1:7890`. yt-dlp also honours `HTTPS_PROXY`. |
| `YT_DLP_COOKIES` / `YT_DLP_COOKIES_FROM_BROWSER` | Sites that demand a sign-in | Optional. A cookies file, or e.g. `chrome`. |

Bilibili needs a token; YouTube needs none. If YouTube's watch page is blocked, the extension retries through the Innertube API and finally through `yt-dlp`.

## Error handling

| Error | Cause | Fix |
| --- | --- | --- |
| `B站字幕接口通常需要登录态` | No / expired `SESSDATA`, or the video has no subtitles | Set a fresh `BILIBILI_SESSION_TOKEN`. |
| `YouTube 字幕获取失败` | Both engines failed | Check the per-engine detail; set `PI_SUBTITLE_PROXY` or yt-dlp cookies. |
| `该视频没有字幕轨道` | The site exposes no caption tracks | That video has no subtitles to extract. |
| `该站点需要 yt-dlp` | `yt-dlp` is not installed | `pip install -U yt-dlp`, or set `YT_DLP_PATH`. |
| `无法识别的视频 URL` | Unsupported URL shape | Pass the full video URL. |
| `字幕内容为空` | Track advertised but has no cues | Pick another `language`. |

## Notes

- Read-only network access; the only filesystem write is the optional `savePath`.
- Prefer `grouped` or `timestamped` when the next step is an LLM summary; prefer `srt`/`vtt` when the user wants a subtitle file for a video player.
- Bare ids work: `BV1fX4y1Q7Ux`, `av123456`, and an 11-char YouTube id are all accepted.
- Sites that burn subtitles into the video pixels cannot be handled by any extractor.
