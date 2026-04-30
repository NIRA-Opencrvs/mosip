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

  applicantForeignResidenceCountry?: string;
  applicantForeignResidenceAddress?: string;
  appResCountryUGA?: string;
  applicantPlaceOfResidenceDistrict?: string;
  applicantPlaceOfResidenceCounty?: string;
  applicantPlaceOfResidenceSubCounty?: string;
  applicantPlaceOfResidenceParish?: string;
  applicantPlaceOfResidenceVillage?: string;

  applicantPlaceOfBirthTimeOfBirth?: string;
  applicantPlaceOfBirthWeightAtBirth?: string;
  applicantPlaceOfBirthHealthFacility?: string;
  appBirCountryUGA?: string;
  applicantPlaceOfBirthDistrict?: string;
  applicantPlaceOfBirthCounty?: string;
  applicantPlaceOfBirthSubCounty?: string;
  applicantPlaceOfBirthParish?: string;
  applicantPlaceOfBirthVillage?: string;
  applicantForeignBirthCountry?: string;
  applicantForeignBirthAddress?: string;
  disabilities?: string;
  applicantLivingStatus?: string;

  motherSurname?: string;
  motherGivenName?: string;
  motherOtherNames?: string;
  motherNIN?: string;
  motResCountryUGA?: string;
  motherPlaceOfResidenceDistrict?: string;
  motherPlaceOfResidenceCounty?: string;
  motherPlaceOfResidenceSubCounty?: string;
  motherPlaceOfResidenceParish?: string;
  motherPlaceOfResidenceVillage?: string;
  motherForeignResidenceCountry?: string;
  motherForeignResidenceAddress?: string;
  motherLivingStatus?: string;
  applicantPlaceOfBirthParityOfChild?: string;

  fatherSurname?: string;
  fatherGivenName?: string;
  fatherOtherNames?: string;
  fatherNIN?: string;
  fatResCountryUGA?: string;
  fatherPlaceOfResidenceDistrict?: string;
  fatherPlaceOfResidenceCounty?: string;
  fatherPlaceOfResidenceSubCounty?: string;
  fatherPlaceOfResidenceParish?: string;
  fatherPlaceOfResidenceVillage?: string;
  fatherForeignResidenceCountry?: string;
  fatherForeignResidenceAddress?: string;
  fatherLivingStatus?: string;
};

const JWT_EXPIRATION_TIME = "1h";
const JWT_ALG = "RS256";

export const OIDPUserInfoSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  service: z.string().optional(),
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
  if (redirectUri.includes("/pages/child")) return "child";
  return undefined;
};

const ALIEN_ID_PREFIXES_REGEX = /^(AM|AF)/i;

const SERVICES_WITHOUT_ALIEN_ID: string[] = [
  "OUTSIDE_UGANDA",
  "FOUNDLING",
  "DEATH_OUTSIDE_UGANDA",
];

const pickUserInfo = async (
  userInfo: OIDPUserInfo,
  redirectUri?: string,
  service?: string
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

  // Alien IDs (AM/AF prefix) are not applicable for Birth Outside Uganda, Foundling, and Death Outside Uganda.
  if (
    nationalId &&
    ALIEN_ID_PREFIXES_REGEX.test(nationalId) &&
    service &&
    SERVICES_WITHOUT_ALIEN_ID.includes(service)
  ) {
    return {
      verificationStatus: "failed"
    };
  }

  const isAlienId = !!nationalId && nationalId.startsWith("A");

  // Only map mother and father info when role is child (not mother or father)
  const isChild = role === "child";
  const isParent = role === "mother" || role === "father";

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
    ...(isChild && {
      foreignCountry: userInfo.applicantForeignBirthCountry,
      foreignAddress: userInfo.applicantForeignBirthAddress,
      country: userInfo.appBirCountryUGA,
      district: userInfo.applicantPlaceOfBirthDistrict,
      county: userInfo.applicantPlaceOfBirthCounty,
      subCounty: userInfo.applicantPlaceOfBirthSubCounty,
      parish: userInfo.applicantPlaceOfBirthParish,
      village: userInfo.applicantPlaceOfBirthVillage,
      healthFacility: userInfo.applicantPlaceOfBirthHealthFacility,
      timeOfBirth: userInfo.applicantPlaceOfBirthTimeOfBirth,
      weightAtBirth: userInfo.applicantPlaceOfBirthWeightAtBirth,
      disabilities: userInfo.disabilities,

      motherDataPresent: !!(userInfo.motherSurname || userInfo.motherGivenName || userInfo.motherOtherNames || userInfo.motherNIN),
      ...(userInfo.motherSurname || userInfo.motherGivenName || userInfo.motherOtherNames
        ? {
            mother_name: {
              ...(userInfo.motherGivenName && { firstname: normalizeString(userInfo.motherGivenName) }),
              ...(userInfo.motherOtherNames && { middlename: normalizeString(userInfo.motherOtherNames) }),
              ...(userInfo.motherSurname && { surname: normalizeString(userInfo.motherSurname) }),
            }
          }
        : {}
      ),
      ...(userInfo.motherNIN
        ? userInfo.motherNIN.startsWith("A")
          ? {
              mother_idType: "ALIEN_ID",
              mother_alienID: userInfo.motherNIN,
            }
          : {
              mother_idType: "NATIONAL_ID",
              mother_nid: userInfo.motherNIN,
            }
        : {}),
      mother_foreignCountry: userInfo.motherForeignResidenceCountry,
      mother_foreignAddress: userInfo.motherForeignResidenceAddress,
      mother_country: userInfo.motResCountryUGA,
      mother_district: userInfo.motherPlaceOfResidenceDistrict,
      mother_county: userInfo.motherPlaceOfResidenceCounty,
      mother_subCounty: userInfo.motherPlaceOfResidenceSubCounty,
      mother_parish: userInfo.motherPlaceOfResidenceParish,
      mother_village: userInfo.motherPlaceOfResidenceVillage,
      mother_livingStatus: userInfo.motherLivingStatus,
      mother_parityOfChild: userInfo.applicantPlaceOfBirthParityOfChild,

      fatherDataPresent: !!(userInfo.fatherSurname || userInfo.fatherGivenName || userInfo.fatherOtherNames || userInfo.fatherNIN),
      ...(userInfo.fatherSurname || userInfo.fatherGivenName || userInfo.fatherOtherNames
        ? {
            father_name: {
              ...(userInfo.fatherGivenName && { firstname: normalizeString(userInfo.fatherGivenName) }),
              ...(userInfo.fatherOtherNames && { middlename: normalizeString(userInfo.fatherOtherNames) }),
              ...(userInfo.fatherSurname && { surname: normalizeString(userInfo.fatherSurname) }),
            }
          }
        : {}
      ),
      ...(userInfo.fatherNIN
        ? userInfo.fatherNIN.startsWith("A")
          ? {
              father_idType: "ALIEN_ID",
              father_alienID: userInfo.fatherNIN,
            }
          : {
              father_idType: "NATIONAL_ID",
              father_nid: userInfo.fatherNIN,
            }
        : {}),
      father_foreignCountry: userInfo.fatherForeignResidenceCountry,
      father_foreignAddress: userInfo.fatherForeignResidenceAddress,
      father_country: userInfo.fatResCountryUGA,
      father_district: userInfo.fatherPlaceOfResidenceDistrict,
      father_county: userInfo.fatherPlaceOfResidenceCounty,
      father_subCounty: userInfo.fatherPlaceOfResidenceSubCounty,
      father_parish: userInfo.fatherPlaceOfResidenceParish,
      father_village: userInfo.fatherPlaceOfResidenceVillage,
      father_livingStatus: userInfo.fatherLivingStatus
    }),
    ...(isParent && {
      foreignCountry: userInfo.applicantForeignResidenceCountry,
      foreignAddress: userInfo.applicantForeignResidenceAddress,
      country: userInfo.appResCountryUGA,
      district: userInfo.applicantPlaceOfResidenceDistrict,
      county: userInfo.applicantPlaceOfResidenceCounty,
      subCounty: userInfo.applicantPlaceOfResidenceSubCounty,
      parish: userInfo.applicantPlaceOfResidenceParish,
      village: userInfo.applicantPlaceOfResidenceVillage,
      livingStatus: userInfo.applicantLivingStatus,
      parityOfChild: userInfo.applicantPlaceOfBirthParityOfChild
    })
  };
};

const decodeUserInfoResponse = (response: string) => {
  return jwt.decode(response) as OIDPUserInfo;
};

export const fetchUserInfo = async (
  accessToken: string,
  redirectUri?: string,
  service?: string
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
  const pickedUserInfo = await pickUserInfo(decodedResponse, redirectUri, service);
  console.log("Picked User Info :", JSON.stringify(pickedUserInfo));

  return pickedUserInfo;
};
