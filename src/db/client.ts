import { Database } from "bun:sqlite";
import { config } from "../config";

export const db = new Database(config.databasePath, { create: true });
try {
  db.exec("PRAGMA journal_mode = WAL;");
} catch {
  // A live bot instance may already hold the journal mode change; tolerate that for read/report CLIs.
}
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");
