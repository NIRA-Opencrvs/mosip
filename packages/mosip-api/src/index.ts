import Fastify, { FastifyError, FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registrationEventHandler } from "./routes/event-registration";
import { env } from "./constants";
import * as openapi from "./openapi-documentation";
import { OIDPUserInfoSchema, OIDPQuerySchema } from "./esignet-api";
import formbody from "@fastify/formbody";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { getPublicKey } from "./opencrvs-api";
import { OIDPUserInfoHandler } from "./routes/oidp-user-info";
import { initSqlite } from "./database";
import {
  credentialErrorHandler,
  CredentialErrorSchema,
  credentialIssuedHandler,
  CredentialIssuedSchema,
} from "./routes/websub-credential-issued";
import { initWebSub } from "./websub/subscribe";
import {
  deleteTransactionHandler,
  getAllTransactionsHandler,
  replaceTokenByIdHandler,
  replaceAllTokensHandler,
  ReplaceTokenSchema,
} from "./routes/debug-sqlite";
import { verifyHandler, VerifySchema } from "./routes/verify";
import { initializeIDSchema } from "./mosip-api";
import { registerPrnValidationRoutes } from "./routes/prn-validation";
import { startBatchRetryJob } from "./batch-retry";
import {
  triggerBatchRetryHandler,
  getPendingRecordsHandler,
  deleteFailedRecordHandler,
  forceRetryRecordHandler,
} from "./routes/batch-retry-debug";

const envToLogger = {
  development: {
    transport: {
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname",
      },
    },
  },
  production: true,
};

const AUTH_EXEMPT_ROUTES = new Set([
  "/websub/callback",
  "/websub/error-callback",
  "/prn/validator",
  "/prn/validate",
  "/favicon.ico",
  "/debug/pending-records",
  "/debug/retry-batch",
  "/debug/force-retry/:id",
  "/debug/failed-records/:id"
]);

const initRoutes = (app: FastifyInstance) => {
  app.get("/favicon.ico", async (_request, reply) => {
    return reply.code(204).send();
  });

  /*
   * OpenCRVS birth / death registration and personal information verification
   */
  app.withTypeProvider<ZodTypeProvider>().route({
    url: "/events/registration",
    method: "POST",
    handler: registrationEventHandler,
  });
  app.withTypeProvider<ZodTypeProvider>().route({
    url: "/verify",
    method: "POST",
    handler: verifyHandler,
    schema: {
      body: VerifySchema,
    },
  });

  /*
   * E-Signet
   */
  app.withTypeProvider<ZodTypeProvider>().route({
    url: "/esignet/get-oidp-user-info",
    method: "POST",
    handler: OIDPUserInfoHandler,
    schema: {
      body: OIDPUserInfoSchema,
      querystring: OIDPQuerySchema,
    },
  });

  /**
   * MOSIP Kafka WebSub
   */
  app.get("/websub/callback", async (request, reply) => {
    const { "hub.challenge": challenge } = request.query as {
      "hub.challenge"?: string;
    };
    if (challenge) return reply.type("text/plain").send(challenge);
    else return reply.code(400).send("Missing hub.challenge");
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "POST",
    url: "/websub/callback", // see constants.ts `${env.MOSIP_WEBSUB_CALLBACK_URL}`
    handler: credentialIssuedHandler,
    schema: {
      body: CredentialIssuedSchema,
    },
  });

  app.get("/websub/error-callback", async (request, reply) => {
    const { "hub.challenge": challenge } = request.query as {
      "hub.challenge"?: string;
    };
    if (challenge) return reply.type("text/plain").send(challenge);
    else return reply.code(400).send("Missing hub.challenge");
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "POST",
    url: "/websub/error-callback", // see constants.ts `${env.MOSIP_WEBSUB_ERROR_CALLBACK_URL}`
    handler: credentialErrorHandler,
    schema: {
      body: CredentialErrorSchema,
    },
  });

  /*
   * SQLite debug route
   */
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/debug/transactions",
    handler: getAllTransactionsHandler,
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "DELETE",
    url: "/debug/transactions/:id",
    handler: deleteTransactionHandler,
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "PATCH",
    url: "/debug/transactions/:id",
    handler: replaceTokenByIdHandler,
    schema: {
      body: ReplaceTokenSchema,
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "PATCH",
    url: "/debug/transactions/replace-token",
    handler: replaceAllTokensHandler,
    schema: {
      body: ReplaceTokenSchema,
    },
  });

  /*
   * Batch retry routes
   */
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/debug/pending-records",
    handler: getPendingRecordsHandler,
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "POST",
    url: "/debug/retry-batch",
    handler: triggerBatchRetryHandler,
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "DELETE",
    url: "/debug/failed-records/:id",
    handler: deleteFailedRecordHandler,
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "POST",
    url: "/debug/force-retry/:id",
    handler: forceRetryRecordHandler,
  });

  registerPrnValidationRoutes(app);
};

let corePublicKey: string;
let publicKeyUpdatedAt = Date.now();
const getCorePublicKey = async () => {
  if (!corePublicKey) {
    corePublicKey = await getPublicKey();
  }

  return corePublicKey;
};

export const buildFastify = async () => {
  const app = Fastify({
    logger: envToLogger[env.isProd ? "production" : "development"],
    ignoreTrailingSlash: true, // MOSIP can call /websub/callback/ with a trailing slash
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(formbody);
  app.register(cors, {
    origin: [env.CLIENT_APP_URL],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  openapi.register(app);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.status(500).send({ error: "An unexpected error occurred" });
  });

  app.register(jwt, {
    secret: { public: getCorePublicKey },
    verify: { algorithms: ["RS256"] },
  });

  app.addHook("onRequest", async (request, reply) => {
    // @NOTE This disables the JWT authentication for the MOSIP webhook
    // The route is open for requests, but the credential will be verified it's from MOSIP
    // This API should be allowed ONLY from the IP address of MOSIP on network / Traefik level
    const routeUrl = request.routeOptions.url;
    if (routeUrl && AUTH_EXEMPT_ROUTES.has(routeUrl)) return;

    try {
      await request.jwtVerify();
    } catch (err) {
      const error = err as FastifyError;

      const moreThanAMinuteSinceLastUpdate =
        Date.now() - publicKeyUpdatedAt > 60_000;

      if (
        error.code === "FST_JWT_AUTHORIZATION_TOKEN_INVALID" &&
        moreThanAMinuteSinceLastUpdate
      ) {
        app.log.info("🔁 JWT failed, refreshing public key...");
        try {
          corePublicKey = await getPublicKey();
          publicKeyUpdatedAt = Date.now();
          await request.jwtVerify();
          return;
        } catch (retryErr) {
          app.log.error("🔐 JWT retry failed:", retryErr);
        }
      } else {
        app.log.error("🔐 JWT verify failed:", err);
      }

      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.after(() => initRoutes(app));

  return app;
};

async function initializeWebSub(app: FastifyInstance) {
  try {
    const { topic } = await initWebSub();
    app.log.info(`WebSub subscription initialized for topic '${topic}' ✅`);
  } catch (error) {
    app.log.error("Failed to initialize WebSub subscription:", error);
  }
}


async function run() {
  const app = await buildFastify();

  const { wasCreated, wasConnected, database } = initSqlite(
    env.SQLITE_DATABASE_PATH,
  );

  wasCreated && app.log.info("SQLite token storage created 🚀✅ ");
  wasConnected && app.log.info("SQLite token storage connected ✅");

  // Initialize ID Schema cache at startup
  // try {
  //   await initializeIDSchema();
  //   app.log.info("ID Schema initialized and cached ✅");
  // } catch (error) {
  //   app.log.error("Failed to initialize ID Schema:", error);
  //   throw error;
  // }

  await app.ready();
  await app.listen({
    port: env.PORT,
    host: env.HOST,
    listenTextResolver: () =>
      `OpenCRVS-MOSIP interoperability API running at http://${env.HOST}:${env.PORT} ✅`,
  });
  app.log.info(
    `Swagger UI running at http://${env.HOST}:${env.PORT}/documentation ✅`,
  );

  await initializeWebSub(app);

  const intervalTime = env.WEB_SUB_BATCH_INTERVAL_MS

  const webSubInterval = setInterval(async () => {
    await initializeWebSub(app);
  }, intervalTime);

  // Start batch retry job (runs every 5 minutes by default)
  const retryJobInterval = startBatchRetryJob(app);

  process.on("exit", () => {
    clearInterval(retryJobInterval);
    clearInterval(webSubInterval);
    database.close();
    app.close();
  });
}

// Only run daemon if it's executed directly - as in `tsx index.ts` for example
if (require.main === module) {
  void run();
}
