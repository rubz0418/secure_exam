const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function sslConfig() {
  const configuredPath = process.env.DB_SSL_CA_PATH;
  if (!configuredPath) return { rejectUnauthorized: true };

  const caPath = path.resolve(process.cwd(), configuredPath);
  if (!fs.existsSync(caPath)) {
    console.warn(`SSL CA file not found at ${caPath}. Copy your Aiven certificate there or update DB_SSL_CA_PATH.`);
    return { rejectUnauthorized: true };
  }

  return {
    ca: fs.readFileSync(caPath),
    rejectUnauthorized: true
  };
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  ssl: sslConfig()
});

module.exports = { pool };
