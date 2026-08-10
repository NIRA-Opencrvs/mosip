import type { VerificationReasonCode } from "@opencrvs/mosip/api";

type IdaError = { errorCode: string; errorMessage?: string };

/**
 * Maps a single IDA error to a stable reason code.
 *
 * - `IDA-MLC-018` means the supplied NIN has no record ("HANDLE not available
 *   in database"). "HANDLE" is an IDA implementation detail and must never
 *   surface, so it maps to NIN_NOT_FOUND.
 * - `IDA-DEA-001` is a generic demographic mismatch; the specific attribute is
 *   derived from a keyword in the accompanying message (`dob` / `name` /
 *   `gender`) rather than matching the full, variable message text.
 *
 * Anything unrecognised (an unknown code, or a DEA-001 whose message has no
 * known keyword) maps to UNKNOWN.
 */
function mapSingleIdaError(error: IdaError): VerificationReasonCode {
  if (error.errorCode === "IDA-MLC-018") {
    return "NIN_NOT_FOUND";
  }

  if (error.errorCode === "IDA-DEA-001" || error.errorCode === "IDA-DEA-003") {
    const message = error.errorMessage?.toLowerCase() ?? "";
    if (message.includes("dob")) return "DOB_MISMATCH";
    if (message.includes("name")) return "NAME_MISMATCH";
    if (message.includes("gender")) return "GENDER_MISMATCH";
  }

  return "UNKNOWN";
}

/**
 * Maps every IDA error to its reason code, deduplicates, and preserves the
 * order in which reasons were first seen (deterministic for a given input).
 *
 * Example: `[DOB, GENDER, DOB]` -> `[DOB_MISMATCH, GENDER_MISMATCH]`.
 *
 * The deceased business exception (IDA-MLC-032) is handled by the caller BEFORE
 * this function runs and never reaches here. Empty input yields an empty array;
 * ensuring a failed verification always has at least one reason is the caller's
 * responsibility.
 */
export function mapIdaError(
  errors: IdaError[] | undefined,
): VerificationReasonCode[] {
  const mapped = (errors ?? []).map(mapSingleIdaError);
  // Set preserves first-insertion order, giving deterministic dedup.
  // Array.from avoids needing downlevelIteration for the target.
  return Array.from(new Set(mapped));
}
