/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * OpenCRVS is also distributed under the terms of the Civil Registration
 * & Healthcare Disclaimer located at http://opencrvs.org/license.
 *
 * Copyright (C) The OpenCRVS Authors located at https://github.com/opencrvs/opencrvs-core/blob/master/AUTHORS.
 */

import * as jwt from "jsonwebtoken";
import { env } from "./constants";
import z from "zod";
import * as jose from "jose";
import { isValid, format, Locale, parse } from "date-fns";
import { enGB } from "date-fns/locale/en-GB";
import { fr } from "date-fns/locale/fr";
import fs from "node:fs";

const OIDP_CLIENT_PRIVATE_KEY = fs
  .readFileSync(env.OIDP_CLIENT_PRIVATE_KEY_PATH)
  .toString();
export const locales: Record<string, Locale> = { en: enGB, fr };

type OIDPUserAddress = {
  formatted: string;
  street_address: string;
  locality: string;
  region: string;
  postal_code: string;
  city: string;
  country: string;
};

type OIDPUserInfo = {
  sub: string;
  name?: string;
  given_name?: string;
  surname?: string;
  other_names?: string;
  nickname?: string;
  nin?: string;
  preferred_username?: string;
  profile?: string;
  picture?: string;
  website?: string;
  email?: string;
  email_verified?: boolean;
  gender?: "female" | "male";
  birthdate?: string;
  zoneinfo?: string;
  locale?: string;
  phone_number?: string;
  phone_number_verified?: boolean;
  address?: Partial<OIDPUserAddress>;
  updated_at?: number;
};

const JWT_EXPIRATION_TIME = "1h";
const JWT_ALG = "RS256";

export const OIDPUserInfoSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  placeOfBirth: z.string().optional(),
  deathService: z.string().optional(),
});

export const OIDPQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
});

type FetchTokenProps = {
  code: string;
  clientId: string;
  redirectUri: string;
  grantType?: string;
};

const generateSignedJwt = async (clientId: string) => {
  const header = {
    alg: JWT_ALG,
    typ: "JWT",
  };

  const payload = {
    iss: clientId,
    sub: clientId,
    // aud: env.OPENID_PROVIDER_CLAIMS,
    aud: env.ESIGNET_TOKEN_URL,
  };

  console.log("JWT payload", payload);

  const decodeKey = Buffer.from(OIDP_CLIENT_PRIVATE_KEY, "base64")?.toString();
  const jwkObject = JSON.parse(decodeKey);
  const privateKey = await jose.importJWK(jwkObject, JWT_ALG);

  return new jose.SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRATION_TIME)
    .sign(privateKey);
};

export const fetchToken = async ({
  code,
  clientId,
  redirectUri,
}: FetchTokenProps) => {
  const clientAssertion = await generateSignedJwt(clientId);
  console.log("client assertion: ", clientAssertion);

  const url = new URL(redirectUri);
  url.searchParams.delete("state");
  url.searchParams.delete("code");
  redirectUri = url.toString();

  const body = new URLSearchParams({
    code: code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion,
  });

  console.log("fetch token request body", body.toString());
  console.log("fetch token request url", env.ESIGNET_TOKEN_URL);

  const request = await fetch(env.ESIGNET_TOKEN_URL!, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const response = await request.json();
  console.log("fetch token response", response);
  return response as { access_token?: string };
};

export const fetchLocationFromFHIR = <T = any>(
  suffix: string,
  method = "GET",
  body: string | undefined = undefined,
): Promise<T> => {
  return fetch(`${env.OPENCRVS_GATEWAY_URL}/${suffix}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body,
  })
    .then((response) => {
      return response.json();
    })
    .catch((error) => {
      return Promise.reject(
        new Error(`Fetch Location from FHIR request failed: ${error.message}`),
      );
    });
};

const searchLocationFromFHIR = (name: string) =>
  fetchLocationFromFHIR<fhir2.Bundle>(
    `/locations?${new URLSearchParams({ name, type: "ADMIN_STRUCTURE" })}`,
  );

function formatDate(dateString: string, formatStr = "PP") {
  const date = parse(dateString, "dd/MM/yyyy", new Date());
  if (!isValid(date)) {
    return "";
  }
  return format(date, formatStr, {
    locale: locales[env.LOCALE],
  });
}

const normalizeString = (value: unknown): string => {
  return typeof value === "string" ? value : "";
};

const getRoleFromRedirectUri = (redirectUri?: string) => {
  if (!redirectUri) return undefined;
  if (redirectUri.includes("/pages/mother")) return "mother";
  if (redirectUri.includes("/pages/father")) return "father";
  return undefined;
};

const getPageFromRedirectUri = (redirectUri?: string): string | undefined => {
  if (!redirectUri) return undefined;
  const match = redirectUri.match(/\/pages\/([^/?#]+)/);
  return match?.[1];
};

const ALIEN_ID_PREFIXES_REGEX = /^(AM|AF)/i;

const BIRTH_SERVICES_WITHOUT_ALIEN_ID: string[] = ["OUTSIDE_UGANDA", "FOUNDLING"];
const DEATH_SERVICES_WITHOUT_ALIEN_ID: string[] = ["DEATH_OUTSIDE_UGANDA"];

const pickUserInfo = async (
  userInfo: OIDPUserInfo,
  redirectUri?: string,
  placeOfBirth?: string,
  deathService?: string
) => {
  const role = getRoleFromRedirectUri(redirectUri);
  const gender = userInfo?.gender?.toLowerCase();

  if (
    (role === "mother" && gender === "male") ||
    (role === "father" && gender === "female")
  ) {
    return {
      verificationStatus: "failed"
    };
  }

  const nationalId = userInfo.nin;
  const page = getPageFromRedirectUri(redirectUri);

  // Alien IDs (AM/AF prefix) are not applicable on the child page for Birth Outside Uganda / Foundling,
  // and on the deceased page for Death Outside Uganda
  if (
    nationalId &&
    ALIEN_ID_PREFIXES_REGEX.test(nationalId) &&
    (
      (page === "child" && placeOfBirth && BIRTH_SERVICES_WITHOUT_ALIEN_ID.includes(placeOfBirth)) ||
      (page === "deceased" && deathService && DEATH_SERVICES_WITHOUT_ALIEN_ID.includes(deathService))
    )
  ) {
    return {
      verificationStatus: "failed"
    };
  }

  const isAlienId = !!nationalId && nationalId.startsWith("A");

  return {
    name: {
      firstname: normalizeString(userInfo.given_name),
      middlename: normalizeString(userInfo.other_names),
      surname: normalizeString(userInfo.surname),
    },
    gender,
    ...(userInfo.birthdate && {
      dobUnknown: null,
      birthDate: formatDate(userInfo.birthdate, "yyyy-MM-dd"),
    }),
    verificationStatus: "authenticated",
    ...(isAlienId
      ? {
        idType: "ALIEN_ID",
        alienID: nationalId,
      }
      : {
        idType: "NATIONAL_ID",
        nid: nationalId,
      }),
  };
};

const decodeUserInfoResponse = (response: string) => {
  return jwt.decode(response) as OIDPUserInfo;
};

export const fetchUserInfo = async (
  accessToken: string,
  redirectUri?: string,
  placeOfBirth?: string,
  deathService?: string
) => {
  const request = await fetch(env.ESIGNET_USERINFO_URL, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + accessToken,
    },
  });

  const response = await request.text();
  const decodedResponse = decodeUserInfoResponse(response);
  console.log("Decoded response", JSON.stringify(decodedResponse));
  if (!decodedResponse) {
    throw new Error(
      "Something went wrong with the OIDP user info request. No user info was returned. Response from OIDP: " +
      JSON.stringify(response),
    );
  }
  const pickedUserInfo = await pickUserInfo(decodedResponse, redirectUri, placeOfBirth, deathService);
  console.log("Picked User Info :", JSON.stringify(pickedUserInfo));

  return pickedUserInfo;
};
