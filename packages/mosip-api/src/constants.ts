import { cleanEnv, str, port, url, num, bool } from "envalid";
import { join } from "node:path";

export const env = cleanEnv(process.env, {
  PORT: port({ default: 2024 }),
  HOST: str({ default: "0.0.0.0", devDefault: "localhost" }),
  LOCALE: str({ devDefault: "en" }),
  SQLITE_DATABASE_PATH: str({
    devDefault: join(__dirname, "../../../data/sqlite/mosip-api.db"),
    example: "/data/sqlite/mosip-api.db", // A good production default, but needs a Docker volume
    desc: "Path to the SQLite database used to store a OpenCRVS record-only token with the MOSIP transaction ID. Note that you need to add a volume to the Docker container to persist the data.",
  }),
  CLIENT_APP_URL: url({
    devDefault: "http://localhost:3000",
    desc: "OpenCRVS client app URL for CORS",
  }),
  OPENCRVS_GATEWAY_URL: str({
    devDefault: "http://localhost:7070",
    desc: "The URL of the OpenCRVS GraphQL Gateway",
  }),
  COUNTRY_CONFIG_URL: str({
    devDefault: "http://localhost:3040",
    desc: "The URL of the OpenCRVS country config server for sending notifications after MOSIP callback",
  }),
  OPENCRVS_PUBLIC_KEY_URL: str({
    devDefault: "http://localhost:4040/.well-known",
    desc: "OpenCRVS public key URL. Used to verify JWT authenticity",
  }),

  // MOSIP Auth manager
  MOSIP_AUTH_URL: str({
    devDefault:
      "http://localhost:20240/v1/authmanager/authenticate/clientidsecretkey",
  }),
  MOSIP_AUTH_CLIENT_APP_ID: str({ default: "admin" }),
  MOSIP_PACKET_AUTH_CLIENT_ID: str({ devDefault: "mosip-regproc-client" }),
  MOSIP_PACKET_AUTH_CLIENT_SECRET: str({ devDefault: "abcdeABCDE123456" }),

  // MOSIP WebSub hub
  MOSIP_WEBSUB_HUB_URL: url({
    devDefault: "http://localhost:20240/websub/hub",
    desc: "MOSIP WebSub hub URL",
  }),
  MOSIP_WEBSUB_SECRET: str({
    devDefault: "mosip-websub-secret",
    desc: "MOSIP WebSub `hub.secret`",
  }),
  MOSIP_WEBSUB_TOPIC: str({
    devDefault: "CREDENTIAL_ISSUED",
    desc: "The Kafka topic that is listened for ID credential issuance, `hub.topic`",
  }),
  MOSIP_WEBSUB_CALLBACK_URL: str({
    devDefault: "http://localhost:2024/websub/callback",
    example: "https://your-domain.com/websub/callback",
    desc: "The OpenCRVS side URL MOSIP sends WebSub updates to, `hub.callback`",
  }),
  MOSIP_WEBSUB_ERROR_SECRET: str({
    devDefault: "mosip-websub-error-secret",
    desc: "MOSIP WebSub error `hub.secret`",
  }),
  MOSIP_WEBSUB_ERROR_TOPIC: str({
    devDefault: "OPENCRVS_ERROR",
    desc: "The Kafka topic that is listened for ID credential issuance errors, `hub.topic`",
  }),
  MOSIP_WEBSUB_ERROR_CALLBACK_URL: str({
    devDefault: "http://localhost:2024/websub/error-callback",
    example: "https://your-domain.com/websub/error-callback",
    desc: "The OpenCRVS side URL MOSIP sends WebSub error updates to, `hub.callback`",
  }),

  MOSIP_VERIFIABLE_CREDENTIAL_ALLOWLIST: str({
    devDefault: "http://localhost:20240/.well-known/public-key.json",
    example: "https://your-domain.com/.well-known/public-key.json",
    desc: "Comma-separated list of verifiable credential allowlist URLs. Used to verify the authenticity of the verifiable credential.",
  }),
  MOSIP_WEBSUB_AUTH_CLIENT_ID: str({ devDefault: "mosip-websub-client" }),
  MOSIP_WEBSUB_AUTH_CLIENT_SECRET: str({ devDefault: "abcdeABCDE123456" }),

  // MOSIP Birth & Death packets
  TRANSACTION_ID_PREFIX: str({
    default: "10001",
    desc: "Used to prefix the numeric transaction ID (1000101234567890) that is sent to MOSIP and received back",
  }),
  MOSIP_BIRTH_WEBHOOK_URL: str({
    devDefault: "http://localhost:20240/webhooks/opencrvs/birth",
    desc: "The URL where MOSIP receives birth webhooks from OpenCRVS",
  }),
  MOSIP_DEATH_WEBHOOK_URL: str({
    devDefault: "http://localhost:20240/webhooks/opencrvs/death",
    desc: "The URL where MOSIP receives death webhooks from OpenCRVS",
  }),

  // E-Signet
  ESIGNET_USERINFO_URL: url({
    devDefault: "http://localhost:20260/oidc/userinfo",
  }),
  ESIGNET_TOKEN_URL: url({ devDefault: "http://localhost:20260/oauth/token" }),
  OPENID_PROVIDER_CLAIMS: str({ devDefault: undefined }),
  OIDP_CLIENT_PRIVATE_KEY_PATH: str({
    devDefault: join(__dirname, "../../../certs/esignet-jwk.txt"),
  }),

  // NOTE: Following files and credentials are generally created by MOSIP and their assistance.
  // MOSIP Auth
  PARTNER_APIKEY: str({ devDefault: "123456" }),
  PARTNER_MISP_LK: str({
    devDefault: "aaaaaAAAAAbbbbbBBBBBcccccCCCCCdddddDDDDD",
  }),
  PARTNER_ID: str({ devDefault: "crvs-partner" }),

  // MOSIP IDA auth server
  IDA_AUTH_DOMAIN_URI: str({ devDefault: "http://localhost:20240" }),
  IDA_AUTH_URL: str({
    devDefault: "http://localhost:20240/idauthentication/v1/auth",
  }),
  IDA_AUTH_TIMEOUT_MS: num({
    default: 15000,
    desc: "Caps a single IDA auth call. Without it a hung IDA would stall the retry worker, which has no outer timeout of its own.",
  }),

  AUTH_HOST: url({
    devDefault: "http://localhost:7070",
    desc: "Opencrvs Auth Service URL",
  }),

  // MOSIP Crypto encrypt
  ENCRYPT_CERT_PATH: str({
    devDefault: join(__dirname, "../../../certs/ida-partner.crt"),
  }),
  DECRYPT_P12_FILE_PATH: str({
    devDefault: join(__dirname, "../../../certs/keystore.p12"),
  }),
  DECRYPT_P12_FILE_PASSWORD: str({ devDefault: "mosip123" }),

  // MOSIP Crypto signature
  SIGN_P12_FILE_PATH: str({
    devDefault: join(__dirname, "../../../certs/keystore.p12"),
  }),
  SIGN_P12_FILE_PASSWORD: str({ devDefault: "mosip123" }),

  // MOSIP packet manager details
  MOSIP_CREATE_PACKET_URL: str({
    devDefault: "http://localhost:20240/commons/v1/packetmanager/createPacket",
  }),
  MOSIP_PROCESS_PACKET_URL: str({
    devDefault:
      "http://localhost:20240/registrationprocessor/v1/workflowmanager/workflowinstance",
  }),
  MOSIP_CENTER_ID: str({
    devDefault: "10001",
  }),
  MOSIP_MACHINE_ID: str({
    devDefault: "10004",
  }),
  // MinIO configuration
  MINIO_ALIAS: str({
    devDefault: "opencrvs-minio",
    desc: "MinIO alias for mc command",
  }),
  MINIO_DOMAIN: str({
    devDefault: "localhost:3535",
    desc: "MinIO host and port",
  }),
  MINIO_ROOT_USER: str({
    devDefault: "minioadmin",
    desc: "MinIO username",
  }),
  MINIO_ROOT_PASSWORD: str({
    devDefault: "minioadmin",
    desc: "MinIO password",
  }),

  // Batch retry configuration
  BATCH_RETRY_INTERVAL_MS: num({
    default: 300000, // 5 minutes
    desc: "Interval in milliseconds between batch retry job executions",
  }),
  BATCH_RETRY_LIMIT: num({
    default: 10,
    desc: "Maximum number of failed records to process in each batch retry job",
  }),

  WEB_SUB_BATCH_INTERVAL_MS: num({
    default: 1800000, // 30 minutes
    desc: "Interval in milliseconds between websub initalization batch job executions",
  }),

  // IDA verification retry
  // MOSIP `failed_records` retry above.
  IDA_RETRY_ENABLED: bool({
    default: true,
    desc: "Kill switch for the IDA verification retry queue. When false, the queue is never drained and countryconfig keeps today's behaviour of treating an unreachable IDA as a failed verification.",
  }),
  IDA_RETRY_INTERVAL_MS: num({
    default: 500000, 
    desc: "Interval in milliseconds between IDA verification retry job executions",
  }),
  IDA_RETRY_BATCH_LIMIT: num({
    default: 50,
    desc: "Maximum number of pending IDA verifications to process in each retry job run. Keep this within what IDA can absorb: the whole batch is processed sequentially.",
  }),
  IDA_RETRY_MAX_ATTEMPTS: num({
    default: 8,
    desc: "Attempts before a pending verification is finalised using the pre-existing behaviour (unreachable IDA counted as a failed verification, so the record lands in Awaiting ID Update). With the default backoff this spans roughly 21 hours.",
  }),
  IDA_RETRY_MAX_AGE_HOURS: num({
    default: 48,
    desc: "Age at which a pending verification is finalised regardless of attempt count. Must stay below the action confirmation token lifetime (1 week by default).",
  }),
  IDA_RETRY_BACKOFF_BASE_MINUTES: num({
    default: 5,
    desc: "Base for the exponential backoff between attempts: 5, 10, 20, 40 ... minutes, plus up to a minute of jitter",
  }),
  IDA_RETRY_LEASE_MINUTES: num({
    default: 10,
    desc: "How long a claimed job is hidden from subsequent runs. Must exceed the callback timeout so a slow pass cannot be picked up twice.",
  }),
  IDA_RETRY_CALLBACK_TIMEOUT_MS: num({
    default: 60000,
    desc: "Timeout for the country config callback that re-runs a pending verification",
  }),
});

export const MOSIP_VERIFIABLE_CREDENTIAL_ALLOWED_URLS =
  env.MOSIP_VERIFIABLE_CREDENTIAL_ALLOWLIST.split(",");
