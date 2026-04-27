# Litmetrics — AI Legal Voice Agent

> A voice-first AI intake agent that replaces the static law firm intake form with a natural conversation. Clients speak or type their situation, the agent collects structured case data across six phases, and attorneys receive a scored case summary before the first call.

**Live:** https://lexai-agent-xr8s.onrender.com  
**Dashboard:** https://lexai-agent-xr8s.onrender.com/dashboard.html  
**Stack:** Node.js · TypeScript · Express · GPT-4o-mini · Deepgram · Tavily · Turso · Cloudflare R2 · LangSmith · Render

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Conversation Phases](#conversation-phases)
- [Guardrails](#guardrails)
- [Litmetrics Scoring](#litmetrics-scoring)
- [File Structure](#file-structure)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [REST API Reference](#rest-api-reference)
- [Prompt Engineering](#prompt-engineering)
- [Observability](#observability)
- [Privacy and Compliance](#privacy-and-compliance)
- [Known Limitations](#known-limitations)
- [Roadmap](#roadmap)

---

## Overview

Legal intake is broken for most people. When someone faces a legal problem — a car accident, a theft, a wrongful termination — most law firms hand them a PDF form. Clients abandon it. Attorneys spend the first 30 minutes of every consultation re-asking questions the form should have already captured.

Litmetrics replaces the form with a conversation. A client opens the interface, speaks or types their situation naturally, and the agent guides them through six structured phases — collecting case data, answering general legal questions via live web search, and producing a scored case summary for the attorney. The attorney dashboard surfaces liability scores, case strength, risk flags, and the full conversation transcript before the first call.

---

## Architecture

Every message the client sends runs through a deterministic 5-node pipeline. The pipeline runs on every turn without exception.

```
Client message (voice or text)
        │
        ▼
┌─────────────────────────────────────────────┐
│              5-NODE PIPELINE                │
│                                             │
│  N1 — Analyzer Prompt Creator               │
│       Reads phases/{phase}/analyzer.md      │
│       + last 20 messages + file descriptions│
│       Assembles structured extraction prompt│
│             │                               │
│             ▼                               │
│  N2 — Analyzer LLM                          │
│       GPT-4o-mini · temperature 0           │
│       response_format: json_object          │
│       Extracts phase-specific fields only   │
│             │                               │
│             ▼                               │
│  N3 — Orchestrator  (zero LLM calls)        │
│       Pure TypeScript · all business logic  │
│       · Merges extracted fields into state  │
│       · Evaluates canTransition()           │
│       · Recomputes risk flags (18 checks)   │
│       · Triggers Litmetrics scoring at      │
│         wrapup entry (set-once)             │
│             │                               │
│             ▼                               │
│  N4 — Speaker Prompt Creator                │
│       Reads phases/{phase}/speaker.md       │
│       + collectedFacts + last 14 messages   │
│       + guardrail instructions              │
│             │                               │
│             ▼                               │
│  N5 — Speaker LLM                           │
│       GPT-4o-mini · temperature 0.7         │
│       Optionally calls Tavily via           │
│       OpenAI function calling (all phases)  │
│       Generates plain prose reply           │
└─────────────────────────────────────────────┘
        │
        ▼
Session saved to Turso → reply returned to client
```

**Key design principle:** The Orchestrator (N3) contains all business logic and makes zero LLM calls. Phase transitions, risk flag computation, and Litmetrics scoring are fully deterministic and testable without any API calls.

**Two OpenAI clients are maintained:**
- `openai` — wrapped with LangSmith `wrapOpenAI()` for full observability on standard calls
- `openaiRaw` — raw, unwrapped client used exclusively for tool call follow-ups (the LangSmith wrapper does not handle `content: null` + `tool_calls` message format correctly)

---

## Conversation Phases

The agent guides clients through six phases. Phase transitions are invisible to the client — the conversation flows naturally while the Orchestrator advances phases when transition conditions are met.

| Phase | Purpose | Max Turns | Transition Condition |
|---|---|---|---|
| **intake** | Identify issue type, jurisdiction, urgency | 6 | `legalIssueType` + `jurisdiction` + `urgencyLevel` all non-empty |
| **situation** | Collect incident details, parties, timeline | 8 | `incidentSummary` + `partiesInvolved` + `timeline` + `clientRole` |
| **insurance** | Coverage type, financial exposure, affordability | 6 | `insuranceCoverageType` + `canAffordAttorney` answered |
| **witnesses** | Evidence inventory, police report status | 8 | Evidence confirmed + `policeReportFiled` set |
| **guidance** | Answer legal questions, provide resources via web search | 10 | `userSatisfied = true` or `referralAccepted` has value |
| **wrapup** | Deliver legal disclaimer, close session | 4 | `disclaimerInjected = true` (hard gate — cannot be bypassed) |

**Emergency bypass:** If `urgencyLevel === "emergency"` is detected in any early phase, the Orchestrator skips directly to guidance on the next turn.

**Passive cross-phase capture:** The intake analyzer opportunistically extracts situation-phase fields (`incidentSummary`, `incidentLocation`, `clientRole`, etc.) from a rich first message using `_passive_*` prefixed fields, even before those phases begin. This prevents the agent from re-asking for information the client has already provided.

---

## Guardrails

Six guardrails are enforced on every turn. Some are injected programmatically into the speaker prompt at the prompt creator level; others are hard-coded in the Orchestrator and cannot be overridden by the LLM.

| Guardrail | Enforcement | Behaviour |
|---|---|---|
| **US jurisdiction only** | Speaker prompt (data-driven) | Non-US location triggers a fixed denial message. Automatically unblocks if client corrects to a US state. |
| **No financial advice** | Speaker prompt (all phases) + insurance speaker | Settlement amounts, bankruptcy strategy, investment questions → fixed redirect to licensed attorney. |
| **Source citations** | Speaker prompt + Tavily result injection | Web search results must cite source title and URL inline. General knowledge responses must include a verification note. |
| **No sensitive data collection** | State schema + Orchestrator SSN guard + analyzer prompts | SSNs, dates of birth, and financial account details blocked at three independent layers. |
| **Mandatory legal disclaimer** | Orchestrator hard gate | Session cannot advance to `done` without `disclaimerInjected = true`. Not a prompt instruction — enforced in Orchestrator transition logic. |
| **No legal advice** | Speaker prompt (all phases) | No case outcome predictions, no named attorney recommendations, no statute interpretation for the client's specific situation. |

---

## Litmetrics Scoring

Scores are computed once when the session enters the wrapup phase and written with a set-once policy — never overwritten after initial computation.

| Score | Range | Description |
|---|---|---|
| `liabilityScore` | 0–100 | Legal complexity and exposure based on urgency, parties, and referral signals |
| `caseStrengthScore` | 0–100 | Evidence quality weighted by evidence count, file uploads, and police report status |
| `settlementLikelihoodScore` | 0–100 | Civil cases only — set to 0 for criminal matters |
| `statuteOfLimitationsFlag` | ok / warning / critical | Time-sensitivity indicator based on incident date and issue type |

The current scoring logic in `src/orchestrator.ts` (`computeScores()`) uses heuristic arithmetic. Replace with a dedicated LLM scoring call for production use.

---

## File Structure

```
lexai-agent/
├── src/
│   ├── pipeline.ts                  Express server — all routes + 5-node pipeline
│   ├── orchestrator.ts              Deterministic merge, scoring, risk flags (N3)
│   ├── error_recovery.ts            Phase-aware fallback messages + input validation
│   ├── test.ts                      5-layer test suite
│   └── prompts/
│       ├── analyzer_prompt_creator.ts   Builds Analyzer prompt each turn (N1)
│       ├── speaker_prompt_creator.ts    Builds Speaker prompt each turn (N4)
│       └── summary_prompt_creator.ts    Builds summarisation prompt at 20+ messages
├── phases/
│   ├── intake/
│   │   ├── analyzer.md              Extraction schema + rules for intake phase
│   │   └── speaker.md               Personality + strategy for intake phase
│   ├── situation/
│   ├── insurance/
│   ├── witnesses/
│   ├── guidance/
│   └── wrapup/
├── state/
│   └── schema.ts                    LegalAgentState type, initialState(), Phase union
├── config/
│   └── phase_registry.ts            Phase definitions, turn limits, transition conditions
├── prompts/
│   ├── analyzer_template.md         Reference: assembled analyzer prompt structure
│   ├── speaker_template.md          Reference: assembled speaker prompt structure
│   └── summary_template.md          Reference: summarisation prompt structure
├── index.html                       Client chat interface (served by Express)
├── dashboard.html                   Attorney Litmetrics dashboard
├── landing.html                     Landing page
├── CLAUDE.md                        AI collaboration context for development sessions
├── .env.example                     Environment variable template
├── package.json
└── tsconfig.json
```

---

## Environment Variables

Copy `.env.example` to `.env` and populate all values.

```bash
# Required
OPENAI_API_KEY=sk-...

# Database — Turso (libSQL cloud)
# CRITICAL: @libsql/client must be pinned to 0.4.0
# v0.5+ runs a migration job on every connection that returns 400 errors
TURSO_DATABASE_URL=libsql://your-db.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=eyJ...

# Voice — Deepgram handles both STT and TTS
DEEPGRAM_API_KEY=...

# File storage — Cloudflare R2 (S3-compatible API)
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=lexai-uploads

# Web search
TAVILY_API_KEY=tvly-...

# Observability — LangSmith
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_pt_...
LANGSMITH_PROJECT=lexai-agent
```

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Build TypeScript
npm run build

# 4. Start development server
npm run dev

# 5. Open the agent
open http://localhost:3000

# 6. Open the attorney dashboard
open http://localhost:3000/dashboard.html
```

The server auto-creates `uploads/` and `data/` directories on startup. A successful startup produces:

```
[Startup] STT: enabled | TTS: enabled | Search: enabled
[Database] Turso ready at libsql://...
[Startup] LexAI running on http://localhost:3000
```

---

## Deployment

The project is configured for zero-configuration deployment on Render.

| Setting | Value |
|---|---|
| **Build command** | `npm install && npm run build` |
| **Start command** | `node dist/src/pipeline.js` |
| **Auto-deploy** | Every push to `main` branch |
| **Deploy time** | ~90 seconds from push to live |

**Keep-alive:** The Render free tier sleeps after 15 minutes of inactivity. Configure UptimeRobot to ping `GET /health` every 5 minutes to prevent cold starts during active use.

**Regenerate Turso auth token if the database connection fails on startup:**
```bash
turso db tokens create your-db-name --expiration none
# Paste the output into Render → Environment → TURSO_AUTH_TOKEN → Save → Redeploy
```

---

## REST API Reference

### Session Management

```
POST /session
Body (optional): { "voiceMode": "chat" | "voice" }
Returns: { sessionId, currentPhase, voiceMode, createdAt }

GET /session/:sessionId
Returns: full session state including scores, transcript, risk flags, extracted facts, uploaded files

GET /sessions
Returns: array of lightweight session summaries for the attorney dashboard

DELETE /session/:sessionId
Marks session as closed
```

### Conversation

```
POST /chat
Body: { "sessionId": "uuid", "message": "user text" }
Returns: { reply, currentPhase, turnCount, riskFlags, sessionId }
```

### Voice

```
POST /voice/transcribe
Body: multipart/form-data — fields: "audio" (webm) + "sessionId"
Returns: { transcript }
Requires: DEEPGRAM_API_KEY

POST /voice/synthesise
Body: { "text": "...", "sessionId": "uuid" }
Returns: audio/mpeg stream (Deepgram Aura voice)
Requires: DEEPGRAM_API_KEY
```

### File Upload

```
POST /upload/:sessionId
Body: multipart/form-data — field: "file" (image, video, PDF — max 50MB)
Returns: { fileId, originalName, description, uploadedAt }
```

### Health Check

```
GET /health
Returns: { status, version, uptime, voiceEnabled, searchEnabled, dbUrl, timestamp }
```

---

## Prompt Engineering

Each conversation phase has two dedicated prompt files loaded from disk at runtime:

- `phases/{phase}/analyzer.md` — defines the extraction schema (fields, types, rules, fallback values) for that phase
- `phases/{phase}/speaker.md` — defines the agent's personality, question strategy, tone, guardrail handling, and mid-phase request behaviour

**Analyzer prompts** use `temperature: 0` and `response_format: json_object`. They extract only the fields relevant to the current phase. The intake analyzer additionally performs passive cross-phase capture using `_passive_*` prefixed fields that the Orchestrator maps into the correct state fields on merge.

**Speaker prompts** use `temperature: 0.7`. Each phase has a distinct personality. All phases share a universal mid-phase request handler — if a client asks for information, resources, or a lawyer recommendation at any point, the agent responds immediately rather than deferring to a later phase.

**Prompt changes deploy without code changes** — edit a `.md` file, push to GitHub, Render redeploys in ~90 seconds.

---

## Observability

LangSmith is integrated via `wrapOpenAI()` on the primary OpenAI client and `traceable()` wrapping the `runTurn()` function. Every conversation turn produces a trace with child spans for each LLM call.

**Identifying turns where Tavily search fired:** A turn where web search was triggered shows three `ChatOpenAI` child spans instead of two. The second span's output shows `finish_reason: tool_calls` confirming the model chose to search. The third span's input contains the `role: tool` message with raw Tavily results.

**Note:** Tool call follow-up requests are routed through `openaiRaw` (unwrapped) to avoid a compatibility issue between the LangSmith wrapper and the `content: null` + `tool_calls` message format. These calls are not traced individually but their context is visible in the third span's input.

---

## Privacy and Compliance

- SSNs, dates of birth, and financial account numbers are never collected. Blocked at three independent layers: state schema, Orchestrator merge guard, and analyzer prompt rules.
- The legal disclaimer is mandatory in every session. The wrapup phase transition is gated on `disclaimerInjected = true` in the Orchestrator — this cannot be bypassed by the LLM.
- All client-facing error messages are safe for display. No stack traces or internal details are ever returned to the client.
- Litmetrics scores are heuristic MVP values and should not be used as legal assessments without attorney review.
- Disclaimer language should be reviewed by qualified legal counsel before production deployment.
- This agent supports US federal law and the law of US states only. US territories (Puerto Rico, Guam, US Virgin Islands) are supported.

---

## Known Limitations

| Issue | Root Cause | Planned Fix |
|---|---|---|
| Agent occasionally asks too many clarifying questions | GPT-4o-mini instruction-following degrades under conversational pressure | Upgrade Speaker LLM to GPT-4o in guidance phase |
| Tavily search may fail on consecutive calls in one session | Free tier rate limiting | Retry logic with exponential backoff + graceful degradation |
| Litmetrics scores are heuristic | `computeScores()` uses arithmetic, not reasoning | Replace with dedicated LLM scoring call |
| No cross-session memory | Each session starts fresh | RAG-based client memory store planned |

---

## Roadmap

- **Attorney notification** — email or webhook trigger when `referralAccepted = true`
- **Document RAG** — chunk uploaded PDFs, embed, retrieve relevant clauses into guidance phase context
- **LLM-as-judge scoring** — replace heuristic `computeScores()` with a reasoning-based LLM call
- **GPT-4o upgrade** — Speaker LLM upgrade in guidance phase for stronger instruction-following
- **White-label plugin** — embeddable script tag for any law firm website with per-firm branding and CRM webhook on session completion
- **Cross-session client memory** — associate client identifier with vector store; surface prior session facts at session start

---

## About

Built as a final project for **MGMT 59000 — Emerging Technologies & Business** at Purdue University (Prof. Rohit Aggarwal, April 2026).

The system architecture was developed using Claude Skill Files — specialised instruction documents for each component of the system that maintained architectural consistency across the full build. The five-node pipeline design, deterministic Orchestrator pattern, and phase-based prompt engineering approach were all defined upfront via skill files before any code was generated.
