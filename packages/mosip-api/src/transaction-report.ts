import { FastifyInstance } from "fastify";
import * as nodemailer from "nodemailer";
import { env } from "./constants";
import * as db from "./database";

const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;

export const transactionsToCsv = (transactions: db.TransactionReportRecord[]) =>
  [
    "id,created_at",
    ...transactions.map(
      ({ id, created_at }) => `${csvCell(id)},${csvCell(created_at)}`,
    ),
  ].join("\r\n");

const getNextRunAt = (time: string) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    throw new Error(
      `TRANSACTION_REPORT_TIME must be a valid UTC time in HH:mm format; received '${time}'`,
    );
  }

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }
  return nextRun;
};

const sendTransactionReport = async () => {
  const recipients = env.TRANSACTION_REPORT_RECIPIENTS.split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    throw new Error(
      "TRANSACTION_REPORT_RECIPIENTS must contain at least one recipient",
    );
  }
  if (!env.SMTP_HOST) {
    throw new Error("SMTP_HOST is required to send the transaction report");
  }
  if (!env.SMTP_USERNAME || !env.SMTP_PASSWORD) {
    throw new Error(
      "SMTP_USERNAME and SMTP_PASSWORD are required to authenticate with the SMTP server",
    );
  }
  const transactions = db.getTransactionsForReport();
  const reportDate = new Date().toISOString().slice(0, 10);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
  });

  await transport.sendMail({
    from: env.SENDER_EMAIL_ADDRESS || env.SMTP_USERNAME,
    to: recipients,
    subject: `MOSIP transaction report - ${reportDate}`,
    text: `Attached are ${transactions.length} matching MOSIP transactions.`,
    attachments: [
      {
        filename: `mosip-transactions-${reportDate}.csv`,
        content: transactionsToCsv(transactions),
        contentType: "text/csv; charset=utf-8",
      },
    ],
  });
};

export const startTransactionReportJob = (
  app: FastifyInstance,
): NodeJS.Timeout => {
  console.log(
    "Batch job for transactions started",
    env.TRANSACTION_REPORT_TIME,
  );
  const scheduleNextRun = (): NodeJS.Timeout => {
    const nextRun = getNextRunAt(env.TRANSACTION_REPORT_TIME);
    app.log.info(
      { nextRun: nextRun.toISOString() },
      "Scheduled daily MOSIP transaction report",
    );

    return setTimeout(async () => {
      app.log.info("Running daily MOSIP transaction report");
      try {
        await sendTransactionReport();
        app.log.info("Daily MOSIP transaction report sent");
        console.log("Daily MOSIP transaction report sent");
      } catch (error) {
        app.log.error(
          { err: error },
          "Failed to send daily MOSIP transaction report",
        );
      } finally {
        scheduleNextRun();
      }
    }, nextRun.getTime() - Date.now());
  };

  return scheduleNextRun();
};
