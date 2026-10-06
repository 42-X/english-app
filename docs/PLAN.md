# HIW Trainer — Build Plan & Launch Checklist

PTE Academic "Highlight Incorrect Words" trainer. Goal: measurable transfer to the real exam —
accuracy first, synchronization second, speed only after both are stable.

## Stack (changed from the Astra prompt)

| Concern | Choice | Why |
|---|---|---|
| App | Vite + React + TypeScript (strict) + Tailwind | Static PWA, no server needed for v1; fastest build; free hosting anywhere |
| Persistence | IndexedDB via Dexie | Local-first, works signed-out and offline |
| PWA | vite-plugin-pwa (Workbox) | Installable, caches app shell + exercise audio |
| Audio | Kokoro-82M (open-source TTS, run offline at build time) | Real neural voices **with exact word timestamps**, free, no API key; US + UK voices |
| Fallback audio | Browser speechSynthesis | Custom exercises only; analytics flagged *approximate* |
| Tests | Vitest | Scoring, sync math, adaptive engine |
| Hosting | Cloudflare static assets (Workers) | Unlimited free bandwidth, commercial use allowed on free tier |
| Sync | Supabase (email+password auth, Postgres, RLS) | Built in v1 at owner's request; project `hiw-trainer` |

## Architecture

```
src/
  domain/        pure TS, fully tested — no React
    types.ts         Exercise, Token, Attempt, TrackingSample, Interaction…
    scoring.ts       +1 / −1 / 0, precision, recall, FP rate
    sync.ts          lag per sample, ±1/±2 %, loss events, recovery times, timeline segments
    latency.ts       click latency buckets
    diagnosis.ts     rule-based error classification ("likely cause")
    adaptive.ts      rolling stats → weaknesses → next exercises, speed readiness
    srs.ts           mistake bank schedule (10m, 1d, 3d, 7d)
    plan.ts          daily 15–25 min plan
    coaching.ts      deterministic coaching messages (zh-TW / en)
    diff.ts          display vs spoken transcript → mismatch pairs (custom creator)
  audio/         AudioProvider interface
    RecordedAudioProvider     (mp3 + word timings — seed content)
    BrowserSpeechProvider     (fallback, approximate timings)
  data/          Dexie DB, repositories, export/import
  i18n/          zh-TW (default) + en
  features/
    player/        transcript renderer, pointer tracking (mouse + touch), click capture
    results/       diagnostics, mismatch rows, snippet replay, timeline, confidence labels
    dashboard/     last 10/25/50, by trap / speed / mode, readiness
    plan/          today's session runner
    mistakes/      mistake bank + review
    creator/       custom exercise creator
content/         source passages (JSON) → scripts/generate-audio.py → public/audio + timings
```

### Key mechanics
- **Tokens**: each selectable word has `index`, `displayText`, `spokenText`, `startMs`, `endMs`,
  `isIncorrect`, `trapCategory`. Punctuation is stored separately and is not selectable.
  Audio is generated from the *spoken* transcript; substitutions are 1:1 so timings map by index.
- **Spoken index**: derived from `audio.currentTime` (media time, so it stays correct at any playbackRate).
- **Pointer index**: desktop = word under/nearest the mouse; mobile = finger tracking (below).
- **Sampling**: every 100 ms while playing → `lag = pointerIndex − spokenIndex`.
  ±1 excellent, ±2 acceptable, 3–4 drifting, 5+ = sync loss. Recovery = time from loss until back within ±2.
- **Mobile gesture model**: touch-and-drag over the transcript = tracking (a pointer marker follows the finger,
  never selects). A short tap with little movement (<10 px, <250 ms) = select/deselect. A dragging finger
  cannot accidentally select.
- **Click latency**: click time − spoken word end. Buckets: fast (<600 ms), normal (<1.5 s), late (<3 s), very late.
- **Scoring**: hit +1, false positive −1, miss 0; per-question floor 0 (labelled "simulation, not Pearson scaling").
- **Miss attribution**: each miss is tagged "while synchronized" or "during sync loss" from the lag at that moment.

## Scope for tonight (v1)

### Must ship
1. PWA shell: installable, offline, light/dark, zh-TW/en toggle
2. Exercise player with speed control (1.0 / 1.05 / 1.10 / 1.15 / 1.20 / 1.30)
3. Training layout + exam layout
4. Modes: Guided Tracking · Fading Guidance · Easy HIW · Micro-drills (per trap category) ·
   Recovery · Over-clicking test · Exam · Stress
5. Mouse tracking (desktop) + finger tracking (mobile)
6. Scoring, precision/recall, sync metrics, click latency, recovery events
7. Results: summary, mismatch table with snippet replay (±1 s at 0.8/1.0/1.1×), diagnostic timeline,
   optional post-hoc confidence labels (High / Medium / Guess) on selections
8. Rule-based error diagnosis + coaching in Traditional Chinese
9. Mistake bank with spaced review that serves *new* items in the same trap category
10. Daily plan (warm-up → weak drill → realistic HIW → review → summary)
11. Dashboard: last 10/25/50, trends, by trap/speed/mode, speed readiness recommendation
12. Custom exercise creator (paste transcript + spoken version → auto-diff; browser TTS or uploaded audio)
13. Account sync between devices (Supabase) + export / import backup (JSON)
14. Seed library of original passages (no Pearson content), 12+ academic topics, US + UK voices:
    3 guided · 5 easy · 10 realistic · 8 micro-drills · 4 over-click (0–2 mismatches) · 3 recovery
15. Tests + lint + typecheck + build all green; deployed

### Phase 2 (after tonight)
- Admin area: token/timestamp editor, publish/unpublish
- Formal speed-experiment wizard (v1 has per-speed stats + recommendation)
- More accents (Australian, Indian) and real recorded audio
- Generated exercises targeting her exact recurring confusions
- Optional AI coaching behind a service boundary (off by default; no data leaves the device in v1)

## Build order

1. Scaffold Vite/React/TS/Tailwind/PWA/Dexie/Vitest, ESLint, strict TS
2. Domain types + scoring/sync/latency/srs/adaptive/plan with unit tests
3. Write seed passages (content JSON) → Kokoro generation script → mp3 + word timings
4. Player: transcript renderer, audio provider, tracking (mouse + touch), selection, modes, fading
5. Results page + timeline + snippet replay + confidence labels + diagnosis/coaching
6. Persistence: sessions, attempts, samples, mistake bank, settings; export/import
7. Dashboard, daily plan runner, mistake review, micro-drill picker
8. Custom exercise creator
9. i18n pass (zh-TW default), mobile layout pass, exam layout pass
10. lint / typecheck / tests / build → fix → manual QA in desktop + mobile viewport
11. Deploy to Vercel, push to GitHub

## Launch checklist

### Build quality
- [x] `npm run lint` clean
- [x] `npm run typecheck` clean
- [x] `npm test` green (scoring, sync, latency, adaptive, srs, diff)
- [x] `npm run build` succeeds; PWA manifest + service worker emitted

### Manual QA — desktop
- [x] Guided tracking: current word highlight follows audio at 1.0× and 1.2×
- [x] Fading guidance: highlight → subtle line cue → none at configured thresholds
- [x] Mouse tracking produces sensible lag numbers (follow perfectly → ~0; stop moving → loss event)
- [x] Clicking a mismatch = +1, clicking a correct word = −1, total floors at 0
- [x] Exam mode: no highlight, no live feedback, no pause, results only after submit
- [x] Results: every mismatch row, latency, lag-at-moment, snippet replay at 0.8/1.0/1.1×
- [x] Timeline shows sync health, mismatches, hits, misses, false positives
- [ ] Confidence labels change "precision by confidence" stats

### Manual QA — mobile (real phone)
- [x] Drag finger along text → tracking marker follows, nothing gets selected
- [x] Quick tap selects/deselects a word
- [ ] Transcript fills the screen; no horizontal scroll; tap targets comfortable
- [ ] Audio plays on iOS Safari after a user tap (autoplay rules)
- [ ] "Add to Home Screen" installs; opens full-screen; works in airplane mode for cached exercises

### Data
- [x] History survives reload and browser restart
- [ ] Mistake bank fills after misses/false positives; review appears when due
- [x] Daily plan changes after a run with many false positives (→ over-click/sparse exercises)
- [ ] Export → clear site data → import restores everything

### Content
- [x] All seed passages original; audio labelled synthetic (Kokoro) in UI
- [ ] Every mismatch token's timing lines up with the audio (spot-check 5 passages)

### Launch
- [x] Deployed: https://hiw-trainer.hiw-trainer.workers.dev
- [ ] Opened on her phone + laptop, installed as app
- [x] Code pushed to github.com/42-X/english-app
- [ ] Phase 2 list captured as GitHub issues (optional)

### Owner to-dos
- Add `~/.ssh/id_rsa_github42x.pub` to the 42-X GitHub account (needed to push)
- Drop her original prototype at `reference/original-hiw-trainer.html` if available

### QA notes (automated, headless Chromium)
- Desktop practice r01: 4 hits + 1 false click → 3/5; false click next to a mismatch flagged "position slip"; simulated 6-word lag shows as red sync-loss on the timeline
- Phone (iPhone 13 viewport) drill d03: finger-drag tracking 100% within ±2; taps selected 3/3, drags selected nothing
- Exam: no pause button, countdown then auto-play. Recovery: two blackouts recorded with recovery times. Guided: auto-finishes, unscored
- Two-device sync: account created on phone context, history appeared on a second context after sign-in; RLS blocks reading/writing other users' rows
- After 4 over-clicky, lagging attempts the plan refocused on sync + over-clicking (2 over-click tests, recovery drill)
- Not yet tested on a real iPhone/Android — do this before relying on it (audio unlock, touch feel)
