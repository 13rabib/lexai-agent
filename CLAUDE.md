# LexAI Agent — CLAUDE.md

## What This Project Does

LexAI is a legal intake AI agent that conducts structured intake conversations with potential legal clients. It collects case facts across six sequential phases (intake → situation → insurance → witnesses → guidance → wrapup), computes Litmetrics scores (liability, case strength, settlement likelihood), and surfaces risk flags for a dashboard. It supports both text (chat) and voice modes.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript |
| Web framework | Express |
| LLM | OpenAI GPT-4o-mini (analyzer, speaker, vision, summariser) |
| Database | Turso (libSQL/SQLite); falls back to `file:data/lexai.db` |
| File storage | Local `./uploads/` or Cloudflare R2 |
| STT | Deepgram (nova-2) — optional |
| TTS | ElevenLabs (eleven_turbo_v2) — optional |
| Web search | Tavily — optional, guidance + situation phases only |
| Observability | LangSmith (optional) |
| Build | `tsc`, `ts-node-dev` for dev hot-reload |

---

## Architecture — 5-Node Pipeline

Every user message passes through this pipeline in order:

```
User message
  → [Node 1] Analyzer Prompt Creator   (assemble extraction prompt)
  → [Node 2] Analyzer LLM              (temp=0, json_object, max 512 tokens)
  → [Node 3] Orchestrator              (PURE: merge, score, phase transitions — zero LLM calls)
  → [Node 4] Speaker Prompt Creator    (assemble reply prompt)
  → [Node 5] Speaker LLM              (temp=0.7, text, max 256 voice / 1024 chat)
  → State saved to Turso
```

**The Orchestrator (`src/orchestrator.ts`) is the core.** It is deterministic, has no I/O, and is fully unit-testable. All LLM calls live in `pipeline.ts`.

### Conversation Phases

| Phase | Max Turns | Completion Condition |
|-------|-----------|---------------------|
| intake | 6 | legalIssueType + jurisdiction + urgencyLevel set |
| situation | 8 | incidentSummary + ≥1 party + timeline + clientRole |
| insurance | 6 | insuranceCoverageType + canAffordAttorney |
| witnesses | 8 | (≥1 evidence OR ≥1 witness) + policeReportFiled not null |
| guidance | 10 | userSatisfied not null OR (referralNeeded=true + referralAccepted not null) |
| wrapup | 4 | disclaimerInjected = true |
| done | — | terminal |

**Emergency bypass**: if `urgencyLevel === "emergency"` in a bypassable phase (intake, situation, insurance, witnesses), the conversation jumps directly to `guidance`.

---

## Key Files & Folders

```
state/schema.ts                   LegalAgentState interface + initialState() + helpers
config/phase_registry.ts          Phase rules, maxTurns, canTransition(), next phase
src/orchestrator.ts               Merge, risk flags, scoring, phase transitions (PURE)
src/pipeline.ts                   Express server, REST endpoints, runTurn()
src/error_recovery.ts             Fallback replies, file validation, error messages
src/prompts/
  analyzer_prompt_creator.ts      Builds Analyzer LLM prompt
  speaker_prompt_creator.ts       Builds Speaker LLM prompt (facts, flags, tool use)
  summary_prompt_creator.ts       Builds summarisation prompt (20+ turns)
phases/{phase}/analyzer.md        Per-phase extraction rules and JSON schema
phases/{phase}/speaker.md         Per-phase personality, strategy, transition signals
src/test.ts                       5-layer test suite
index.html                        Web UI (chat, file upload, voice controls, progress bar)
.env.example                      All environment variables with descriptions
```

---

## How to Run / Build / Test

### Setup

```bash
npm install
cp .env.example .env
# Edit .env — only OPENAI_API_KEY is required for basic operation
```

### Development

```bash
npm run dev        # ts-node-dev with hot-reload, serves on localhost:3000
```

### Production

```bash
npm run build      # tsc → dist/
npm run start      # node dist/src/pipeline.js
```

### Testing

```bash
npm run test:unit  # Layers 1–3 — no LLM calls, no DB required
npm run test:e2e   # Layers 4–5 — needs OPENAI_API_KEY + running server
npm test           # All 5 layers
```

Layer breakdown:
- **1** — Schema validation (initialState, helpers)
- **2** — Orchestrator unit tests (merges, transitions, scoring, flags)
- **3** — Error recovery unit tests (fallbacks, MIME validation, SSN rejection)
- **4** — End-to-end pipeline (real LLM, real orchestration)
- **5** — API smoke tests (requires server running on port 3000)

---

## REST API

```
POST /session                  Create session  { voiceMode?: "chat"|"voice" }
POST /chat                     Send message    { sessionId, message }
POST /upload/:sessionId        Upload file     multipart/form-data, field "file"
GET  /session/:sessionId       Get full state (includes Litmetrics payload)
GET  /sessions                 List all session summaries
DELETE /session/:sessionId     Close session
POST /voice/transcribe         STT: multipart/form-data { audio, sessionId }
POST /voice/synthesise         TTS: { text, sessionId }
GET  /health                   Health check
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes | Analyzer, speaker, vision, summariser LLMs |
| `DEEPGRAM_API_KEY` | No | Speech-to-text |
| `ELEVENLABS_API_KEY` | No | Text-to-speech |
| `ELEVENLABS_VOICE_ID` | No | Defaults to Rachel voice |
| `TAVILY_API_KEY` | No | Web search (guidance + situation phases) |
| `TURSO_DATABASE_URL` | No | Turso cloud DB; falls back to `file:data/lexai.db` |
| `TURSO_AUTH_TOKEN` | No | Turso auth token |
| `R2_ACCOUNT_ID` | No | Cloudflare R2 (falls back to local `./uploads/`) |
| `R2_ACCESS_KEY_ID` | No | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | No | Cloudflare R2 |
| `R2_BUCKET_NAME` | No | Cloudflare R2 |
| `PORT` | No | Default 3000 |

---

## State Schema Highlights

State is one large `LegalAgentState` object serialised as JSON in Turso. Key invariants:

- `turnCount` **always increments by exactly 1** per `orchestrate()` call, never decreases
- `phaseTurnCount` **resets to 0** on every phase transition
- `riskFlags` is **recomputed from scratch** every turn (never appended)
- Litmetrics scores (`liabilityScore`, `caseStrengthScore`, `settlementLikelihoodScore`, `extractedFacts`) are **set-once** on wrapup entry — never updated again
- `disclaimerInjected` is **set-once** after the mandatory legal disclaimer is acknowledged
- **No SSN/DOB fields exist** in schema; the orchestrator also rejects `XXX-XX-XXXX` patterns and 9-digit strings at merge time

---

## Gotchas & Conventions

1. **Phase-scoped merge**: The orchestrator only touches fields belonging to the current phase. If the analyzer returns wrong-phase fields, they are silently ignored. This is intentional — it prevents LLM hallucinations from poisoning state.

2. **Speaker fallback doesn't advance the turn**: If the speaker LLM fails, `phaseTurnCount` is decremented by 1 so the user gets a free retry without burning a phase turn.

3. **Conversation compression**: Analyzer sees the last 6 messages; speaker sees the last 8. After 20 messages, a summarisation LLM compresses earlier turns into `conversationSummary`, which is injected into the speaker prompt.

4. **Web search is in-turn**: If the speaker LLM returns a `web_search` tool call, Tavily is queried and results are fed back to the speaker LLM in the **same turn** (not a new API request from the client).

5. **Emergency bypass goes to guidance, not wrapup**: High-urgency cases skip straight to the legal guidance phase where a referral offer is made — they don't skip the disclaimer.

6. **Phase instructions live in markdown files**: `phases/{phase}/analyzer.md` and `phases/{phase}/speaker.md` are loaded at runtime. To change how a phase behaves, edit those files — not TypeScript.

7. **Litmetrics scoring is heuristic**: `computeScores()` in `orchestrator.ts` uses weighted additive formulas (not LLM calls). Scores are clamped 0–100.

8. **`canTransition()` is soft; `maxTurns` is hard**: If the completion conditions aren't met, the phase continues — but at `maxTurns` the phase advances regardless to prevent infinite loops.

9. **File uploads**: Images are auto-described by GPT-4o-mini vision and stored in `uploadedFiles`. Videos get only filename + size. The description is included in subsequent speaker prompts as context.

10. **LangSmith tracing**: `runTurn()` is wrapped in a LangSmith traceable if `LANGCHAIN_API_KEY` is set; otherwise it runs normally. No code changes needed to enable/disable.
