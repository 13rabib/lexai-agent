// =============================================================================
// src/prompts/analyzer_prompt_creator.ts
// LexAI Legal Intake Agent — Analyzer Prompt Creator (Node 1)
//
// Assembles the full extraction prompt every turn before the Analyzer LLM call.
// Pure function — no side effects, no LLM calls, no database access.
//
// Output is sent to the Analyzer LLM with:
//   model: "gpt-4o-mini"
//   temperature: 0
//   max_tokens: 512
//   response_format: { type: "json_object" }
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { LegalAgentState } from "../../state/schema";
import { phaseRegistry } from "../../config/phase_registry";
import type { Phase } from "../../state/schema";

// ---------------------------------------------------------------------------
// Analyzer window size (last N messages shown to extraction LLM)
// ---------------------------------------------------------------------------
const ANALYZER_HISTORY_WINDOW = 6;

// ---------------------------------------------------------------------------
// buildAnalyzerPrompt
// Main entry point — call once per turn before Analyzer LLM call.
// ---------------------------------------------------------------------------

export function buildAnalyzerPrompt(state: LegalAgentState): string {
  const phase = state.currentPhase;
  const config = phaseRegistry[phase];
  const phaseInstructions = loadPhaseAnalyzerInstructions(phase);
  const historyBlock = buildHistoryBlock(state.messages, ANALYZER_HISTORY_WINDOW);
  const uploadedFilesBlock = buildUploadedFilesBlock(state);

  const lines: string[] = [];

  // -------------------------------------------------------------------------
  // System framing
  // -------------------------------------------------------------------------
  lines.push("You are a precise data extractor for a legal intake agent.");
  lines.push("Your only job is to extract structured data from what the client just said.");
  lines.push("Never invent or infer values the client has not explicitly stated.");
  lines.push("");

  // -------------------------------------------------------------------------
  // Phase and turn context
  // -------------------------------------------------------------------------
  lines.push(
    `PHASE: ${phase.toUpperCase()} | TURN: ${state.phaseTurnCount + 1} of ${config.maxTurns}`
  );
  lines.push(`LEGAL DOMAIN: ${state.legalDomain || "not yet determined"}`);
  lines.push(`URGENCY: ${state.urgencyLevel || "not yet determined"}`);
  lines.push("");

  // -------------------------------------------------------------------------
  // Recent conversation history
  // -------------------------------------------------------------------------
  if (historyBlock) {
    lines.push("RECENT CONVERSATION:");
    lines.push(historyBlock);
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Current user input
  // -------------------------------------------------------------------------
  lines.push(`USER JUST SAID:`);
  lines.push(`"${state.currentUserInput}"`);
  lines.push("");

  // -------------------------------------------------------------------------
  // Uploaded files context (photos/video only for this agent)
  // -------------------------------------------------------------------------
  if (uploadedFilesBlock) {
    lines.push("UPLOADED EVIDENCE FILES:");
    lines.push(uploadedFilesBlock);
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Turn-limit awareness instruction
  // Near the end of a phase, the LLM should be more aggressive about extracting
  // partial information rather than waiting for a complete answer.
  // -------------------------------------------------------------------------
  const turnsRemaining = config.maxTurns - (state.phaseTurnCount + 1);
  if (turnsRemaining <= 1 && phase !== "done") {
    lines.push(
      `NOTE: This is the final turn of the ${phase} phase. ` +
      `Extract whatever partial information is available — do not leave fields empty ` +
      `just because the client's answer is incomplete.`
    );
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Phase-specific extraction instructions (loaded from phases/{phase}/analyzer.md)
  // -------------------------------------------------------------------------
  lines.push("--- EXTRACTION INSTRUCTIONS ---");
  lines.push("");
  lines.push(phaseInstructions);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// buildHistoryBlock
// Formats the last N messages as "USER: ..." / "ASSISTANT: ..." lines.
// ---------------------------------------------------------------------------

function buildHistoryBlock(
  messages: LegalAgentState["messages"],
  windowSize: number
): string {
  if (messages.length === 0) return "";

  const window = messages.slice(-windowSize);
  return window
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// buildUploadedFilesBlock
// Formats uploaded file descriptions for the extraction prompt.
// Only included when files exist.
// ---------------------------------------------------------------------------

function buildUploadedFilesBlock(state: LegalAgentState): string {
  if (state.uploadedFiles.length === 0) return "";

  return state.uploadedFiles
    .map((f) => `• ${f.originalName}: ${f.description}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// loadPhaseAnalyzerInstructions
// Reads the phase's analyzer.md file from disk.
// Cached in memory after first read to avoid repeated disk I/O.
// ---------------------------------------------------------------------------

const instructionCache: Partial<Record<Phase, string>> = {};

function loadPhaseAnalyzerInstructions(phase: Phase): string {
  if (instructionCache[phase]) return instructionCache[phase]!;

  const filePath = path.resolve(
    process.cwd(),
    `phases/${phase}/analyzer.md`
  );

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    instructionCache[phase] = content;
    return content;
  } catch (err) {
    console.error(`[AnalyzerPromptCreator] Failed to load ${filePath}:`, err);
    // Fallback: return a minimal safe instruction
    return [
      `## Goal`,
      `Extract any relevant information from the client's message for the ${phase} phase.`,
      ``,
      `## Output`,
      `Return ONLY valid JSON. No preamble, no explanation.`,
    ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Analyzer LLM call configuration (exported for the pipeline runner)
// ---------------------------------------------------------------------------

export const ANALYZER_LLM_CONFIG = {
  model: "gpt-4o-mini",
  temperature: 0,
  max_tokens: 512,
  response_format: { type: "json_object" as const },
} as const;

// ---------------------------------------------------------------------------
// parseAnalyzerResponse
// Safely parses the JSON output from the Analyzer LLM.
// Returns {} on any failure — the orchestrator handles empty output gracefully.
// ---------------------------------------------------------------------------

export function parseAnalyzerResponse(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") {
    console.warn("[AnalyzerPromptCreator] Empty response from Analyzer LLM");
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[AnalyzerPromptCreator] Analyzer returned non-object JSON:", raw);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error("[AnalyzerPromptCreator] JSON parse failure:", err, "\nRaw:", raw);
    return {};
  }
}
