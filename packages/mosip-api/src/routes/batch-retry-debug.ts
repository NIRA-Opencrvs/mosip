import { FastifyRequest, FastifyReply } from "fastify";
import { processPendingRecords } from "../batch-retry";
import * as db from "../database";
import { env } from "../constants";

/**
 * Manual trigger for batch retry job (useful for testing or manual intervention)
 */
export const triggerBatchRetryHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const { limit } = request.query as { limit?: string };
    const recordLimit = limit ? parseInt(limit) : env.BATCH_RETRY_LIMIT;

    const result = await processPendingRecords(request.server, recordLimit);

    return reply.code(200).send({
      message: "Batch retry job executed",
      ...result,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Error triggering batch retry";

    request.log.error("Error in batch retry trigger:", error);
    return reply.code(500).send({ error: errorMessage });
  }
};

/**
 * Get pending/failed records (for debugging)
 */
export const getPendingRecordsHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const { limit } = request.query as { limit?: string };
    const recordLimit = limit ? parseInt(limit) : env.BATCH_RETRY_LIMIT;

    const records = db.getFailedRecordsForRetry(recordLimit);

    return reply.code(200).send({
      count: records.length,
      records: records.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        trackingId: r.trackingId,
        retryCount: r.retryCount,
        lastError: r.lastError,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Error fetching pending records";

    request.log.error("Error fetching pending records:", error);
    return reply.code(500).send({ error: errorMessage });
  }
};

/**
 * Delete a specific failed record (for administrative purposes)
 */
export const deleteFailedRecordHandler = async (
  request: FastifyRequest<{
    Params: { id: string };
  }>,
  reply: FastifyReply,
) => {
  try {
    const { id } = request.params;

    db.removeFailedRecord(id);

    return reply.code(200).send({ message: "Record deleted successfully" });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Error deleting record";

    request.log.error("Error deleting record:", error);
    return reply.code(500).send({ error: errorMessage });
  }
};
