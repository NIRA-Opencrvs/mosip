import { DateValue, NameFieldValue, TextValue } from "@opencrvs/toolkit/events";
import { FastifyReply, FastifyRequest } from "fastify";
import { verifyNid } from "../mosip-api";
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

/** Handles the calls coming from OpenCRVS countryconfig */
export const verifyHandler = async (
  request: OpenCRVSRequest,
  reply: FastifyReply,
) => {
  const {
    response: { authStatus },
  } = await verifyNid({
    nid: request.body.nid,
    dob: request.body.dob? formatDate(request.body.dob, "dd/MM/yyyy"):undefined,
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

  const transactionId = request.body.transactionId;

  if (transactionId) {
    request.log.info({ transactionId, authStatus });
  }

  return reply.code(200).send(authStatus ? "verified" : "failed");
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