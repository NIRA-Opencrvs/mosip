import { DateValue, NameFieldValue, TextValue } from "@opencrvs/toolkit/events";
import { FastifyReply, FastifyRequest } from "fastify";
import { verifyNid } from "../mosip-api";
import { mapIdaError } from "./mapIdaError";
import type { VerifyNidResult } from "@opencrvs/mosip/api";
import { z } from "zod";
import { isValid, format, Locale, parse } from "date-fns";
import { enGB } from "date-fns/locale/en-GB";
import { fr } from "date-fns/locale/fr";
import { env } from "../constants";

export const locales: Record<string, Locale> = { en: enGB, fr };

export const VerifySchema = z.object({
  nid: TextValue,
  dob: DateValue.optional(),
  name: NameFieldValue,
  gender: TextValue.optional(),
  transactionId: z.string().optional(),
});

export type OpenCRVSRequest = FastifyRequest<{
  Body: z.infer<typeof VerifySchema>;
}>;

/** IDA's business exception for a NIN that has already been deactivated. */
const NIN_ALREADY_DEACTIVATED = "IDA-MLC-032";

/**
 * Transaction ids are `${page}-${eventId}`, set by country config
 */
const isMotherOrFatherVerification = (transactionId: string | undefined) =>
  transactionId?.startsWith("mother-") || transactionId?.startsWith("father-") || false;

/**
 * Turns IDA's answer into a verdict.
 */
export const resolveVerificationStatus = ({
  authStatus,
  errors,
  transactionId,
}: {
  authStatus: boolean;
  errors?: { errorCode: string }[];
  transactionId?: string;
}): VerifyNidResult["status"] => {
  if (authStatus) {
    return "verified";
  }

  const ninAlreadyDeactivated =
    !!errors?.length &&
    errors.every(({ errorCode }) => errorCode === NIN_ALREADY_DEACTIVATED);

  return ninAlreadyDeactivated && isMotherOrFatherVerification(transactionId)
    ? "verified"
    : "failed";
};

/** Handles the calls coming from OpenCRVS countryconfig */
export const verifyHandler = async (
  request: OpenCRVSRequest,
  reply: FastifyReply,
) => {
  const result = await verifyNid({
    nid: request.body.nid,
    dob: request.body.dob
      ? formatDate(request.body.dob, "dd/MM/yyyy")
      : undefined,
    name: [
      {
        language: "eng",
        value: `${request.body.name.surname} ${request.body.name.firstname} ${request.body.name.middlename}`,
      },
    ],
    gender: request.body.gender
      ? [{ language: "eng", value: request.body.gender }]
      : undefined,
  });

  const authStatus = result.response.authStatus;
  const transactionId = request.body.transactionId;

  const status = resolveVerificationStatus({
    authStatus,
    errors: result.errors,
    transactionId,
  });

  let reasons: VerifyNidResult["reasons"];
  if (status === "failed") {
    const mapped = mapIdaError(result.errors);
    reasons = mapped.length > 0 ? mapped : ["UNKNOWN"];
  }

  const verifyResult: VerifyNidResult = { status, reasons };

  if (transactionId) {
    request.log.info({
      transactionId,
      authStatus,
      errors: result.errors,
      status,
      reasons,
    });
  }

  return reply.code(200).send(verifyResult);
};

function formatDate(dateString: string, formatStr = "dd/MM/yyyy") {
  const date = parse(dateString, "yyyy-MM-dd", new Date());
  if (!isValid(date)) {
    return "";
  }
  return format(date, formatStr, {
    locale: locales[env.LOCALE],
  });
};