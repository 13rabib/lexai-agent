// =============================================================================
// config/phase_registry.ts
// LexAI Legal Intake Agent — Phase Registry
//
// Defines transition rules, turn limits, and labels for all 6 conversation
// phases plus the terminal "done" state.
//
// Consumed by the Orchestrator (src/orchestrator.ts) every turn.
// Never import anything from the orchestrator here — no circular deps.
// =============================================================================

import type { Phase, LegalAgentState } from "../state/schema";

// ---------------------------------------------------------------------------
// PhaseConfig interface
// ---------------------------------------------------------------------------

export interface PhaseConfig {
  /**
   * Hard turn ceiling for this phase.
   * When phaseTurnCount >= maxTurns, the Orchestrator advances regardless
   * of whether canTransition() returns true.
   * Set to 0 only for terminal states.
   */
  maxTurns: number;

  /**
   * The phase to move to when this phase completes or times out.
   */
  nextPhase: Phase;

  /**
   * Human-readable label shown in the UI progress bar and Litmetrics dashboard.
   */
  label: string;

  /**
   * Progress bar step index (0-based) for UI rendering.
   * "done" is not shown in the progress bar.
   */
  step: number;

  /**
   * Completion condition evaluated after every merge.
   * Return true when the minimum required fields for this phase are present.
   * The turn limit is the safety net — don't require perfect data here.
   */
  canTransition: (state: LegalAgentState) => boolean;

  /**
   * Optional: phases where emergency bypass applies.
   * If urgencyLevel === "emergency" and bypassable === true,
   * the Orchestrator may skip ahead to guidance immediately.
   */
  bypassable: boolean;
}

// ---------------------------------------------------------------------------
// Phase registry
// ---------------------------------------------------------------------------

export const phaseRegistry: Record<Phase, PhaseConfig> = {

  // -------------------------------------------------------------------------
  // Phase 1 — Intake
  // Goal: identify legal domain, issue type, jurisdiction, and urgency.
  // Transition: all three core fields collected.
  // Turn limit: 6 — enough for a slow or hesitant user to orient themselves.
  // -------------------------------------------------------------------------
  intake: {
    maxTurns: 4,
    nextPhase: "situation",
    label: "Initial intake",
    step: 0,
    bypassable: true,
    canTransition: (s) =>
      s.legalIssueType !== "" &&
      s.jurisdiction !== "" &&
      s.urgencyLevel !== "",
  },

  // -------------------------------------------------------------------------
  // Phase 2 — Situation
  // Goal: understand what happened, when, where, who was involved, and
  // what evidence exists. Also captures client role and prior legal action.
  // Transition: incident summary + at least one party + timeline present.
  // Turn limit: 8 — criminal cases often need more back-and-forth.
  // -------------------------------------------------------------------------
  situation: {
    maxTurns: 5,
    nextPhase: "insurance",
    label: "Your situation",
    step: 1,
    bypassable: true,
    canTransition: (s) =>
      s.incidentSummary !== "" &&
      s.partiesInvolved.length > 0 &&
      s.timeline !== "" &&
      s.clientRole !== "",
  },

  // -------------------------------------------------------------------------
  // Phase 3 — Insurance / Financial
  // Goal: understand coverage, financial exposure, and ability to retain counsel.
  // Transition: either insurance status is known OR client has indicated
  // no coverage (insuranceCoverageType === "none" | "unknown") AND
  // canAffordAttorney has been answered.
  // Turn limit: 6 — focused phase, most answers are yes/no.
  // Note: account numbers, SSN, DOB are NEVER collected.
  // -------------------------------------------------------------------------
  insurance: {
    maxTurns: 3,
    nextPhase: "witnesses",
    label: "Insurance & finances",
    step: 2,
    bypassable: false,
    canTransition: (s) =>
      s.insuranceCoverageType !== "" &&
      s.canAffordAttorney !== null,
  },

  // -------------------------------------------------------------------------
  // Phase 4 — Witness & Evidence Inventory
  // Goal: catalogue known witnesses and evidence; confirm police report status.
  // Transition: at least one evidence item OR witness logged, AND
  // policeReportFiled has been answered (even if false).
  // Turn limit: 8 — evidence inventory can be extensive in criminal cases.
  // -------------------------------------------------------------------------
  witnesses: {
    maxTurns: 4,
    nextPhase: "guidance",
    label: "Witnesses & evidence",
    step: 3,
    bypassable: false,
    canTransition: (s) =>
      (s.evidenceItems.length > 0 || s.witnesses.length > 0) &&
      s.policeReportFiled !== null,
  },

  // -------------------------------------------------------------------------
  // Phase 5 — Guidance
  // Goal: provide general legal information relevant to the case, answer
  // client questions, and determine whether a lawyer referral is appropriate
  // and accepted.
  // Transition: client has indicated satisfaction OR referral decision made.
  // Turn limit: 10 — guidance phase can involve multiple questions.
  // -------------------------------------------------------------------------
  guidance: {
    maxTurns: 10,
    nextPhase: "wrapup",
    label: "Legal guidance",
    step: 4,
    bypassable: false,
    canTransition: (s) =>
      s.userSatisfied !== null ||
      (s.referralNeeded === true && s.referralAccepted !== null),
  },

  // -------------------------------------------------------------------------
  // Phase 6 — Wrap-up
  // Goal: deliver disclaimer, confirm next steps, close session cleanly.
  // Transition: disclaimer has been injected into the conversation.
  // Turn limit: 4 — short closing phase.
  // On entry: Orchestrator runs computeScores() + extractFacts().
  // -------------------------------------------------------------------------
  wrapup: {
    maxTurns: 4,
    nextPhase: "done",
    label: "Wrapping up",
    step: 5,
    bypassable: false,
    canTransition: (s) => s.disclaimerInjected === true,
  },

  // -------------------------------------------------------------------------
  // Terminal state — session complete
  // No further transitions possible.
  // -------------------------------------------------------------------------
  done: {
    maxTurns: 0,
    nextPhase: "done",
    label: "Session complete",
    step: 6,
    bypassable: false,
    canTransition: () => false,
  },
};

// ---------------------------------------------------------------------------
// Emergency bypass rules
// ---------------------------------------------------------------------------

/**
 * Phases from which an emergency can fast-track the session to guidance.
 * Insurance and witnesses are skipped — urgency takes priority over
 * complete fact collection.
 *
 * Activated in orchestrator.ts when:
 *   urgencyLevel === "emergency" && EMERGENCY_BYPASS_PHASES.has(currentPhase)
 */
export const EMERGENCY_BYPASS_PHASES = new Set<Phase>([
  "intake",
  "situation",
  "insurance",
  "witnesses",
]);

/**
 * Target phase when emergency bypass is triggered.
 */
export const EMERGENCY_BYPASS_TARGET: Phase = "guidance";

// ---------------------------------------------------------------------------
// Progress bar helpers (for UI)
// ---------------------------------------------------------------------------

/**
 * Returns all phases in order, excluding "done" (not shown in progress bar).
 */
export const ORDERED_PHASES: Phase[] = [
  "intake",
  "situation",
  "insurance",
  "witnesses",
  "guidance",
  "wrapup",
];

/**
 * Total number of visible steps in the progress bar.
 */
export const TOTAL_STEPS = ORDERED_PHASES.length;

/**
 * Returns the 0-based step index for a given phase.
 * Returns -1 for "done".
 */
export function getPhaseStep(phase: Phase): number {
  return phaseRegistry[phase].step;
}

/**
 * Returns a progress percentage (0–100) for the progress bar.
 */
export function getProgressPercent(phase: Phase): number {
  if (phase === "done") return 100;
  return Math.round((phaseRegistry[phase].step / TOTAL_STEPS) * 100);
}

/**
 * Returns the human-readable label for a phase.
 */
export function getPhaseLabel(phase: Phase): string {
  return phaseRegistry[phase].label;
}

/**
 * Returns the next phase for a given phase.
 */
export function getNextPhase(phase: Phase): Phase {
  return phaseRegistry[phase].nextPhase;
}

/**
 * Returns true if the given phase can be bypassed in an emergency.
 */
export function isEmergencyBypassable(phase: Phase): boolean {
  return EMERGENCY_BYPASS_PHASES.has(phase);
}
