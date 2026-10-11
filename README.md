# Lana

**Agency performance command center for insurance agencies** — agent
leaderboards, sales submission, a dialer portal, AI call scoring, and an admin
portal for approvals and reporting.

Original implementation. No build step: the frontend is plain ES modules that
run straight from the filesystem or any static host.

```
lana/
├─ supabase/
│  ├─ schema.sql            tables, RLS policies, RPCs, seed products
│  ├─ 002_dialer.sql        dialer portal: call tallies, appointments, targets
│  ├─ 003_call_scoring.sql  recordings, scores, audio bucket, scorecard RPCs
│  └─ functions/
│     ├─ score-call/        Edge Function: transcript → Claude → scores
│     │  ├─ index.ts
│     │  └─ rubric.ts       ← the rubric; also the cached prompt prefix
│     ├─ score-scorecard/   Edge Function: transcript → Claude → pass/fail scorecard
│     │                     (needs 035_scorecards.sql; separate from score-call)
│     └─ transcribe-call/   Edge Function: audio → transcript (optional)
└─ public/
   ├─ index.html
   ├─ css/app.css
   └─ js/
      ├─ config.js          ← the only file you edit to get running
      ├─ db.js              all data access; RLS-aware
      ├─ ui.js              formatting + chart primitives
      ├─ views-agent.js     dashboard, log a sale, my sales, appointments, leaderboard
      ├─ views-dialer.js    dialer dashboard, log activity, appointment book, board
      ├─ views-scoring.js   call reviews, score detail, admin scorecard
      ├─ views-admin.js     agents, submissions, dialer activity, reports
      └─ app.js             boot, auth gate, role-based router
```

## Roles

| Role | Sees |
|---|---|
| `agent` | Dashboard, Log a sale, My sales, My appointments, Leaderboard |
| `dialer` | Dialer dashboard, Log activity, Appointment book, Dialer board |
| `admin` | Everything, plus Agents, Submissions, Dialer activity, Reports |

`roles` on each route in `app.js` decides what renders and what shows in the
nav — but that is convenience, not security. RLS is the enforcement; a dialer
who types an admin URL gets bounced by the router *and* an empty result from
Postgres.

## Setup

**1. Create a Supabase project** at supabase.com (the free tier is fine).

**2. Run the schema.** Open the SQL Editor and run `supabase/schema.sql`, then
`supabase/002_dialer.sql`, then `supabase/003_call_scoring.sql`. In that order —
each later file references helpers from the first. All are re-runnable, so a
second run is harmless.

Call scoring also needs the two Edge Functions deployed — see **Call scoring**
below. Skip that section entirely and everything else still works; the Call
reviews page just can't score.

**3. Fill in `public/js/config.js`** with the Project URL and the **anon** key
from Project Settings → API.

> The anon key belongs in client code — it is not a secret, and every table is
> behind row level security. The **service role** key is a different thing
> entirely: it bypasses RLS. It must never appear in this folder.

**4. Serve `public/`.** Any static server works; ES modules will not load over
`file://`.

```
python -m http.server 5173 --directory C:\Users\ryan\lana\public
```

Then open `http://localhost:5173`.

**5. Create the first account.** Click *Create one* and sign up. **The first
account to sign up becomes the admin** — that rule is in the `handle_new_user`
trigger, so make sure the first signup is yours. Everyone after defaults to
`agent`, and you promote them from the Agents page.

If Supabase has email confirmation on (Authentication → Providers → Email), the
signup will ask you to confirm before signing in. Turn it off there for faster
testing.

## Deploying

The `public/` folder is the whole site — no build, no `npm install`.

**Cloudflare Pages** (dashboard → Workers & Pages → Create → Pages → connect a
Git repo): set build command **empty** and output directory `public`. Because
nothing has to run locally, this sidesteps the wrangler/Node problems on the
Windows box — the build happens on Cloudflare's side, or not at all.

Netlify and Vercel work the same way: no build command, publish `public`.

## How the numbers work

- **Daily AP** — annualized premium submitted today, in `America/Chicago`.
- **Month AP** — month-to-date total.
- **Pace** — month AP projected to month end using **business days**, not
  calendar days: `month_ap / business_days_elapsed × business_days_in_month`.
  A month holds 20–23 selling days, so calendar-day math understates pace every
  weekend. The tile prints the divisor (`4 of 22 selling days`) because early in
  a month the projection is extremely noisy and should not read as a forecast.
- **Leaderboard / metrics** count `pending` + `approved`, and exclude `rejected`
  and `chargeback`.
- **Targets** are per agent per month, set on the Agents page, and drive the
  meter on the Month AP tile.

### Dialer metrics

There is no per-call table, on purpose. A dialer places 150–250 calls a day;
hand-entering a row per dial guarantees the data never gets logged. So volume
is a **daily tally** — one editable row per dialer per day, backed by a unique
index so saving twice corrects the day rather than doubling it — and only
**appointments**, the events that carry money, get individual records.

- **`set_on` vs `scheduled_at`** — `set_on` is the date the appointment was
  *booked*; `scheduled_at` is when it happens. Dialer productivity is measured
  on `set_on`, because crediting a booking to a future date leaves today's
  board empty.
- **Contact rate** = contacts ÷ dials · **Set rate** = appointments ÷ contacts
- **Held rate** = (held + sold) ÷ resolved · **Close rate** = sold ÷ (held + sold)
- Rates come back as **fractions, and `null` when the denominator is zero**.
  "No dials yet" and "a 0% contact rate" are different facts, and the tiles
  render the first as `—`. If you add a rate, keep that — a zero there reads as
  a performance problem that isn't real.
- `contacts <= dials` is a **database check constraint**, not just a form
  validation. Without it one fat-fingered entry produces a contact rate over
  100% and every downstream rate is garbage.

Timezone lives in three places — `TIMEZONE` in `config.js` and the
`America/Chicago` literals in `schema.sql` and `002_dialer.sql`. Change all
three together or "today" will mean different days in the browser and the
database.

## Call scoring

A transcript goes to Claude with a fixed rubric; back comes a structured score
per dimension, plus compliance findings with evidence quotes.

### Why it runs server-side

**The Anthropic key cannot go in `config.js`.** The frontend ships with the
Supabase anon key, and anything sitting beside it is published. So the model
call lives in the `score-call` Edge Function, which is also the **only writer**
to `call_scores` — that table has no insert policy, so an agent cannot grade
their own call.

The function uses two Supabase clients deliberately:

| Client | Key | Job |
|---|---|---|
| `userClient` | caller's JWT | Reads the recording **through RLS** — this is the authorization check |
| `serviceClient` | service role | Writes the score, bypassing RLS |

Doing the read with the service client would let any signed-in user score any
call in the org. If you edit the function, keep the read on `userClient`.

### Deploy

```
supabase functions deploy score-call
supabase functions deploy transcribe-call     # only if you want auto-transcription

supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set DEEPGRAM_API_KEY=...     # optional
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — don't set them yourself.

> The Supabase CLI runs on Node. If it trips the antivirus on this machine the
> way wrangler did, deploy the functions from the Supabase dashboard
> (Edge Functions → Deploy) or from CI instead.

Optional overrides: `SCORING_MODEL` (default `claude-opus-5`), `SCORING_EFFORT`
(default `high`), `MAX_TRANSCRIPT_CHARS` (default 200,000), `ALLOWED_ORIGIN`
(default `*` — set it to your deployed origin).

### Medicare scorecard (`score-scorecard`)

A second instrument beside the rubric score: a pass/fail compliance checklist.
Needs `035_scorecards.sql` and its own deploy (`supabase functions deploy
score-scorecard`); it reuses `ANTHROPIC_API_KEY`.

It grades from the "Grade against scorecard" button on any call. To grade
Medicare calls automatically, add a Database Webhook (Dashboard → Database →
Webhooks) on `call_recordings`, events **Insert + Update**, type Supabase Edge
Function → `score-scorecard`, timeout at the maximum. The function ignores
everything except a call with call type Medicare arriving at `transcribed` for
the first time with no grade yet. `AUTO_SCORECARD=off` stops the automatic path
without removing the webhook.

### Transcription

**Claude has no audio input**, so scoring needs text. Two paths, and the first
one works with nothing extra installed:

1. **Paste a transcript** — always available, no second vendor, no extra cost.
2. **Upload audio → `transcribe-call`** — needs `DEEPGRAM_API_KEY`. Without the
   key the function returns a clear error and path 1 still works.

Swapping providers means replacing the `transcribe()` function in
`transcribe-call/index.ts`. Its whole contract is: signed URL in, plain text
out.

Transcripts are requested **diarized** (`Speaker 0:` / `Speaker 1:` lines). The
rubric grades the agent, not the prospect — an undiarized wall of text makes
every dimension guesswork.

### The rubric is the cached prefix

`rubric.ts` is the system prompt, and it carries the `cache_control`
breakpoint. Render order is tools → system → messages, so the rubric caches and
the transcript (which changes every call) sits after it.

**That means nothing per-call may go in that file.** Interpolating the agent's
name or today's date into the system prompt gives every request its own cache
entry and nothing is ever read — the cache silently stops working, with no
error. Verify with `usage.cache_read_input_tokens` on the second call; the
Scorecard surfaces the running total.

Bump `RUBRIC_VERSION` whenever you edit the text. It's stored on every score row
so old scores stay interpretable, and it's your signal that the cache is about
to be written fresh once.

### Two API constraints worth knowing

**Structured outputs can't express numeric ranges.** JSON Schema `minimum` /
`maximum` aren't supported, so "0–100" lives in the prompt text and the function
clamps on the way in. Same for string lengths. If you add a bounded field,
enforce it in `index.ts` — the schema won't.

**Thinking counts against `max_tokens`.** Thinking is on by default on Claude
Opus 5, and `max_tokens` caps reasoning *plus* output together. The function
sets 16,000 for that reason. A `max_tokens` stop reason is treated as a failure
rather than parsed, because a truncated JSON body would otherwise deserialize
into a plausible-looking wrong score.

The function also checks `stop_reason` **before** reading content — Opus 5's
safety classifiers can decline a request, and indexing `content[0]` blind throws
on a refusal. Server-side fallbacks are enabled (`fallbacks: "default"`), so a
declined request is re-run on Anthropic's recommended substitute inside the same
call rather than just failing.

### Cost

Claude Opus 5 lists at $5 / $25 per million input / output tokens. A 20-minute
call is roughly 4–5k transcript tokens against a ~1.5k-token cached rubric, with
reasoning and output on top — **order of $0.10–0.20 per call**, and the cached
rubric bills at ~10% of input rate after the first call of each 5-minute window.

Every score row stores its own token counts and computed `cost_usd`, and the
admin Scorecard totals them. Watch real numbers for a week before assuming any
estimate, including this one.

If it's too expensive, the levers in order: drop `SCORING_EFFORT` to `medium`,
then score a sample rather than every call, then set `SCORING_MODEL` to
`claude-sonnet-5` (and update the `PRICING` table in `index.ts` to match, or
your cost reporting will be confidently wrong).

### What the scores are for

They're coaching signal, not adjudication. The UI says so on every score page.
Read the evidence quotes before acting on a compliance finding — the model is
scoring an imperfect transcript, and a garbled line can look like a violation.
Nothing here is a substitute for a compliance review.

## Security model

RLS is on for every table.

| Table | Agent | Admin |
|---|---|---|
| `profiles` | read own; rename self | read/write all |
| `submissions` | read own; insert own as `pending`; edit/delete own while pending | read/write all |
| `goals` | read own | read/write all |
| `teams`, `products` | read | read/write |
| `call_sessions` | dialer: read/write own | read/write all |
| `appointments` | dialer: read/write own · agent: read + update ones booked **for** them | read/write all |
| `dialer_goals` | read own | read/write all |
| `call_recordings` | read/write ones you're on or uploaded | read/write all |
| `call_scores` | **read only** — no client can write | read/write all |
| `call-recordings` bucket | read/write objects under your own UUID prefix | all objects |

The appointment policy is split deliberately: the dialer owns the record, but
the agent it was booked for can resolve the status, because they are the only
person who actually knows whether it held.

Two things worth knowing about the implementation:

**`is_admin()` is `SECURITY DEFINER` on purpose.** A policy on `profiles` that
reads `profiles` to check the caller's role recurses infinitely and Postgres
aborts the query. Reading the role through a definer function breaks the cycle.

**The leaderboard is an RPC, not a table read.** Agents must see everyone's
totals but must not read each other's submission rows, so `leaderboard()` is
`SECURITY DEFINER` and returns aggregates only.

### The empty-array trap

Under RLS a blocked read is **not** an error. Postgres filters the rows and
returns `200` with `[]`. A dashboard that trusts that renders a confident zero:
the leaderboard looks empty, month AP reads `$0`, and nothing says "you are not
allowed to see this."

Every query in `db.js` therefore runs behind `requireSession()`, which throws
`NotSignedIn` rather than letting an unauthenticated empty array reach the UI,
and `app.js` turns that into the login screen. If you add a query, add it in
`db.js` and keep that guard — a raw `supabase.from(...)` call at a call site is
how a silent zero gets back in.

## Brand

**Name:** Lana. **Mark:** a rounded tile with an `L` whose lower arm turns
upward — it reads as the letter and as a trend line. It lives inline in
`index.html` as SVG (no image files, nothing to 404) and inherits `color` for
its tile fill, so one token drives both themes.

| Role | Light | Dark |
|---|---|---|
| `--brand` | `#4a3aa7` | `#a89ff0` |
| `--brand-ink` (label **on** brand) | `#ffffff` (8.6:1) | `#0b0b0b` (8.3:1) |

**The brand color is chrome only.** It appears on the mark, primary buttons,
active-nav edge, focus rings, and toast accents — never inside a chart. That
separation is load-bearing: if the brand accent looks like a series color,
people can't tell decoration from data.

Keeping them apart took two attempts. Violet at the series lightness step
(`#9085e9`) failed against the chart blue — ΔE 1.9 under protan, 9.8 for normal
vision. Magenta failed against orange (11.6) and against green under deutan
(1.6). The categorical hues already crowd the wheel, so hunting for a free hue
was the wrong approach.

**The fix was lightness, not hue.** Series marks sit in a tight band — OKLab L
≈ 0.62 in dark, 0.58–0.67 in light. The brand steps are deliberately outside
it: L 0.741 in dark (above the band), L 0.433 in light (below it). A brand
element can't be mistaken for a data mark because it is visibly a different
weight, whatever the hue does.

If you re-skin this, hold any replacement to the same two bars: **outside the
series lightness band**, and **≥4.5:1 against its own label color**. Check the
second one before shipping a colored button — several otherwise-nice violets
fail it.

## Palette

Chart colors are validated, not chosen by eye — both modes pass the lightness
band, chroma floor, CVD separation, normal-vision floor, and contrast checks.

| Role | Light | Dark |
|---|---|---|
| MAPD | `#2a78d6` | `#3987e5` |
| Ancillary | `#eb6834` | `#d95926` |
| Combined | `#1baf7a` | `#199e70` |

Status colors are reserved and never reused as a series: good `#0ca30c`,
warning `#fab219`, serious `#ec835a`, critical `#d03b3b`. They always ship an
icon **and** a word, so state never rides on color alone.

Three rules to preserve if you extend the charts:

- **Every bar carries a visible value label.** In light mode the aqua sits below
  3:1 against the surface, so the direct label is the required relief, not
  decoration.
- **Color follows the entity, not its rank** — filtering the leaderboard must
  not repaint the survivors.
- **Category is categorical, team is sequential.** Teams are a magnitude
  comparison where identity is irrelevant, so they share one hue. Adding a
  fourth *categorical* slot puts yellow next to orange, which fails the CVD
  floor; fold a 4th category into "Other" or facet it instead.
- **The dialer funnel is an ordinal ramp, not four categories.** Dials →
  contacts → appointments → sold are four stages of one quantity, so they step
  one hue darker (`--seq-300` → `--seq-600`). Four categorical colors would
  imply the stages are unrelated. The ramp is bounded at those ends because
  lighter than step 250 fails contrast on the light surface and darker than 600
  fails it on the dark one.

## Not built yet

Deliberately out of scope for this first version:

- **GoHighLevel integration** — no CRM sync. This is also what would replace
  the manual daily tally with real dial counts, and would pull call recordings
  in automatically instead of by hand.
- **Async scoring queue** — `score-call` runs synchronously inside one HTTP
  request. Fine for one-at-a-time review; a nightly batch over every call would
  need a queue and a webhook, since Edge Functions have a wall-clock limit.
- **`duration_seconds` is never populated** — the column exists and the UI
  renders it, but nothing measures audio length on upload.
- **Notifications** — no in-app or email alerts.
- **Chargeback accounting** — a chargeback drops AP out of the totals but does
  not claw back a prior period.
- **Appointment → submission link** — `appointments.submission_id` exists in the
  schema and is never populated. Wiring it would turn the dialer close rate from
  a self-reported `sold` status into something reconciled against actual AP.
- **Dialer activity history** — `mySessions()` and `allSessions()` are in
  `db.js` with no view behind them yet; they are what a "past days" table would
  read from.
