import {
  encryptAuthData,
  extractKeysFromPkcs12,
  signAuthRequestData,
  urlSafeCertificateThumbprint,
} from "./crypto";
import fs from "node:fs";
import crypto from "node:crypto";

interface MOSIPAuthenticatorConfig {
  partnerApiKey: string;
  partnerMispLk: string;
  partnerId: string;
  idaAuthDomainUri: string;
  idaAuthUrl: string;
  encryptCertPath: string;
  decryptP12FilePath: string;
  decryptP12FilePassword: string;
  signP12FilePath: string;
  signP12FilePassword: string;
  authTimeoutMs?: number;
}

type IdentityInfo = { value: string; language: string };

interface AuthParams {
  individualId: string;
  individualIdType: string;
  demographicData: {
    dob?: string;
    name?: IdentityInfo[];
    gender?: IdentityInfo[];
  };
  consent: boolean;
  /** OpenCRVS transaction id, logged so a request can be traced end to end. */
  transactionId?: string;
}

/** `1234567890@nin` -> `1234567890`, so logs can be grepped by plain NIN. */
const toNin = (individualId: string) => individualId.replace(/@nin$/i, "");

export default class MOSIPAuthenticator {
  private encryptPemCertificate: string;
  private signPemPrivateKey: string;
  private signPemCertificate: string;

  constructor(private config: MOSIPAuthenticatorConfig) {
    this.encryptPemCertificate = fs
      .readFileSync(this.config.encryptCertPath)
      .toString();

    const p12fileContents = fs.readFileSync(
      this.config.signP12FilePath,
      "binary",
    );
    const { privateKeyPkcs8, certificate } = extractKeysFromPkcs12(
      p12fileContents,
      this.config.signP12FilePassword,
    );

    this.signPemPrivateKey = privateKeyPkcs8;
    this.signPemCertificate = certificate;
  }

  async auth(params: AuthParams) {
    const requestData = {
      id: "mosip.identity.auth",
      version: "1.0",
      individualId: params.individualId,
      individualIdType: params.individualIdType,
      transactionID: `${crypto.randomInt(10 ** 9, 10 ** 10)}`,
      requestTime: new Date().toISOString(),
      specVersion: "1.0",
      thumbprint: urlSafeCertificateThumbprint(this.encryptPemCertificate),
      domainUri: this.config.idaAuthDomainUri,
      env: "Staging",
      requestedAuth: {
        demo: false,
        pin: false,
        otp: false,
        bio: false,
      },
      consentObtained: true,
    };

    const authData = {
      biometrics: [],
      demographics: params.demographicData,
      otp: "",
      timestamp: new Date().toISOString(),
    };

    const nin = toNin(params.individualId);
    // One prefix for every line of this transaction, so a single grep on the
    // NIN or on either id pulls the whole exchange out of the logs.
    const logPrefix = `NIN:: ${nin} :: transactionId:: ${params.transactionId ?? "-"} :: ida_transactionID:: ${requestData.transactionID}`;

    // Logged before encryption: this is the payload as IDA will see it after
    // decrypting, which is what you actually need when a match fails. The
    // encrypted form on the wire is opaque and tells you nothing.
    console.log(
      `${logPrefix} :: auth_request::${JSON.stringify({
        ...requestData,
        request: authData,
      })}`,
    );

    const {
      encryptedAuthB64Data,
      encryptedAesKeyB64,
      encryptedAuthDataHashBase64,
    } = encryptAuthData(JSON.stringify(authData), this.encryptPemCertificate);

    const fullRequestJson = JSON.stringify({
      ...requestData,
      request: encryptedAuthB64Data,
      requestSessionKey: encryptedAesKeyB64,
      requestHMAC: encryptedAuthDataHashBase64,
    });

    const signatureHeader = await signAuthRequestData(
      fullRequestJson,
      this.encryptPemCertificate,
      this.signPemPrivateKey,
      this.signPemCertificate,
    );

    const fullIdaAuthUrl = `${this.config.idaAuthUrl}/${this.config.partnerMispLk}/${this.config.partnerId}/${this.config.partnerApiKey}`;

    const response = await fetch(fullIdaAuthUrl, {
      method: "POST",
      body: fullRequestJson,
      headers: {
        Authorization: "Authorization",
        "content-type": "application/json",
        Signature: signatureHeader,
      },
      signal: AbortSignal.timeout(this.config.authTimeoutMs ?? 15_000),
    });

    try {
      // Cloned so the caller still gets an unread body to parse.
      const responseBody = await response.clone().text();
      console.log(
        `${logPrefix} :: auth_response:: status=${response.status} :: ${responseBody}`,
      );
    } catch (error) {
      console.error(`${logPrefix} :: auth_response_log_failed::`, error);
    }

    return response;
  }
}
