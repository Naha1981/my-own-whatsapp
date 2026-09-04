import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Most managed Postgres providers (Render, Neon, Supabase) require SSL.
  // Disable this only for local development against a non-SSL database.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});
