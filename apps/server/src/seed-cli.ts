/** CLI: seed demo data into the database, then exit. */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, logger } from "@devrecap/shared";
import { seedDemoData } from "./seed.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const DB_PATH = process.env.DEVRECAP_DB || resolve(ROOT, "data", "devrecap.db");

const db = openDb(DB_PATH);
const r = seedDemoData(db);
logger.info("seeded demo data", { ...r, db: DB_PATH });
process.stdout.write(`Seeded ${r.projects} projects and ${r.activities} activities into ${DB_PATH}\n`);
db.close();
