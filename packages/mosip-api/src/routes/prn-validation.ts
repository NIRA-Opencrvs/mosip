import { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../constants";
import { z } from "zod";

type PaymentStatus = "paid" | "unpaid";
type VerificationStatus = "verified" | "failed";
type PrnStatusCode = "A" | "T" | "R" | "D" | "C" | "X";

type ValidationResponse = {
  success: boolean;
  prn: string;
  regId?: string;
  paymentStatus?: PaymentStatus;
  prnVerificationStatus?: VerificationStatus;
  prnStatusCode?: string;
  prnStatusDescription?: string;
  message: string;
};

type PaymentApiError = {
  errorCode: string | null;
  message: string;
};

type PaymentApiEnvelope<T> = {
  id: string | null;
  version: string | null;
  responsetime: string | null;
  response: T | null;
  errors: PaymentApiError[] | null;
};

type ConsumePrnApiResponse = {
  prnNum?: string;
  consumedSucess?: boolean;
  regIdTaggedToPrn?: string;
};

type CheckTranscLogsApiResponse = {
  prn?: string;
  prnNum?: string;
  regIdTagged?: string | null;
  regIdTaggedToPrn?: string | null;
  presentInLogs?: boolean
};

type CheckPrnStatusApiResponse = {
  prn?: string;
  statusCode?: string;
  statusDesc?: string;
};

type TaggedRegIdResponse = {
  regIdTagged?: string | null;
  regIdTaggedToPrn?: string | null;
};

type ValidateCheckBody = {
  prn: string;
  regId: string;
  redirect_uri?: string;
};

const PAYMENT_API_TIMEOUT_MS = 15_000;

const ValidateQuerySchema = z.object({
  redirect_uri: z.string().optional(),
  regId: z.string().optional(),
});

const ValidateCheckBodySchema = z.object({
  prn: z.string(),
  regId: z.string(),
  redirect_uri: z.string().optional(),
});

const PRN_STATUS_DESCRIPTION: Record<PrnStatusCode, string> = {
  A: "PRN is available and not fully paid.",
  T: "Payment fully paid. You can continue.",
  R: "Payment received but not credited.",
  D: "Payment received but dishonoured.",
  C: "PRN was cancelled.",
  X: "PRN has expired.",
};

function normalizePrnStatusCode(
  statusCode: string | null | undefined,
): PrnStatusCode | null {
  if (!statusCode) {
    return null;
  }
  const normalized = statusCode.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  const knownCodes: PrnStatusCode[] = ["A", "T", "R", "D", "C", "X"];
  return knownCodes.includes(normalized as PrnStatusCode)
    ? (normalized as PrnStatusCode)
    : null;
}

function getVerificationStatusFromPrnStatusCode(
  statusCode: PrnStatusCode,
): VerificationStatus {
  return statusCode === "T" ? "verified" : "failed";
}

function getPaymentStatusFromPrnStatusCode(statusCode: PrnStatusCode) {
  return statusCode === "T" ? "paid" : "unpaid";
}

function extractErrorMessage(errors: PaymentApiError[] | null | undefined) {
  return errors?.find((error) => Boolean(error?.message))?.message ?? null;
}

function normalizeString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function hasSameRegId(left: string | null | undefined, right: string) {
  const normalizedLeft = normalizeString(left);
  const normalizedRight = normalizeString(right);

  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft === normalizedRight
  );
}

function getTaggedRegId(
  response: TaggedRegIdResponse | null | undefined,
) {
  return (
    normalizeString(response?.regIdTagged) ??
    normalizeString(response?.regIdTaggedToPrn)
  );
}

function buildPrnAttachedMessage(taggedRegId: string) {
  return `This PRN is already attached to tracking ID ${taggedRegId}. Please enter the correct PRN number.`;
}

const PRN_ATTACHED_STATUS_CODE = "ATTACHED";

function buildFailedVerificationResponse({
  prn,
  regId,
  message,
  prnStatusCode,
}: {
  prn: string;
  regId: string;
  message: string;
  prnStatusCode?: string;
}): ValidationResponse {
  return {
    success: true,
    prn,
    regId,
    paymentStatus: "unpaid",
    prnVerificationStatus: "failed",
    prnStatusCode,
    prnStatusDescription: message,
    message,
  };
}

function buildSuccessResponse({
  prn,
  regId,
  prnStatusCode,
  statusDescription,
}: {
  prn: string;
  regId: string;
  prnStatusCode: PrnStatusCode;
  statusDescription: string;
}): ValidationResponse {
  return {
    success: true,
    prn,
    regId,
    paymentStatus: getPaymentStatusFromPrnStatusCode(prnStatusCode),
    prnVerificationStatus: getVerificationStatusFromPrnStatusCode(prnStatusCode),
    prnStatusCode,
    prnStatusDescription: statusDescription,
    message: statusDescription,
  };
}

function buildRequestErrorResponse(prn: string, message: string) {
  return {
    success: false,
    prn,
    message,
  } satisfies ValidationResponse;
}

async function postPaymentApi<T>(
  url: string,
  payload: Record<string, string>,
): Promise<PaymentApiEnvelope<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAYMENT_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let responseBody: PaymentApiEnvelope<T> | null = null;

    try {
      responseBody = responseText
        ? (JSON.parse(responseText) as PaymentApiEnvelope<T>)
        : null;
    } catch (_error) {
      throw new Error(`Non-JSON response from payment API: ${responseText}`);
    }

    if (!response.ok) {
      const apiErrorMessage = extractErrorMessage(responseBody?.errors);
      throw new Error(
        `Payment API call failed (${response.status}): ${
          apiErrorMessage ?? responseText
        }`,
      );
    }

    if (!responseBody) {
      throw new Error("Payment API returned an empty response.");
    }

    return responseBody;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Payment API timeout after ${PAYMENT_API_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const checkTranscLogsUrl = `${env.IDA_AUTH_DOMAIN_URI}/v1/payment/checkTranscLogs`;
const consumePRNUrl = `${env.IDA_AUTH_DOMAIN_URI}/v1/payment/consumePrn`;
const checkPrnStatusUrl = `${env.IDA_AUTH_DOMAIN_URI}/v1/payment/checkPrnStatus`;

async function validatePrn({
  prn,
  regId,
}: {
  prn: string;
  regId: string;
}): Promise<ValidationResponse> {
  const transactionLogResponse = await postPaymentApi<CheckTranscLogsApiResponse>(
    checkTranscLogsUrl,
    { prn },
  );
  const taggedRegId = getTaggedRegId(transactionLogResponse.response);

  if (taggedRegId && !hasSameRegId(taggedRegId, regId)) {
    return buildFailedVerificationResponse({
      prn,
      regId,
      prnStatusCode: PRN_ATTACHED_STATUS_CODE,
      message: buildPrnAttachedMessage(taggedRegId),
    });
  }

  const checkResponse = await postPaymentApi<CheckPrnStatusApiResponse>(
    checkPrnStatusUrl,
    { prn },
  );

  const rawStatusCode = checkResponse.response?.statusCode ?? null;
  const normalizedStatusCode = normalizePrnStatusCode(rawStatusCode);
  const statusDescription =
    normalizedStatusCode && PRN_STATUS_DESCRIPTION[normalizedStatusCode]
      ? PRN_STATUS_DESCRIPTION[normalizedStatusCode]
      : checkResponse.response?.statusDesc ??
        extractErrorMessage(checkResponse.errors) ??
        "PRN status could not be determined.";

  if (!normalizedStatusCode) {
    return buildFailedVerificationResponse({
      prn,
      regId,
      prnStatusCode: rawStatusCode ?? undefined,
      message: statusDescription,
    });
  }

  if (normalizedStatusCode === "T" && !hasSameRegId(taggedRegId, regId)) {
    const consumeResponse = await postPaymentApi<ConsumePrnApiResponse>(
      consumePRNUrl,
      { regId, prn },
    );
    const consumeResult = consumeResponse.response;
    const consumeTaggedRegId = getTaggedRegId(consumeResult);
    const consumeErrorMessage =
      extractErrorMessage(consumeResponse.errors) ??
      (consumeTaggedRegId && !hasSameRegId(consumeTaggedRegId, regId)
        ? buildPrnAttachedMessage(consumeTaggedRegId)
        : "PRN could not be reserved for this tracking ID. Please try again.");

    if (!consumeResult?.consumedSucess) {
      return buildFailedVerificationResponse({
        prn,
        regId,
        message: consumeErrorMessage,
        prnStatusCode:
          consumeTaggedRegId && !hasSameRegId(consumeTaggedRegId, regId)
            ? PRN_ATTACHED_STATUS_CODE
            : normalizedStatusCode,
      });
    }
  }

  return buildSuccessResponse({
    prn,
    regId,
    prnStatusCode: normalizedStatusCode,
    statusDescription,
  });
}

export const registerPrnValidationRoutes = (app: FastifyInstance) => {
  app.get("/prn/validator", {
    schema: {
      querystring: ValidateQuerySchema,
    },
    handler: async (_request, reply) => {
      const htmlFilePath = path.join(__dirname, "../prn-validator/index.html");
      const html = readFileSync(htmlFilePath, "utf-8");
      return reply.type("text/html").send(html);
    },
  });

  app.post<{ Body: ValidateCheckBody }>(
    "/prn/validate",
    {
      schema: {
        body: ValidateCheckBodySchema,
      },
    },
    async (request, reply) => {
      const prn = request.body.prn.trim();
      const regId = request.body.regId.trim();

      if (!prn) {
        return reply
          .status(400)
          .send(buildRequestErrorResponse(prn, "PRN is required."));
      }

      if (!regId) {
        return reply
          .status(400)
          .send(buildRequestErrorResponse(prn, "Tracking ID is required."));
      }

      try {
        const validationResponse = await validatePrn({ prn, regId });
        return reply.send(validationResponse);
      } catch (error) {
        request.log.error(
          { err: error, prn, regId },
          "Failed to validate PRN through payment API",
        );
        return reply.status(502).send(
          buildRequestErrorResponse(
            prn,
            "Unable to validate PRN at the moment. Please try again.",
          ),
        );
      }
    },
  );

};
