/**
 * Test suite for the subtitle pipelines.
 *
 * Runs fully offline: the Bilibili API contract is replayed through a stubbed
 * `fetch`, because Bilibili's subtitle list is login-gated in reality and a
 * network-dependent test would be flaky either way.
 *
 *   npm test                       # offline
 *   PI_SUBTITLE_NET_TEST=1 npm test # + a real YouTube download (needs network)
 */
import { fetchBilibiliSubtitle } from '../src/bilibili'
import { renderSubtitle } from '../src/download'
import { fetchSubtitle, parseVideoUrl } from '../src/fetchSubtitle'
import { parseJson3, parseSubtitleFile } from '../src/ytdlp'
import { dedupeRollingCues, overlapWordCount } from '../src/utils'

let failures = 0
const check = (label: string, condition: boolean, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failures++
}

// ---------------------------------------------------------------------------
// URL routing
// ---------------------------------------------------------------------------
console.log('\n# URL routing')

const routing: [string, string, string][] = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://www.bilibili.com/video/BV1GJ411x7h7', 'bilibili', 'BV1GJ411x7h7'],
  ['BV1GJ411x7h7', 'bilibili', 'BV1GJ411x7h7'],
  ['av12345', 'bilibili', 'av12345'],
  ['https://framatube.org/videos/watch/abc', 'ytdlp', 'https://framatube.org/videos/watch/abc'],
]
for (const [input, service, videoId] of routing) {
  const parsed = parseVideoUrl(input)
  check(`route ${input}`, parsed.service === service && parsed.videoId === videoId, `${parsed.service}/${parsed.videoId}`)
}
check('bilibili multi-page is captured', parseVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=3').pageNumber === '3')
check('b23.tv becomes a resolvable short id', parseVideoUrl('https://b23.tv/abc123').videoId === 'short:abc123')
try {
  parseVideoUrl('not a url at all')
  check('non-URL input is rejected', false)
} catch (error) {
  check('non-URL input is rejected', /无法识别的视频 URL/.test((error as Error).message))
}

// ---------------------------------------------------------------------------
// External subtitle formats (what yt-dlp hands back varies by site)
// ---------------------------------------------------------------------------
console.log('\n# Subtitle parsing')

const json3 = parseJson3({
  events: [
    { tStartMs: 500, dDurationMs: 1500, segs: [{ utf8: 'hello' }, { utf8: ' world' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
  ],
})
check('json3 skips whitespace-only events', json3.length === 1 && json3[0].text === 'hello world', JSON.stringify(json3))
check('json3 keeps timing', json3[0].start === 0.5 && json3[0].end === 2)

const srtCues = parseSubtitleFile(
  'x.fr.srt',
  [
    '1',
    '00:00:05,200 --> 00:00:07,000',
    'Bonjour à tous.',
    '',
    '2',
    '01:02:03,400 --> 01:02:05,000',
    'Deuxième ligne',
    'sur deux lignes.',
    '',
  ].join('\n'),
)
check('srt blocks parsed', srtCues.length === 2, String(srtCues.length))
check('srt timecode parsed', srtCues[0].start === 5.2 && srtCues[0].end === 7, `${srtCues[0].start}-${srtCues[0].end}`)
check('srt hour rollover parsed', srtCues[1].start === 3723.4, String(srtCues[1].start))
check('srt multiline joined', srtCues[1].text === 'Deuxième ligne sur deux lignes.', srtCues[1].text)

const vttCues = parseSubtitleFile(
  'x.fr.vtt',
  [
    'WEBVTT',
    '',
    'NOTE this comment must be ignored',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:03.000 align:start position:10%',
    '<v Speaker>Salut</v>',
    '',
    '00:00:04.000 --> 00:00:05.500',
    'Au revoir',
    '',
  ].join('\n'),
)
check('vtt header and NOTE skipped', vttCues.length === 2, String(vttCues.length))
check('vtt cue settings ignored', vttCues[0].start === 1 && vttCues[0].end === 3, `${vttCues[0].start}-${vttCues[0].end}`)
check('vtt inline tags stripped', vttCues[0].text === 'Salut', vttCues[0].text)

// ---------------------------------------------------------------------------
// Bilibili pipeline (stubbed network)
// ---------------------------------------------------------------------------
console.log('\n# Bilibili pipeline')

const REAL_FETCH = globalThis.fetch
const calls: { url: string; cookie?: string }[] = []

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  calls.push({ url, cookie: (init?.headers as Record<string, string> | undefined)?.Cookie })

  if (url.includes('/x/web-interface/view')) {
    return json({
      code: 0,
      data: {
        aid: 12345,
        bvid: 'BV1GJ411x7h7',
        title: '测试视频标题',
        desc: '描述文本',
        pages: [
          { page: 1, cid: 111, part: 'P1' },
          { page: 2, cid: 222, part: 'P2' },
        ],
      },
    })
  }
  if (url.includes('/x/player/v2')) {
    return json({
      code: 0,
      data: {
        subtitle: {
          subtitles: [
            { lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/en.json', type: 0 },
            { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/zh.json', ai_status: 1 },
          ],
        },
      },
    })
  }
  if (url.endsWith('/zh.json')) {
    return json({
      body: [
        { from: 0.5, to: 2.0, content: '大家好' },
        { from: 2.0, to: 4.75, content: '欢迎来到测试' },
        { from: 3600.25, to: 3603.5, content: '最后一句话' },
      ],
    })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

process.env.BILIBILI_SESSION_TOKEN = 'token-a, token-b'

try {
  const result = await fetchBilibiliSubtitle('BV1GJ411x7h7', {})
  check('title', result.title === '测试视频标题', result.title)
  check('bvid used for the view lookup', calls[0].url.includes('bvid=BV1GJ411x7h7'), calls[0].url)
  check(
    'SESSDATA sent from the comma-separated token list',
    calls[0].cookie === 'SESSDATA=token-a' || calls[0].cookie === 'SESSDATA=token-b',
    String(calls[0].cookie),
  )
  check('ai-zh preferred over manual en', result.track.language === 'ai-zh', result.track.language)
  check('isAuto flagged', result.track.isAuto === true)
  check('cues parsed', result.track.cues.length === 3, String(result.track.cues.length))
  check(
    'protocol-relative subtitle_url normalised',
    calls.some((call) => call.url === 'https://aisubtitle.hdslb.com/zh.json'),
    calls.map((call) => call.url).join(' | '),
  )
  check('cues carry from/to', result.track.cues[0].start === 0.5 && result.track.cues[0].end === 2.0)

  const srt = renderSubtitle(result, { format: 'srt' })
  check('srt timestamp formatting', srt.includes('00:00:00,500 --> 00:00:02,000'), srt.split('\n')[1])
  check('srt hour rollover', srt.includes('01:00:00,250 --> 01:00:03,500'))

  const vtt = renderSubtitle(result, { format: 'vtt' })
  check('vtt header', vtt.startsWith('WEBVTT'))
  check('vtt dot millis', vtt.includes('00:00:00.500 --> 00:00:02.000'))

  const grouped = renderSubtitle(result, { format: 'grouped', showTimestamp: true })
  check('grouped starts with a timestamp', /^00:00 - /.test(grouped), grouped.split('\n')[0])

  check(
    'plain text is one cue per line',
    renderSubtitle(result, { format: 'text' }) === '大家好\n欢迎来到测试\n最后一句话',
  )

  const jsonOut = JSON.parse(renderSubtitle(result, { format: 'json' }))
  check(
    'json output is a cue array with timing',
    Array.isArray(jsonOut) && jsonOut.length === 3 && jsonOut[0].start === 0.5 && jsonOut[0].text === '大家好',
    JSON.stringify(jsonOut[0]),
  )

  calls.length = 0
  await fetchBilibiliSubtitle('BV1GJ411x7h7', { pageNumber: '2' })
  check('page 2 selects cid=222', calls[1].url.includes('cid=222'), calls[1].url)

  calls.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url })
    if (url.startsWith('https://b23.tv/')) {
      return { url: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=1', status: 200, ok: true } as Response
    }
    if (url.includes('/x/web-interface/view')) {
      return json({ code: 0, data: { aid: 1, bvid: 'BV1GJ411x7h7', title: 'T', pages: [{ page: 1, cid: 9 }] } })
    }
    if (url.includes('/x/player/v2')) {
      return json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://x/zh.json' }] } } })
    }
    return json({ body: [{ from: 0, to: 1, content: 'hi' }] })
  }) as typeof fetch
  const short = await fetchSubtitle('https://b23.tv/BV1GJ411x7h7')
  check('b23.tv short link resolved', short.videoId === 'BV1GJ411x7h7', short.videoId)

  globalThis.fetch = (async () =>
    json({ code: 0, data: { aid: 1, bvid: 'BV1GJ411x7h7', title: 'T', pages: [{ page: 1, cid: 9 }] } })) as typeof fetch
  delete process.env.BILIBILI_SESSION_TOKEN
  try {
    await fetchBilibiliSubtitle('BV1GJ411x7h7', {})
    check('an empty subtitle list throws', false)
  } catch (error) {
    check(
      'an empty subtitle list throws with a login hint',
      /BILIBILI_SESSION_TOKEN/.test((error as Error).message),
      (error as Error).message.slice(0, 60),
    )
  }
} finally {
  globalThis.fetch = REAL_FETCH
}

// ---------------------------------------------------------------------------
// Rolling auto-caption (ASR) dedupe
// ---------------------------------------------------------------------------
console.log('\n# ASR rolling-window dedupe')

check(
  'overlap measures the repeated tail',
  overlapWordCount('hello world this is a test', 'this is a test of the system') === 4,
)
check('overlap is zero for unrelated lines', overlapWordCount('completely different', 'nothing in common') === 0)

const rolling = [
  'the quick brown fox jumps',
  'the quick brown fox jumps over the lazy dog',
  'over the lazy dog and runs away',
  'and runs away into the woods',
  'into the woods',
  'and then it stops',
].map((text, index) => ({ index, start: index * 2, end: index * 2 + 2, text }))

const deduped = dedupeRollingCues(rolling)
check(
  'rolling repeats are stripped',
  deduped.cues.map((cue) => cue.text).join(' | ') ===
    'the quick brown fox jumps | over the lazy dog | and runs away | into the woods | and then it stops',
  deduped.cues.map((cue) => cue.text).join(' | '),
)
check('fully covered lines are dropped', deduped.report.removedCues === 1, String(deduped.report.removedCues))
check('removed word count', deduped.report.removedWords === 15, String(deduped.report.removedWords))
check('overlap ratio measured', Math.abs(deduped.report.overlapRatio - 4 / 6) < 1e-9, String(deduped.report.overlapRatio))
check('surviving lines are re-indexed', deduped.cues.every((cue, index) => cue.index === index))
check('a dropped line extends its predecessor', deduped.cues[3].end === 10, String(deduped.cues[3].end))

const handWritten = ['你好，欢迎观看', '今天我们聊聊字幕', '先从 B 站开始'].map((text, index) => ({
  index,
  start: index,
  end: index + 1,
  text,
}))
check('hand-written tracks are untouched', dedupeRollingCues(handWritten).report.removedWords === 0)

const asrBody = [
  { from: 0, to: 2, content: 'this is a rolling caption' },
  { from: 2, to: 4, content: 'this is a rolling caption and it repeats' },
  { from: 4, to: 6, content: 'and it repeats a lot of times' },
  { from: 6, to: 8, content: 'a lot of times' },
]
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/x/web-interface/view')) {
    return json({ code: 0, data: { aid: 1, bvid: 'BV1GJ411x7h7', title: 'ASR', pages: [{ page: 1, cid: 9 }] } })
  }
  if (url.includes('/x/player/v2')) {
    return json({
      code: 0,
      data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://x/asr.json', ai_status: 1 }] } },
    })
  }
  return json({ body: asrBody })
}) as typeof fetch
try {
  const auto = await fetchSubtitle('BV1GJ411x7h7')
  check('auto dedupe fires on a rolling track', auto.dedupe !== undefined, JSON.stringify(auto.dedupe))
  check('auto dedupe shrinks the transcript', auto.track.cues.length === 3, String(auto.track.cues.length))
  check(
    'auto dedupe keeps every word of speech',
    renderSubtitle(auto, { format: 'text' }) === 'this is a rolling caption\nand it repeats\na lot of times',
    renderSubtitle(auto, { format: 'text' }).replace(/\n/g, ' / '),
  )

  const off = await fetchSubtitle('BV1GJ411x7h7', { dedupe: false })
  check('dedupe can be switched off', off.dedupe === undefined && off.track.cues.length === 4, String(off.track.cues.length))

  const forced = await fetchSubtitle('BV1GJ411x7h7', { dedupe: true })
  check('dedupe can be forced', forced.dedupe?.removedCues === 1, JSON.stringify(forced.dedupe))
} finally {
  globalThis.fetch = REAL_FETCH
}

// ---------------------------------------------------------------------------
// Optional live check
// ---------------------------------------------------------------------------
if (process.env.PI_SUBTITLE_NET_TEST) {
  console.log('\n# Live YouTube download')
  try {
    const live = await fetchSubtitle(process.env.PI_SUBTITLE_NET_TEST)
    check('live download returned cues', live.track.cues.length > 0, `${live.track.language} · ${live.track.cues.length} cues`)
  } catch (error) {
    check('live download returned cues', false, (error as Error).message.slice(0, 200))
  }
} else {
  console.log('\n(skipping the live network check; set PI_SUBTITLE_NET_TEST=<video url> to run it)')
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
