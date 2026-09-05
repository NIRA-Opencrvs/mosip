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
  /**
   * The caller's own correlation id — countryconfig sends `${page}-${eventId}`
   * as `transactionId`. Logged as-is so a line can be tied back to the record
   * that triggered it. Not sent to IDA: IDA gets its own numeric
   * `transactionID` below.
   */
  transactionId?: string;
}

/**
 * In this deployment IDA is called with a handle (`<nin>@nin`) rather than a
 * UIN. Logs are far easier to grep when they carry the bare NIN, so strip the
 * handle suffix before printing.
 */
const toNin = (individualId: string) => individualId.split("@")[0];

/**
 * The demographics that go on the wire are encrypted, so the request log alone
 * does not tell you *what* was sent for matching. Set
 * `IDA_LOG_AUTH_DATA=true` to additionally print the plaintext demographic
 * block. It contains PII (name / dob / gender), so keep it off outside of
 * active debugging.
 */
const shouldLogPlainAuthData = () => process.env.IDA_LOG_AUTH_DATA === "true";

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
    const idaTransactionId = `${crypto.randomInt(10 ** 9, 10 ** 10)}`;

    const requestData = {
      id: "mosip.identity.auth",
      version: "1.0",
      individualId: params.individualId,
      individualIdType: params.individualIdType,
      transactionID: idaTransactionId,
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

    const nin = toNin(params.individualId);
    // One prefix for every line of this transaction, so a single grep on the
    // NIN or on either id pulls the whole exchange out of the logs.
    const logPrefix = `NIN:: ${nin} :: transactionId:: ${params.transactionId ?? "-"} :: ida_transactionID:: ${idaTransactionId}`;

    console.log(`${logPrefix} :: auth_request::${fullRequestJson}`);

    if (shouldLogPlainAuthData()) {
      console.log(`${logPrefix} :: auth_request_data::${JSON.stringify(authData)}`);
    }

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
    });

    // Read from a clone so the caller can still consume `response.json()` /
    // `response.text()` exactly as before.
    try {
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
