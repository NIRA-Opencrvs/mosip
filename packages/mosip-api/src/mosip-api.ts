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
  processMotherLocationHierarchy,
} from "./dynamic-fields";

export class MOSIPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MOSIPError";
  }
}

export type AuthType = "PACKET" | "WEBSUB";

const execAsync = promisify(exec);

// MinIO configuration
const MINIO_CONFIG = {
  alias: 'opencrvs-minio',
  host: 'localhost:3535',
  username: 'minioadmin',
  password: 'minioadmin'
};

// Function to download document from MinIO (in-memory only)
async function downloadDocumentFromMinIO(documentPath: string): Promise<Buffer | null> {
  try {
    // Remove leading slash if present and convert to MinIO object path
    const minioObjectPath = documentPath.startsWith('/') ? documentPath.slice(1) : documentPath;
    
    // Create temporary directory for download
    const tempDir = '/tmp/opencrvs-docs';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Generate unique filename for temporary download
    const fileName = path.basename(documentPath);
    const timestamp = Date.now();
    const tempFilePath = path.join(tempDir, `${timestamp}_${fileName}`);
    
    console.log(`Fetching document from MinIO: ${minioObjectPath}`);
    
    // Configure MinIO alias (do this each time to ensure it's set up)
    await execAsync(`mc alias set ${MINIO_CONFIG.alias} http://${MINIO_CONFIG.host} ${MINIO_CONFIG.username} ${MINIO_CONFIG.password}`);
    
    // Download the file to temp location
    const downloadCommand = `mc cp "${MINIO_CONFIG.alias}/${minioObjectPath}" "${tempFilePath}"`;
    await execAsync(downloadCommand);
    
    // Check if file was downloaded successfully
    if (fs.existsSync(tempFilePath)) {
      // Read file as buffer
      const fileBuffer = fs.readFileSync(tempFilePath);
      
      // Clean up temporary file immediately
      fs.unlinkSync(tempFilePath);
      
      console.log(`Successfully fetched document from MinIO: ${documentPath} (${fileBuffer.length} bytes)`);
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
  const baseUrl = "https://prereg.niradev1.idencode.link";
  const userId = "jai@gmail.com";
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

interface DocumentField {
  type: string;
  path: string;
  originalName: string;
}

// Document category and type mapping based on MOSIP requirements
const getDocumentMapping = (documentType: string): { docCatCode: string; docTypCode: string } => {
  const typeMapping: Record<string, { docCatCode: string; docTypCode: string }> = {
    // Identity Documents
    'PASSPORT': { docCatCode: 'POPASS', docTypCode: 'DOC001' },
    'NATIONAL_ID': { docCatCode: 'POI', docTypCode: 'DOC002' },
    'ALIEN_ID': { docCatCode: 'POI', docTypCode: 'DOC003' },
    'REFUGEE_ID': { docCatCode: 'POI', docTypCode: 'DOC004' },
    
    // Birth Documents
    'CERTIFICATE_OF_BIRTH': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'BIRTH_CERTIFICATE': { docCatCode: 'POBC', docTypCode: 'DOC028' },
    'LC_RECOMMENDATION_LETTER': { docCatCode: 'POB', docTypCode: 'DOC029' },
    'MISSION_LETTER': { docCatCode: 'POB', docTypCode: 'DOC030' },
    
    // Legal Documents
    'POLICE_REPORT': { docCatCode: 'POL', docTypCode: 'DOC031' },
    'STATUTORY_DECLARATION': { docCatCode: 'POL', docTypCode: 'DOC032' },
    'COURT_ORDER': { docCatCode: 'POL', docTypCode: 'DOC033' },
    'AFFIDAVIT': { docCatCode: 'POL', docTypCode: 'DOC034' },
    
    // Citizenship Documents
    'CITIZENSHIP_CERTIFICATE': { docCatCode: 'POC', docTypCode: 'DOC035' },
    'NATURALIZATION_CERTIFICATE': { docCatCode: 'POC', docTypCode: 'DOC036' },
    
    // General/Other Documents
    'OTHER': { docCatCode: 'POO', docTypCode: 'DOC999' }
  };
  
  return typeMapping[documentType] || { docCatCode: 'POO', docTypCode: 'DOC999' };
};

async function uploadDocumentToMosip(
  preRegId: string,
  documentField: DocumentField,
  authToken: string
): Promise<void> {
  const PREREG_BASE_URL = "https://prereg.niradev1.idencode.link";
  
  // Extract document type from the documentField.type
  let docType = documentField.type;
  if (docType.startsWith('[{') && docType.endsWith('}]')) {
    try {
      const parsed = JSON.parse(docType);
      docType = Array.isArray(parsed) && parsed.length > 0 ? parsed[0].value : docType;
    } catch (e) {
      // If parsing fails, use the original type
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
    
    // Check if the path is an OpenCRVS internal path that needs to be fetched from MinIO
    if (documentField.path.startsWith('/ocrvs/')) {
      console.log(` Fetching document from MinIO: ${documentField.path}`);
      console.log(`Document: ${documentField.originalName} (Type: ${documentField.type})`);
      
      // Download from MinIO
      const minioBuffer = await downloadDocumentFromMinIO(documentField.path);
      
      if (minioBuffer) {
        fileBuffer = minioBuffer;
        console.log(` Document fetched successfully from MinIO: ${documentField.originalName} (${fileBuffer.length} bytes)`);
        
        // Validate file signature
        const signature = fileBuffer.slice(0, 8).toString('hex');
        console.log(`File signature: ${signature}`);
        
        // Validate common file types
        if (signature.startsWith('89504e47')) {
          console.log(`Valid PNG file detected`);
        } else if (signature.startsWith('ffd8ff')) {
          console.log(` Valid JPEG file detected`);
        } else if (signature.startsWith('25504446')) {
          console.log(`Valid PDF file detected`);
        } else {
          console.log(` Unknown file signature, proceeding anyway`);
        }
      } else {
        console.error(`MinIO download failed for: ${documentField.path}`);
        throw new Error(`Failed to fetch document from MinIO: ${documentField.path}`);
      }
    } else {
      // Handle local file system paths
      if (!existsSync(documentField.path)) {
        console.warn(`Document file not found: ${documentField.path}`);
        return;
      }
      fileBuffer = readFileSync(documentField.path);
    }
    
    // Create multipart form data manually
    const boundary = '----formdata-' + Math.random().toString(36).substring(2, 15);
    let formData = '';
    
    // Add document request field
    formData += `--${boundary}\r\n`;
    formData += `Content-Disposition: form-data; name="Document request"\r\n`;
    formData += `Content-Type: application/json\r\n\r\n`;
    formData += `${JSON.stringify(documentRequest)}\r\n`;
    
    // Add file field
    formData += `--${boundary}\r\n`;
    formData += `Content-Disposition: form-data; name="file"; filename="${documentField.originalName}"\r\n`;
    formData += `Content-Type: application/octet-stream\r\n\r\n`;
    
    // Convert string parts to buffer and concatenate with file buffer
    const formDataStart = Buffer.from(formData, 'utf8');
    const formDataEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const fullFormData = Buffer.concat([formDataStart, fileBuffer, formDataEnd]);

    const uploadUrl = `${PREREG_BASE_URL}/preregistration/v1/documents/${preRegId}`;
    
    console.log(`Uploading document ${documentField.originalName} to ${uploadUrl}`);
    
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
      console.error(`Failed to upload document ${documentField.originalName}:`, response.status, errorText);
      throw new Error(`Document upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    console.log(`Successfully uploaded document ${documentField.originalName}:`, result);
    
  } catch (error) {
    console.error(`Error uploading document ${documentField.originalName}:`, error);
    throw error;
  }
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

  // console.log("payload from opencrvs : ", requestBody);

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

    // Get auth token for API calls
    const preRegAuthToken = await getPreRegistrationAuthToken();
    
    // Process hierarchical location lookup for father's and mother's residence
    console.log("\\n=== Processing Location Hierarchies ===");
    const fatherLocationCodes = await processLocationHierarchy(requestFields);
    console.log("Father location codes resolved:", fatherLocationCodes);
    
    const motherLocationCodes = await processMotherLocationHierarchy(requestFields);
    console.log("Mother location codes resolved:", motherLocationCodes);

    console.log("\\n=== Processing requestFields ===");
    for (const [fieldName, fieldValue] of Object.entries(requestFields)) {
      if (fieldValue == null || fieldValue === '') continue;

     
      if (fieldName === 'birthCertificateNumber') continue;

      // Skip document-related fields from being included in the identity
      if (fieldName.toLowerCase().includes('document')) continue;

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

    // Update identity with resolved location codes
    console.log("\n=== Updating Location Codes in Identity ===");
    
    // Father location codes
    if (fatherLocationCodes.districtCode) {
      identity['fatherPlaceOfResidenceDistrict'] = [{ language: 'eng', value: fatherLocationCodes.districtCode }];
      console.log(`Updated father district code: ${fatherLocationCodes.districtCode}`);
    }
    if (fatherLocationCodes.countyCode) {
      identity['fatherPlaceOfResidenceCounty'] = [{ language: 'eng', value: fatherLocationCodes.countyCode }];
      console.log(`Updated father county code: ${fatherLocationCodes.countyCode}`);
    }
    if (fatherLocationCodes.subCountyCode) {
      identity['fatherPlaceOfResidenceSubCounty'] = [{ language: 'eng', value: fatherLocationCodes.subCountyCode }];
      console.log(`Updated father subcounty code: ${fatherLocationCodes.subCountyCode}`);
    }
    if (fatherLocationCodes.parishCode) {
      identity['fatherPlaceOfResidenceParish'] = [{ language: 'eng', value: fatherLocationCodes.parishCode }];
      console.log(`Updated father parish code: ${fatherLocationCodes.parishCode}`);
    }
    if (fatherLocationCodes.villageCode) {
      identity['fatherPlaceOfResidenceVillage'] = [{ language: 'eng', value: fatherLocationCodes.villageCode }];
      console.log(`Updated father village code: ${fatherLocationCodes.villageCode}`);
    }
    
    // Mother location codes
    if (motherLocationCodes.districtCode) {
      identity['motherPlaceOfResidenceDistrict'] = [{ language: 'eng', value: motherLocationCodes.districtCode }];
      console.log(`Updated mother district code: ${motherLocationCodes.districtCode}`);
    }
    if (motherLocationCodes.countyCode) {
      identity['motherPlaceOfResidenceCounty'] = [{ language: 'eng', value: motherLocationCodes.countyCode }];
      console.log(`Updated mother county code: ${motherLocationCodes.countyCode}`);
    }
    if (motherLocationCodes.subCountyCode) {
      identity['motherPlaceOfResidenceSubCounty'] = [{ language: 'eng', value: motherLocationCodes.subCountyCode }];
      console.log(`Updated mother subcounty code: ${motherLocationCodes.subCountyCode}`);
    }
    if (motherLocationCodes.parishCode) {
      identity['motherPlaceOfResidenceParish'] = [{ language: 'eng', value: motherLocationCodes.parishCode }];
      console.log(`Updated mother parish code: ${motherLocationCodes.parishCode}`);
    }
    if (motherLocationCodes.villageCode) {
      identity['motherPlaceOfResidenceVillage'] = [{ language: 'eng', value: motherLocationCodes.villageCode }];
      console.log(`Updated mother village code: ${motherLocationCodes.villageCode}`);
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

    if (!preRegId) {
      throw new Error("Failed to get pre-registration ID from MOSIP response");
    }

    console.log("Pre-registration ID obtained:", preRegId);

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

    // Extract and upload documents only if we have a valid preRegId
    if (preRegId) {
      console.log("\n=== Processing Document Uploads ===");
      const documentFields: DocumentField[] = [];
      
      // Extract document fields from new nested documents structure
      const documentsObject = requestFields.documents as any;
      
      if (documentsObject && typeof documentsObject === 'object') {
        console.log("Found documents object in requestFields");
        
        // Iterate through all document entries in the documents object
        for (const [documentKey, documentData] of Object.entries(documentsObject)) {
          if (documentData && typeof documentData === 'object') {
            const docData = documentData as any;
            
            // Extract document type, path, and original name
            let docType = docData.documentType;
            const docPath = docData.path;
            const docOriginalName = docData.originalName;
            
            // Parse document type if it's in language array format
            if (typeof docType === 'string' && docType.startsWith('[{') && docType.endsWith('}]')) {
              try {
                const parsed = JSON.parse(docType);
                docType = Array.isArray(parsed) && parsed.length > 0 ? parsed[0].value : docType;
              } catch (e) {
                console.warn(`Failed to parse document type for ${documentKey}:`, e);
              }
            }
            
            if (docType && docPath && docOriginalName) {
              documentFields.push({
                type: String(docType),
                path: String(docPath),
                originalName: String(docOriginalName)
              });
              console.log(`Found document: ${documentKey} -> ${docOriginalName} (Type: ${docType})`);
            } else {
              console.warn(`Incomplete document data for ${documentKey}:`, { docType, docPath, docOriginalName });
            }
          }
        }
      } else {
        console.log("⚠️ No documents object found in new format - this may indicate an outdated payload structure");
        console.log("Expected documents to be in nested format under 'documents' field");
      }

      // Upload each document
      for (const document of documentFields) {
        try {
          await uploadDocumentToMosip(preRegId, document, preRegAuthToken);
        } catch (error) {
          console.error(`Failed to upload document ${document.originalName}:`, error);
          // Continue with other documents even if one fails
        }
      }

      console.log("=== Document Upload Process Completed ===");
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
