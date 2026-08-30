import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to run migrations.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
try {
  const sql = await readFile(new URL('../migrations/001_trading_core.sql', import.meta.url), 'utf8');
  await pool.query('BEGIN');
  await pool.query(sql);
  const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', ['001_trading_core']);
  if (existing.rowCount === 0) {
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_trading_core']);
    console.log('Trading core migration applied.');
  } else {
    console.log('Trading core migration already applied.');
  }
  await pool.query('COMMIT');
} catch (error) {
  await pool.query('ROLLBACK').catch(() => {});
  console.error(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
