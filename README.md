# pi-video-subtitle

A [Pi](https://pi.dev) **extension + skill** combo that extracts and downloads video subtitles.

Subtitle extraction logic is ported from [JimmyLv/BibiGPT-v1](https://github.com/JimmyLv/BibiGPT-v1)
and extended with SRT/VTT rendering, directory-aware downloads, and a generic
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) engine.

## Supported platforms

| Platform | Method | Credentials |
| --- | --- | --- |
| **Bilibili** | Official web APIs: `x/web-interface/view` → `x/player/v2` → subtitle JSON | `BILIBILI_SESSION_TOKEN` (SESSDATA) usually required |
| **YouTube** | `yt-dlp` (primary) → `ytInitialPlayerResponse.captionTracks` → Innertube API | none; cookies recommended on datacenter IPs |
| **Anything else** | yt-dlp — ~1800 sites (Twitter/X, TikTok, Vimeo, PeerTube, Weibo, TED, …) | site-dependent |

Bilibili multi-part (`?p=N`) videos, `b23.tv` short links, bare `BV…`/`av…` ids, YouTube `youtu.be`/`shorts` links and bare 11-char ids are all supported. Any other `http(s)` URL is handed to yt-dlp.

## What's inside

```
pi-video-subtitle/
├── package.json                    # Pi package manifest (extensions + skills)
├── extensions/
│   └── subtitle-fetcher.ts         # fetch_subtitle tool + /subtitle command
├── skills/
│   └── video-subtitle/
│       └── SKILL.md                # when/how to use the tool
└── src/
    ├── bilibili.ts                 # Bilibili API pipeline
    ├── youtube.ts                  # YouTube captions (yt-dlp + native fallback)
    ├── ytdlp.ts                    # generic yt-dlp engine (any site)
    ├── download.ts                 # render + file naming
    ├── fetchSubtitle.ts            # platform dispatcher
    ├── types.ts                    # shared types
    └── utils.ts                    # URL parsing + text/SRT/VTT renderers
└── tests/
    └── pipeline.test.ts            # offline test suite (`npm test`)
```

## Install

### Local

```bash
git clone https://github.com/1L7V5101V/pi-video-subtitle.git
pi install ./pi-video-subtitle
```

Or for a single run:

```bash
pi -e ./pi-video-subtitle
```

### Git

```bash
pi install git:github.com/1L7V5101V/pi-video-subtitle
```

## Configure

```bash
# Bilibili: copy SESSDATA from a logged-in bilibili.com session
# (DevTools → Application → Cookies). Comma-separate multiple accounts.
export BILIBILI_SESSION_TOKEN=xxxxxxxx%2Cxxxxxxxx

# Optional: path to yt-dlp if it is not on PATH (used for YouTube and every other site)
export YT_DLP_PATH=/usr/local/bin/yt-dlp

# Optional: proxy for sites you cannot reach directly (yt-dlp also honours HTTPS_PROXY)
export PI_SUBTITLE_PROXY=http://127.0.0.1:7890

# Optional: give yt-dlp your browser cookies when a site asks you to sign in
# (e.g. YouTube's “Sign in to confirm you're not a bot”)
export YT_DLP_COOKIES_FROM_BROWSER=chrome   # or: YT_DLP_COOKIES=/path/cookies.txt
```

On Windows PowerShell:

```powershell
$env:BILIBILI_SESSION_TOKEN="xxxxxxxx"
```

Bilibili needs a token; YouTube needs none; other sites need whatever yt-dlp needs.

## Test

```bash
npm install
npm test                                  # offline: routing, parsers, Bilibili pipeline
PI_SUBTITLE_NET_TEST=<video-url> npm test  # + one live download
```

## Use

Ask the agent to fetch a video's subtitles — the `fetch_subtitle` tool is selected automatically:

```
下载这个视频的字幕并保存为 srt: https://www.bilibili.com/video/BV1fX4y1Q7Ux
```

Or call the tool directly:

```jsonc
fetch_subtitle({
  "url": "https://www.bilibili.com/video/BV1fX4y1Q7Ux",
  "format": "srt",
  "savePath": "D:/subs/"
})
```

### Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `url` | yes | Video URL or bare id. Platform is auto-detected. |
| `service` | no | Force `bilibili`, `youtube` or `ytdlp`. |
| `language` | no | Preferred language code (`zh-CN`, `en`, …). Default: Chinese → English → first. |
| `format` | no | `text` (default), `timestamped`, `grouped`, `srt`, `vtt`, `json`. |
| `showTimestamp` | no | Prefix `text` lines with `[mm:ss]`. |
| `dedupe` | no | Strip the duplicated words that rolling auto-captions (ASR) repeat on every line. Default `auto`: applied only when 20%+ of the lines overlap. Set `false` to keep the raw track. |
| `savePath` | no | File path or directory to write to. Auto-names from the title + language. |
| `pageNumber` | no | Bilibili multi-part `P` index (default 1). |

### `/subtitle` command

```
/subtitle <url> [--format srt|vtt|json|text] [--lang <code>] [--out <path>] [--no-dedupe]
```

Fetches and writes the subtitle to disk, then reports the path.

## Auto-caption dedupe

Machine-generated captions are streamed as a **rolling window**: every line repeats the tail of the line
before it and only the end of the last line is new speech.

```
Today I'm speaking with
Today I'm speaking with Andrej Karpathy
Andrej Karpathy, why do you say
```

Our extractors keep one cue per ASR line, so that duplication lands in the transcript verbatim — and
the summarising model pays for it twice. `dedupeRollingCues` compares each cue with the previous kept
cue, strips the overlapping head words, drops a cue that carried no new words, and hands the timing it
covered to its predecessor.

It is content-gated, not flag-gated: `'auto'` (the default) only rewrites the cues when **≥20% of them
overlap their predecessor by ≥3 words**, so hand-written subtitles pass through untouched even though
the track is labelled manual. Measured on a simulated 20 000-word YouTube ASR track (4 000 cues):

| output | tokens (gpt-4o) | after dedupe | saving |
| --- | --- | --- | --- |
| `text` | 71542 | 49922 | **30%** |
| `grouped` | 67511 | 45893 | **32%** |

The tool always reports what it removed (`已去除滚动重复: -N 行 / -M 词`), so nothing disappears silently.
Force it with `dedupe: true`, or keep the raw track with `dedupe: false` / `/subtitle --no-dedupe`.

## Formats

| `format` | Description |
| --- | --- |
| `text` | One cue per line, no timestamps. |
| `timestamped` | One cue per line, prefixed with `[mm:ss]`. |
| `grouped` | ~30 merged blocks with a leading timestamp — the BibiGPT preprocessing style, ideal before an LLM summary. |
| `srt` | SubRip with `-->` timings — drop into any video player. |
| `vtt` | WebVTT. |
| `json` | Array of `{ index, start, end, text }` cues (seconds). |

## Notes & limitations

- Auto-generated caption tracks repeat the previous line, which is what the dedupe pass removes. If a
  transcript looks like it is missing words, re-run with `dedupe: false` and compare.
- Bilibili's subtitle list is behind the logged-in `player/v2` API. Videos where the uploader disabled
  subtitles, or premium videos without entitlement, will return an empty list even with a valid token.
- YouTube now gates its `timedtext` endpoint behind a proof-of-origin token, so the native path often
  returns an empty body. yt-dlp is the primary engine for that reason; the native path is only a
  fallback for machines without yt-dlp installed.
- Private / age-restricted / paid videos may fail on every path.
- Sites that only burn subtitles into the video pixels cannot be handled by any extractor.
- A site may advertise a subtitle language and still fail to serve it — YouTube lists ~150 auto-translated
  tracks and rate-limits most of them — so every candidate track is retried before giving up.

## Credits

- Subtitle pipeline adapted from [JimmyLv/BibiGPT-v1](https://github.com/JimmyLv/BibiGPT-v1).
- `grouped` output reproduces BibiGPT's `reduceSubtitleTimestamp` grouping (30 blocks of 7 cues).

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE). This package is a derivative work of
[JimmyLv/BibiGPT-v1](https://github.com/JimmyLv/BibiGPT-v1), which is licensed under GPL-3.0, so the
same copyleft terms apply here.
