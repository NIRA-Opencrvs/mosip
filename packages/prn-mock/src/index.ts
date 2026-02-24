import Fastify from "fastify";
import path from "path";
import fastifyStatic from "@fastify/static";
import formbody from "@fastify/formbody";
import { readFileSync } from "node:fs";
import { env } from "./constants";

const app = Fastify({ logger: true });

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

type CheckPrnStatusApiResponse = {
  prn?: string;
  statusCode?: string;
  statusDesc?: string;
};

const PRN_STATUS_DESCRIPTION: Record<PrnStatusCode, string> = {
  A: "PRN is available and not fully paid.",
  T: "Payment fully paid. You can continue.",
  R: "Payment received but not credited.",
  D: "Payment received but dishonoured.",
  C: "PRN was cancelled.",
  X: "PRN has expired."
};

app.register(fastifyStatic, {
  root: path.join(__dirname, "prn-validator")
});
app.register(formbody);

function normalizePrnStatusCode(
  statusCode: string | null | undefined
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
  statusCode: PrnStatusCode
): VerificationStatus {
  return statusCode === "T" ? "verified" : "failed";
}

function getPaymentStatusFromPrnStatusCode(statusCode: PrnStatusCode) {
  return statusCode === "T" ? "paid" : "unpaid";
}

function extractErrorMessage(errors: PaymentApiError[] | null | undefined) {
  return errors?.find((error) => Boolean(error?.message))?.message ?? null;
}

function buildFailedVerificationResponse({
  prn,
  regId,
  message,
  prnStatusCode
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
    message
  };
}

function buildSuccessResponse({
  prn,
  regId,
  prnStatusCode,
  statusDescription
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
    message: statusDescription
  };
}

function buildRequestErrorResponse(prn: string, message: string) {
  return {
    success: false,
    prn,
    message
  } satisfies ValidationResponse;
}

async function postPaymentApi<T>(
  url: string,
  payload: Record<string, string>
): Promise<PaymentApiEnvelope<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    env.PAYMENT_API_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
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
        }`
      );
    }

    if (!responseBody) {
      throw new Error("Payment API returned an empty response.");
    }

    return responseBody;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `Payment API timeout after ${env.PAYMENT_API_TIMEOUT_MS}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function validatePrn({
  prn,
  regId
}: {
  prn: string;
  regId: string;
}): Promise<ValidationResponse> {
  const consumeResponse = await postPaymentApi<ConsumePrnApiResponse>(
    env.PAYMENT_CONSUME_PRN_URL,
    { regId, prn }
  );
  const consumeResult = consumeResponse.response;
  const consumeErrorMessage =
    extractErrorMessage(consumeResponse.errors) ??
    "PRN could not be consumed. It may already be used.";

  if (!consumeResult?.consumedSucess) {
    return buildFailedVerificationResponse({
      prn,
      regId,
      message: consumeErrorMessage
    });
  }

  const checkResponse = await postPaymentApi<CheckPrnStatusApiResponse>(
    env.PAYMENT_CHECK_PRN_STATUS_URL,
    { prn }
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
      message: statusDescription
    });
  }

  return buildSuccessResponse({
    prn,
    regId,
    prnStatusCode: normalizedStatusCode,
    statusDescription
  });
}

app.get("/validate", {
  schema: {
    querystring: {
      type: "object",
      required: [],
      properties: {
        redirect_uri: { type: "string" },
        regId: { type: "string" }
      }
    }
  },
  handler: async (_request, reply) => {
    const htmlFilePath = path.join(__dirname, "./prn-validator/index.html");
    const html = readFileSync(htmlFilePath, "utf-8");
    return reply.type("text/html").send(html);
  }
});

app.post(
  "/validate/check",
  {
    schema: {
      body: {
        type: "object",
        required: ["prn", "regId"],
        properties: {
          prn: { type: "string" },
          regId: { type: "string" },
          redirect_uri: { type: "string" }
        }
      }
    }
  },
  async (request: any, reply) => {
    const prn = request.body.prn.trim();
    const regId = (request.body.regId ?? "").trim();

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
        "Failed to validate PRN through payment API"
      );
      return reply
        .status(502)
        .send(
          buildRequestErrorResponse(
            prn,
            "Unable to validate PRN at the moment. Please try again."
          )
        );
    }
  }
);

app.get(
  "/validate-status",
  {
    schema: {
      querystring: {
        type: "object",
        required: ["prn", "regId"],
        properties: {
          prn: { type: "string" },
          regId: { type: "string" }
        }
      }
    }
  },
  async (request: any, reply) => {
    const prn = request.query.prn.trim();
    const regId = (request.query.regId ?? "").trim();

    if (!prn || !regId) {
      return reply
        .status(400)
        .send(buildRequestErrorResponse(prn, "Both PRN and regId are required."));
    }

    try {
      const validationResponse = await validatePrn({ prn, regId });
      return reply.send(validationResponse);
    } catch (error) {
      request.log.error(
        { err: error, prn, regId },
        "Failed to validate PRN status query"
      );
      return reply
        .status(502)
        .send(
          buildRequestErrorResponse(
            prn,
            "Unable to validate PRN at the moment. Please try again."
          )
        );
    }
  }
);

app.get("/health", async (_request, reply) => {
  return reply.send({ status: "ok" });
});

async function run() {
  await app.ready();
  await app.listen({
    port: env.PORT,
    host: env.HOST
  });

  console.log(
    `PRN Validator server running at http://${env.HOST}:${env.PORT}`
  );
  console.log(`\nEndpoints:`);
  console.log(`  GET  /validate?redirect_uri=<uri>  - PRN validation page`);
  console.log(`  POST /validate/check               - Consume + check PRN status`);
  console.log(
    `  GET  /validate-status?prn=<prn>&regId=<trackingId> - Validate PRN status`
  );
  console.log(`  GET  /health                       - Health check`);
}

void run();
