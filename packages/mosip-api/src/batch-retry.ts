import { FastifyInstance } from "fastify";
import * as mosip from "./mosip-api";
import * as db from "./database";
import { insertTransaction } from "./database";
import { env } from "./constants";

/**
 * Batch retry job that processes failed MOSIP records
 * Call this periodically (e.g., every 5-10 minutes) to retry failed records
 *
 * @param app - Fastify instance for logging
 * @param limit - Number of failed records to process in one batch (default: env.BATCH_RETRY_LIMIT)
 * @returns Promise with retry results
 */
export const processPendingRecords = async (
  app: FastifyInstance,
  limit = env.BATCH_RETRY_LIMIT,
) => {
  try {
    app.log.info("Started batch retry job to process pending records");
    const failedRecords = db.getFailedRecordsForRetry(limit);

    if (failedRecords.length === 0) {
      app.log.info("No pending records to retry");
      return { processed: 0, successful: 0, failed: 0 };
    }

    app.log.info(
      { count: failedRecords.length },
      "Processing pending records",
    );

    let successful = 0;
    let failed = 0;

    for (const record of failedRecords) {
      try {
        if (record.eventType === "birth") {
          const birthCertificateNumber =
            record.requestFields.birthCertificateNumber as string;

          const regId = await mosip.postBirthRecord({
            event: {
              id: record.id,
              trackingId: record.trackingId,
              token: record.token,
            },
            requestFields: record.requestFields,
            audit: record.audit,
            metaInfo: record.metaInfo,
            notification: record.notification,
            preRegistrationId: db.findPreRegIdByTrackingId(record.trackingId),
          });

          // Success - insert transaction and remove from failed records
          insertTransaction(regId, record.token, birthCertificateNumber);

          db.removeFailedRecord(record.id);
          successful++;
          app.log.info(
            { recordId: record.id, eventType: "birth" },
            "✅ Birth record successfully retried and removed",
          );
        } else if (record.eventType === "death") {
          await mosip.postDeathRecord({
            event: { id: record.id, trackingId: record.trackingId },
            requestFields: record.requestFields,
            audit: record.audit,
            metaInfo: record.metaInfo,
            notification: record.notification,
          });

          const result = record.metaInfo?.reduce((acc, item) => {
              acc[item.label] = item.value;
              return acc;
          }, {} as Record<string, string>);

          // Success - insert transaction and remove from failed records
          const deathCertificateNumber =
            record.requestFields.deathCertificateNumber as string;
          insertTransaction(record.id, record.token, deathCertificateNumber, result?.actionType, result?.requestedId);

          db.removeFailedRecord(record.id);
          successful++;
          app.log.info(
            { recordId: record.id, eventType: "death" },
            "✅ Death record successfully retried and removed",
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unknown error during retry";

        /*
         * An Expired, Consumed or Cancelled pre-registration can never be completed
         */
        if (error instanceof mosip.NonRetryableError) {
          db.removeFailedRecord(record.id);
          failed++;

          app.log.error(
            {
              recordId: record.id,
              eventType: record.eventType,
              error: errorMessage,
            },
            "⛔ Record cannot be completed, dropped without further retries",
          );
          continue;
        }

        db.incrementFailedRecordRetry(record.id, errorMessage);
        failed++;

        app.log.error(
          {
            recordId: record.id,
            eventType: record.eventType,
            retryCount: record.retryCount + 1,
            error: errorMessage,
          },
          "⚠️  Record retry failed, will retry again later",
        );
      }
    }

    app.log.info(
      { processed: failedRecords.length, successful, failed },
      "Batch retry job completed",
    );

    return {
      processed: failedRecords.length,
      successful,
      failed,
    };
  } catch (error) {
    app.log.error("Error in batch retry job:", error);
    throw error;
  }
};

/**
 * Force retry a single specific record by ID (bypasses nextRetryAt check)
 * 
 * @param app - Fastify instance for logging
 * @param record - The failed record to process
 * @returns Promise with success status and any error
 */
export const processSingleRecord = async (
  app: FastifyInstance,
  record: {
    id: string;
    eventType: "birth" | "death";
    trackingId: string;
    token: string;
    requestFields: Record<string, unknown>;
    audit: Record<string, unknown>;
    metaInfo?: Array<{label: string, value: string}> ;
    notification?: Record<string, unknown>;
  },
) => {
  try {
    app.log.info({ recordId: record.id }, "Force retrying specific record");

    if (record.eventType === "birth") {
      const birthCertificateNumber = record.requestFields.birthCertificateNumber as string;

      const regId = await mosip.postBirthRecord({
        event: {
          id: record.id,
          trackingId: record.trackingId,
          token: record.token,
        },
        requestFields: record.requestFields,
        audit: record.audit,
        metaInfo: record.metaInfo,
        notification: record.notification,
        preRegistrationId: db.findPreRegIdByTrackingId(record.trackingId),
      });

      // Success - insert transaction and remove from failed records
      insertTransaction(regId, record.token, birthCertificateNumber);

      db.removeFailedRecord(record.id);
      app.log.info(
        { recordId: record.id, eventType: "birth" },
        "✅ Birth record force retried successfully",
      );
      return { success: true };
    } else if (record.eventType === "death") {
      await mosip.postDeathRecord({
        event: { id: record.id, trackingId: record.trackingId },
        requestFields: record.requestFields,
        audit: record.audit,
        metaInfo: record.metaInfo,
        notification: record.notification,
      });

      const metaData  = record.metaInfo;

      const result = record.metaInfo?.reduce((acc, item) => {
              acc[item.label] = item.value;
              return acc;
          }, {} as Record<string, string>);

      // Success - insert transaction and remove from failed records
      const deathCertificateNumber = record.requestFields.deathCertificateNumber as string;
      insertTransaction(record.id, record.token, deathCertificateNumber, result?.actionType, result?.requestedId);

      db.removeFailedRecord(record.id);
      app.log.info(
        { recordId: record.id, eventType: "death" },
        "✅ Death record force retried successfully",
      );
      return { success: true };
    }

    return { success: false, error: "Unknown event type" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error during force retry";

    // Increment retry count but don't update nextRetryAt for force retry
    // db.incrementFailedRecordRetry(record.id, errorMessage);

    app.log.error(
      { recordId: record.id, eventType: record.eventType, error: errorMessage },
      "⚠️  Record force retry failed",
    );

    return { success: false, error: errorMessage };
  }
};

/**
 * Start a periodic batch retry job
 * @param app - Fastify instance
 * @param intervalMs - Interval in milliseconds (default: env.BATCH_RETRY_INTERVAL_MS)
 */
export const startBatchRetryJob = (
  app: FastifyInstance,
  intervalMs = env.BATCH_RETRY_INTERVAL_MS,
) => {
  app.log.info(
    { intervalMs },
    "Starting batch retry job scheduler",
  );

  const intervalId = setInterval(async () => {
    try {
      await processPendingRecords(app);
    } catch (error) {
      app.log.error("Batch retry job error:", error);
    }
  }, intervalMs);

  return intervalId;
};
