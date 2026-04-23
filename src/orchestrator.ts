// =============================================================================
// src/orchestrator.ts
// LexAI Legal Intake Agent — Orchestrator (Node 3)
//
// Purely deterministic TypeScript — zero LLM calls.
//
// Responsibilities:
//   1. Validate and merge Analyzer JSON output into session state
//   2. Compute risk flags (recomputed from scratch every turn)
//   3. Evaluate phase transition conditions via the phase registry
//   4. Trigger Litmetrics scoring + fact extraction on wrapup entry
//   5. Enforce all schema invariants
//
// Invariants (must always hold):
//   - turnCount increases by exactly 1 per call, never decreases
//   - phaseTurnCount resets to 0 on every phase transition
//   - Risk flags are always recomputed from scratch, never appended
//   - Litmetrics scores are written at most once (set-once policy)
//   - Merge logic only touches fields belonging to the current phase
// =============================================================================

import type { LegalAgentState, LegalIssueType, UrgencyLevel, InsuranceCoverageType, WitnessType, EvidenceType, Witness, EvidenceItem } from "../state/schema";
import { dedupe, clamp, isSet } from "../state/schema";
import {
  phaseRegistry,
  EMERGENCY_BYPASS_PHASES,
  EMERGENCY_BYPASS_TARGET,
} from "../config/phase_registry";
import type { Phase } from "../state/schema";

// ---------------------------------------------------------------------------
// Orchestrate — main entry point
// Called once per turn, after the Analyzer LLM has returned its JSON output.
// Returns a partial state update object. Caller merges into full state.
// ---------------------------------------------------------------------------

export function orchestrate(
  state: LegalAgentState,
  analyzerOutput: Record<string, unknown>
): Partial<LegalAgentState> {
  const updates: Partial<LegalAgentState> = {};
  const now = new Date().toISOString();

  // -------------------------------------------------------------------------
  // Step 1 — Increment turn counters
  // -------------------------------------------------------------------------
  updates.turnCount = state.turnCount + 1;
  updates.phaseTurnCount = state.phaseTurnCount + 1;
  updates.updatedAt = now;
  updates.analyzerOutput = analyzerOutput;

  // -------------------------------------------------------------------------
  // Step 2 — Merge analyzer output into state (phase-scoped)
  // Build a working copy that reflects what state will look like after merge.
  // -------------------------------------------------------------------------
  const merged: LegalAgentState = { ...state, ...updates };
  mergeByPhase(merged, analyzerOutput, state.currentPhase);

  // Copy merged phase fields back into updates
  copyMergedFields(merged, updates, state.currentPhase);

  // Passively capture any cross-phase fields the user volunteered early
  passiveCrossPhaseCapture(merged, analyzerOutput, state.currentPhase);
  copyPassiveFields(merged, updates, state.currentPhase);

  // -------------------------------------------------------------------------
  // Step 3 — Recompute risk flags from scratch
  // -------------------------------------------------------------------------
  updates.riskFlags = computeRiskFlags(merged);
  merged.riskFlags = updates.riskFlags;

  // -------------------------------------------------------------------------
  // Step 4 — Emergency bypass check
  // If urgency is emergency and current phase is bypassable, jump to guidance.
  // -------------------------------------------------------------------------
  if (
    merged.urgencyLevel === "emergency" &&
    EMERGENCY_BYPASS_PHASES.has(state.currentPhase) &&
    state.currentPhase !== EMERGENCY_BYPASS_TARGET
  ) {
    updates.currentPhase = EMERGENCY_BYPASS_TARGET;
    updates.phaseTurnCount = 0;
    // Trigger wrapup scoring if somehow jumping directly to wrapup (edge case)
    if (EMERGENCY_BYPASS_TARGET === "wrapup") {
      applyWrapupScoring(merged, updates);
    }
    return updates;
  }

  // -------------------------------------------------------------------------
  // Step 5 — Phase transition evaluation
  // -------------------------------------------------------------------------
  const config = phaseRegistry[state.currentPhase];
  const phaseTurnCountAfterMerge = merged.phaseTurnCount;

  const shouldAdvance =
    state.currentPhase !== "done" &&
    (config.canTransition(merged) || phaseTurnCountAfterMerge >= config.maxTurns);

  if (shouldAdvance) {
    const nextPhase = config.nextPhase;
    updates.currentPhase = nextPhase;
    updates.phaseTurnCount = 0;

    // On entry to wrapup: compute Litmetrics scores + extract facts (set-once)
    if (nextPhase === "wrapup" && state.liabilityScore === null) {
      applyWrapupScoring(merged, updates);
    }
  }

  return updates;
}

// ---------------------------------------------------------------------------
// mergeByPhase
// Mutates `merged` in-place. Only touches fields for the given phase.
// Foreign fields from other phases are silently ignored.
// ---------------------------------------------------------------------------

function mergeByPhase(
  merged: LegalAgentState,
  out: Record<string, unknown>,
  phase: Phase
): void {
  switch (phase) {

    // -----------------------------------------------------------------------
    case "intake": {
      if (isValidString(out.legalDomain, ["criminal", "civil"]))
        merged.legalDomain = out.legalDomain as LegalAgentState["legalDomain"];

      if (isNonEmptyString(out.legalIssueType))
        merged.legalIssueType = out.legalIssueType as LegalIssueType;

      if (isNonEmptyString(out.jurisdiction))
        merged.jurisdiction = out.jurisdiction as string;

      if (isValidString(out.urgencyLevel, ["emergency", "urgent", "standard", "exploratory"]))
        merged.urgencyLevel = out.urgencyLevel as UrgencyLevel;

      break;
    }

    // -----------------------------------------------------------------------
    case "situation": {
      if (isNonEmptyString(out.incidentSummary))
        merged.incidentSummary = out.incidentSummary as string;

      if (isNonEmptyString(out.incidentDate))
        merged.incidentDate = out.incidentDate as string;

      if (isNonEmptyString(out.incidentLocation))
        merged.incidentLocation = out.incidentLocation as string;

      if (Array.isArray(out.partiesInvolved) && out.partiesInvolved.length > 0)
        merged.partiesInvolved = dedupe([
          ...merged.partiesInvolved,
          ...out.partiesInvolved.filter(isNonEmptyString),
        ]);

      if (isNonEmptyString(out.clientRole))
        merged.clientRole = out.clientRole as string;

      if (isNonEmptyString(out.timeline))
        merged.timeline = out.timeline as string;

      if (typeof out.priorLegalAction === "boolean")
        merged.priorLegalAction = out.priorLegalAction;

      if (isNonEmptyString(out.priorLegalActionDetails))
        merged.priorLegalActionDetails = out.priorLegalActionDetails as string;

      if (Array.isArray(out.evidenceNoted) && out.evidenceNoted.length > 0)
        merged.evidenceNoted = dedupe([
          ...merged.evidenceNoted,
          ...out.evidenceNoted.filter(isNonEmptyString),
        ]);

      break;
    }

    // -----------------------------------------------------------------------
    case "insurance": {
      if (isValidString(out.insuranceCoverageType, [
        "auto", "homeowners", "renters", "health",
        "liability", "workers-comp", "none", "unknown",
      ]))
        merged.insuranceCoverageType = out.insuranceCoverageType as InsuranceCoverageType;

      if (isNonEmptyString(out.insuranceProvider))
        merged.insuranceProvider = out.insuranceProvider as string;

      // Policy number: accept only if it looks like a policy number (no SSN pattern)
      if (isNonEmptyString(out.insurancePolicyNumber) && !looksLikeSSN(out.insurancePolicyNumber as string))
        merged.insurancePolicyNumber = out.insurancePolicyNumber as string;

      if (typeof out.insuranceClaimFiled === "boolean")
        merged.insuranceClaimFiled = out.insuranceClaimFiled;

      if (isNonEmptyString(out.insuranceClaimNumber))
        merged.insuranceClaimNumber = out.insuranceClaimNumber as string;

      if (isNonEmptyString(out.estimatedDamages))
        merged.estimatedDamages = out.estimatedDamages as string;

      if (isNonEmptyString(out.financialExposure))
        merged.financialExposure = out.financialExposure as string;

      if (typeof out.canAffordAttorney === "boolean")
        merged.canAffordAttorney = out.canAffordAttorney;

      break;
    }

    // -----------------------------------------------------------------------
    case "witnesses": {
      // Append structured witness entries
      if (Array.isArray(out.witnesses)) {
        const newWitnesses = out.witnesses
          .filter(isWitnessShape)
          .map(normaliseWitness);
        merged.witnesses = [...merged.witnesses, ...newWitnesses];
      }

      // Append structured evidence items
      if (Array.isArray(out.evidenceItems)) {
        const newItems = out.evidenceItems
          .filter(isEvidenceItemShape)
          .map(normaliseEvidenceItem);
        merged.evidenceItems = [...merged.evidenceItems, ...newItems];
      }

      if (typeof out.policeReportFiled === "boolean")
        merged.policeReportFiled = out.policeReportFiled;

      if (isNonEmptyString(out.policeReportNumber))
        merged.policeReportNumber = out.policeReportNumber as string;

      if (typeof out.hasDigitalEvidence === "boolean")
        merged.hasDigitalEvidence = out.hasDigitalEvidence;

      if (isNonEmptyString(out.evidenceCustody))
        merged.evidenceCustody = out.evidenceCustody as string;

      break;
    }

    // -----------------------------------------------------------------------
    case "guidance": {
      if (isNonEmptyString(out.questionAsked))
        merged.questionsAnswered = [...merged.questionsAnswered, out.questionAsked as string];

      if (isNonEmptyString(out.infoProvided))
        merged.generalInfoProvided = [...merged.generalInfoProvided, out.infoProvided as string];

      if (typeof out.referralNeeded === "boolean")
        merged.referralNeeded = out.referralNeeded;

      if (typeof out.referralAccepted === "boolean")
        merged.referralAccepted = out.referralAccepted;

      if (typeof out.userSatisfied === "boolean")
        merged.userSatisfied = out.userSatisfied;

      break;
    }

    // -----------------------------------------------------------------------
    case "wrapup": {
      if (out.userAcknowledgedDisclaimer === true)
        merged.disclaimerInjected = true;

      if (Array.isArray(out.nextStepsProvided)) {
        const steps = out.nextStepsProvided.filter(isNonEmptyString) as string[];
        merged.nextStepsProvided = [...merged.nextStepsProvided, ...steps];
      }

      if (out.sessionClosed === true)
        merged.sessionClosed = true;

      break;
    }

    // done: no merging
    case "done":
      break;
  }
}

// ---------------------------------------------------------------------------
// copyMergedFields
// After mergeByPhase mutates `merged`, copy the phase-relevant fields
// back into the `updates` partial so the caller can apply them.
// ---------------------------------------------------------------------------

function copyMergedFields(
  merged: LegalAgentState,
  updates: Partial<LegalAgentState>,
  phase: Phase
): void {
  switch (phase) {
    case "intake":
      updates.legalDomain = merged.legalDomain;
      updates.legalIssueType = merged.legalIssueType;
      updates.jurisdiction = merged.jurisdiction;
      updates.urgencyLevel = merged.urgencyLevel;
      break;
    case "situation":
      updates.incidentSummary = merged.incidentSummary;
      updates.incidentDate = merged.incidentDate;
      updates.incidentLocation = merged.incidentLocation;
      updates.partiesInvolved = merged.partiesInvolved;
      updates.clientRole = merged.clientRole;
      updates.timeline = merged.timeline;
      updates.priorLegalAction = merged.priorLegalAction;
      updates.priorLegalActionDetails = merged.priorLegalActionDetails;
      updates.evidenceNoted = merged.evidenceNoted;
      break;
    case "insurance":
      updates.insuranceCoverageType = merged.insuranceCoverageType;
      updates.insuranceProvider = merged.insuranceProvider;
      updates.insurancePolicyNumber = merged.insurancePolicyNumber;
      updates.insuranceClaimFiled = merged.insuranceClaimFiled;
      updates.insuranceClaimNumber = merged.insuranceClaimNumber;
      updates.estimatedDamages = merged.estimatedDamages;
      updates.financialExposure = merged.financialExposure;
      updates.canAffordAttorney = merged.canAffordAttorney;
      break;
    case "witnesses":
      updates.witnesses = merged.witnesses;
      updates.evidenceItems = merged.evidenceItems;
      updates.policeReportFiled = merged.policeReportFiled;
      updates.policeReportNumber = merged.policeReportNumber;
      updates.hasDigitalEvidence = merged.hasDigitalEvidence;
      updates.evidenceCustody = merged.evidenceCustody;
      break;
    case "guidance":
      updates.questionsAnswered = merged.questionsAnswered;
      updates.generalInfoProvided = merged.generalInfoProvided;
      updates.referralNeeded = merged.referralNeeded;
      updates.referralAccepted = merged.referralAccepted;
      updates.userSatisfied = merged.userSatisfied;
      break;
    case "wrapup":
      updates.disclaimerInjected = merged.disclaimerInjected;
      updates.nextStepsProvided = merged.nextStepsProvided;
      updates.sessionClosed = merged.sessionClosed;
      break;
    case "done":
      break;
  }
}

// ---------------------------------------------------------------------------
// passiveCrossPhaseCapture
// When users volunteer info from future phases early (e.g. "I have insurance"
// during intake), capture it so those phases can transition faster and the
// speaker doesn't re-ask for things already mentioned.
// Only sets fields that are currently empty — never overwrites.
// ---------------------------------------------------------------------------

function passiveCrossPhaseCapture(
  merged: LegalAgentState,
  out: Record<string, unknown>,
  currentPhase: Phase
): void {
  // Helper: read both direct key and _passive_ prefixed key
  const p = (key: string) => out[`_passive_${key}`] ?? out[key];

  // From intake: passively capture situation fields
  if (currentPhase === "intake") {
    if (isNonEmptyString(p("incidentSummary")) && !isSet(merged.incidentSummary))
      merged.incidentSummary = p("incidentSummary") as string;
    if (isNonEmptyString(p("incidentDate")) && !isSet(merged.incidentDate))
      merged.incidentDate = p("incidentDate") as string;
    if (isNonEmptyString(p("incidentLocation")) && !isSet(merged.incidentLocation))
      merged.incidentLocation = p("incidentLocation") as string;
    if (isNonEmptyString(p("clientRole")) && !isSet(merged.clientRole))
      merged.clientRole = p("clientRole") as string;
    if (isNonEmptyString(p("timeline")) && !isSet(merged.timeline))
      merged.timeline = p("timeline") as string;
    const parties = p("partiesInvolved");
    if (Array.isArray(parties) && parties.length > 0)
      merged.partiesInvolved = dedupe([...merged.partiesInvolved, ...(parties as unknown[]).filter(isNonEmptyString) as string[]]);
    const evidence = p("evidenceNoted");
    if (Array.isArray(evidence) && evidence.length > 0)
      merged.evidenceNoted = dedupe([...merged.evidenceNoted, ...(evidence as unknown[]).filter(isNonEmptyString) as string[]]);
  }

  // From intake or situation: passively capture insurance/financial fields
  if (currentPhase === "intake" || currentPhase === "situation") {
    if (isValidString(p("insuranceCoverageType"), ["auto","homeowners","renters","health","liability","workers-comp","none","unknown"]) && !isSet(merged.insuranceCoverageType))
      merged.insuranceCoverageType = p("insuranceCoverageType") as InsuranceCoverageType;
    if (typeof p("canAffordAttorney") === "boolean" && merged.canAffordAttorney === null)
      merged.canAffordAttorney = p("canAffordAttorney") as boolean;
    if (typeof p("insuranceClaimFiled") === "boolean" && merged.insuranceClaimFiled === null)
      merged.insuranceClaimFiled = p("insuranceClaimFiled") as boolean;
    if (isNonEmptyString(p("estimatedDamages")) && !isSet(merged.estimatedDamages))
      merged.estimatedDamages = p("estimatedDamages") as string;
  }

  // From any phase before witnesses: passively capture police/evidence fields
  if (currentPhase === "intake" || currentPhase === "situation" || currentPhase === "insurance") {
    if (typeof p("policeReportFiled") === "boolean" && merged.policeReportFiled === null)
      merged.policeReportFiled = p("policeReportFiled") as boolean;
    if (typeof p("hasDigitalEvidence") === "boolean" && merged.hasDigitalEvidence === null)
      merged.hasDigitalEvidence = p("hasDigitalEvidence") as boolean;
  }
}

// ---------------------------------------------------------------------------
// copyPassiveFields
// Copies passively-captured cross-phase fields from merged → updates.
// ---------------------------------------------------------------------------

function copyPassiveFields(
  merged: LegalAgentState,
  updates: Partial<LegalAgentState>,
  currentPhase: Phase
): void {
  if (currentPhase === "intake") {
    updates.incidentSummary  = merged.incidentSummary;
    updates.incidentDate     = merged.incidentDate;
    updates.incidentLocation = merged.incidentLocation;
    updates.clientRole       = merged.clientRole;
    updates.timeline         = merged.timeline;
    updates.partiesInvolved  = merged.partiesInvolved;
    updates.evidenceNoted    = merged.evidenceNoted;
  }
  if (currentPhase === "intake" || currentPhase === "situation") {
    updates.insuranceCoverageType = merged.insuranceCoverageType;
    updates.canAffordAttorney     = merged.canAffordAttorney;
    updates.insuranceClaimFiled   = merged.insuranceClaimFiled;
    updates.estimatedDamages      = merged.estimatedDamages;
  }
  if (currentPhase === "intake" || currentPhase === "situation" || currentPhase === "insurance") {
    updates.policeReportFiled  = merged.policeReportFiled;
    updates.hasDigitalEvidence = merged.hasDigitalEvidence;
  }
}

// ---------------------------------------------------------------------------
// computeRiskFlags
// Recomputed from scratch every turn. Flags can appear and clear.
// Domain-aware: some flags only apply to criminal, others to civil.
// ---------------------------------------------------------------------------

export function computeRiskFlags(state: LegalAgentState): string[] {
  const flags: string[] = [];
  const phase = state.currentPhase;
  const isCriminal = state.legalDomain === "criminal";
  const isCivil = state.legalDomain === "civil";
  const pastIntake = phase !== "intake" && phase !== "done";
  const pastSituation = !["intake", "situation", "done"].includes(phase);
  const atOrPastGuidance = ["guidance", "wrapup", "done"].includes(phase);

  // --- Urgency flags (always active) ---
  if (state.urgencyLevel === "emergency")
    flags.push("URGENT: Emergency situation — immediate attention required");

  if (state.urgencyLevel === "urgent")
    flags.push("Urgent: Court date or hard deadline imminent");

  // --- Jurisdiction ---
  if (!isSet(state.jurisdiction) && pastIntake)
    flags.push("Jurisdiction not confirmed — required for accurate guidance");

  // --- Client role ---
  if (!isSet(state.clientRole) && pastSituation)
    flags.push("Client role not established (defendant / plaintiff / victim)");

  // --- Criminal-specific ---
  if (isCriminal) {
    if (
      state.legalIssueType === "criminal-homicide" ||
      state.legalIssueType === "criminal-sex-offense"
    )
      flags.push("High-severity criminal charge — immediate attorney referral strongly recommended");

    if (state.legalIssueType === "criminal-domestic-violence")
      flags.push("Domestic violence case — safety assessment recommended");

    if (state.priorLegalAction === true && pastSituation)
      flags.push("Prior legal action noted — attorney must review prior case history");
  }

  // --- Civil-specific ---
  if (isCivil) {
    if (!isSet(state.estimatedDamages) && atOrPastGuidance)
      flags.push("Civil case: estimated damages not captured");

    if (state.insuranceCoverageType === "" && atOrPastGuidance)
      flags.push("Insurance coverage not determined for civil case");
  }

  // --- Evidence & witnesses ---
  if (
    state.evidenceNoted.length === 0 &&
    state.evidenceItems.length === 0 &&
    atOrPastGuidance
  )
    flags.push("No evidence documented — case may be difficult to pursue");

  if (state.witnesses.length === 0 && atOrPastGuidance && isCriminal)
    flags.push("No witnesses recorded for criminal case");

  if (state.uploadedFiles.length === 0 && phase === "wrapup")
    flags.push("No photo or video evidence uploaded");

  // --- Police report ---
  if (state.policeReportFiled === false && isCriminal && atOrPastGuidance)
    flags.push("No police report filed — may affect criminal case");

  if (state.policeReportFiled === false && isCivil && atOrPastGuidance)
    flags.push("No police report filed — may be required for civil claim");

  // --- Informal settlement / cash offer detection ---
  // Scan recent user messages for patterns indicating a defendant has offered money
  const recentUserMessages = state.messages
    .filter(m => m.role === "user")
    .slice(-12)
    .map(m => m.content.toLowerCase());
  const settlementKeywords = ["offered", "offering", "cash offer", "pay me", "pay you", "settlement", "hush money", "paying me", "gave me money"];
  const hasCashOfferContext = recentUserMessages.some(text =>
    settlementKeywords.some(kw => text.includes(kw)) &&
    (text.includes("$") || text.includes("dollar") || text.includes("money") || text.includes("cash") || text.includes("paid") || text.includes("amount"))
  );
  if (hasCashOfferContext) {
    flags.push("CRITICAL: Informal settlement offer detected — advise client NOT to accept any payment or sign anything before consulting an attorney");
  }

  // --- Attorney referral ---
  if (state.referralNeeded === true && state.referralAccepted === false)
    flags.push("Attorney referral recommended but declined by client");

  if (state.referralNeeded === true && state.referralAccepted === true)
    flags.push("Attorney referral accepted — follow-up required");

  if (state.canAffordAttorney === false && state.referralNeeded === true)
    flags.push("Client cannot afford attorney — consider legal aid referral");

  // --- Stuck session ---
  if (state.turnCount > 30 && phase === "intake")
    flags.push("Session may be stuck — client has not completed intake after 30 turns");

  return flags;
}

// ---------------------------------------------------------------------------
// applyWrapupScoring
// Runs once when transitioning into wrapup. Writes scores + facts to updates.
// These are heuristic MVP scores. Replace with LLM scoring call in production.
// ---------------------------------------------------------------------------

function applyWrapupScoring(
  state: LegalAgentState,
  updates: Partial<LegalAgentState>
): void {
  const scores = computeScores(state);
  updates.liabilityScore = scores.liability;
  updates.caseStrengthScore = scores.strength;
  updates.settlementLikelihoodScore = scores.settlement;
  updates.statuteOfLimitationsFlag = scores.statuteFlag;
  updates.extractedFacts = extractFacts(state);
}

// ---------------------------------------------------------------------------
// computeScores
// Heuristic scoring across 4 Litmetrics dimensions.
// ---------------------------------------------------------------------------

function computeScores(state: LegalAgentState): {
  liability: number;
  strength: number;
  settlement: number;
  statuteFlag: string;
} {
  const isCriminal = state.legalDomain === "criminal";
  const isCivil = state.legalDomain === "civil";

  // --- Liability score (how much legal exposure / complexity exists) ---
  let liability = 50;

  if (state.urgencyLevel === "emergency") liability += 15;
  if (state.urgencyLevel === "urgent")    liability += 8;

  if (state.partiesInvolved.length > 2)  liability += 8;
  else if (state.partiesInvolved.length > 1) liability += 4;

  if (state.referralNeeded)              liability += 10;
  if (state.priorLegalAction)            liability += 8;

  if (
    state.legalIssueType === "criminal-homicide" ||
    state.legalIssueType === "criminal-sex-offense"
  ) liability += 20;

  if (
    state.legalIssueType === "criminal-domestic-violence" ||
    state.legalIssueType === "criminal-white-collar"
  ) liability += 12;

  if (state.legalIssueType === "civil-medical-malpractice") liability += 12;
  if (state.legalIssueType === "civil-civil-rights")        liability += 10;

  // --- Case strength score (how well-supported the client's case is) ---
  let strength = 40;

  // Evidence
  strength += clamp(state.evidenceNoted.length * 4, 0, 16);
  strength += clamp(state.evidenceItems.length * 5, 0, 20);
  strength += clamp(state.uploadedFiles.length * 6, 0, 18);

  // Witnesses
  strength += clamp(state.witnesses.length * 5, 0, 15);
  const hasExpertWitness = state.witnesses.some((w) => w.type === "expert");
  if (hasExpertWitness) strength += 8;

  // Police report
  if (state.policeReportFiled === true) strength += 8;

  // Insurance claim filed (civil — shows documented harm)
  if (isCivil && state.insuranceClaimFiled === true) strength += 6;

  // Digital evidence
  if (state.hasDigitalEvidence === true) strength += 6;

  // Prior legal action (cuts both ways — shows pattern but adds complexity)
  if (state.priorLegalAction === true) strength -= 5;

  // --- Settlement likelihood (civil only; criminal gets 0) ---
  let settlement = 0;
  if (isCivil) {
    settlement = 35; // civil baseline
    if (state.urgencyLevel === "urgent" || state.urgencyLevel === "emergency") settlement += 10;
    if (state.insuranceCoverageType !== "" && state.insuranceCoverageType !== "none") settlement += 12;
    if (state.insuranceClaimFiled === true) settlement += 8;
    if (state.evidenceItems.length > 2) settlement += 10;
    if (state.uploadedFiles.length > 0) settlement += 8;
    if (state.legalIssueType === "civil-personal-injury")   settlement += 10;
    if (state.legalIssueType === "civil-medical-malpractice") settlement += 8;
    if (state.legalIssueType === "civil-employment")        settlement += 6;
    // Complexity reduces settlement likelihood
    if (state.partiesInvolved.length > 3) settlement -= 8;
    if (state.priorLegalAction === true)  settlement -= 6;
  }

  // --- Statute of limitations flag ---
  // Heuristic only — production should use jurisdiction + issue type + incident date
  // to compute actual SoL deadline. For MVP, flag based on urgency + time cues.
  let statuteFlag = "ok";
  if (state.urgencyLevel === "emergency") {
    statuteFlag = "critical";
  } else if (state.urgencyLevel === "urgent") {
    statuteFlag = "warning";
  } else if (
    isCivil &&
    isSet(state.incidentDate) &&
    approximatelyOlderThanOneYear(state.incidentDate)
  ) {
    // Many civil SoL are 1–3 years — flag for attorney review
    statuteFlag = "warning";
  }

  return {
    liability:    clamp(liability,   0, 100),
    strength:     clamp(strength,    0, 100),
    settlement:   clamp(settlement,  0, 100),
    statuteFlag,
  };
}

// ---------------------------------------------------------------------------
// extractFacts
// Builds the structured fact list for the Litmetrics dashboard.
// Runs once on wrapup entry alongside computeScores.
// ---------------------------------------------------------------------------

export function extractFacts(state: LegalAgentState): string[] {
  const facts: string[] = [];

  if (isSet(state.legalDomain))      facts.push(`Legal domain: ${state.legalDomain}`);
  if (isSet(state.legalIssueType))   facts.push(`Legal issue: ${state.legalIssueType}`);
  if (isSet(state.jurisdiction))     facts.push(`Jurisdiction: ${state.jurisdiction}`);
  if (isSet(state.urgencyLevel))     facts.push(`Urgency: ${state.urgencyLevel}`);
  if (isSet(state.clientRole))       facts.push(`Client role: ${state.clientRole}`);
  if (isSet(state.incidentSummary))  facts.push(`Incident: ${state.incidentSummary}`);
  if (isSet(state.incidentDate))     facts.push(`Incident date: ${state.incidentDate}`);
  if (isSet(state.incidentLocation)) facts.push(`Location: ${state.incidentLocation}`);
  if (isSet(state.timeline))         facts.push(`Timeline: ${state.timeline}`);

  for (const p of state.partiesInvolved)
    facts.push(`Party: ${p}`);

  for (const e of state.evidenceNoted)
    facts.push(`Evidence noted: ${e}`);

  for (const item of state.evidenceItems)
    facts.push(`Evidence item: ${item.description} (${item.type})${item.inPossession ? " — in client possession" : ""}`);

  for (const w of state.witnesses)
    facts.push(`Witness: ${w.name} (${w.type})${w.contactAvailable ? " — contact available" : ""}`);

  if (state.policeReportFiled !== null)
    facts.push(`Police report filed: ${state.policeReportFiled ? "yes" : "no"}${isSet(state.policeReportNumber) ? ` — #${state.policeReportNumber}` : ""}`);

  if (state.priorLegalAction !== null)
    facts.push(`Prior legal action: ${state.priorLegalAction ? "yes" : "no"}${isSet(state.priorLegalActionDetails) ? ` — ${state.priorLegalActionDetails}` : ""}`);

  if (isSet(state.insuranceCoverageType))
    facts.push(`Insurance: ${state.insuranceCoverageType}${isSet(state.insuranceProvider) ? ` via ${state.insuranceProvider}` : ""}`);

  if (isSet(state.estimatedDamages))
    facts.push(`Estimated damages: ${state.estimatedDamages}`);

  if (isSet(state.financialExposure))
    facts.push(`Financial exposure: ${state.financialExposure}`);

  if (state.canAffordAttorney !== null)
    facts.push(`Can afford attorney: ${state.canAffordAttorney ? "yes" : "no"}`);

  if (state.referralNeeded !== null)
    facts.push(`Referral needed: ${state.referralNeeded ? "yes" : "no"}`);

  if (state.referralAccepted !== null)
    facts.push(`referral accepted: ${state.referralAccepted ? "yes" : "no"}`);

  for (const q of state.questionsAnswered)
    facts.push(`Question addressed: ${q}`);

  for (const f of state.uploadedFiles)
    facts.push(`Uploaded file: ${f.originalName} — ${f.description}`);

  return facts;
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isValidString(v: unknown, allowed: string[]): boolean {
  return typeof v === "string" && allowed.includes(v);
}

function looksLikeSSN(s: string): boolean {
  // Reject anything matching XXX-XX-XXXX or 9 consecutive digits
  return /^\d{3}-\d{2}-\d{4}$/.test(s) || /^\d{9}$/.test(s);
}

function isWitnessShape(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    isNonEmptyString((v as Record<string, unknown>).name)
  );
}

function isEvidenceItemShape(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    isNonEmptyString((v as Record<string, unknown>).description)
  );
}

function normaliseWitness(v: Record<string, unknown>): Witness {
  const validWitnessTypes: WitnessType[] = ["eyewitness", "expert", "character", "other"];
  return {
    name: String(v.name ?? "unknown"),
    type: validWitnessTypes.includes(v.type as WitnessType)
      ? (v.type as WitnessType)
      : "other",
    contactAvailable:
      typeof v.contactAvailable === "boolean" ? v.contactAvailable : null,
    notes: isNonEmptyString(v.notes) ? (v.notes as string) : "",
  };
}

function normaliseEvidenceItem(v: Record<string, unknown>): EvidenceItem {
  const validTypes: EvidenceType[] = [
    "photo", "video", "document", "physical", "digital", "testimony", "other",
  ];
  return {
    description: String(v.description ?? ""),
    type: validTypes.includes(v.type as EvidenceType)
      ? (v.type as EvidenceType)
      : "other",
    inPossession:
      typeof v.inPossession === "boolean" ? v.inPossession : null,
    notes: isNonEmptyString(v.notes) ? (v.notes as string) : "",
  };
}

/**
 * Heuristic: returns true if the free-text date string appears to reference
 * something older than ~1 year. Used for SoL flag in MVP.
 * Production should use a proper date parser + jurisdiction SoL lookup.
 */
function approximatelyOlderThanOneYear(dateStr: string): boolean {
  // Look for 4-digit years in the string
  const yearMatch = dateStr.match(/\b(20\d{2})\b/);
  if (!yearMatch) return false;
  const year = parseInt(yearMatch[1], 10);
  const currentYear = new Date().getFullYear();
  return currentYear - year >= 1;
}
