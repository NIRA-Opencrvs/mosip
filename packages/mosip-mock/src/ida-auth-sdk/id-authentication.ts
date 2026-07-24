import { RouteHandlerMethod } from "fastify";
import identities from "../mock-identities.json" assert { type: "json" };
import { decryptAuthData } from "./crypto";
import { PRIVATE_KEY } from "../constants";

export const idAuthenticationHandler: RouteHandlerMethod = async (
  request,
  reply,
) => {
  const {
    individualId,
    transactionID,
    request: requestBody,
    requestSessionKey,
  } = request.body as {
    transactionID: string;
    individualId: string;
    individualIdType: "UIN" | "VID" | "HANDLE";
    request: string;
    requestSessionKey: string;
  };

  const authParams = decryptAuthData(
    requestBody,
    requestSessionKey,
    PRIVATE_KEY,
  );

 const identity = identities.find(({ nid }) => `${nid}@NIN` === individualId.toUpperCase());

  if (!identity) {
    return reply.status(200).send({
      transactionID,
      version: "1.0",
      id: "mosip.identity.auth",
      errors: [
        {
          errorCode: "IDA-MLC-018",
          errorMessage: "HANDLE not available in database",
          actionMessage: "Please retry with the correct UIN",
        },
      ],
      responseTime: new Date().toISOString(),
      response: { authStatus: false, authToken: null },
    });
  }

  const authToken = new Array({ length: 36 })
    .map(() => Math.floor(Math.random() * 10))
    .join("");

  /*
   * Real IDA reports *every* failing demographic attribute in a single
   * response, so collect them all rather than returning on the first mismatch.
   * Checks run in a fixed order (name -> dob -> gender), which keeps the
   * resulting `errors` order deterministic for the downstream mapper.
   */
  const errors: Array<{
    errorCode: string;
    errorMessage: string;
    actionMessage: string;
  }> = [];

  if (
    authParams.demographics.name[0].value.toLocaleLowerCase() !==
    `${identity.familyName} ${identity.firstName} ${identity.middleName}`.toLocaleLowerCase()
  ) {
    errors.push({
      errorCode: "IDA-DEA-001",
      errorMessage: "Demographic data name in eng did not match",
      actionMessage: "Please re-enter your name in eng",
    });
  }

  if (authParams.demographics.dob !== identity.birthDate.replaceAll("-", "/")) {
    errors.push({
      errorCode: "IDA-DEA-001",
      errorMessage: "Demographic data dob did not match",
      actionMessage: "Please re-enter your dob",
    });
  }

  if (
    authParams.demographics.gender?.[0] &&
    authParams.demographics.gender[0].value !== identity.gender
  ) {
    errors.push({
      errorCode: "IDA-DEA-001",
      errorMessage: "Demographic data gender in eng did not match",
      actionMessage: "Please re-enter your gender in eng",
    });
  }

  if (errors.length > 0) {
    return reply.status(200).send({
      transactionID,
      version: "1.0",
      id: "mosip.identity.auth",
      errors,
      responseTime: new Date().toISOString(),
      response: {
        authStatus: false,
        authToken,
      },
    });
  }

  return reply.status(200).send({
    transactionID,
    version: "1.0",
    id: "mosip.identity.auth",
    responseTime: new Date().toISOString(),
    response: {
      authStatus: true,
      authToken,
    },
  });
};

 