import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/infrastructure/db/schema';

async function ensureDatabaseExists(dbUrl: string): Promise<void> {
  // Extract DB name and connect to the maintenance "postgres" database to create it
  const url = new URL(dbUrl);
  const dbName = url.pathname.slice(1); // remove leading /
  url.pathname = '/postgres';

  const mainPool = new Pool({ connectionString: url.toString(), max: 1 });
  const client = await mainPool.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code !== '42P04') throw err; // 42P04 = duplicate_database, safe to ignore
  } finally {
    client.release();
    await mainPool.end();
  }
}

export async function createTestPool(): Promise<Pool | null> {
  const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!dbUrl) return null;

  try {
    await ensureDatabaseExists(dbUrl);
    const pool = new Pool({ connectionString: dbUrl, max: 5 });
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return pool;
  } catch {
    return null;
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationPath = join(__dirname, '..', '..', '..', 'migrations', '0001_initial.sql');
  const sql = readFileSync(migrationPath, 'utf-8');
  const client = await pool.connect();
  try {
    // Advisory lock serializes concurrent migration calls from parallel test suites
    await client.query('SELECT pg_advisory_lock(9876543)');
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'default_preferences'
       ) AS exists`,
    );
    if (!rows[0]?.exists) {
      await client.query(sql);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(9876543)').catch(() => undefined);
    client.release();
  }
}

export async function cleanDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM user_preferences');
    await client.query('DELETE FROM quiet_hours');
    await client.query('DELETE FROM global_policies');
    // Don't delete default_preferences as they're seeded
  } finally {
    client.release();
  }
}

export function createTestDb(pool: Pool) {
  return drizzle(pool, { schema });
}
