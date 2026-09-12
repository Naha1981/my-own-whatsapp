import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

/**
 * The schema is intentionally idempotent (CREATE IF NOT EXISTS / safe ALTERs),
 * so the Operator can bring a fresh or upgraded database to the expected shape
 * automatically at startup.
 */
export async function initializeDatabase(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(currentDir, '../../db/schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf8');

  await pool.query(schema);
  await pool.query('SELECT 1');
}
