const db = require('./db');

async function testConnection() {
  console.log('Testing database connection...');
  try {
    const res = await db.query('SELECT NOW() as current_time');
    console.log('✅ Database connection successful!');
    console.log('Timestamp from DB:', res.rows[0].current_time);
    process.exit(0);
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }
}
testConnection();