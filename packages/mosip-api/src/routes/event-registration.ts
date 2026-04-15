import { FastifyRequest, FastifyReply } from "fastify";
import * as mosip from "../mosip-api";
import { generateTransactionId } from "../registration-number";
import { insertTransaction, insertFailedRecord } from "../database";
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
  try {

  const birthCertificateNumber = requestFields.birthCertificateNumber;

  if (birthCertificateNumber) {
    const transactionId = generateTransactionId();

    // request.log.info({ transactionId }, "Event ID");

    // insertTransaction(transactionId, token, birthCertificateNumber);

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
    const transactionId = trackingId + '-' + generateTransactionId();

    request.log.info({ transactionId }, "Event ID");

    await mosip.postDeathRecord({
      event: { id: transactionId, trackingId },
      requestFields,
      audit,
      metaInfo,
      notification,
    });

    insertTransaction(transactionId, token, deathCertificateNumber);
  }

  return reply.code(202).send({});
   } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred in MOSIP API";

    request.log.error({ trackingId }, "Error occurred in mosip-api: ", errorMessage);

    // Store failed records for retry
    const birthCertificateNumber = requestFields.birthCertificateNumber;
    if (birthCertificateNumber) {
      const transactionId = generateTransactionId();
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
        { trackingId },
        "Birth record stored for retry",
      );
    }

    const deathCertificateNumber = requestFields.deathCertificateNumber;
    if (deathCertificateNumber) {
      const transactionId = trackingId + "-" + generateTransactionId();
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
        { trackingId },
        "Death record stored for retry",
      );
    }

    return reply.code(202).send({});
  }
};
