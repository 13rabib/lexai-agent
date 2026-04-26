// =============================================================================
// src/error_recovery.ts
// LexAI Legal Intake Agent — Error Recovery
//
// Defines fallback behaviour for every failure mode in the pipeline.
// All user-facing messages are calm, brief, and always offer a next action.
// Stack traces and technical details are never surfaced to clients.
//
// Failure modes covered:
//   1.  Analyzer LLM returns unparseable output
//   2.  Analyzer LLM returns wrong-phase fields (handled in orchestrator)
//   3.  Speaker LLM times out or fails
//   4.  File upload fails (disk write / MIME type error)
//   5.  File analysis fails (vision API error)
//   6.  SQLite write fails
//   7.  Session not found (stale client)
//   8.  Phase stuck (maxTurns reached without completion — handled in orchestrator)
//   9.  STT (speech-to-text) transcription fails  [voice-specific]
//   10. TTS (text-to-speech) synthesis fails       [voice-specific]
// =============================================================================

import type { Phase, LegalAgentState } from "../state/schema";

// ---------------------------------------------------------------------------
// Allowed upload MIME types (photos and video evidence only)
// ---------------------------------------------------------------------------

export const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",   // .avi
  "video/webm",
]);

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Speaker fallback replies — one per phase
// Returned when the Speaker LLM times out or fails entirely.
// phaseTurnCount is NOT incremented on a fallback turn (free turn policy).
// ---------------------------------------------------------------------------

export const SPEAKER_FALLBACK_REPLIES: Record<Phase, string> = {
  intake:
    "I wasn't able to pull that information right now, but I'll get it for you. " +
    "Could you tell me a bit more about your situation in the meantime?",

  situation:
    "I wasn't able to retrieve that just now — I'll get it for you shortly. " +
    "Could you continue telling me what happened?",

  insurance:
    "I wasn't able to pull that right now. Could you tell me about your insurance " +
    "coverage in the meantime?",

  witnesses:
    "I wasn't able to retrieve that just now. Could you tell me about any evidence " +
    "or witnesses you have while I sort that out?",

  guidance:
    "I encountered a brief technical issue. Could you repeat your question " +
    "and I'll do my best to help?",

  wrapup:
    "Almost done — just a brief technical pause. Thank you for your patience. " +
    "We're nearly finished.",

  done:
    "This session has ended. Please start a new session if you need further help.",
};

// ---------------------------------------------------------------------------
// getSpeakerFallbackReply
// Returns the appropriate fallback reply for the current phase.
// ---------------------------------------------------------------------------

export function getSpeakerFallbackReply(phase: Phase): string {
  return SPEAKER_FALLBACK_REPLIES[phase] ?? SPEAKER_FALLBACK_REPLIES.intake;
}

// ---------------------------------------------------------------------------
// File upload error responses
// ---------------------------------------------------------------------------

export interface FileUploadError {
  httpStatus: 400 | 413 | 415 | 500;
  userMessage: string;
  logMessage: string;
}

export function getFileUploadError(
  reason: "mime" | "size" | "disk" | "unknown",
  context?: { fileName?: string; mimeType?: string; sizeBytes?: number }
): FileUploadError {
  switch (reason) {
    case "mime":
      return {
        httpStatus: 415,
        userMessage:
          "This file type isn't supported. Please upload a photo (JPEG, PNG, WEBP, HEIC) " +
          "or video (MP4, MOV, AVI, WEBM) as evidence.",
        logMessage:
          `[FileUpload] Unsupported MIME type: ${context?.mimeType ?? "unknown"} ` +
          `for file: ${context?.fileName ?? "unknown"}`,
      };

    case "size":
      return {
        httpStatus: 413,
        userMessage:
          "That file is too large to upload. Please keep files under 50 MB. " +
          "If you have a large video, try trimming it to the key moments.",
        logMessage:
          `[FileUpload] File too large: ${((context?.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MB ` +
          `for file: ${context?.fileName ?? "unknown"}`,
      };

    case "disk":
      return {
        httpStatus: 500,
        userMessage:
          "We weren't able to save your file due to a technical issue. " +
          "Please try again in a moment.",
        logMessage:
          `[FileUpload] Disk write error for file: ${context?.fileName ?? "unknown"}`,
      };

    case "unknown":
    default:
      return {
        httpStatus: 500,
        userMessage:
          "Something went wrong while uploading your file. Please try again.",
        logMessage:
          `[FileUpload] Unknown error for file: ${context?.fileName ?? "unknown"}`,
      };
  }
}

// ---------------------------------------------------------------------------
// File analysis fallback
// Used when the vision API call fails or returns unusable output.
// The file record is still saved — session continues normally.
// ---------------------------------------------------------------------------

export function getFileAnalysisFallbackDescription(originalName: string): string {
  return `${originalName} — uploaded to case file.`;
}

// ---------------------------------------------------------------------------
// SQLite error responses
// ---------------------------------------------------------------------------

export interface DatabaseError {
  httpStatus: 500;
  userMessage: string;
  logMessage: string;
}

export function getDatabaseError(
  operation: "read" | "write" | "unknown",
  context?: { sessionId?: string; turnCount?: number }
): DatabaseError {
  const sessionRef = context?.sessionId
    ? ` (session: ${context.sessionId})`
    : "";
  const turnRef = context?.turnCount !== undefined
    ? ` turn ${context.turnCount}`
    : "";

  return {
    httpStatus: 500,
    userMessage:
      "We encountered a technical issue. Your message was received but may not " +
      "have been saved. Please try sending it again.",
    logMessage:
      `[Database] ${operation} error${sessionRef}${turnRef}`,
  };
}

// ---------------------------------------------------------------------------
// Session not found
// ---------------------------------------------------------------------------

export const SESSION_NOT_FOUND_RESPONSE = {
  httpStatus: 404 as const,
  body: {
    error: "Session not found. Please start a new session.",
  },
};

// ---------------------------------------------------------------------------
// STT (speech-to-text) transcription failure  [voice mode]
// ---------------------------------------------------------------------------

export const STT_FALLBACK = {
  userMessage:
    "I didn't catch that — could you please repeat what you said?",
  logPrefix: "[STT]",
};

export function getSTTError(context?: { sessionId?: string }): {
  userMessage: string;
  logMessage: string;
} {
  return {
    userMessage: STT_FALLBACK.userMessage,
    logMessage: `${STT_FALLBACK.logPrefix} Transcription failed${context?.sessionId ? ` (session: ${context.sessionId})` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// TTS (text-to-speech) synthesis failure  [voice mode]
// Falls back to returning the text transcript so the chat UI can display it.
// ---------------------------------------------------------------------------

export const TTS_FALLBACK_NOTE =
  "(Voice playback is temporarily unavailable. Please read the response above.)";

export function getTTSError(context?: { sessionId?: string }): {
  fallbackNote: string;
  logMessage: string;
} {
  return {
    fallbackNote: TTS_FALLBACK_NOTE,
    logMessage: `[TTS] Synthesis failed${context?.sessionId ? ` (session: ${context.sessionId})` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Stuck session detection
// Called by the orchestrator's computeRiskFlags — not directly from here.
// Defined here for centralised threshold management.
// ---------------------------------------------------------------------------

export const STUCK_SESSION_TURN_THRESHOLD = 30;

export function isSessionStuck(state: LegalAgentState): boolean {
  return (
    state.turnCount > STUCK_SESSION_TURN_THRESHOLD &&
    state.currentPhase === "intake"
  );
}

export const STUCK_SESSION_FLAG =
  "Session may be stuck — client has not completed intake after 30 turns. Manual follow-up recommended.";

// ---------------------------------------------------------------------------
// Rate limit / quota exhausted
// ---------------------------------------------------------------------------

export const RATE_LIMIT_ERROR = {
  httpStatus: 429 as const,
  userMessage:
    "We're experiencing high demand right now. Please wait a moment and try again.",
  logPrefix: "[RateLimit]",
};

// ---------------------------------------------------------------------------
// Generic pipeline error (catch-all)
// Used when an unexpected error reaches the top-level handler.
// ---------------------------------------------------------------------------

export const PIPELINE_ERROR = {
  httpStatus: 500 as const,
  userMessage:
    "Something unexpected went wrong. Your session is still active — " +
    "please try sending your message again.",
  logPrefix: "[Pipeline]",
};

// ---------------------------------------------------------------------------
// Error logging utility
// Centralises all error output. Replace with your preferred logger (Winston,
// Pino, Datadog, etc.) by swapping the implementation here.
// ---------------------------------------------------------------------------

export function logError(
  prefix: string,
  message: string,
  error?: unknown
): void {
  const timestamp = new Date().toISOString();
  const errorDetail =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : error !== undefined
        ? String(error)
        : "";

  console.error(
    `[${timestamp}] ${prefix} ${message}${errorDetail ? `\n  ${errorDetail}` : ""}`
  );
}

export function logWarn(prefix: string, message: string): void {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] ${prefix} ${message}`);
}

export function logInfo(prefix: string, message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ---------------------------------------------------------------------------
// validateUploadedFile
// Call before writing to disk. Returns null on success, FileUploadError on failure.
// ---------------------------------------------------------------------------

export function validateUploadedFile(
  fileName: string,
  mimeType: string,
  sizeBytes: number
): FileUploadError | null {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return getFileUploadError("mime", { fileName, mimeType });
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return getFileUploadError("size", { fileName, sizeBytes });
  }
  return null;
}
