import { z } from "zod";
import { FastifyReply, FastifyRequest } from "fastify";
import { getTransactionAndDiscard } from "../database";
import { decode } from "jsonwebtoken";
import * as opencrvs from "../opencrvs-api";
import { decryptMosipCredential } from "../websub/crypto";
import { env } from "../constants";
import { isBirthSubject } from "../websub/verify-vc";

export const CredentialIssuedSchema = z.object({
  publisher: z.string(),
  topic: z.literal(env.MOSIP_WEBSUB_TOPIC),
  publishedOn: z.string().datetime(),
  event: z.object({
    id: z.string().uuid(),
    transactionId: z.string().uuid(),
    type: z.object({
      namespace: z.string(),
      name: z.string(),
    }),
    timestamp: z.string().datetime(),
    data: z.object({
      registrationId: z.string(),
      registrationType: z.string().optional(),
      credential: z.string(),
      credentialType: z.literal("vercred"),
      protectionKey: z.string(),
    }),
  }),
});

export const CredentialErrorSchema = z.object({
  publisher: z.string(),
  topic: z.literal(env.MOSIP_WEBSUB_ERROR_TOPIC),
  publishedOn: z.string().datetime(),
  event: z.object({
    id: z.string().uuid(),
    timestamp: z.string().datetime(),
    data: z.object({
      registrationId: z.string(),
      registrationType: z.string().optional(),
      failureReason: z.string(),
    }),
  }),
});

export interface TokenPayload {
  eventId: string;
  actionId: string;
}

type CredentialIssuedRequest = FastifyRequest<{
  Body: z.infer<typeof CredentialIssuedSchema>;
}>;

type CredentialErrorRequest = FastifyRequest<{
  Body: z.infer<typeof CredentialErrorSchema>;
}>;

export const credentialIssuedHandler = async (
  request: CredentialIssuedRequest,
  reply: FastifyReply,
) => {
  try {
    const verifiableCredential = decryptMosipCredential(
      request.body.event.data.credential,
    );

    // commented out for now, as there is an issue when verifying the VC
    // await verifyCredentialOrThrow(verifiableCredential, {
    //   allowList: MOSIP_VERIFIABLE_CREDENTIAL_ALLOWED_URLS,
    // });

    // const transactionId = verifiableCredential.credentialSubject.id
    //   .split("/")
    //   .pop()!;
    const transactionId = request.body.event.data.registrationId;

    const { token, registrationNumber } =
      getTransactionAndDiscard(transactionId);
    const { eventId, actionId } = decode(token) as TokenPayload;

    const registrationType = request.body.event.data.registrationType;
    const isDeath = registrationType === "DEACTIVATED";

    if (isBirthSubject(verifiableCredential.credentialSubject) && !isDeath) {
      const childNIN = verifiableCredential.credentialSubject.NIN;

      
      await opencrvs.confirmRegistration(
        {
          eventId,
          actionId,
          registrationNumber,
          nationalId: childNIN,
          additionalDeclaration: childNIN
            ? { "child.verified": "verified" }
            : undefined,
        },
        { token },
      );
       await opencrvs.sendMosipNotification(
        { eventId, registrationNumber },
        { token },
      );
    } else {
      
      await opencrvs.confirmRegistration(
        {
          eventId,
          actionId,
          registrationNumber,
          additionalDeclaration: {
            "deceased.verified": "failed"  // Use "failed" for deactivated IDs (displays as "ID Verification Failed")
          },
        },
        { token },
      );
       await opencrvs.sendMosipNotification(
        { eventId, registrationNumber },
        { token },
      );
    }
    return reply
      .send({
        publisher: request.body.publisher,
        topic: request.body.topic,
        publishedOn: new Date().toISOString(),
        event: {
          id: request.body.event.id,
          requestId: request.body.event.transactionId,
          timestamp: new Date().toISOString(),
          status: "RECEIVED",
          url: "",
        },
      })
      .status(200);
  } catch (error) {
    console.error("error: ", error);
    return reply
      .send({
        publisher: request.body.publisher,
        topic: request.body.topic,
        publishedOn: new Date().toISOString(),
        event: {
          id: request.body.event.id,
          requestId: request.body.event.transactionId,
          timestamp: new Date().toISOString(),
          status: "ERROR",
          url: "",
        },
      })
      .status(200);
  }
};

export const credentialErrorHandler = async (
  request: CredentialErrorRequest,
  reply: FastifyReply,
) => {
  try {
    const transactionId = request.body.event.data.registrationId;
    console.log("Received error from MOSIP for transactionId: ", transactionId);

    const { token, registrationNumber } =
      getTransactionAndDiscard(transactionId);
    const { eventId, actionId } = decode(token) as TokenPayload;

    const failureReason = request.body.event.data.failureReason;

    await opencrvs.rejectRegistration(
      {
        eventId,
        actionId,
        failureReason
      },
      { token }
    );

    return reply
      .send({
        publisher: request.body.publisher,
        topic: request.body.topic,
        publishedOn: new Date().toISOString(),
        event: {
          id: request.body.event.id,
          // requestId: request.body.event.transactionId,
          timestamp: new Date().toISOString(),
          status: "RECEIVED",
          url: "",
        },
      })
      .status(200);
  } catch (error) {
    console.error("error: ", error);
    return reply
      .send({
        publisher: request.body.publisher,
        topic: request.body.topic,
        publishedOn: new Date().toISOString(),
        event: {
          id: request.body.event.id,
          // requestId: request.body.event.transactionId,
          timestamp: new Date().toISOString(),
          status: "ERROR",
          url: "",
        },
      })
      .status(200);
  }
};