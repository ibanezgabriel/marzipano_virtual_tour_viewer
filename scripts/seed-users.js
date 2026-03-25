const db = require('../db');
const bcrypt = require('bcrypt');

const SUPERADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || 'superadmin';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requirePassword(name, value) {
  if (typeof value === 'string' && value.length >= 8) return;
  console.error(`❌ Missing/invalid ${name}. Set it as an environment variable (min 8 chars).`);
  process.exit(1);
}

async function upsertUser({ username, password, role }) {
  const saltRounds = 10;
  const hash = await bcrypt.hash(password, saltRounds);
  const res = await db.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
     SET password_hash = $2, role = $3
     RETURNING id, username, role;`,
    [username, hash, role]
  );
  return res.rows[0];
}

async function seed() {
  console.log('🌱 Seeding database users (Super Admin + Admin)...');

  requirePassword('SUPERADMIN_PASSWORD', SUPERADMIN_PASSWORD);
  const superAdmin = await upsertUser({
    username: SUPERADMIN_USERNAME,
    password: SUPERADMIN_PASSWORD,
    role: 'super_admin',
  });
  console.log(`✅ Super Admin created/updated: ${superAdmin.username} (ID: ${superAdmin.id})`);

  if (ADMIN_PASSWORD) {
    requirePassword('ADMIN_PASSWORD', ADMIN_PASSWORD);
    const admin = await upsertUser({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      role: 'admin',
    });
    console.log(`✅ Admin created/updated: ${admin.username} (ID: ${admin.id})`);
  } else {
    console.log('ℹ️  ADMIN_PASSWORD not set; skipped creating/updating the admin user.');
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  });

