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

export const isDirectAuthConfigured = () =>
  Boolean(env.OPENCRVS_CLIENT_ID && env.OPENCRVS_CLIENT_SECRET);

/**
 * Obtains a fresh record-specific confirmation token using this integration's
 * own client credentials (client_credentials grant followed by an OAuth 2.0
 * token exchange scoped to the event & action being confirmed).
 *
 * Compared to using the token stored at registration time, a fresh token
 * survives OpenCRVS redeployments and attributes the confirmation to this
 * integration in the record's audit trail.
 */
export const getConfirmationToken = async (
  eventId: string,
  actionId: string,
): Promise<string> => {
  const clientCredentialsParams = new URLSearchParams({
    client_id: env.OPENCRVS_CLIENT_ID,
    client_secret: env.OPENCRVS_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const clientCredentialsResponse = await fetch(
    `${env.OPENCRVS_AUTH_URL}/token?${clientCredentialsParams}`,
    { method: "POST" },
  );
  if (!clientCredentialsResponse.ok) {
    throw new OpenCRVSError(
      `client_credentials authentication failed: ${clientCredentialsResponse.status} ${await clientCredentialsResponse.text()}`,
    );
  }
  const { access_token: systemToken } =
    (await clientCredentialsResponse.json()) as { access_token: string };

  const tokenExchangeParams = new URLSearchParams({
    grant_type: "urn:opencrvs:oauth:grant-type:token-exchange",
    subject_token: systemToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:opencrvs:oauth:token-type:single_record_token",
    event_id: eventId,
    action_id: actionId,
  });
  const tokenExchangeResponse = await fetch(
    `${env.OPENCRVS_AUTH_URL}/token?${tokenExchangeParams}`,
    { method: "POST" },
  );
  if (!tokenExchangeResponse.ok) {
    throw new OpenCRVSError(
      `Token exchange failed: ${tokenExchangeResponse.status} ${await tokenExchangeResponse.text()}`,
    );
  }
  const { access_token: confirmationToken } =
    (await tokenExchangeResponse.json()) as { access_token: string };

  return confirmationToken;
};

export const confirmRegistration = (
  {
    eventId,
    actionId,
    nationalId,
    registrationNumber,
    additionalDeclaration,
    requestedId
  }: {
    eventId: string;
    actionId: string;
    nationalId?: string;
    registrationNumber: string;
    additionalDeclaration?: Record<string, string>;
    requestedId?: string;
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

  if(requestedId!==undefined){
    return client.event.actions.correction.approve.accept.mutate({
      requestId: requestedId,
      ...basePayload,
    });
  }

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
  process.nextTick(async () => {
    try {
      const url = new URL("events", env.OPENCRVS_GATEWAY_URL).toString();
      const client = createClient(url, `Bearer ${token}`);

      await client.event.actions.register.reject.mutate({
        transactionId: `mosip-interop-${crypto.randomUUID()}`,
        eventId,
        actionId,
        keepAssignment: true
      });

      await client.event.actions.reject.request.mutate({
        transactionId: `mosip-interop-${crypto.randomUUID()}`,
        eventId,
        actionId,
        content: { reason: failureReason }
      });

    } catch (err) {
      console.error("MOSIP rejection failed:", err);
    }
  });

  return true;
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
