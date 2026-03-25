/* scripts/seed-admin.js */
const db = require('../db'); // Uses your existing db/index.js
const bcrypt = require('bcrypt');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'password123'; // Change this!

async function seed() {
  try {
    console.log('🌱 Seeding database with Super Admin...');

    // 1. Hash the password
    const saltRounds = 10;
    const hash = await bcrypt.hash(ADMIN_PASSWORD, saltRounds);

    // 2. Insert User (User ID 1)
    // We use ON CONFLICT to avoid errors if you run this script twice
    const text = `
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, 'super_admin')
      ON CONFLICT (username) DO UPDATE 
      SET password_hash = $2
      RETURNING id, username, role;
    `;
    
    const res = await db.query(text, [ADMIN_USERNAME, hash]);
    console.log(`✅ Super Admin created/updated: ${res.rows[0].username} (ID: ${res.rows[0].id})`);
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  }
}

seed();
