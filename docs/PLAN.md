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

## Gap audit vs Astra's spec (2026-10-06)

Audited against Astra's master build prompt and the Gemini improvement list. Status: ✅ built ·
🟡 partial · ❌ missing · ⏸ deferred on purpose.

| Spec item | Status | Notes |
|---|---|---|
| Modes: guided, fading, easy, micro-drill, recovery, exam, stress | ✅ | All playable; fading thresholds configurable |
| Tracking mode: "periodically click the currently spoken word to verify sync" | ❌ | Missed. Sync is only measured passively from pointer position |
| Speeds 0.8×–1.3× | 🟡 | 1.0–1.3× for practice; 0.8×/1.0×/1.1× only for snippet replay. 0.8×/0.9× practice missing |
| Desktop mouse + mobile finger tracking | ✅ | Tested headless; **not yet tested on a real phone** |
| Scoring (+1/−1/0), precision, recall, FP rate, net score | ✅ | |
| Sync metrics (±1/±2, lag, loss events, recovery time) + timeline | ✅ | |
| Click latency + "missed while synced vs during sync loss" | ✅ | |
| Error diagnosis categories | 🟡 | Accent-related and unknown-vocabulary are weak (accent unknown for human clips; vocabulary inferred from trap type only). "Several consecutive errors ⇒ flag sync loss" not implemented |
| Confidence High/Medium/Guess | 🟡 | Post-hoc labelling after each question (spec allowed this). No at-click option. FP-rate-by-confidence not shown separately |
| Over-clicking test (≈10 passages, 0–1 mismatches, verdict: decision threshold vs discrimination) | 🟡 | 9 single over-click passages exist; **no dedicated test session and no aggregate verdict** — this was Astra's key diagnostic |
| Adaptive engine: weakness → exercise selection | ✅ | Over-clicking → sparse passages; trap misses → drills; weak sync → guided/fading/recovery; speed step-down |
| Adaptive: shorten passages when sync is weak, lengthen gradually | ❌ | Missed |
| Adaptive: raise difficulty after ≥90% precision over 20 passages | ❌ | Only speed progression. `difficulty` field is never used |
| Micro-drills for every trap category, select one category | 🟡 | Category picker works, but **only 1 dedicated drill per category**; function words and connected speech have **0** items |
| Mistake bank + spaced review (10 min/1 d/3 d/7 d) | ✅ | |
| Mistake bank: *new* sentences with the same trap | 🟡 | Reuses other library items with the same trap type — thin because the library is small. No generation |
| Daily 15–25 min plan, adapts next day | ✅ | |
| End-of-session summary (what improved / what cost points / tomorrow) | ❌ | Missed. Plan just says "done" |
| Dashboard last 10/25/50, trends, by trap/speed/mode/accent | 🟡 | All present; by-accent is useless for human clips (labelled "other"); sync-loss rate not shown |
| Rolling written diagnosis in Chinese ("you catch 84% but 19% of clicks are false…", vs yesterday) | ❌ | Missed. Only per-question coaching and plan focus lines |
| Speed experiment (equivalent passages at 1.0–1.2×) | 🟡 | By-speed table + recommendation; no guided experiment flow |
| Real audio, multiple accents, connected speech | 🟡 | 28 human recordings (accents unlabelled) + synthetic US/UK. No Australian/Indian guaranteed |
| Library size | 🟡 | 62 items. The daily plan uses ~8/day, so she will **repeat passages within about a week** — and a remembered passage is no longer a valid test |
| Custom exercise creator with auto-diff | ✅ | |
| Admin area (edit tokens/timestamps, publish/unpublish) | ⏸ | One learner; content lives in repo files. Custom creator covers adding items |
| Local-first + account sync, keep anonymous history | ✅ | |
| PWA install/offline | ✅ | Update flow fixed 2026-10-06 (was banner-only, never showed on installed apps) |
| Session flow Home → warm-up → drill → realistic → review → summary | 🟡 | Summary step missing |
| Tests for scoring/sync/adaptive, lint, typecheck, build | ✅ | 43 tests |
| Stack Next.js → Vite; magic link → password | ⏸ | Deliberate: no server code; Supabase's mailer can't reach her inbox |

Outside HIW (from Astra's study advice): her **FIB-L was 16 — as low as HIW** and Astra ranked it priority #1.
This app trains HIW only.

## Roadmap

### P0 — before sending to her

Learner feedback (2026-10-06): passages felt shorter than the real exam; Start button far from the
passage; no "Beginning in N seconds" before the audio. → All HIW items rebuilt at exam length
(85–125 words, 32–50 s); exam-style status box above the passage with a 7 s countdown and automatic
start in every mode; Next directly under the passage; volume control; phone auto-scroll.

- [x] **Content volume**: 117 exam-length human-voice items from 126 recordings (85–125 words, 32–50 s), 0–7 mismatches each, every trap category ≥6, 19 over-click passages (5 with zero mismatches). Older short items archived
- [x] **Automated clip check**: re-transcribe every cut clip and confirm words + timings match the tokens (catches bad cuts/alignment without needing ears)
- [x] **Over-clicking diagnostic test**: 10-passage session, count hidden, aggregate report (unnecessary clicks, net impact, confidence pattern) + verdict "decision threshold vs discrimination"
- [x] **Tracking checks**: in guided/fading, occasional "tap the word you just heard" prompts; sync accuracy reported
- [x] **Session summary** at the end of the daily plan: what improved, what cost the most points, tomorrow's focus
- [x] **Rolling written diagnosis** on Progress (zh-TW/en), with change vs previous period
- [x] **Difficulty progression**: use `difficulty` + passage length; shorter passages when sync is weak, harder/longer after ≥90% precision over 20
- [x] 0.8× / 0.9× practice speeds
- [x] Consecutive-error sync-loss flag; false clicks by confidence; sync-loss rate on dashboard
- [ ] Accent labels for human recordings where the reader's accent can be determined (not reliably possible from metadata; left as "other")
- [ ] Real-phone test (iPhone Safari + installed app): audio start, finger tracking, update applies

### Learner feedback round 2 (2026-10-06)
- [x] Today: focus updates live (was frozen at plan creation → "not enough data" all day); explains exactly how many scored questions are still needed; progress bar + "up next"; "Add 3 more" when done
- [x] Mistake bank records misses from the fading warm-up too; Today shows bank size, not just due count
- [x] Quick review flashcards with audio replay and self-grading
- [x] My words: look up any word, definitions + pronunciation + Chinese dictionary link, learned count and milestones, synced

### P1 — soon after
- [ ] FIB-L trainer (same audio + timestamp engine; type the missing words, spelling-aware scoring)
- [ ] Mistake-bank generated examples (new sentences per confusion pair, synthesised offline)
- [ ] Guided speed-experiment flow
- [ ] At-click confidence option (desktop modifier keys)

### P2 — later
- [ ] Admin/content editor (tokens, timestamps, publish)
- [ ] Optional AI coaching behind a service boundary (off by default)

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
