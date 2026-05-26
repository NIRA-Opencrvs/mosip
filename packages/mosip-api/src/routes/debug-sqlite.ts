import { FastifyReply, FastifyRequest } from "fastify";
import {
  getAllTransactions,
  getTransactionAndDiscard,
  updateTransactionToken,
  updateAllTransactionsToken,
  getTransaction,
} from "../database";
import { SCOPES } from "@opencrvs/toolkit/scopes";
import { TokenPayload } from "./websub-credential-issued";
import { decode } from "jsonwebtoken";
import { z } from "zod";
import { env } from "../constants";

interface AuthenticatedUser {
  scope: string[];
}

/**
 * Allow listing transactions for users that have the search scope.
 *
 * Rationale:
 * - Users with this scope would be able to see record UUID's and registration numbers in the UI anyway.
 */
const isAllowedToSearch = (scope: string[]) => {
  return (
    scope.includes(SCOPES.SEARCH_BIRTH) && scope.includes(SCOPES.SEARCH_DEATH)
  );
};

/**
 * Allow deleting transactions for users that have `record.reject-registration` scope.
 *
 * Rationale:
 * - This should be accompanied with a `client.event.actions.register.reject` call via Postman which requires this scope.
 */
const isAllowedToDelete = (scope: string[]) =>
  scope.includes(SCOPES.RECORD_REJECT_REGISTRATION);

export const getAllTransactionsHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const { scope } = request.user as AuthenticatedUser;

  if (!isAllowedToSearch(scope)) {
    return reply.status(403).send({
      error: "You do not have permission to access this resource.",
    });
  }

  const transactions = getAllTransactions();

  return transactions.map(({ token, ...rest }) => {
    const { eventId, actionId } = decode(token) as TokenPayload;

    return {
      eventId,
      actionId,
      ...rest,
    };
  });
};

export type DeleteTransactionRequest = FastifyRequest<{
  Params: { id: string };
}>;

export const deleteTransactionHandler = async (
  request: DeleteTransactionRequest,
  reply: FastifyReply,
) => {
  const { scope } = request.user as AuthenticatedUser;

  if (!isAllowedToDelete(scope)) {
    return reply.status(403).send({
      error: "You do not have permission to access this resource.",
    });
  }

  const { id } = request.params;

  try {
    const transaction = getTransactionAndDiscard(id);

    reply.status(200).send(transaction);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";

    reply.status(404).send({ error: message });
  }
};

export const ReplaceTokenSchema = z.object({
  token: z.string().describe("The new token to replace the existing one"),
});

export type ReplaceTokenRequest = FastifyRequest<{
  Params: { id: string };
  Body: z.infer<typeof ReplaceTokenSchema>;
}>;

export const replaceTokenByIdHandler = async (
  request: ReplaceTokenRequest,
  reply: FastifyReply,
) => {
  const { scope } = request.user as AuthenticatedUser;

  if (!isAllowedToDelete(scope)) {
    return reply.status(403).send({
      error: "You do not have permission to access this resource.",
    });
  }

  const { id } = request.params;
  const { token: inputToken } = request.body;

  try {
    // Fetch the existing token from the database
    const existingTransaction = getTransaction(id);
    const { eventId, actionId } = decode(
      existingTransaction.token,
    ) as TokenPayload;

    // Build the token exchange URL
    const tokenExchangeUrl = new URL(`${env.AUTH_HOST}/token`);
    tokenExchangeUrl.searchParams.set(
      "grant_type",
      "urn:opencrvs:oauth:grant-type:token-exchange",
    );
    tokenExchangeUrl.searchParams.set("subject_token", inputToken);
    tokenExchangeUrl.searchParams.set(
      "subject_token_type",
      "urn:ietf:params:oauth:token-type:access_token",
    );
    tokenExchangeUrl.searchParams.set(
      "requested_token_type",
      "urn:opencrvs:oauth:token-type:single_record_token",
    );
    tokenExchangeUrl.searchParams.set("event_id", eventId);
    tokenExchangeUrl.searchParams.set("action_id", actionId);

    // Fetch the new token from AUTH service
    const tokenResponse = await fetch(tokenExchangeUrl.toString(), {
      method: "POST",
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(
        `Failed to exchange token: ${tokenResponse.status} - ${error}`,
      );
    }

    const tokenData = await tokenResponse.json();
    const newToken = tokenData.access_token;

    if (!newToken) {
      throw new Error(
        "No access token received from auth service in token exchange response",
      );
    }

    // Update the database with the new token
    updateTransactionToken(id, newToken);

    reply.status(200).send({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";

    reply.status(400).send({ error: message });
  }
};

export type ReplaceAllTokensRequest = FastifyRequest<{
  Body: z.infer<typeof ReplaceTokenSchema>;
}>;

export const replaceAllTokensHandler = async (
  request: ReplaceAllTokensRequest,
  reply: FastifyReply,
) => {
  const { scope } = request.user as AuthenticatedUser;

  if (!isAllowedToDelete(scope)) {
    return reply.status(403).send({
      error: "You do not have permission to access this resource.",
    });
  }

  const { token } = request.body;

  try {
    const result = updateAllTransactionsToken(token);

    reply.status(200).send(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";

    reply.status(500).send({ error: message });
  }
};
