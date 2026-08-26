import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { insertPendingVerification, pendingVerificationId } from "../database";
import { env } from "../constants";

/**
 * Payload country config sends when an identity verification could not be
 * completed because IDA was unreachable.
 *
 * `event` is the whole EventDocument. Storing it verbatim is what lets the retry
 * re-run the *same* verification code the live VALIDATE flow uses, instead of a
 * parallel reimplementation that would drift.
 */
export const EnqueueVerificationSchema = z.object({
  eventId: z.string().min(1),
  actionId: z.string().min(1),
  eventType: z.string().min(1),
  actionType: z.string().min(1),
  event: z.record(z.unknown()),
  verified: z.record(z.unknown()).optional(),
  pendingRequests: z
    .array(
      z.object({
        nid: z.string().min(1),
        dob: z.string().optional(),
        name: z.record(z.unknown()),
        gender: z.string().optional(),
        transactionId: z.string().optional(),
      }),
    )
    .optional(),
  error: z.string().default("IDA unavailable"),
});

export type EnqueueVerificationRequest = FastifyRequest<{
  Body: z.infer<typeof EnqueueVerificationSchema>;
}>;

/**
 * Parks a verification for later retry.
 *
 * Idempotent: re-enqueuing the same action, or a second action for a record
 * that already has a job, returns 200 with `created: false` rather than
 * erroring. Country config only defers the action once this has succeeded, so a
 * failure here must be visible rather than swallowed.
 */
export const enqueueVerificationHandler = async (
  request: EnqueueVerificationRequest,
  reply: FastifyReply,
) => {
  const {
    eventId,
    actionId,
    eventType,
    actionType,
    event,
    verified,
    pendingRequests,
    error,
  } = request.body;

  if (!env.IDA_RETRY_ENABLED) {
    request.log.warn(
      { eventId, actionId },
      "Rejected IDA retry enqueue: IDA_RETRY_ENABLED=false",
    );
    return reply
      .code(503)
      .send({ error: "IDA verification retry is disabled" });
  }

  /*
   * The record-scoped action confirmation token this request arrived with is
   * what the retry will use to accept or reject the action later. It is valid
   * for a week by default, comfortably longer than IDA_RETRY_MAX_AGE_HOURS.
   */
  const token = request.headers.authorization!.split(" ")[1];

  const created = insertPendingVerification({
    eventId,
    actionId,
    eventType,
    actionType,
    token,
    eventDocument: event,
    verified,
    pendingRequests,
    lastError: error,
  });

  request.log.info(
    {
      eventId,
      actionId,
      eventType,
      actionType,
      created,
      pendingRequestCount: pendingRequests?.length ?? 0,
    },
    created
      ? "IDA verification parked for retry"
      : "IDA verification already queued, enqueue ignored",
  );

  return reply
    .code(200)
    .send({ id: pendingVerificationId(eventId, actionId), created });
};
