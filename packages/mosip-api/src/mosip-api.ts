import { env } from "./constants";
import { readFileSync } from "fs";
import path from "path";
import MOSIPAuthenticator from "@mosip/ida-auth-sdk";
import { schemaJson } from "./types/idSchemaJson";
import {
  BirthRequestFields,
  DeathRequestFields,
  MosipInteropPayload,
} from "@opencrvs/mosip/api";
import {
  isDynamicField,
  findCodeForFieldValue,
  pickFirstString,
  isLangArrayString,
} from "./dynamic-fields";

export class MOSIPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MOSIPError";
  }
}

export type AuthType = "PACKET" | "WEBSUB";

export async function getMosipAuthToken(authType: AuthType) {
  const response = await fetch(env.MOSIP_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: "string",
      version: "string",
      requesttime: new Date().toISOString(),
      metadata: {},
      request: {
        clientId:
          authType === "PACKET"
            ? env.MOSIP_PACKET_AUTH_CLIENT_ID
            : env.MOSIP_WEBSUB_AUTH_CLIENT_ID,
        secretKey:
          authType === "PACKET"
            ? env.MOSIP_PACKET_AUTH_CLIENT_SECRET
            : env.MOSIP_WEBSUB_AUTH_CLIENT_SECRET,
        appId: env.MOSIP_AUTH_CLIENT_APP_ID,
      },
    }),
  });

  if (!response.ok) {
    throw new MOSIPError(
      `Failed getting MOSIP auth token. Response: ${response.status
      }, response: ${await response.text()}`,
    );
  }

  // Get the 'Set-Cookie' header from the response
  const cookie: string | null = response.headers.get("Set-Cookie");

  if (!cookie) {
    throw new MOSIPError(
      `Failed getting MOSIP auth token. Response: ${response.status
      }, response: ${await response.text()}`,
    );
  }

  // Split the string by ';' to separate the cookie parts
  const cookieParts = cookie.split(";");

  // The first part will be the Authorization token
  const authorizationPart = cookieParts[0];

  // Extract the token by splitting on '='
  const token = authorizationPart.split("=")[1];
  return token;
}

export async function getPreRegistrationAuthToken(): Promise<string> {
  const baseUrl = "http://localhost:9091";
  const userId = "kumar@gmail.com";
  const otp = "111111";

  const sendOtpResponse = await fetch(
    `${baseUrl}/preregistration/v1/login/sendOtpWithCaptcha`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "mosip.pre-registration.login.sendotp",
        request: {
          langCode: "eng",
          userId: userId,
        },
        version: "1.0",
        requesttime: new Date().toISOString(),
      }),
    }
  );

  if (!sendOtpResponse.ok) {
    throw new MOSIPError(
      `Failed sending OTP for pre-registration. Response: ${sendOtpResponse.status}, response: ${await sendOtpResponse.text()}`
    );
  }

  const sendOtpResult = await sendOtpResponse.json();
  // console.log("Send OTP response:", JSON.stringify(sendOtpResult, null, 2));

  const validateOtpResponse = await fetch(
    `${baseUrl}/preregistration/v1/login/validateOtp`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "mosip.pre-registration.login.useridotp",
        request: {
          otp: otp,
          userId: userId,
        },
        version: "1.0",
        requesttime: new Date().toISOString(),
      }),
    }
  );

  if (!validateOtpResponse.ok) {
    throw new MOSIPError(
      `Failed validating OTP for pre-registration. Response: ${validateOtpResponse.status}, response: ${await validateOtpResponse.text()}`
    );
  }

  const validateOtpResult = await validateOtpResponse.json();
  console.log("Validate OTP response:", JSON.stringify(validateOtpResult, null, 2));

  if (validateOtpResult.errors && validateOtpResult.errors.length > 0) {
    throw new MOSIPError(
      `OTP validation failed: ${validateOtpResult.errors[0].message}`
    );
  }

  const cookie: string | null = validateOtpResponse.headers.get("Set-Cookie");

  if (!cookie) {
    throw new MOSIPError(
      `Failed getting Authorization token from cookies. Response: ${validateOtpResponse.status}`
    );
  }


  const cookieParts = cookie.split(";");
  const authorizationPart = cookieParts.find((part) =>
    part.trim().startsWith("Authorization=")
  );

  if (!authorizationPart) {
    throw new MOSIPError(
      `Authorization token not found in cookies. Cookie: ${cookie}`
    );
  }

  const token = authorizationPart.split("=")[1];
  console.log("Successfully obtained pre-registration auth token");
  
  return token;
}
function getAgeInMonths(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  const years = now.getFullYear() - dob.getFullYear();
  const months = now.getMonth() - dob.getMonth();
  const totalMonths = years * 12 + months;
  return totalMonths;
}

export const postBirthRecord = async ({
  event,
  requestFields,
  audit,
  metaInfo,
  notification,
}: {
  event: {
    id: string;
    trackingId: string;
  };
  requestFields: BirthRequestFields;
  audit: MosipInteropPayload["audit"];
  metaInfo: MosipInteropPayload["metaInfo"];
  notification: MosipInteropPayload["notification"];
}) => {
  const requestBody = JSON.stringify(
    {
      id: "string",
      version: "string",
      requesttime: new Date().toISOString(),
      request: {
        id: event.id,
        refId: `${env.MOSIP_CENTER_ID}_${env.MOSIP_MACHINE_ID}`,
        offlineMode: false,
        process: "CRVS_NEW",
        source: "OPENCRVS",
        schemaVersion: "8.400",
        fields: requestFields,
        metaInfo: metaInfo,
        audits: Array.of(audit),
        schemaJson: schemaJson,
      },
    },
    null,
    2,
  );

  const authToken = await getMosipAuthToken("PACKET");

  // packet manager: create packet

  const dob = typeof requestFields.dateOfBirth === "string"
    ? requestFields.dateOfBirth
    : String(requestFields.dateOfBirth);

  const ageInMonths = getAgeInMonths(dob);
  if (ageInMonths < 9) {

    const createPacketResponse = await fetch(env.MOSIP_CREATE_PACKET_URL, {
      method: "PUT",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        Cookie: `Authorization=${authToken};`,
      },
    });

    if (!createPacketResponse.ok) {
      throw new Error(
        `Failed sending record to MOSIP, response: ${await createPacketResponse.text()}`,
      );
    }

    await createPacketResponse.json();

    // packet manager: process packet API.
    const processPacketRequestBody = JSON.stringify(
      {
        id: "mosip.registration.processor.workflow.instance",
        requesttime: new Date().toISOString(),
        version: "v1",
        request: {
          registrationId: event.id,
          process: "CRVS_NEW",
          source: "OPENCRVS",
          additionalInfoReqId: "",
          notificationInfo: {
            name: notification.recipientFullName,
            phone: notification.recipientPhone || "",
            email: notification.recipientEmail || "",
          },
        },
      },
      null,
      2,
    );

    const processPacketResponse = await fetch(env.MOSIP_PROCESS_PACKET_URL, {
      method: "POST",
      body: processPacketRequestBody,
      headers: {
        "Content-Type": "application/json",
        Cookie: `Authorization=${authToken};`,
      },
    });

    if (!processPacketResponse.ok) {
      throw new Error(
        `Failed sending record to MOSIP, response: ${await processPacketResponse.text()}`,
      );
    }

    const processPacketResponseJson = await processPacketResponse.json();

    if (processPacketResponseJson?.errors?.length > 0) {
      throw new Error(
        `Error in processing packet, response: ${await processPacketResponseJson?.errors[0]?.message}`,
      );
    }
  } else {

    const identity: Record<string, any> = {
      IDSchemaVersion: 8.4,
      userService: 'NEW',
    };

    console.log("\n=== Processing requestFields ===");
    for (const [fieldName, fieldValue] of Object.entries(requestFields)) {
      if (fieldValue == null || fieldValue === '') continue;

     
      if (fieldName === 'birthCertificateNumber') continue;

      const rawValue = String(fieldValue).trim();
      const wasLangArray = isLangArrayString(fieldValue);

      
      const extractedValue = pickFirstString(fieldValue);
      if (!extractedValue) continue;

      // console.log(`[Processing] ${fieldName}: raw="${rawValue.substring(0, 50)}..." wasLangArray=${wasLangArray}`);

    
      let finalValue: string = extractedValue;
      if (isDynamicField(fieldName)) {
        const code = findCodeForFieldValue(fieldName, extractedValue);
        console.log(`[Dynamic Field] ${fieldName}: "${extractedValue}" -> "${code}"`);
        if (code) {
          finalValue = code;
        }
      }

      if (wasLangArray) {
        identity[fieldName] = [{ language: 'eng', value: finalValue }];
      } else {
        identity[fieldName] = finalValue;
      }
    }

    const springPayload = {
      id: "mosip.pre-registration.demographic.create",
      version: "1.0",
      requesttime: new Date().toISOString(),
      request: {
        langCode: "eng",
        demographicDetails: {
          identity,
        },
        requiredFields: ["givenName", "surname", "dateOfBirth", "gender"]
      }
    };

    const preRegAuthToken = await getPreRegistrationAuthToken();
    const authCookie = `Authorization=${preRegAuthToken};`;
    
    try {
      console.log("Sending pre-registration payload to Spring:", JSON.stringify(springPayload, null, 2));
    } catch (e) {
      console.log("Sending pre-registration payload (could not stringify)");
    }

    const SPRING_SERVICE_URL = "http://localhost:9091/preregistration/v1/applications/prereg";

    const response = await fetch(SPRING_SERVICE_URL, {
      method: "POST",
      body: JSON.stringify(springPayload),
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie
      }
    });

    const rawResponseText = await response.text();
    let createData: any = rawResponseText;
    try {
      createData = rawResponseText ? JSON.parse(rawResponseText) : rawResponseText;
    } catch (e) {
    }

    console.log("create API response:", createData);
    const preRegId = createData?.response?.preRegistrationId;

    const statusCode = "Pending_Appointment";

    const statusUrl =
      `http://localhost:9091/preregistration/v1/applications/prereg/status/${preRegId}?statusCode=${encodeURIComponent(statusCode)}`;

    const statusRes = await fetch(statusUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie
      }
    });

    const statusResult = await statusRes.json();

    console.log("Update status:", statusResult);

    const appointmentUrl = "http://localhost:9091/preregistration/v1/applications/appointment";

    const appointmentBody = {
      id: "mosip.pre-registration.booking.book",
      request: {
        bookingRequest: [
          {
            preRegistrationId: preRegId,
            registration_center_id: "10045",
            appointment_date: "2028-10-01",
            time_slot_from: "09:30:00",
            time_slot_to: "09:45:00",
          },
        ],
      },
      version: "1.0",
      requesttime: new Date().toISOString(),
    };

    const appointmentRes = await fetch(appointmentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify(appointmentBody),
    });

    // if (!appointmentRes.ok) {
    //   throw new Error(
    //     `Failed creating appointment: ${appointmentRes.status} ${await appointmentRes.text()}`,
    //   );
    // }

    const appointmentJson = await appointmentRes.json();
    console.log(JSON.stringify(appointmentJson, null, 2));
  }
};

export const postDeathRecord = async ({
  event,
  requestFields,
  audit,
  metaInfo,
  notification,
}: {
  event: {
    id: string;
    trackingId: string;
  };
  requestFields: DeathRequestFields;
  audit: MosipInteropPayload["audit"];
  metaInfo: MosipInteropPayload["metaInfo"];
  notification: MosipInteropPayload["notification"];
}) => {
  const authToken = await getMosipAuthToken("PACKET");

  const { deathCertificateNumber, ...newRequestBody } = requestFields;

  const deactivatePacketRequestBody = JSON.stringify(
    {
      id: "string",
      version: "string",
      requesttime: new Date().toISOString(),
      request: {
        id: event.id,
        refId: `${env.MOSIP_CENTER_ID}_${env.MOSIP_MACHINE_ID}`,
        offlineMode: false,
        process: "CRVS_DEATH",
        source: "OPENCRVS",
        schemaVersion: "0.100",
        fields: newRequestBody,
        metaInfo: metaInfo,
        audits: Array.of(audit),
        schemaJson: schemaJson,
      },
    },
    null,
    2,
  );

  // packet manager: deactivate packet
  const deactivatePacketResponse = await fetch(env.MOSIP_CREATE_PACKET_URL, {
    method: "PUT",
    body: deactivatePacketRequestBody,
    headers: {
      "Content-Type": "application/json",
      Cookie: `Authorization=${authToken};`,
    },
  });

  if (!deactivatePacketResponse.ok) {
    throw new Error(
      `Failed sending record to MOSIP, response: ${await deactivatePacketResponse.text()}`,
    );
  }

  await deactivatePacketResponse.json();

  // packet manager: process packet API.
  const processPacketRequestBody = JSON.stringify(
    {
      id: "mosip.registration.processor.workflow.instance",
      requesttime: new Date().toISOString(),
      version: "v1",
      request: {
        registrationId: event.id,
        process: "CRVS_DEATH",
        source: "OPENCRVS",
        additionalInfoReqId: "",
        notificationInfo: {
          name: notification.recipientFullName,
          phone: notification.recipientPhone || "",
          email: notification.recipientEmail || "",
        },
      },
    },
    null,
    2,
  );

  const processPacketResponse = await fetch(env.MOSIP_PROCESS_PACKET_URL, {
    method: "POST",
    body: processPacketRequestBody,
    headers: {
      "Content-Type": "application/json",
      Cookie: `Authorization=${authToken};`,
    },
  });

  if (!processPacketResponse.ok) {
    throw new Error(
      `Failed sending record to MOSIP, response: ${await processPacketResponse.text()}`,
    );
  }

  const processPacketResponseJson = await processPacketResponse.json();

  if (processPacketResponseJson?.errors?.length > 0) {
    throw new Error(
      `Error in processing packet, response: ${await processPacketResponseJson?.errors[0]?.message}`,
    );
  }
};

export const verifyNid = async ({
  nid,
  name,
  gender,
  dob,
}: {
  nid: string;
  /** date of birth as YYYY/MM/DD */
  dob: string | undefined;
  name: { language: string; value: string }[] | undefined;
  gender: { language: string; value: string }[] | undefined;
}) => {
  const authenticator = new MOSIPAuthenticator({
    partnerApiKey: env.PARTNER_APIKEY,
    partnerMispLk: env.PARTNER_MISP_LK,
    partnerId: env.PARTNER_ID,
    idaAuthDomainUri: env.IDA_AUTH_DOMAIN_URI,
    idaAuthUrl: env.IDA_AUTH_URL,
    encryptCertPath: env.ENCRYPT_CERT_PATH,
    decryptP12FilePath: env.DECRYPT_P12_FILE_PATH,
    decryptP12FilePassword: env.DECRYPT_P12_FILE_PASSWORD,
    signP12FilePath: env.SIGN_P12_FILE_PATH,
    signP12FilePassword: env.SIGN_P12_FILE_PASSWORD,
  });

  const response = await authenticator.auth({
    individualId: nid.toLowerCase() + "@nin",
    individualIdType: "HANDLE",
    demographicData: {
      dob,
      name,
      gender,
    },
    consent: true,
  });

  if (!response.ok) {
    throw new Error(`Error in MOSIP Authenticator: ${await response.text()}`);
  }

  return (await response.json()) as {
    responseTime: string;
    response: { authStatus: boolean; authToken: string };
  };
};
