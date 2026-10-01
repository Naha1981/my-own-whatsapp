import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database migration");
  }

  const schemaPath = process.env.WHATSAPP_OPERATOR_SCHEMA_PATH
    ?? path.resolve(process.cwd(), "db", "schema.sql");

  const schemaSql = await readFile(schemaPath, "utf8");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    console.log(`[db-migrate] Applying schema from ${schemaPath}`);
    await pool.query(schemaSql);
    console.log("[db-migrate] Schema applied successfully");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("[db-migrate] Migration failed", error);
  process.exit(1);
});
