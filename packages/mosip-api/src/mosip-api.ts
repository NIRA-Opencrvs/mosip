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
  processApplicantLocationHierarchy,
  processFatherLocationHierarchy,
  processMotherLocationHierarchy
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

let cachedIDSchema: {
  version: number;
  versionString: string;
  schemaJson: string;
} | null = null;

/**
 * Initialize and cache the ID Schema version at service startup
 */
export async function initializeIDSchema(): Promise<void> {
  try {
    const authToken = await getMosipAuthToken("PACKET");
    cachedIDSchema = await getLatestIDSchemaVersion(authToken);
    console.log(`ID Schema initialized and cached: version ${cachedIDSchema.versionString}`);
  } catch (error) {
    console.error("Failed to initialize ID Schema:", error);
    throw error;
  }
}

export function getCachedIDSchema(): {
  version: number;
  versionString: string;
  schemaJson: string;
} {
  if (!cachedIDSchema) {
    throw new MOSIPError(
      "ID Schema not initialized. Please call initializeIDSchema() at service startup."
    );
  }
  return cachedIDSchema;
}


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
    const authUrl = authType === "WEBSUB"
    ? "http://localhost:20240/v1/authmanager/authenticate/clientidsecretkey"
    : env.MOSIP_AUTH_URL;

  // Use different URLs based on authType
  const response = await fetch(authUrl, {
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

interface IDSchemaResponse {
  id: string | null;
  version: string | null;
  responsetime: string;
  metadata: any;
  response: {
    idVersion: number;
    schemaJson: string;
  };
}

/**
 * Fetches the latest ID Schema version and schema JSON from MOSIP
 * @param authToken - The MOSIP authentication token
 * @returns Object containing version info and schema JSON string
 */
export async function getLatestIDSchemaVersion(authToken: string): Promise<{ 
  version: number; 
  versionString: string; 
  schemaJson: string;
}> {
  try {
    const ID_SCHEMA_URL = `${env.IDA_AUTH_DOMAIN_URI}/v1/masterdata/idschema/latest`;
    const response = await fetch(ID_SCHEMA_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `Authorization=${authToken};`,
      },
    });

    if (!response.ok) {
      throw new MOSIPError(
        `Failed to fetch ID schema. Response: ${response.status}, response: ${await response.text()}`,
      );
    }

    const data: IDSchemaResponse = await response.json();
    
    if (!data.response || data.response.idVersion === undefined) {
      throw new MOSIPError(
        `Invalid ID schema response: missing idVersion in response`,
      );
    }

    if (!data.response.schemaJson || typeof data.response.schemaJson !== 'string') {
      throw new MOSIPError(
        `Invalid ID schema response: missing or invalid schema JSON string`,
      );
    }

    const version = data.response.idVersion;
    const versionString = String(version);
    const schemaJson = data.response.schemaJson;
    
    // Validate that the schema is parseable JSON
    try {
      JSON.parse(schemaJson);
    } catch (parseError) {
      throw new MOSIPError(
        `Failed to parse schema JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
      );
    }
    return { version, versionString, schemaJson };
  } catch (error) {
    console.error("Error fetching ID schema:", error);
    throw new MOSIPError(
      `Failed to fetch ID schema from API: ${error instanceof Error ? error.message : 'Unknown error'}. Please check API connectivity and authentication.`,
    );
  }
}

function getAgeInMonths(dateOfBirth: string): number {
  // Parse DD/MM/YYYY format
  const parts = dateOfBirth.split('/');
  let dob: Date;
  
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; 
    const year = parseInt(parts[2], 10);
    dob = new Date(year, month, day);
  } else {
    dob = new Date(dateOfBirth);
  }
  
  const now = new Date();
  
  // Calculate the date that would be exactly 9 months after birth (at the end of that day)
  const nineMonthsAfterBirth = new Date(dob);
  nineMonthsAfterBirth.setMonth(nineMonthsAfterBirth.getMonth() + 9);
  nineMonthsAfterBirth.setHours(23, 59, 59, 999); // End of the 9-month day
  
  // If current date is after the 9-month mark, return 10 (to trigger else condition)
  if (now > nineMonthsAfterBirth) {
    return 10; // More than 9 months
  }
  
  // Calculate exact months for cases within 9 months
  const years = now.getFullYear() - dob.getFullYear();
  const months = now.getMonth() - dob.getMonth();
  const days = now.getDate() - dob.getDate();
  
  let totalMonths = years * 12 + months;
  if (days < 0) {
    totalMonths--;
  }
  
  return totalMonths;
}

interface DocumentField {
  type: string;
  path: string;
  originalName: string;
}
const getDocumentMapping = (documentType: string): { docCatCode: string; docTypCode: string } => {
  const typeMapping: Record<string, { docCatCode: string; docTypCode: string }> = {
    'NIN': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'PASSPORT': { docCatCode: 'POPASS', docTypCode: 'DOC001' },
    'NATIONAL_ID': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'ALIEN_ID': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'REFUGEE_ID': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'BIRTH_NOTIFICATION': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'CERTIFICATE_OF_BIRTH': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'DISCHARGE_FORM': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'IMMUNISATION_CARD': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'LC_RECOMMENDATION_LETTER': { docCatCode: 'POCLEI', docTypCode: 'CLEIPLD' },
    'MISSION_LETTER': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'POLICE_REPORT': { docCatCode: 'POPOLREP', docTypCode: 'POLREP' },
    'STATUTORY_DECLARATION': { docCatCode: 'POCLEI', docTypCode: 'CLEIPLD' },
    'COURT_ORDER': { docCatCode: 'POCLEI', docTypCode: 'CLEIPLD' },
    'AFFIDAVIT': { docCatCode: 'POCLEI', docTypCode: 'CLEIPLD' },
    'PARENTS_UGANDAN_PASSPORT_OR_NATIONAL_ID': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'BIRTH_CERTIFICATE_OF_CHILD': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'STATUTORY_DECLARATION_FROM_PARENTS': { docCatCode: 'PONPBR', docTypCode: 'GID' },
    'OTHER': { docCatCode: 'POFALL', docTypCode: 'CAOR' }
  };
 

  return typeMapping[documentType] || { docCatCode: 'POFALL', docTypCode: 'CAOR' };
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
    
  if (result?.errors?.length > 0) {
      throw new Error(
        `Document Upload failed: [${result.errors[0].errorCode}] ${result.errors[0].message}`,
      );
    }

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

function getDocumentCategoryMapping(documentType: string): string {
  const typeMapping: Record<string, string> = {
    'NATIONAL_ID': 'proofOfNIDPBR',
    'PASSPORT': 'proofOfPassport',
    'ALIEN_ID': 'proofOfNIDPBR',
    'REFUGEE_ID': 'proofOfNIDPBR',
    'BIRTH_NOTIFICATION': 'proofOfBirthCert',
    'CERTIFICATE_OF_BIRTH': 'proofOfBirthCert',
    'DISCHARGE_FORM': 'proofOfBirthCert',
    'IMMUNISATION_CARD': 'proofOfBirthCert',
    'LC_RECOMMENDATION_LETTER': 'proofOfCLEI',
    'MISSION_LETTER': 'proofOfCLEI',
    'POLICE_REPORT': 'proofOfPOLREP',
    'STATUTORY_DECLARATION': 'proofOfStatutory',
    'COURT_ORDER': 'proofOfPOLREP',
    'AFFIDAVIT': 'proofOfStatutory',
    'CERTIFICATE_OF_DUAL_CITIZENSHIP': 'proofOfCbyDual',
    'CERTIFICATE_OF_CITIZENSHIP_BY_REGISTRATION': 'proofOfCbyReg',
    'PARENTS_UGANDAN_PASSPORT_OR_NATIONAL_ID': 'proofOfNIDPBR',
    'BIRTH_CERTIFICATE_OF_CHILD': 'proofOfNIDPBR',
    'STATUTORY_DECLARATION_FROM_PARENTS': 'proofOfNIDPBR',
    'OTHER': 'proofOfFAll'
  };

  return typeMapping[documentType] || 'proofOfFAll';
}

interface MosipDocumentFormat {
  document: number[];
  value: string;
  type: string;
  format: string;
}

async function extractAndProcessDocumentsForPacket(
  documents: any,
  authToken: string
): Promise<Record<string, MosipDocumentFormat>> {
  const processedDocuments: Record<string, MosipDocumentFormat> = {};
  const categorySet: Set<string> = new Set();

  if (!documents || typeof documents !== 'object') {
    console.log('No documents to process for packet');
    return processedDocuments;
  }

  for (const [documentKey, documentData] of Object.entries(documents)) {
    if (documentData && typeof documentData === 'object') {
      const docData = documentData as any;
      let docType = docData.documentType;
      const docPath = docData.path;
      const originalName = docData.originalName || 'document';

      if (typeof docType === 'string' && docType.startsWith('[{') && docType.endsWith('}]')) {
        try {
          const parsed = JSON.parse(docType);
          docType = Array.isArray(parsed) && parsed.length > 0 ? parsed[0].value : docType;
        } catch (e) {
          console.warn(`Failed to parse document type for ${documentKey}:`, e);
        }
      }

      if (!docType || !docPath) {
        console.warn(`Incomplete document data for ${documentKey}:`, { docType, docPath });
        continue;
      }

      const category = getDocumentCategoryMapping(String(docType));

      if (categorySet.has(category)) {
        console.log(`Skipping duplicate document for category ${category}: ${documentKey}`);
        continue;
      }

      try {
        // Download document from MinIO
        let fileBuffer: Buffer;
        if (docPath.startsWith('/ocrvs/')) {
          const minioBuffer = await downloadDocumentFromMinIO(docPath);
          if (minioBuffer) {
            fileBuffer = minioBuffer;
            console.log(`Document fetched from MinIO: ${documentKey} (${fileBuffer.length} bytes)`);
          } else {
            console.warn(`Failed to fetch document from MinIO: ${docPath}`);
            continue;
          }
        } else {
          if (!existsSync(docPath)) {
            console.warn(`Document file not found: ${docPath}`);
            continue;
          }
          fileBuffer = readFileSync(docPath);
        }

        // Convert to base64
        // const base64Content = fileBuffer.toString('base64');

        // Determine file format from original name or path
        const fileExtension = path.extname(originalName || docPath).toLowerCase().replace('.', '') || 'pdf';

        // Convert buffer to byte array (array of numbers)
        const byteArray = Array.from(new Uint8Array(fileBuffer));

        // Store in processed documents with MOSIP expected format
        processedDocuments[category] = {
          document: byteArray,
          value: category,
          type: 'DOC' + Math.floor(100 + Math.random() * 900).toString(),
          format: fileExtension
        };

        categorySet.add(category);
        console.log(`Processed document ${documentKey} as category ${category}`);
      } catch (error) {
        console.error(`Error processing document ${documentKey}:`, error);
      }
    }
  }

  return processedDocuments;
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
  
  // const { versionString: schemaVersionString, version: idSchemaVersion, schemaJson } = getCachedIDSchema();

  const documentFields = await extractDocumentFields(requestFields);

  const dob = typeof requestFields.dateOfBirth === "string"
    ? requestFields.dateOfBirth
    : String(requestFields.dateOfBirth);

  const ageInMonths = getAgeInMonths(dob);
  const birthCertificateNumber = requestFields.birthCertificateNumber;
  if (ageInMonths <= 9) {
    const registrationId = event.id;
    console.log({ registrationId }, "Event ID");
    // insertTransaction(registrationId, event.token, birthCertificateNumber);

    const { documents, ...newRequestBody } = requestFields;
    
    // const processedDocuments = await extractAndProcessDocumentsForPacket(documents, authToken);
    
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
          schemaVersion: "8.4",
          fields: newRequestBody,
          metaInfo: metaInfo,
          // documents: processedDocuments,
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

    const createPacketApiResponce =await createPacketResponse.json();

    if (createPacketApiResponce?.errors?.length > 0) {
      throw new Error(
        `createPacket failed: [${createPacketApiResponce.errors[0].errorCode}] ${createPacketApiResponce.errors[0].message}`,
      );
    }
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

    return registrationId;
  } else {
    let userServiceValue = 'NEW';
    const userServiceTypeField = requestFields.userServiceType;
    if (userServiceTypeField) {
      const extractedServiceType = pickFirstString(userServiceTypeField);
      if (extractedServiceType === 'Alien New Registration') {
        userServiceValue = 'ALIENNEW';
      }
    }

    const identity: Record<string, any> = {
      IDSchemaVersion: 8.4,
      userService: userServiceValue,
      userServiceType: [{ language: 'eng', value: 'CBBI' }],
      trackingId: [{ language: 'eng', value: event.trackingId }]
    };
    const applicantLocationCodes = await processApplicantLocationHierarchy(requestFields);
    const fatherLocationCodes = await processFatherLocationHierarchy(requestFields);
    const motherLocationCodes = await processMotherLocationHierarchy(requestFields);
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
    //father location
    if (fatherLocationCodes.districtCode) {
      identity['fatherPlaceOfResidenceDistrict'] = [{ language: 'eng', value: fatherLocationCodes.districtCode }];
    }
    if (fatherLocationCodes.countyCode) {
      identity['fatherPlaceOfResidenceCounty'] = [{ language: 'eng', value: fatherLocationCodes.countyCode }];
    }
    if (fatherLocationCodes.subCountyCode) {
      identity['fatherPlaceOfResidenceSubCounty'] = [{ language: 'eng', value: fatherLocationCodes.subCountyCode }];
    }
    if (fatherLocationCodes.parishCode) {
      identity['fatherPlaceOfResidenceParish'] = [{ language: 'eng', value: fatherLocationCodes.parishCode }];
    }
    if (fatherLocationCodes.villageCode) {
      identity['fatherPlaceOfResidenceVillage'] = [{ language: 'eng', value: fatherLocationCodes.villageCode }];
    }
   //mother location
    if(motherLocationCodes.districtCode) {
      identity['motherPlaceOfResidenceDistrict'] = [{ language: 'eng', value: motherLocationCodes.districtCode }];
    }
    if(motherLocationCodes.countyCode) {
      identity['motherPlaceOfResidenceCounty'] = [{ language: 'eng', value: motherLocationCodes.countyCode }];
    }
    if(motherLocationCodes.subCountyCode) {
      identity['motherPlaceOfResidenceSubCounty'] = [{ language: 'eng', value: motherLocationCodes.subCountyCode }];
    }
    if(motherLocationCodes.parishCode) {
      identity['motherPlaceOfResidenceParish'] = [{ language: 'eng', value: motherLocationCodes.parishCode }];
    }
    if(motherLocationCodes.villageCode) {
      identity['motherPlaceOfResidenceVillage'] = [{ language: 'eng', value: motherLocationCodes.villageCode }];
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

    if (!response.ok) {
      throw new Error(
        `Failed creating pre-registration: ${response.status} ${rawResponseText}`,
      );
    }

    let createData: any = rawResponseText;
    try {
      createData = rawResponseText ? JSON.parse(rawResponseText) : rawResponseText;
    } catch (e) {
      throw new Error(
        `Failed parsing pre-registration response: ${e instanceof Error ? e.message : "Unknown parsing error"}`,
      );
    }
    const preRegId = createData?.response?.preRegistrationId;

    console.log("Pre-registration creation response:", preRegId);

    if (createData?.errors?.length > 0) {
      throw new Error(
        `Pre-registration failed: [${createData.errors[0].errorCode}] ${createData.errors[0].message}`,
      );
    }

    if (!preRegId) {
      throw new Error("Failed to get pre-registration ID from MOSIP response");
    }

    // insertTransaction(preRegId, event.token, birthCertificateNumber);

    const statusUrl =
      `${env.IDA_AUTH_DOMAIN_URI}/preregistration/v1/applications/prereg/status/${preRegId}?statusCode=Pending_Appointment`;

    const statusRes = await fetch(statusUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: `Authorization=${authToken};`
      }
    });

    if (!statusRes.ok) {
      throw new Error(
        `Failed updating status to Pending_Appointment: ${statusRes.status} ${await statusRes.text()}`,
      );
    }

    const statusResult = await statusRes.json();
    console.log("Status update response:", statusResult);

    if (statusResult?.errors?.length > 0) {
      throw new Error(
        `Status update failed: [${statusResult.errors[0].errorCode}] ${statusResult.errors[0].message}`,
      );
    }

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

     if (appointmentJson?.errors?.length > 0) {
      throw new Error(
        `Appointment booking failed: [${appointmentJson.errors[0].errorCode}] ${appointmentJson.errors[0].message}`,
      );
    }
    console.log("Appointment booking response:", JSON.stringify(appointmentJson, null, 2));

    if (preRegId) {
      const uploadedDocCatCodes = new Set<string>();

      // NIN takes priority over NationalID category — sort NIN to the front
      const prioritisedDocumentFields = [...documentFields].sort((a, b) => {
        if (a.type === 'NIN') return -1;
        if (b.type === 'NIN') return 1;
        return 0;
      });

      for (const document of prioritisedDocumentFields) {
        try {
          const { docCatCode } = getDocumentMapping(document.type);
          
          // Skip if this docCatCode has already been uploaded
          if (uploadedDocCatCodes.has(docCatCode)) {
            console.log(`Skipping duplicate docCatCode ${docCatCode} for document: ${document.originalName}`);
            continue;
          }
          
          await uploadDocumentToMosip(preRegId, document, authToken);
          uploadedDocCatCodes.add(docCatCode);
        } catch (error) {
          console.error(`Failed to upload document ${document.originalName}:`, error);
        }
      }
      try {
        const surname = pickFirstString(requestFields.surname) || '';
        const emailID = pickFirstString(requestFields.email) || '';
        const mobNum = pickFirstString(requestFields.phoneNumber) || '';

        const notificationRequestDTO = {
          id: "mosip.pre-registration.notification.notify",
          request: {
            eng: {
              name: surname,
              preRegistrationId: preRegId,
              appointmentDate: "2028-10-01",
              appointmentTime: "09:30 AM",
              mobNum: mobNum,
              emailID: emailID,
              additionalRecipient: false,
              isBatch: false,
              userService: "NEW"
            }
          },
          version: "1.0",
          requesttime: new Date().toISOString()
        };

        const notificationUrl = `${env.IDA_AUTH_DOMAIN_URI}/preregistration/v1/notification`;
        const formData = new FormData();
        formData.append('NotificationRequestDTO', JSON.stringify(notificationRequestDTO));
        formData.append('langCode', 'eng');


        const notificationRes = await fetch(notificationUrl, {
          method: 'POST',
          headers: {
            Cookie: `Authorization=${authToken};`,
          },
          body: formData,

        });


        if (!notificationRes.ok) {
          console.log(
            `Failed to send notification: ${notificationRes.status} ${await notificationRes.text()}`,
          );
        } else {
          const notificationResult = await notificationRes.json();
          console.log("Notification sent successfully:", notificationResult);
        }

        return preRegId;
      } catch (error) {
        console.log(
          `Error sending notification: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
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
  // const { versionString: schemaVersionString, version: idSchemaVersion, schemaJson } = getCachedIDSchema();
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
        process: "DEACTIVATED",
        source: "REGISTRATION_CLIENT",
        schemaVersion: "8.4",
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
        process: "DEACTIVATED",
        source: "REGISTRATION_CLIENT",
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

type VerifyNidResponse = {
  responseTime: string;
  response: {
    authStatus: boolean;
    authToken: string | null;
  };
  errors?: {
    errorCode: string;
    errorMessage: string;
  }[];
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
}): Promise<VerifyNidResponse> => {
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

  return (await response.json()) as VerifyNidResponse;
};
