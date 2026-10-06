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
| Content | **28 human-voice items**: excerpts of Spoken Wikipedia recordings (real readers, varied accents, CC BY-SA), word-timed with Whisper, swaps written by hand · plus 34 original passages voiced with Kokoro TTS. Mismatch counts vary 0–7 per item. No Pearson material |
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

## Deploy (Cloudflare)

Live: **https://hiw-trainer.hiw-trainer.workers.dev**

The app is a static site served by Cloudflare's static-assets hosting (the successor to Pages);
[`wrangler.jsonc`](wrangler.jsonc) points it at `dist/` with single-page-app fallback. There is no server code.

```bash
npx wrangler login   # once
npm run deploy       # build + upload
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are baked in at build time from `.env.local`, so deploy
from a machine that has it. Any static host works (Vercel, Netlify) with an SPA fallback to `/index.html`.

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

## Human-voice items (Spoken Wikipedia)

Real HIW recordings are people reading academic text, so the realistic and exam slots prefer these.

```bash
.venv-tts/bin/pip install faster-whisper
npm run human:fetch   # download recordings (politely, one at a time), transcribe, propose excerpts
npm run human:build   # cut clips + apply content/human/items.json → library.json
```

`fetch` writes `content/human/candidates.json`: sentence-aligned 18–45 s excerpts with word timings,
the spoken intro skipped, low-confidence words flagged. Swaps are then written by hand in
[`content/human/items.json`](content/human/items.json); each swap names the word it replaces (`from`) and
the build fails if it doesn't match. Excerpts with transcription errors that couldn't be verified against
the article text were not used, since a mis-transcribed word would show the learner an accidental mismatch.

Licence: the recordings are CC BY-SA; each exercise carries its reader, licence and source link, shown on its
results page. The cut clips are adaptations and remain CC BY-SA.

## Content pipeline (synthetic passages)

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
- Human-voice word timings come from Whisper's alignment; synthetic ones from Kokoro's. Both are machine-checked for order and plausible durations, not hand-verified by ear.
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
