import { env } from "./constants";
import { readFileSync, existsSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { exec } from "child_process";
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
  processLocationHierarchy,
} from "./dynamic-fields";
import { error } from "console";
import { insertTransaction } from "./database";

export class MOSIPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MOSIPError";
  }
}

export type AuthType = "PACKET" | "WEBSUB";

const execAsync = promisify(exec);

async function downloadDocumentFromMinIO(documentPath: string): Promise<Buffer | null> {
  try {
    const minioObjectPath = documentPath.startsWith('/') ? documentPath.slice(1) : documentPath;

    const tempDir = '/tmp/opencrvs-docs';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fileName = path.basename(documentPath);
    const timestamp = Date.now();
    const tempFilePath = path.join(tempDir, `${timestamp}_${fileName}`);
    await execAsync(`mc alias set ${env.MINIO_ALIAS} http://${env.MINIO_DOMAIN} ${env.MINIO_ROOT_USER} ${env.MINIO_ROOT_PASSWORD}`);

    const downloadCommand = `mc cp "${env.MINIO_ALIAS}/${minioObjectPath}" "${tempFilePath}"`;
    await execAsync(downloadCommand);

    if (fs.existsSync(tempFilePath)) {
      const fileBuffer = fs.readFileSync(tempFilePath);

      fs.unlinkSync(tempFilePath);
      return fileBuffer;
    } else {
      console.error(` Failed to download document from MinIO: ${documentPath}`);
      return null;
    }
  } catch (error) {
    console.error(` Error downloading document from MinIO ${documentPath}:`, error);
    return null;
  }
}

export async function getMosipAuthToken(authType: AuthType) {
  // Use different URLs based on authType
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

function getAgeInMonths(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  const years = now.getFullYear() - dob.getFullYear();
  const months = now.getMonth() - dob.getMonth();
  const totalMonths = years * 12 + months;
  return totalMonths;
}

interface DocumentField {
  type: string;
  path: string;
  originalName: string;
}
const getDocumentMapping = (documentType: string): { docCatCode: string; docTypCode: string } => {
  const typeMapping: Record<string, { docCatCode: string; docTypCode: string }> = {
    'PASSPORT': { docCatCode: 'POPASS', docTypCode: 'DOC001' },
    'NATIONAL_ID': { docCatCode: 'POI', docTypCode: 'DOC002' },
    'ALIEN_ID': { docCatCode: 'POI', docTypCode: 'DOC003' },
    'REFUGEE_ID': { docCatCode: 'POI', docTypCode: 'DOC004' },
    'CERTIFICATE_OF_BIRTH': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'BIRTH_CERTIFICATE': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'LC_RECOMMENDATION_LETTER': { docCatCode: 'POB', docTypCode: 'DOC029' },
    'MISSION_LETTER': { docCatCode: 'POB', docTypCode: 'DOC030' },
    'POLICE_REPORT': { docCatCode: 'POL', docTypCode: 'DOC031' },
    'STATUTORY_DECLARATION': { docCatCode: 'POL', docTypCode: 'DOC032' },
    'COURT_ORDER': { docCatCode: 'POL', docTypCode: 'DOC033' },
    'AFFIDAVIT': { docCatCode: 'POL', docTypCode: 'DOC034' },
    'CITIZENSHIP_CERTIFICATE': { docCatCode: 'POC', docTypCode: 'DOC035' },
    'NATURALIZATION_CERTIFICATE': { docCatCode: 'POC', docTypCode: 'DOC036' },
    'OTHER': { docCatCode: 'POO', docTypCode: 'DOC999' }
  };

  return typeMapping[documentType] || { docCatCode: 'POO', docTypCode: 'DOC999' };
};

async function uploadDocumentToMosip(
  preRegId: string,
  documentField: DocumentField,
  authToken: string
): Promise<void> {
  // const IDA_AUTH_DOMAIN_URI = "https://localhost:9091";
  let docType = documentField.type;
  if (docType.startsWith('[{') && docType.endsWith('}]')) {
    try {
      const parsed = JSON.parse(docType);
      docType = Array.isArray(parsed) && parsed.length > 0 ? parsed[0].value : docType;
    } catch (e) {
      console.warn(`Failed to parse document type in uploadDocumentToMosip: ${docType}`, e);
    }
  }

  const { docCatCode, docTypCode } = getDocumentMapping(docType);

  const documentRequest = {
    id: "mosip.pre-registration.document.upload",
    request: {
      docCatCode,
      docTypCode,
      langCode: "eng",
      refNumber: ""
    },
    metadata: {},
    version: "1.0",
    requesttime: new Date().toISOString()
  };

  try {
    let fileBuffer: Buffer;
    if (documentField.path.startsWith('/ocrvs/')) {

      const minioBuffer = await downloadDocumentFromMinIO(documentField.path);

      if (minioBuffer) {
        fileBuffer = minioBuffer;
        console.log(` Document fetched successfully from MinIO: ${documentField.originalName} (${fileBuffer.length} bytes)`);
      } else {
        throw new Error(`Failed to fetch document from MinIO: ${documentField.path}`);
      }
    } else {
      if (!existsSync(documentField.path)) {
        console.warn(`Document file not found: ${documentField.path}`);
        return;
      }
      fileBuffer = readFileSync(documentField.path);
    }

    const boundary = '----formdata-' + Math.random().toString(36).substring(2, 15);

    const formDataStart = `--${boundary}\r\nContent-Disposition: form-data; name="Document request"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(documentRequest)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${documentField.originalName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const formDataEnd = `\r\n--${boundary}--\r\n`;

    const fullFormData = Buffer.concat([
      Buffer.from(formDataStart, 'utf8'),
      fileBuffer,
      Buffer.from(formDataEnd, 'utf8')
    ]);

    const uploadUrl = `${env.IDA_AUTH_DOMAIN_URI}/preregistration/v1/documents/${preRegId}`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: fullFormData,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullFormData.length.toString(),
        Cookie: `Authorization=${authToken};`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Document upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();

    console.log(`Successfully uploaded document ${documentField.originalName}:`, result);

  } catch (error) {
    console.error(`Error uploading document ${documentField.originalName}:`, error);
    throw error;
  }
}

async function extractDocumentFields(requestFields: any): Promise<DocumentField[]> {
  const documentFields: DocumentField[] = [];
  const documentsObject = requestFields.documents as any;

  if (documentsObject && typeof documentsObject === 'object') {
    for (const [documentKey, documentData] of Object.entries(documentsObject)) {
      if (documentData && typeof documentData === 'object') {
        const docData = documentData as any;
        let docType = docData.documentType;
        const docPath = docData.path;
        const docOriginalName = docData.originalName;

        if (typeof docType === 'string' && docType.startsWith('[{') && docType.endsWith('}]')) {
          try {
            const parsed = JSON.parse(docType);
            docType = Array.isArray(parsed) && parsed.length > 0 ? parsed[0].value : docType;
          } catch (e) {
            console.warn(`Failed to parse document type in extractDocumentFields for ${documentKey}:`, e);
          }
        }

        if (docType && docPath && docOriginalName) {
          documentFields.push({
            type: String(docType),
            path: String(docPath),
            originalName: String(docOriginalName)
          });
        } else {
          console.warn(`Incomplete document data for ${documentKey}:`, { docType, docPath, docOriginalName });
        }
      }
    }
  } else {
    console.log("No documents object found - this may indicate an outdated payload structure");
  }

  return documentFields;
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
    token: string;
  };
  requestFields: BirthRequestFields;
  audit: MosipInteropPayload["audit"];
  metaInfo: MosipInteropPayload["metaInfo"];
  notification: MosipInteropPayload["notification"];
}) => {
  const authToken = await getMosipAuthToken("PACKET");

  const documentFields = await extractDocumentFields(requestFields);

  const dob = typeof requestFields.dateOfBirth === "string"
    ? requestFields.dateOfBirth
    : String(requestFields.dateOfBirth);

  const ageInMonths = getAgeInMonths(dob);
  const birthCertificateNumber = requestFields.birthCertificateNumber;
  if (ageInMonths < 9) {
    const registrationId = event.trackingId + '-' + event.id;
    console.log({ registrationId }, "Event ID");
    insertTransaction(registrationId, event.token, birthCertificateNumber);

    const { documents, ...newRequestBody } = requestFields;
    const requestBody = JSON.stringify(
      {
        id: "string",
        version: "string",
        requesttime: new Date().toISOString(),
        request: {
          id: registrationId,
          refId: `${env.MOSIP_CENTER_ID}_${env.MOSIP_MACHINE_ID}`,
          offlineMode: false,
          process: "CRVS_NEW",
          source: "OPENCRVS",
          schemaVersion: "8.400",
          fields: newRequestBody,
          metaInfo: metaInfo,
          audits: Array.of(audit),
          schemaJson: schemaJson,
        },
      },
      null,
      2,
    );

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
          registrationId: registrationId,
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
      userServiceType: [{ language: 'eng', value: 'CRVS' }],
      trackingId: [{ language: 'eng', value: event.trackingId }]
    };
    const applicantLocationCodes = await processLocationHierarchy(requestFields);

    for (const [fieldName, fieldValue] of Object.entries(requestFields)) {
      if (fieldValue == null || fieldValue === '') continue;


      if (fieldName === 'birthCertificateNumber'|| fieldName ==='userService' || fieldName ==='userServiceType') continue;
      if (fieldName.toLowerCase().includes('document')) continue;
      const wasLangArray = isLangArrayString(fieldValue);


      const extractedValue = pickFirstString(fieldValue);
      if (!extractedValue) continue;


      let finalValue: string = extractedValue;
      if (isDynamicField(fieldName)) {
        const code = findCodeForFieldValue(fieldName, extractedValue);
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

    if (applicantLocationCodes.districtCode) {
      identity['applicantPlaceOfBirthDistrict'] = [{ language: 'eng', value: applicantLocationCodes.districtCode }];
    }
    if (applicantLocationCodes.countyCode) {
      identity['applicantPlaceOfBirthCounty'] = [{ language: 'eng', value: applicantLocationCodes.countyCode }];
    }
    if (applicantLocationCodes.subCountyCode) {
      identity['applicantPlaceOfBirthSubCounty'] = [{ language: 'eng', value: applicantLocationCodes.subCountyCode }];
    }
    if (applicantLocationCodes.parishCode) {
      identity['applicantPlaceOfBirthParish'] = [{ language: 'eng', value: applicantLocationCodes.parishCode }];
    }
    if (applicantLocationCodes.villageCode) {
      identity['applicantPlaceOfBirthVillage'] = [{ language: 'eng', value: applicantLocationCodes.villageCode }];
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

    // const IDA_AUTH_DOMAIN_URI = "http://localhost:9091";
    const SPRING_SERVICE_URL = `${env.IDA_AUTH_DOMAIN_URI}/preregistration/v1/applications/prereg`;

    const response = await fetch(SPRING_SERVICE_URL, {
      method: "POST",
      body: JSON.stringify(springPayload),
      headers: {
        "Content-Type": "application/json",
        Cookie: `Authorization=${authToken};`
      }
    });

    const rawResponseText = await response.text();
    let createData: any = rawResponseText;
    try {
      createData = rawResponseText ? JSON.parse(rawResponseText) : rawResponseText;
    } catch (e) {
      throw error("Parsing error exception: ", e);
    }
    const preRegId = createData?.response?.preRegistrationId;

    console.log("Pre-registration creation response:", preRegId);

    if (!preRegId) {
      throw new Error("Failed to get pre-registration ID from MOSIP response");
    }

    insertTransaction(preRegId, event.token, birthCertificateNumber);

    const statusUrl =
      `${env.IDA_AUTH_DOMAIN_URI}/preregistration/v1/applications/prereg/status/${preRegId}?statusCode=Pending_Appointment`;

    const statusRes = await fetch(statusUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: `Authorization=${authToken};`
      }
    });

    const statusResult = await statusRes.json();
    console.log("Status update response:", statusResult);

    const appointmentUrl = `${env.IDA_AUTH_DOMAIN_URI}/preregistration/v1/applications/appointment`;

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
        Cookie: `Authorization=${authToken};`,
      },
      body: JSON.stringify(appointmentBody),
    });

    if (!appointmentRes.ok) {
      throw new Error(
        `Failed creating appointment: ${appointmentRes.status} ${await appointmentRes.text()}`,
      );
    }

    const appointmentJson = await appointmentRes.json();
    console.log("Appointment booking response:", JSON.stringify(appointmentJson, null, 2));

    if (preRegId) {
      for (const document of documentFields) {
        try {
          await uploadDocumentToMosip(preRegId, document, authToken);
        } catch (error) {
          console.error(`Failed to upload document ${document.originalName}:`, error);
        }
      }
    } else {
      console.warn("Pre-registration ID not available, skipping document upload");
    }
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
        fields: requestFields,
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
