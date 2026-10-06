# HIW Trainer

A focused trainer for **PTE Academic – Highlight Incorrect Words**. It measures what actually loses
points in HIW (pointer/audio synchronization, late clicks, over-clicking, specific trap types) and adapts
daily practice to it.

- Installable PWA (desktop + phone), works offline, no login required
- Optional account (email + password) syncs history between devices via Supabase
- Traditional Chinese UI and coaching by default, English available
- All analytics are deterministic and run on-device — no AI service receives any data

## What's in it

| Area | Details |
|---|---|
| Modes | Guided tracking · Fading guidance · HIW practice · Micro-drills (per trap type) · Recovery (text blackouts) · Over-clicking test (0–2 hidden mismatches) · Exam (countdown, no pause, no hints) · Stress (1.10–1.30×) · Mistake review |
| Tracking | Desktop: mouse hover. Phone: slide a finger over the text to track (sliding never selects); a quick tap selects. Sampled every 100 ms against the spoken word |
| Scoring | Hit +1, false click −1, miss 0, floored at 0 — labelled as a simulation, not Pearson scaling. Precision, recall, false-positive rate |
| Diagnostics | ±1/±2 sync, lag, sync-loss events and recovery time, click latency buckets, per-mismatch "likely cause" (lost sync vs trap type vs late response vs position slip), timeline, snippet replay at 0.8/1.0/1.1× |
| Adaptive | Rolling weakness detection → daily 15–25 min plan (warm-up → weak drills → realistic → review). Speed only goes up after stable quality at the current speed; drops back if quality falls |
| Mistake bank | Misses and false clicks, spaced review at 10 min → 1 day → 3 days → 7 days, reviewed with *different* passages of the same confusion |
| Content | 34 original passages (no Pearson material) across 15 topics, US + UK voices, generated with open-source Kokoro TTS **with exact per-word timestamps** |
| Custom | Paste displayed + spoken text → mismatches auto-detected and categorised; browser voice (approximate) or uploaded audio (+ optional timestamps) |

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: Supabase keys for sync
npm run dev                  # http://localhost:5173
```

Checks:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Deploy (Cloudflare Pages)

The app is a static site (`dist/`). Cloudflare Pages serves `index.html` for unknown paths, so client
routing works with no extra config.

```bash
npm run build
npx wrangler pages deploy dist --project-name hiw-trainer
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are baked in at build time from `.env.local`.
Any static host works (Vercel, Netlify) — add an SPA fallback to `/index.html` there.

## Cloud sync (Supabase)

Schema: [`supabase/migrations/`](supabase/migrations/). Each synced table stores the client document as
`jsonb`, keyed by `(user_id, id)`, with row-level security restricting every row to its owner.
Conflict resolution is last-write-wins on the client's `updatedAt`; `server_updated_at` is the pull cursor.
The first sign-in on a device uploads everything practised anonymously, so no history is lost.

New project setup:

```bash
supabase link --project-ref <ref>
supabase db push
supabase config push      # email confirmations off (see supabase/config.toml)
```

Login is email + password with confirmation disabled: Supabase's built-in mailer only delivers to project
members unless custom SMTP is configured, so magic links would not reach learners.

Free-tier note: Supabase pauses projects after ~7 days without any requests. Daily practice keeps it awake;
if it pauses, restore it from the dashboard — local data on each device is unaffected.

## Content pipeline

Passages live in [`content/passages.json`](content/passages.json). Mismatches are written inline as
`[displayed|spoken:trap-category]`:

```
Governments often measure [economical|economic:word-family] progress …
```

The audio says the *spoken* word; the transcript shows the *displayed* one. Generate audio + timings:

```bash
python3 -m venv .venv-tts
.venv-tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv-tts/bin/pip install "kokoro>=0.9.4" soundfile lameenc
npm run audio            # only new/changed passages
npm run audio -- --force # everything
```

Output: `public/audio/<id>.mp3` and `public/content/library.json`. Kinds: `guided` (no mismatches),
`easy` (1–2 obvious), `realistic` (4–6 mixed), `drill` (one trap type), `overclick` (0–2), `recovery`
(longer, anchor-rich). Voices: `af_heart`, `af_bella`, `am_michael` (US), `bf_emma`, `bm_george`,
`bm_fable` (UK).

## Architecture

```
src/domain/     pure, tested logic: scoring, sync, latency, diagnosis, SRS, adaptive engine, plan, text diff
src/audio/      AudioEngine: recorded/timestamped audio (exact) + browser speech fallback (approximate)
src/data/       Dexie (IndexedDB) storage, repositories, backup, Supabase sync
src/features/   player, results, home (daily plan), practice, mistakes, progress, create, settings
src/i18n/       zh-TW + en dictionaries
```

## What is approximate

- Custom exercises using the browser voice or uploaded audio without timestamps: word timing is estimated,
  so sync/latency numbers are flagged as approximate in the UI.
- Kokoro word timestamps come from the TTS model's own alignment. They are machine-checked for order and plausible durations, but not hand-verified by ear.
- The exam layout approximates the test's density; it is not pixel-verified against Pearson's UI.
- "Likely cause" labels are heuristics from timing + trap type, never definitive claims.
- Uploaded audio for custom exercises stays on the device (only the exercise text syncs).

## Phase 2 ideas

- Admin area to edit tokens/timestamps of library passages; publish/unpublish
- More accents (Australian, Indian) and real recorded audio
- Generated passages targeting the learner's exact recurring confusions
- Guided speed-experiment flow (equivalent passages at 1.0/1.05/1.10/1.15/1.20)
- Optional AI-written coaching behind a service boundary (off by default)
