import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { getConfig } from '../../config';

async function runMigrations(): Promise<void> {
  const config = getConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL });

  try {
    const migrationPath = join(__dirname, '..', '..', '..', 'migrations', '0001_initial.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    const client = await pool.connect();
    try {
      // Advisory lock prevents race when multiple replicas start simultaneously
      await client.query('SELECT pg_advisory_lock(1234567890)');
      await client.query(sql);
      console.log('Migrations completed successfully');
    } finally {
      await client.query('SELECT pg_advisory_unlock(1234567890)').catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
