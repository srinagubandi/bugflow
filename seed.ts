import 'dotenv/config';
import { randomBytes, scryptSync } from 'node:crypto';
import { Pool } from 'pg';

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

async function seedPlatformAdmin() {
  const username = process.env.PLATFORM_ADMIN_USERNAME;
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const connectionString = process.env.DATABASE_URL;

  if (!username || !email || !password) {
    console.log('Platform administrator seed variables are absent; skipping initial admin seed.');
    return;
  }
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to seed a platform administrator.');
  }

  const pool = new Pool({ connectionString, ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false } });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (existing.rowCount) {
      console.log('Platform administrator already exists; skipping seed.');
      return;
    }
    await pool.query(
      `INSERT INTO users (username, email, display_name, password_hash, is_platform_admin)
       VALUES ($1, $2, $3, $4, true)`,
      [username, email, 'Platform Administrator', hashPassword(password)],
    );
    console.log('Created the initial platform administrator. Remove the seed password from Railway variables now.');
  } finally {
    await pool.end();
  }
}

seedPlatformAdmin().catch((error) => {
  console.error('Platform administrator seed failed:', error);
  process.exitCode = 1;
});
