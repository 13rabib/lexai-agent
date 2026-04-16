// =============================================================================
// src/pipeline.ts — LexAI Legal Intake Agent (Turso + LangSmith + Tavily)
// =============================================================================

import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { createClient } from "@libsql/client";
import OpenAI from "openai";
import { wrapOpenAI } from "langsmith/wrappers";
import { traceable } from "langsmith/traceable";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import FormData from "form-data";
import fetch from "node-fetch";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { initialState, type LegalAgentState, type VoiceMode } from "../state/schema";
import { orchestrate } from "./orchestrator";
import { buildAnalyzerPrompt, ANALYZER_LLM_CONFIG, parseAnalyzerResponse } from "./prompts/analyzer_prompt_creator";
import { buildSpeakerPrompt, getSpeakerLLMConfig } from "./prompts/speaker_prompt_creator";
import { shouldSummarise, buildSummaryPrompt, SUMMARY_LLM_CONFIG, parseSummaryResponse } from "./prompts/summary_prompt_creator";
import { getSpeakerFallbackReply, validateUploadedFile, getFileUploadError, getFileAnalysisFallbackDescription, getDatabaseError, SESSION_NOT_FOUND_RESPONSE, getSTTError, getTTSError, PIPELINE_ERROR, RATE_LIMIT_ERROR, logError, logWarn, logInfo } from "./error_recovery";

const PORT                = parseInt(process.env.PORT ?? "3000", 10);
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY ?? "";
const DEEPGRAM_API_KEY    = process.env.DEEPGRAM_API_KEY ?? "";
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY ?? "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
const TAVILY_API_KEY      = process.env.TAVILY_API_KEY ?? "";
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const DATA_DIR    = path.resolve(process.cwd(), "data");
const DB_PATH     = path.join(DATA_DIR, "lexai.db");

if (!OPENAI_API_KEY) { console.error("FATAL: OPENAI_API_KEY is not set."); process.exit(1); }

for (const dir of [UPLOADS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); logInfo("[Startup]", `Created: ${dir}`); }
}

// ── Turso ─────────────────────────────────────────────────────────────────
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL ?? `file:${DB_PATH}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb(): Promise<void> {
  await turso.execute(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  logInfo("[Database]", `Turso ready at ${process.env.TURSO_DATABASE_URL ?? DB_PATH}`);
}

async function dbGetSession(sessionId: string): Promise<LegalAgentState | null> {
  const result = await turso.execute({ sql: "SELECT state_json FROM sessions WHERE session_id = ?", args: [sessionId] });
  if (result.rows.length === 0) return null;
  try { return JSON.parse(result.rows[0].state_json as string) as LegalAgentState; }
  catch { logError("[Database]", `Failed to parse state for session ${sessionId}`); return null; }
}

async function dbSaveSession(state: LegalAgentState): Promise<void> {
  await turso.execute({
    sql: `INSERT INTO sessions (session_id, state_json, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    args: [state.sessionId, JSON.stringify(state), state.createdAt, state.updatedAt],
  });
}

async function dbListSessions() {
  const result = await turso.execute("SELECT state_json FROM sessions ORDER BY updated_at DESC");
  return result.rows.flatMap((row) => {
    try {
      const s = JSON.parse(row.state_json as string) as LegalAgentState;
      return [{ sessionId: s.sessionId, currentPhase: s.currentPhase, turnCount: s.turnCount, legalIssueType: s.legalIssueType, jurisdiction: s.jurisdiction, urgencyLevel: s.urgencyLevel, riskFlags: s.riskFlags, liabilityScore: s.liabilityScore, caseStrengthScore: s.caseStrengthScore, createdAt: s.createdAt, updatedAt: s.updatedAt }];
    } catch { return []; }
  });
}

// ── OpenAI ────────────────────────────────────────────────────────────────
const openai = wrapOpenAI(new OpenAI({ apiKey: OPENAI_API_KEY }));

// ── R2 ────────────────────────────────────────────────────────────────────
const r2 = process.env.R2_ACCOUNT_ID ? new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
}) : null;

// ── Tavily web search ─────────────────────────────────────────────────────
async function tavilySearch(query: string): Promise<string> {
  if (!TAVILY_API_KEY) return "";
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: 4,
        search_depth: "basic",
        include_answer: true,
      }),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}`);
    const data = await res.json() as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string }>;
    };
    const parts: string[] = [];
    if (data.answer) parts.push(`Summary: ${data.answer}`);
    if (data.results) {
      data.results.slice(0, 3).forEach(r => {
        // Include title, URL, and content so the LLM can cite sources in its reply
        parts.push(`---\nSource title: ${r.title}\nSource URL: ${r.url}\nContent: ${r.content.substring(0, 400)}`);
      });
    }
    // Append citation instruction to every search result block
    parts.push("---\nIMPORTANT: When using any of the above information in your reply, you MUST cite the source title and URL inline. Format: state the information, then add (Source: [title] — [url]).");
    return parts.join("\n");
  } catch (err) {
    logWarn("[Search]", `Tavily failed: ${(err as Error).message}`);
    return "";
  }
}

// Tool definition for OpenAI function calling
const WEB_SEARCH_TOOL: OpenAI.Chat.ChatCompletionTool[] = [{
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current US legal information, US lawyer directories, US court contacts, US police department numbers, US victim assistance programs, US filing fees, US statutes of limitations, or any real-world US-based information the client is asking for. Only search for information relevant to US federal law or the law of a US state. Do not search for legal frameworks, guidelines, or resources from any other country.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query — be specific and include location when relevant" }
      },
      required: ["query"]
    }
  }
}];

// ── Multer ────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, UPLOADS_DIR),
  filename: (_r, _f, cb) => cb(null, `${uuidv4()}-${Date.now()}`)
});
const upload = multer({ storage, limits: { fileSize: 52 * 1024 * 1024 }, fileFilter: (_r, _f, cb) => cb(null, true) });

// ── runTurn ───────────────────────────────────────────────────────────────
export const runTurn = traceable(async function runTurn(state: LegalAgentState): Promise<LegalAgentState> {
  const sessionId = state.sessionId;
  const phase     = state.currentPhase;

  // Node 1+2: Analyzer
  let analyzerOutput: Record<string, unknown> = {};
  try {
    const r = await openai.chat.completions.create({
      ...ANALYZER_LLM_CONFIG,
      messages: [{ role: "user", content: buildAnalyzerPrompt(state) }]
    });
    analyzerOutput = parseAnalyzerResponse(r.choices[0]?.message?.content ?? "");
  } catch (err) { logWarn("[Analyzer]", `Empty output turn ${state.turnCount}: ${(err as Error).message}`); }

  // Node 3: Orchestrator
  const updates = orchestrate(state, analyzerOutput);
  let ws: LegalAgentState = { ...state, ...updates };

  // Optional summarisation
  if (shouldSummarise(ws)) {
    try {
      const sr = await openai.chat.completions.create({
        ...SUMMARY_LLM_CONFIG,
        messages: [{ role: "user", content: buildSummaryPrompt(ws) }]
      });
      const summary = parseSummaryResponse(sr.choices[0]?.message?.content ?? "");
      if (summary) { ws = { ...ws, conversationSummary: summary }; logInfo("[Summary]", `Generated for ${sessionId}`); }
    } catch (err) { logWarn("[Summary]", `Failed: ${(err as Error).message}`); }
  }

  // Node 4+5: Speaker with optional web search
  let reply = "";
  let speakerFailed = false;

  try {
    const sc = getSpeakerLLMConfig(state.voiceMode);
    const speakerPrompt = buildSpeakerPrompt(ws);

    // Only offer search tool in guidance phase and if Tavily is configured
    const useSearch = TAVILY_API_KEY && ["guidance", "situation"].includes(ws.currentPhase);
    const tools = useSearch ? WEB_SEARCH_TOOL : undefined;

    type Msg = OpenAI.Chat.ChatCompletionMessageParam;
    const messages: Msg[] = [{ role: "user", content: speakerPrompt }];

    const sr = await openai.chat.completions.create({
      ...sc,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    });

    const choice = sr.choices[0];

    // Check if the model wants to search
    if (choice?.finish_reason === "tool_calls" && choice.message.tool_calls?.[0]) {
      const toolCall  = choice.message.tool_calls[0];
      const args      = JSON.parse(toolCall.function.arguments) as { query: string };
      logInfo("[Search]", `Searching: "${args.query}"`);

      const searchResults = await tavilySearch(args.query);

      const followUpMessages: Msg[] = [
        ...messages,
        choice.message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: searchResults || "No results found — answer from general knowledge.",
        },
      ];

      const followUp = await openai.chat.completions.create({ ...sc, messages: followUpMessages });
      reply = followUp.choices[0]?.message?.content?.trim() ?? "";
      logInfo("[Search]", `Reply generated with search results`);
    } else {
      reply = choice?.message?.content?.trim() ?? "";
    }

    if (!reply) throw new Error("Empty speaker response");

  } catch (err) {
    logError("[Speaker]", `Failed turn ${state.turnCount}`, err);
    reply = getSpeakerFallbackReply(phase);
    speakerFailed = true;
  }

  const now = new Date().toISOString();
  ws = {
    ...ws,
    messages: [
      ...ws.messages,
      { role: "user",      content: state.currentUserInput, timestamp: now },
      { role: "assistant", content: reply,                  timestamp: now },
    ],
    currentAssistantReply: reply,
    phaseTurnCount: speakerFailed ? Math.max(0, ws.phaseTurnCount - 1) : ws.phaseTurnCount,
  };

  return ws;
}, { name: "runTurn", tags: ["lexai"] });

// ── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

app.post("/session", async (req: Request, res: Response) => {
  try {
    const voiceMode: VoiceMode = req.body?.voiceMode === "voice" ? "voice" : "chat";
    const sessionId = uuidv4();
    const state = initialState(sessionId, voiceMode);
    await dbSaveSession(state);
    logInfo("[Session]", `Created ${sessionId} (${voiceMode})`);
    res.json({ sessionId, currentPhase: state.currentPhase, voiceMode: state.voiceMode, createdAt: state.createdAt });
  } catch (err) { logError("[Session]", "Failed to create session", err); res.status(500).json({ error: PIPELINE_ERROR.userMessage }); }
});

app.post("/chat", async (req: Request, res: Response) => {
  const { sessionId, message } = req.body ?? {};
  if (!sessionId || typeof sessionId !== "string") return res.status(400).json({ error: "sessionId is required." });
  if (!message || typeof message !== "string" || message.trim() === "") return res.status(400).json({ error: "message is required." });
  let state = await dbGetSession(sessionId);
  if (!state) return res.status(SESSION_NOT_FOUND_RESPONSE.httpStatus).json(SESSION_NOT_FOUND_RESPONSE.body);
  if (state.currentPhase === "done") return res.json({ reply: "This session has ended. Please start a new session.", currentPhase: "done", sessionId });
  state = { ...state, currentUserInput: message.trim() };
  let nextState: LegalAgentState;
  try { nextState = await runTurn(state); }
  catch (err) {
    logError("[Pipeline]", `runTurn failed for ${sessionId}`, err);
    if ((err as Error).message?.includes("429")) return res.status(RATE_LIMIT_ERROR.httpStatus).json({ error: RATE_LIMIT_ERROR.userMessage });
    return res.status(500).json({ error: PIPELINE_ERROR.userMessage });
  }
  try { await dbSaveSession(nextState); }
  catch (err) { logError("[Database]", `Write failed for ${sessionId}`, err); const e = getDatabaseError("write", { sessionId }); return res.status(e.httpStatus).json({ error: e.userMessage }); }
  logInfo("[Chat]", `Session ${sessionId} | Turn ${nextState.turnCount} | Phase: ${nextState.currentPhase}`);
  res.json({ reply: nextState.currentAssistantReply, currentPhase: nextState.currentPhase, turnCount: nextState.turnCount, riskFlags: nextState.riskFlags, sessionId });
});

app.post("/upload/:sessionId", upload.single("file"), async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const state = await dbGetSession(sessionId);
  if (!state) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(SESSION_NOT_FOUND_RESPONSE.httpStatus).json(SESSION_NOT_FOUND_RESPONSE.body); }
  if (!req.file) return res.status(400).json({ error: "No file received." });
  const { originalname, mimetype, size, path: tempPath, filename } = req.file;
  const ve = validateUploadedFile(originalname, mimetype, size);
  if (ve) { logWarn("[Upload]", ve.logMessage); fs.unlink(tempPath, () => {}); return res.status(ve.httpStatus).json({ error: ve.userMessage }); }
  const storedName = `${filename}${path.extname(originalname).toLowerCase()}`;
  const finalPath  = path.join(UPLOADS_DIR, storedName);
  let fileBuffer: Buffer;
  try { fileBuffer = fs.readFileSync(tempPath); }
  catch (err) { logError("[Upload]", `Failed to read ${originalname}`, err); const e = getFileUploadError("disk", { fileName: originalname }); return res.status(e.httpStatus).json({ error: e.userMessage }); }
  try {
    if (r2 && process.env.R2_BUCKET_NAME) {
      await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storedName, Body: fileBuffer, ContentType: mimetype }));
      fs.unlink(tempPath, () => {});
    } else {
      fs.renameSync(tempPath, finalPath);
    }
  } catch (err) { logError("[Upload]", `Failed to store ${originalname}`, err); const e = getFileUploadError("disk", { fileName: originalname }); return res.status(e.httpStatus).json({ error: e.userMessage }); }
  let description = getFileAnalysisFallbackDescription(originalname);
  try {
    if (!mimetype.startsWith("video/")) {
      const base64 = fileBuffer.toString("base64");
      const vr = await openai.chat.completions.create({ model: "gpt-4o-mini", max_tokens: 256, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}`, detail: "low" } }, { type: "text", text: "Describe this image in 1-2 sentences for a legal case file. Be factual and neutral." }] }] });
      const raw = vr.choices[0]?.message?.content?.trim() ?? "";
      if (raw) description = raw;
    } else { description = `${originalname} — video file uploaded (${(size / 1024 / 1024).toFixed(1)} MB).`; }
  } catch (err) { logWarn("[FileAnalysis]", `Vision failed for ${originalname}: ${(err as Error).message}`); }
  const fileRecord = { id: uuidv4(), originalName: originalname, storedName, mimeType: mimetype, size, uploadedAt: new Date().toISOString(), description };
  try { await dbSaveSession({ ...state, uploadedFiles: [...state.uploadedFiles, fileRecord], updatedAt: new Date().toISOString() }); }
  catch (err) { logError("[Database]", `Write failed after upload for ${sessionId}`, err); const e = getDatabaseError("write", { sessionId }); return res.status(e.httpStatus).json({ error: e.userMessage }); }
  logInfo("[Upload]", `${sessionId} | ${originalname}`);
  res.json({ fileId: fileRecord.id, originalName: fileRecord.originalName, description: fileRecord.description, uploadedAt: fileRecord.uploadedAt });
});

app.get("/session/:sessionId", async (req: Request, res: Response) => {
  const state = await dbGetSession(req.params.sessionId);
  if (!state) return res.status(SESSION_NOT_FOUND_RESPONSE.httpStatus).json(SESSION_NOT_FOUND_RESPONSE.body);
  res.json({ ...state, uploadedFiles: state.uploadedFiles.map(f => ({ id: f.id, originalName: f.originalName, mimeType: f.mimeType, size: f.size, uploadedAt: f.uploadedAt, description: f.description })), transcript: state.messages });
});

app.get("/sessions", async (_req: Request, res: Response) => {
  try { res.json(await dbListSessions()); }
  catch (err) { logError("[Sessions]", "Failed to list sessions", err); res.status(500).json({ error: PIPELINE_ERROR.userMessage }); }
});

app.delete("/session/:sessionId", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const state = await dbGetSession(sessionId);
  if (!state) return res.status(SESSION_NOT_FOUND_RESPONSE.httpStatus).json(SESSION_NOT_FOUND_RESPONSE.body);
  try {
    await dbSaveSession({ ...state, currentPhase: "done", sessionClosed: true, updatedAt: new Date().toISOString() });
    logInfo("[Session]", `Closed ${sessionId}`);
    res.json({ sessionId, closed: true });
  } catch (err) { logError("[Session]", `Failed to close ${sessionId}`, err); res.status(500).json({ error: PIPELINE_ERROR.userMessage }); }
});

app.post("/voice/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
  if (!DEEPGRAM_API_KEY) return res.status(503).json({ error: "STT not configured." });
  const { sessionId } = req.body ?? {};
  if (!sessionId || !(await dbGetSession(sessionId))) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(404).json(SESSION_NOT_FOUND_RESPONSE.body); }
  if (!req.file) return res.status(400).json({ error: "No audio file received." });
  try {
    const audioBuffer = fs.readFileSync(req.file.path);
    const dgRes = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en-US", { method: "POST", headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": req.file.mimetype }, body: audioBuffer });
    fs.unlink(req.file.path, () => {});
    if (!dgRes.ok) throw new Error(`Deepgram ${dgRes.status}`);
    const dgData = (await dgRes.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
    const transcript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    if (!transcript.trim()) { const e = getSTTError({ sessionId }); logWarn("[STT]", e.logMessage); return res.json({ transcript: "", fallback: e.userMessage }); }
    res.json({ transcript });
  } catch (err) { if (req.file) fs.unlink(req.file.path, () => {}); const e = getSTTError({ sessionId }); logError("[STT]", e.logMessage, err); res.status(500).json({ error: e.userMessage }); }
});

app.post("/voice/synthesise", async (req: Request, res: Response) => {
  if (!DEEPGRAM_API_KEY) return res.status(503).json({ error: "TTS not configured." });
  const { text, sessionId } = req.body ?? {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text is required." });
  try {
    const dgRes = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mp3", {
      method: "POST",
      headers: { "Authorization": `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!dgRes.ok) {
      const errText = await dgRes.text();
      throw new Error(`Deepgram TTS ${dgRes.status}: ${errText}`);
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");
    const reader = dgRes.body;
    if (!reader) throw new Error("No body");
    reader.pipe(res as unknown as NodeJS.WritableStream);
  } catch (err) { const e = getTTSError({ sessionId }); logError("[TTS]", e.logMessage, err); if (!res.headersSent) res.status(500).json({ error: e.fallbackNote }); }
});

app.use(express.static(path.resolve(process.cwd(), ".")));
app.get("/", (_req: Request, res: Response) => res.sendFile(path.resolve(process.cwd(), "index.html")));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    version: "1.1.0",
    uptime: process.uptime(),
    voiceEnabled: !!DEEPGRAM_API_KEY,
    searchEnabled: !!TAVILY_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logError("[Express]", "Unhandled error", err);
  if (!res.headersSent) res.status(500).json({ error: PIPELINE_ERROR.userMessage });
});

initDb().then(() => {
  app.listen(PORT, () => {
    logInfo("[Startup]", `LexAI running on http://localhost:${PORT}`);
    logInfo("[Startup]", `STT: ${DEEPGRAM_API_KEY ? "enabled" : "disabled"} | TTS: ${ELEVENLABS_API_KEY ? "enabled" : "disabled"} | Search: ${TAVILY_API_KEY ? "enabled" : "disabled"}`);
    logInfo("[Startup]", `DB: ${process.env.TURSO_DATABASE_URL ?? DB_PATH}`);
  });
}).catch((err) => { console.error("DB init failed:", err); process.exit(1); });

export default app;
