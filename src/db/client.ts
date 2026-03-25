import { Database } from "bun:sqlite";
import { config } from "../config";

export const db = new Database(config.databasePath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
