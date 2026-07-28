import { FastifyRequest, FastifyReply } from "fastify";
import * as mosip from "../mosip-api";
import { generateTransactionId } from "../registration-number";
import {
  insertTransaction,
  insertFailedRecord,
  hasTransactionForRegistrationNumber,
  hasPendingFailedRecordForTracking,
} from "../database";
import { MosipInteropPayload } from "@opencrvs/mosip/api";

export type OpenCRVSRequest = FastifyRequest<{
  Body: MosipInteropPayload;
}>;

/** Handles the calls coming from OpenCRVS countryconfig */
export const registrationEventHandler = async (
  request: OpenCRVSRequest,
  reply: FastifyReply,
) => {
  const { trackingId, requestFields, audit, metaInfo, notification } =
    request.body;

  const token = request.headers.authorization!.split(" ")[1];

  request.log.info({ trackingId }, "Received record from OpenCRVS");

  /*
   Ignore duplicate REGISTER requests if already processed or queued for retry, preventing duplicate MOSIP pre-registrations.
   */
  const registrationNumber =
    requestFields.birthCertificateNumber ??
    requestFields.deathCertificateNumber;

  if (
    registrationNumber &&
    hasTransactionForRegistrationNumber(registrationNumber)
  ) {
    request.log.info(
      { trackingId },
      "Duplicate submission ignored: record already sent to MOSIP",
    );
    return reply.code(202).send({});
  }

  if (hasPendingFailedRecordForTracking(trackingId)) {
    request.log.info(
      { trackingId },
      "Duplicate submission ignored: record already queued for retry",
    );
    return reply.code(202).send({});
  }

  const transactionId = trackingId + '-' + generateTransactionId();

  try {
    const birthCertificateNumber = requestFields.birthCertificateNumber;

    if (birthCertificateNumber) {
      const regId = await mosip.postBirthRecord({
        event: { id: transactionId, trackingId, token },
        requestFields,
        audit,
        metaInfo,
        notification,
      });

      insertTransaction(regId, token, birthCertificateNumber);
    }

    const deathCertificateNumber = requestFields.deathCertificateNumber;

    if (deathCertificateNumber) {
      request.log.info({ transactionId }, "Event ID");

      await mosip.postDeathRecord({
        event: { id: transactionId, trackingId },
        requestFields,
        audit,
        metaInfo,
        notification,
      });


      const parsedArray = JSON.parse(metaInfo.metaData) as Array<{label: string, value: string}>;
      const result = parsedArray.reduce((acc, item) => {
          acc[item.label] = item.value;
          return acc;
      }, {} as Record<string, string>);
      
      insertTransaction(transactionId, token, deathCertificateNumber, result.actionType, result.requestedId);
    }

    return reply.code(202).send({});
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred in MOSIP API";

    request.log.error({ transactionId }, "Error occurred in mosip-api: ", errorMessage);

    // Store failed records for retry
    const birthCertificateNumber = requestFields.birthCertificateNumber;
    if (birthCertificateNumber) {
      insertFailedRecord(
        transactionId,
        "birth",
        trackingId,
        token,
        requestFields,
        audit,
        metaInfo,
        notification,
        errorMessage,
      );
      request.log.info(
        { transactionId },
        "Birth record stored for retry",
      );
    }

    const deathCertificateNumber = requestFields.deathCertificateNumber;
    if (deathCertificateNumber) {
      insertFailedRecord(
        transactionId,
        "death",
        trackingId,
        token,
        requestFields,
        audit,
        metaInfo,
        notification,
        errorMessage,
      );
      request.log.info(
        { transactionId },
        "Death record stored for retry",
      );
    }

    return reply.code(202).send({});
  }
};
