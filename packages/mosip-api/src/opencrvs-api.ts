import { env } from "./constants";
import { createClient } from "@opencrvs/toolkit/api";
import crypto from "node:crypto";

export class OpenCRVSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCRVSError";
  }
}

/** Fetches the public key from OpenCRVS to be able to verify JWTs */
export const getPublicKey = async (): Promise<string> => {
  try {
    const response = await fetch(env.OPENCRVS_PUBLIC_KEY_URL);
    return response.text();
  } catch (error) {
    console.error(
      `🔑  Failed to fetch public key from Core. Make sure Core is running, and you are able to connect to ${env.OPENCRVS_PUBLIC_KEY_URL}`,
    );
    if (env.isProd) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return getPublicKey();
  }
};

export const confirmRegistration = (
  {
    eventId,
    actionId,
    nationalId,
    registrationNumber,
    additionalDeclaration,
  }: {
    eventId: string;
    actionId: string;
    nationalId?: string;
    registrationNumber: string;
    additionalDeclaration?: Record<string, string>;
  },
  { token }: { token: string },
) => {
  const url = new URL("events", env.OPENCRVS_GATEWAY_URL).toString();
  const client = createClient(url, `Bearer ${token}`);

  const isAlienId = !!nationalId && nationalId?.startsWith("A");

  const basePayload = {
    transactionId: `mosip-interop-${crypto.randomUUID()}`,
    eventId,
    actionId,
    registrationNumber,
  };

  const declaration = nationalId
    ? {
        "child.ninAvailable": "YES",
        ...(isAlienId
          ? {
              "child.idType": "ALIEN_ID",
              "child.alienID": nationalId,
            }
          : {
              "child.idType": "NATIONAL_ID",
              "child.nid": nationalId,
            }),
        ...(additionalDeclaration || {}),
      }
    : additionalDeclaration
      ? additionalDeclaration
      : undefined;

  return client.event.actions.register.accept.mutate({
    ...basePayload,
    ...(declaration ? { declaration } : {}),
  });
};

export const rejectRegistration = async (
  {
    eventId,
    actionId,
    failureReason
  }: {
    eventId: string;
    actionId: string;
    failureReason: string;
  },
  { token }: { token: string },
) => {
  const url = new URL("events", env.OPENCRVS_GATEWAY_URL).toString();
  const client = createClient(url, `Bearer ${token}`);

  await client.event.actions.register.reject.mutate({
    transactionId: `mosip-interop-${crypto.randomUUID()}`,
    eventId,
    actionId
  });

  return client.event.actions.reject.request.mutate({
    transactionId: `mosip-interop-${crypto.randomUUID()}`,
    eventId,
    actionId,
    content: { failureReason }
  })
};

/** Sends informant notification via country-config after MOSIP websub callback */
export const sendMosipNotification = async (
  {
    eventId,
    registrationNumber,
  }: {
    eventId: string;
    registrationNumber: string;
  },
  { token }: { token: string },
): Promise<void> => {
  try {
    const response = await fetch(
      `${env.COUNTRY_CONFIG_URL}/mosip-notification`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ eventId, registrationNumber }),
      },
    );

    if (!response.ok) {
      console.error(
        `Failed to send MOSIP notification: ${response.status} ${response.statusText}`,
      );
    } else {
      console.log(
        `MOSIP notification sent successfully for event ${eventId}`,
      );
    }
  } catch (error) {
    console.error("Error sending MOSIP notification:", error);
  }
};
