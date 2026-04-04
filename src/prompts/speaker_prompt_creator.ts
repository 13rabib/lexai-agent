// =============================================================================
// src/prompts/speaker_prompt_creator.ts
// LexAI Legal Intake Agent — Speaker Prompt Creator (Node 4)
//
// Assembles the full reply prompt every turn after the Orchestrator has
// merged state and (potentially) advanced the phase.
// Pure function — no side effects, no LLM calls, no database access.
//
// Output is sent to the Speaker LLM with:
//   model: "gpt-4o-mini"
//   temperature: 0.7
//   max_tokens: 1024 (chat) | 256 (voice)
//   response_format: default (plain text)
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { LegalAgentState } from "../../state/schema";
import { isSet } from "../../state/schema";
import type { Phase } from "../../state/schema";

// ---------------------------------------------------------------------------
// Speaker window sizes
// ---------------------------------------------------------------------------
const SPEAKER_HISTORY_WINDOW = 8;

// ---------------------------------------------------------------------------
// buildSpeakerPrompt
// Main entry point — call once per turn after orchestration.
// ---------------------------------------------------------------------------

export function buildSpeakerPrompt(state: LegalAgentState): string {
  const phase = state.currentPhase;
  const phaseInstructions = loadPhaseSpeakerInstructions(phase);
  const collectedFacts = buildCollectedFactsSummary(state);
  const uploadedFilesBlock = buildUploadedFilesBlock(state);
  const historyBlock = buildHistoryBlock(state);
  const isVoice = state.voiceMode === "voice";

  const lines: string[] = [];

  // -------------------------------------------------------------------------
  // Phase personality and strategy (loaded from phases/{phase}/speaker.md)
  // -------------------------------------------------------------------------
  lines.push(phaseInstructions);
  lines.push("");
  lines.push("---");
  lines.push("");

  // -------------------------------------------------------------------------
  // Conversation summary (injected when available — sessions > 20 turns)
  // -------------------------------------------------------------------------
  if (isSet(state.conversationSummary)) {
    lines.push("CONVERSATION SUMMARY (earlier turns):");
    lines.push(state.conversationSummary);
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Collected facts — what the agent knows so far
  // -------------------------------------------------------------------------
  lines.push("COLLECTED SO FAR:");
  lines.push(collectedFacts);
  lines.push("");

  // -------------------------------------------------------------------------
  // Uploaded evidence files
  // -------------------------------------------------------------------------
  if (uploadedFilesBlock) {
    lines.push("UPLOADED EVIDENCE FILES:");
    lines.push(uploadedFilesBlock);
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Active risk flags (show to speaker so it can react appropriately)
  // -------------------------------------------------------------------------
  if (state.riskFlags.length > 0) {
    lines.push("ACTIVE RISK FLAGS:");
    state.riskFlags.forEach((flag) => lines.push(`• ${flag}`));
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Recent conversation
  // -------------------------------------------------------------------------
  lines.push("CONVERSATION:");
  lines.push(historyBlock || "(no messages yet — this is the opening turn)");
  lines.push("");

  // -------------------------------------------------------------------------
  // Current user input
  // -------------------------------------------------------------------------
  lines.push(`USER JUST SAID: "${state.currentUserInput}"`);
  lines.push("");

  // -------------------------------------------------------------------------
  // Disclaimer instruction — wrapup phase only
  // -------------------------------------------------------------------------
  if (phase === "wrapup" && !state.disclaimerInjected && state.phaseTurnCount === 0) {
    lines.push("IMPORTANT — DISCLAIMER REQUIRED:");
    lines.push(
      'You MUST include the following disclaimer naturally in your response, then ask the client to acknowledge it: ' +
      '"I want to be clear: I\'m an AI assistant providing general legal information only — ' +
      'not legal advice, and this conversation does not create an attorney-client relationship. ' +
      'For advice specific to your situation, please consult a qualified, licensed attorney. ' +
      'Do you understand and acknowledge that?"'
    );
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Referral instruction — guidance phase when referralNeeded is true and
  // referralAccepted has not yet been set
  // -------------------------------------------------------------------------
  if (
    phase === "guidance" &&
    state.referralNeeded === true &&
    state.referralAccepted === null
  ) {
    const issueLabel = state.legalIssueType || "legal";
    const jurisdictionLabel = state.jurisdiction || "your area";
    lines.push("REFERRAL OFFER REQUIRED:");
    lines.push(
      `Based on what has been collected, a lawyer referral is recommended. ` +
      `Offer to connect the client with an attorney who handles ${issueLabel} cases ` +
      `in ${jurisdictionLabel}. Ask clearly whether they would like to be connected.`
    );
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Phase transition awareness
  // If the phase just changed (phaseTurnCount === 0), signal the transition.
  // -------------------------------------------------------------------------
  if (state.phaseTurnCount === 0 && phase !== "intake" && phase !== "done") {
    lines.push(
      `PHASE TRANSITION NOTE: The conversation just moved into the ${phase} phase. ` +
      `Use the transition signal from your instructions to acknowledge this naturally ` +
      `before asking your first question in this phase.`
    );
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // Output constraints — voice vs chat
  // -------------------------------------------------------------------------
  lines.push("RESPONSE INSTRUCTIONS:");
  lines.push("• Respond in plain prose — no markdown, no bullet points, no numbered lists.");
  lines.push("• Output is rendered directly in a chat or voice UI — formatting characters will show as literal symbols.");
  lines.push("• Never fabricate legal citations, case names, or statutes unless from a verified source.");
  lines.push("• Never say 'I cannot help with that' — always offer an alternative or next step.");
  lines.push("• Ask at most ONE question per turn.");
  lines.push("• Do NOT promise legal outcomes or predictions.");
  lines.push(`• Current phase: ${phase}`);
  lines.push("");
  lines.push("GUARDRAIL 1 — SOURCE CITATIONS:");
  lines.push("• When you provide legal information drawn from a web search, you MUST cite the source. Format: state the information, then add 'Source: [title] — [url]' on the same line.");
  lines.push("• When you provide legal information from your own knowledge (no search), you MUST indicate this with: 'Note: This is general knowledge — verify with a licensed attorney or official government source for your specific situation.'");
  lines.push("• Never present legal information as definitive fact without a citation or the general knowledge note.");
  lines.push("");
  lines.push("GUARDRAIL 2 — US JURISDICTION ONLY:");
  lines.push("• This agent only supports legal matters under US federal law or the law of US states.");
  lines.push("• If the client mentions a location outside the United States, or asks about the legal framework of another country, respond with EXACTLY this and nothing else: 'I can only assist with legal matters in the United States. For legal questions in [country], I recommend consulting a local attorney or your country\\'s official legal aid resources. Unfortunately I am not able to help further with this matter.' Do NOT ask any follow-up questions after this message. Do NOT offer to help further. The conversation should end here.");
  lines.push("• Do NOT provide legal information about non-US jurisdictions under any circumstances, even if you have general knowledge of them.");
  lines.push("• US territories (Puerto Rico, Guam, US Virgin Islands) are supported.");
  lines.push("");
  lines.push("GUARDRAIL 3 — NO FINANCIAL ADVICE:");
  lines.push("• You MUST NOT provide financial advice of any kind. This includes: investment advice, tax advice, debt management advice, bankruptcy strategy, settlement amount recommendations, or any guidance on how the client should manage their money.");
  lines.push("• You MAY state general factual information such as typical court filing fee ranges or that attorney fees vary — but only as factual context, not as a recommendation.");
  lines.push("• If a client asks a financial advice question (e.g. 'should I accept this settlement?', 'how much should I ask for?', 'should I file for bankruptcy?'), respond with: 'That is a financial decision I am not able to advise on. A licensed attorney and, if needed, a financial advisor are the right resources for that question.'");
  lines.push("• Never suggest a specific dollar amount the client should seek or accept.");

  if (isVoice) {
    lines.push("• VOICE MODE: Keep your response to 1–2 short sentences. No lists. One idea per turn.");
    lines.push("• VOICE MODE: Spell out abbreviations and avoid symbols.");
  } else {
    lines.push("• CHAT MODE: Maximum 3 sentences unless providing detailed legal information in the guidance phase.");
  }

  lines.push("");
  lines.push("Your response:");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// buildCollectedFactsSummary
// Builds a plain-language summary of all non-empty state fields.
// This is the speaker's awareness of what has been gathered so far.
// ---------------------------------------------------------------------------

function buildCollectedFactsSummary(state: LegalAgentState): string {
  const facts: string[] = [];

  // Session context
  if (isSet(state.legalDomain))
    facts.push(`Domain: ${state.legalDomain}`);
  if (isSet(state.legalIssueType))
    facts.push(`Issue type: ${state.legalIssueType}`);
  if (isSet(state.jurisdiction))
    facts.push(`Jurisdiction: ${state.jurisdiction}`);
  if (isSet(state.urgencyLevel))
    facts.push(`Urgency: ${state.urgencyLevel}`);
  if (isSet(state.clientRole))
    facts.push(`Client role: ${state.clientRole}`);

  // Situation
  if (isSet(state.incidentSummary))
    facts.push(`Incident: ${state.incidentSummary}`);
  if (isSet(state.incidentDate))
    facts.push(`Incident date: ${state.incidentDate}`);
  if (isSet(state.incidentLocation))
    facts.push(`Location: ${state.incidentLocation}`);
  if (isSet(state.timeline))
    facts.push(`Timeline: ${state.timeline}`);
  if (state.partiesInvolved.length > 0)
    facts.push(`Parties: ${state.partiesInvolved.join(", ")}`);
  if (state.priorLegalAction !== null)
    facts.push(`Prior legal action: ${state.priorLegalAction ? "yes" : "no"}${isSet(state.priorLegalActionDetails) ? ` — ${state.priorLegalActionDetails}` : ""}`);

  // Evidence (quick notes)
  if (state.evidenceNoted.length > 0)
    facts.push(`Evidence noted: ${state.evidenceNoted.join("; ")}`);

  // Insurance
  if (isSet(state.insuranceCoverageType))
    facts.push(`Insurance: ${state.insuranceCoverageType}${isSet(state.insuranceProvider) ? ` (${state.insuranceProvider})` : ""}`);
  if (state.insuranceClaimFiled !== null)
    facts.push(`Claim filed: ${state.insuranceClaimFiled ? "yes" : "no"}`);
  if (isSet(state.estimatedDamages))
    facts.push(`Estimated damages: ${state.estimatedDamages}`);
  if (isSet(state.financialExposure))
    facts.push(`Financial exposure: ${state.financialExposure}`);
  if (state.canAffordAttorney !== null)
    facts.push(`Can afford attorney: ${state.canAffordAttorney ? "yes" : "no"}`);

  // Witnesses & evidence inventory
  if (state.witnesses.length > 0) {
    const witnessSummary = state.witnesses
      .map((w) => `${w.name} (${w.type})`)
      .join(", ");
    facts.push(`Witnesses: ${witnessSummary}`);
  }
  if (state.evidenceItems.length > 0) {
    const evidenceSummary = state.evidenceItems
      .map((e) => `${e.description} [${e.type}]`)
      .join("; ");
    facts.push(`Evidence items: ${evidenceSummary}`);
  }
  if (state.policeReportFiled !== null)
    facts.push(`Police report: ${state.policeReportFiled ? `filed${isSet(state.policeReportNumber) ? ` (#${state.policeReportNumber})` : ""}` : "not filed"}`);
  if (state.hasDigitalEvidence !== null)
    facts.push(`Digital evidence: ${state.hasDigitalEvidence ? "yes" : "no"}`);
  if (isSet(state.evidenceCustody))
    facts.push(`Evidence custody: ${state.evidenceCustody}`);

  // Guidance progress
  if (state.questionsAnswered.length > 0)
    facts.push(`Questions addressed: ${state.questionsAnswered.join("; ")}`);
  if (state.referralNeeded !== null)
    facts.push(`Referral needed: ${state.referralNeeded ? "yes" : "no"}`);
  if (state.referralAccepted !== null)
    facts.push(`Referral accepted: ${state.referralAccepted ? "yes" : "no"}`);

  // Litmetrics (show in wrapup so speaker can reference scores)
  if (state.liabilityScore !== null)
    facts.push(`Liability score: ${state.liabilityScore}/100`);
  if (state.caseStrengthScore !== null)
    facts.push(`Case strength: ${state.caseStrengthScore}/100`);
  if (isSet(state.statuteOfLimitationsFlag) && state.statuteOfLimitationsFlag !== "ok")
    facts.push(`Statute of limitations: ${state.statuteOfLimitationsFlag}`);

  if (facts.length === 0) return "(nothing collected yet)";
  return facts.join("\n");
}

// ---------------------------------------------------------------------------
// buildUploadedFilesBlock
// ---------------------------------------------------------------------------

function buildUploadedFilesBlock(state: LegalAgentState): string {
  if (state.uploadedFiles.length === 0) return "";
  return state.uploadedFiles
    .map((f) => `• ${f.originalName}: ${f.description}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// buildHistoryBlock
// Uses last 8 messages for the speaker.
// Prepends summary if available (sessions > 20 turns).
// ---------------------------------------------------------------------------

function buildHistoryBlock(state: LegalAgentState): string {
  const window = state.messages.slice(-SPEAKER_HISTORY_WINDOW);
  if (window.length === 0) return "";
  return window
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// loadPhaseSpeakerInstructions
// Reads the phase's speaker.md file from disk. Cached after first read.
// ---------------------------------------------------------------------------

const instructionCache: Partial<Record<Phase, string>> = {};

function loadPhaseSpeakerInstructions(phase: Phase): string {
  if (instructionCache[phase]) return instructionCache[phase]!;

  const filePath = path.resolve(
    __dirname,
    `../../phases/${phase}/speaker.md`
  );

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    instructionCache[phase] = content;
    return content;
  } catch (err) {
    console.error(`[SpeakerPromptCreator] Failed to load ${filePath}:`, err);
    return [
      `You are a helpful legal intake assistant currently in the ${phase} phase.`,
      `Be warm, professional, and ask one clear question at a time.`,
    ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Speaker LLM call configuration (exported for the pipeline runner)
// ---------------------------------------------------------------------------

export function getSpeakerLLMConfig(voiceMode: "voice" | "chat") {
  return {
    model: "gpt-4o-mini",
    temperature: 0.7,
    // Voice replies must be short — cap tokens accordingly
    max_tokens: voiceMode === "voice" ? 256 : 1024,
  } as const;
}
