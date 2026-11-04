import assert from "node:assert";
import test from "node:test";
import * as db from "./database";
import { transactionsToCsv } from "./transaction-report";

test("selects all matching transactions in created-at order", () => {
  const { database } = db.initSqlite(":memory:");
  db.insertTransaction("birth-10001-old", "token1", "registration1");
  db.insertTransaction("birth-10001-older", "token2", "registration2");
  db.insertTransaction("birth-10001-new", "token3", "registration3");
  db.insertTransaction("birth-20001-old", "token4", "registration4");
  database
    .prepare(
      "UPDATE transactions SET created_at = datetime('now', ?) WHERE id = ?",
    )
    .run("-2 days", "birth-10001-old");
  database
    .prepare(
      "UPDATE transactions SET created_at = datetime('now', ?) WHERE id = ?",
    )
    .run("-3 days", "birth-10001-older");
  database
    .prepare(
      "UPDATE transactions SET created_at = datetime('now', ?) WHERE id = ?",
    )
    .run("-1 hour", "birth-10001-new");

  assert.deepStrictEqual(
    db.getTransactionsForReport().map(({ id }) => id),
    ["birth-10001-older", "birth-10001-old", "birth-10001-new"],
  );

  db.exit();
});

test("serializes report rows as escaped CSV", () => {
  assert.strictEqual(
    transactionsToCsv([
      { id: 'id,"with quote', created_at: "2026-10-29 12:00:00" },
    ]),
    'id,created_at\r\n"id,""with quote","2026-10-29 12:00:00"',
  );
});
