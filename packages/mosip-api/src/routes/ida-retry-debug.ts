import { FastifyReply, FastifyRequest } from "fastify";
import * as db from "../database";
import {
  processPendingVerifications,
  processVerificationJob,
} from "../ida-retry";
import { env } from "../constants";

/*
 * Operational endpoints for the IDA verification retry queue.
 *
 * Mirrors the MOSIP batch retry debug routes. These matter in production: a
 * record with a parked verification is blocked from every other action until
 * the job resolves, so operators need to be able to see the queue and force a
 * stuck record to a conclusion.
 */

type IdParams = FastifyRequest<{ Params: { id: string } }>;

/** Queue depth plus the oldest jobs, for monitoring and triage. */
export const getPendingVerificationsHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const { limit } = request.query as { limit?: string };

  const jobs = db.getAllPendingVerifications(
    limit ? parseInt(limit, 10) : env.IDA_RETRY_BATCH_LIMIT,
  );

  return reply.code(200).send({
    enabled: env.IDA_RETRY_ENABLED,
    total: db.countPendingVerifications(),
    count: jobs.length,
    // The stored token and event document are deliberately not returned
    jobs: jobs.map((job) => ({
      id: job.id,
      eventId: job.eventId,
      actionId: job.actionId,
      eventType: job.eventType,
      actionType: job.actionType,
      retryCount: job.retryCount,
      lastError: job.lastError,
      nextRetryAt: job.nextRetryAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
  });
};

/** Runs a batch immediately instead of waiting for the scheduler. */
export const triggerIdaRetryHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const { limit } = request.query as { limit?: string };

  const result = await processPendingVerifications(
    request.server,
    limit ? parseInt(limit, 10) : env.IDA_RETRY_BATCH_LIMIT,
  );

  return reply.code(200).send({ message: "IDA retry job executed", ...result });
};

/** Retries one job now, bypassing its `next_retry_at`. */
export const forceRetryVerificationHandler = async (
  request: IdParams,
  reply: FastifyReply,
) => {
  const job = db.getPendingVerificationById(request.params.id);

  if (!job) {
    return reply.code(404).send({ error: "Pending verification not found" });
  }

  const result = await processVerificationJob(request.server, job);

  return reply.code(200).send({ id: job.id, ...result });
};

/**
 * Forces a job to a conclusion now.
 *
 * Country config finalises it with the pre-existing behaviour, so if IDA is
 * still unreachable the verification counts as failed and the record moves to
 * Awaiting ID Update. This is the escape hatch for a record whose retries are
 * not progressing — it always leaves the record actionable again.
 */
export const resolveVerificationHandler = async (
  request: IdParams,
  reply: FastifyReply,
) => {
  const job = db.getPendingVerificationById(request.params.id);

  if (!job) {
    return reply.code(404).send({ error: "Pending verification not found" });
  }

  request.log.warn(
    { jobId: job.id, eventId: job.eventId },
    "Operator forced an IDA verification to finalise",
  );

  const result = await processVerificationJob(request.server, job, true);

  return reply.code(200).send({ id: job.id, ...result });
};

/**
 * Removes a job without finalising the action.
 *
 * @warning The record stays in `validate:requested` and remains blocked from
 * every other action, with nothing left to complete it. Prefer
 * `POST /debug/ida-retry/:id/resolve`; use this only to clear a job whose
 * action has already been confirmed by other means.
 */
export const deleteVerificationHandler = async (
  request: IdParams,
  reply: FastifyReply,
) => {
  const removed = db.removePendingVerification(request.params.id);

  if (!removed) {
    return reply.code(404).send({ error: "Pending verification not found" });
  }

  request.log.warn(
    { jobId: request.params.id },
    "Pending IDA verification deleted without finalising the action",
  );

  return reply.code(200).send({ message: "Pending verification deleted" });
};
