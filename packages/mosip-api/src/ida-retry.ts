import { FastifyInstance } from "fastify";
import type { VerifyNidResult } from "@opencrvs/mosip/api";
import * as db from "./database";
import { env } from "./constants";
import { runVerification } from "./routes/verify";

/*
 * A durable timer, holding no business logic: it decides when to retry a parked
 * verification and hands it back to country config, which owns the decision.
 * Mirrors batch-retry.ts but on its own table.
 */

/** What country config did with a job we handed back to it. */
export type RetryOutcome =
  /** IDA answered; the action has been accepted or rejected. Job is done. */
  | "resolved"
  /** IDA is still unreachable. Job stays queued. */
  | "retry"
  /** The job can never complete (e.g. the action is already confirmed). Drop it. */
  | "dropped";

type ProcessResponse = {
  outcome?: RetryOutcome;
  decision?: "accepted" | "rejected";
  error?: string;
};

const isProcessResponse = (body: unknown): body is ProcessResponse =>
  typeof body === "object" && body !== null;

const hoursSince = (timestamp: string) => {
  // SQLite `datetime('now')` is UTC without a zone designator
  const created = Date.parse(`${timestamp.replace(" ", "T")}Z`);
  if (Number.isNaN(created)) {
    return 0;
  }
  return (Date.now() - created) / 3_600_000;
};

/** On the final attempt country config finalises instead of deferring again. */
const isFinalAttempt = (job: db.PendingVerification) =>
  job.retryCount + 1 >= env.IDA_RETRY_MAX_ATTEMPTS ||
  hoursSince(job.createdAt) >= env.IDA_RETRY_MAX_AGE_HOURS;

/**
 * Replays the calls that could not be completed, merging them into the verdicts
 * already obtained. Returns undefined as soon as IDA is unreachable again: a
 * partial set cannot complete the action.
 */
const replayPendingRequests = async (
  app: FastifyInstance,
  job: db.PendingVerification,
): Promise<Record<string, VerifyNidResult> | undefined> => {
  const verified = { ...job.verified } as Record<string, VerifyNidResult>;

  for (const request of job.pendingRequests ?? []) {
    try {
      const { status, reasons } = await runVerification(
        request as unknown as Parameters<typeof runVerification>[0],
      );

      if (request.transactionId) {
        verified[request.transactionId] = { status, reasons };
      }
    } catch (error) {
      app.log.warn(
        {
          jobId: job.id,
          eventId: job.eventId,
          transactionId: request.transactionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "⏳ IDA still unavailable while replaying a pending verification",
      );

      return undefined;
    }
  }

  return verified;
};

/** Flattens the verdicts into `page=status(reasons)` for one readable log line. */
const summariseVerdicts = (verified: Record<string, VerifyNidResult>) =>
  Object.entries(verified).map(([transactionId, result]) =>
    result.status === "failed"
      ? `${transactionId}=failed(${(result.reasons ?? []).join("|")})`
      : `${transactionId}=${result.status}`,
  );

const callCountryConfig = async (
  job: db.PendingVerification,
  finalAttempt: boolean,
  verified?: Record<string, VerifyNidResult>,
) => {
  const url = new URL("/ida-retry/process", env.COUNTRY_CONFIG_URL).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${job.token}`,
    },
    body: JSON.stringify({
      eventId: job.eventId,
      actionId: job.actionId,
      eventType: job.eventType,
      actionType: job.actionType,
      attempt: job.retryCount + 1,
      finalAttempt,
      // The re-run serves these from cache instead of calling IDA again.
      ...(verified ? { verified } : {}),
    }),
    signal: AbortSignal.timeout(env.IDA_RETRY_CALLBACK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Country config returned ${response.status}: ${await response.text()}`,
    );
  }

  const body: unknown = await response.json();

  if (!isProcessResponse(body) || !body.outcome) {
    throw new Error("Country config returned no outcome");
  }

  return body;
};

/**
 * Hands one job back and applies the result.
 * @param forceFinal - Operator override to unblock a stalled record.
 */
export const processVerificationJob = async (
  app: FastifyInstance,
  job: db.PendingVerification,
  forceFinal = false,
): Promise<{ outcome: RetryOutcome; error?: string }> => {
  const finalAttempt = forceFinal || isFinalAttempt(job);

  try {
    let verified: Record<string, VerifyNidResult> | undefined;

    if (job.pendingRequests?.length) {
      verified = await replayPendingRequests(app, job);

      if (!verified && !finalAttempt) {
        db.reschedulePendingVerification(
          job.id,
          "IDA still unavailable",
          env.IDA_RETRY_BACKOFF_BASE_MINUTES,
        );

        return { outcome: "retry", error: "IDA still unavailable" };
      }
    }


    const { outcome, decision, error } = await callCountryConfig(
      job,
      finalAttempt,
      verified,
    );

    if (outcome === "resolved" || outcome === "dropped") {
      db.removePendingVerification(job.id);

      // Records the verdict, not just that the job finished.
      app.log.info(
        {
          jobId: job.id,
          eventId: job.eventId,
          attempt: job.retryCount + 1,
          finalAttempt,
          outcome,
          decision,
          verifications: verified && summariseVerdicts(verified),
          lastError: error ?? job.lastError,
        },
        outcome === "dropped"
          ? "✅ IDA verification job dropped, already confirmed elsewhere"
          : `✅ IDA verification resolved (${decision ?? "unknown"}), job removed`,
      );

      return { outcome };
    }

    db.reschedulePendingVerification(
      job.id,
      error ?? "IDA still unavailable",
      env.IDA_RETRY_BACKOFF_BASE_MINUTES,
    );

    app.log.warn(
      {
        jobId: job.id,
        eventId: job.eventId,
        attempt: job.retryCount + 1,
        error,
      },
      "⏳ IDA still unavailable, verification stays queued",
    );

    return { outcome: "retry", error };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error while retrying IDA verification";

    db.reschedulePendingVerification(
      job.id,
      message,
      env.IDA_RETRY_BACKOFF_BASE_MINUTES,
    );

    // Kept rather than dropped: dropping strands the record in
    // validate:requested. /debug/ida-retry/:id/resolve is the escape hatch.
    const context = {
      jobId: job.id,
      eventId: job.eventId,
      attempt: job.retryCount + 1,
      finalAttempt,
      error: message,
    };

    if (finalAttempt) {
      app.log.error(
        context,
        "🚨 IDA verification past its final attempt could not be handed back, needs attention",
      );
    } else {
      app.log.warn(
        context,
        "⚠️  IDA verification retry failed, will retry again later",
      );
    }

    return { outcome: "retry", error: message };
  }
};

/** Processes one batch sequentially, so a recovering IDA is not stampeded. */
export const processPendingVerifications = async (
  app: FastifyInstance,
  limit = env.IDA_RETRY_BATCH_LIMIT,
) => {
  const jobs = db.claimPendingVerifications(limit, env.IDA_RETRY_LEASE_MINUTES);

  if (jobs.length === 0) {
    return { processed: 0, resolved: 0, requeued: 0, dropped: 0 };
  }

  app.log.info(
    { count: jobs.length, queueDepth: db.countPendingVerifications() },
    "Processing pending IDA verifications",
  );

  let resolved = 0;
  let requeued = 0;
  let dropped = 0;

  for (const job of jobs) {
    const { outcome } = await processVerificationJob(app, job);

    if (outcome === "resolved") resolved++;
    else if (outcome === "dropped") dropped++;
    else requeued++;
  }

  app.log.info(
    { processed: jobs.length, resolved, requeued, dropped },
    "IDA verification retry job completed",
  );

  return { processed: jobs.length, resolved, requeued, dropped };
};

/** Returns undefined when disabled; parked rows simply wait. */
export const startIdaRetryJob = (
  app: FastifyInstance,
  intervalMs = env.IDA_RETRY_INTERVAL_MS,
  enabled = env.IDA_RETRY_ENABLED,
) => {
  if (!enabled) {
    app.log.info(
      "IDA verification retry job disabled (IDA_RETRY_ENABLED=false)",
    );
    return undefined;
  }

  app.log.info({ intervalMs }, "Starting IDA verification retry scheduler");

  return setInterval(async () => {
    try {
      await processPendingVerifications(app);
    } catch (error) {
      app.log.error("IDA verification retry job error:", error);
    }
  }, intervalMs);
};
