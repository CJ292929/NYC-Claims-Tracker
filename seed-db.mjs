/**
 * Seed script — migrates patients.json into the MySQL database.
 * Run once: node seed-db.mjs
 */

import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load patients.json ───────────────────────────────────────────────────────
const patientsJson = JSON.parse(
  readFileSync(join(__dirname, 'client/src/data/patients.json'), 'utf-8')
);

// ─── DB connection ────────────────────────────────────────────────────────────
const connection = await mysql.createConnection(process.env.DATABASE_URL);
const db = drizzle(connection);

// ─── Helper: parse date strings like "2026-04-21 00:00:00" → Date | null ─────
function parseDate(s) {
  if (!s || s === 'RE' || s === 'N/A') return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

// ─── Seed ─────────────────────────────────────────────────────────────────────
for (const patient of patientsJson) {
  console.log(`Inserting patient: ${patient.name}`);

  // Determine authDate from first visit row
  const firstVisit = patient.visits?.[0];
  const authDate = firstVisit ? parseDate(firstVisit['Authorization Date']) : null;

  // Insert patient
  const [result] = await connection.execute(
    'INSERT INTO patients (name, insurance, authDate, createdAt, updatedAt) VALUES (?, ?, ?, NOW(), NOW())',
    [patient.name, patient.insurance, authDate ? authDate.toISOString().split('T')[0] : null]
  );
  const patientId = result.insertId;

  // Insert visit records
  for (const visit of (patient.visits || [])) {
    const dateOfService = parseDate(visit['Dates of Service']);
    const dateAshSubmitted = parseDate(visit['Date ASH submitted']);
    const sessionsAuthorized = visit['# of sessions authorized'] ?? null;
    const sessionsRemaining = visit['#of sessions remaining'] ?? null;
    const sessionNumber = visit['Session number'] ?? null;
    const newAuth = visit['New authorization?'] || null;

    await connection.execute(
      `INSERT INTO visit_records 
        (patientId, sessionsAuthorized, sessionsRemaining, sessionNumber, dateOfService, newAuth, dateAshSubmitted, authStatus, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NOW(), NOW())`,
      [
        patientId,
        sessionsAuthorized,
        sessionsRemaining,
        sessionNumber,
        dateOfService ? dateOfService.toISOString().split('T')[0] : null,
        newAuth,
        dateAshSubmitted ? dateAshSubmitted.toISOString().split('T')[0] : null,
      ]
    );
  }

  console.log(`  → Inserted ${patient.visits?.length ?? 0} visit records`);
}

console.log('\n✅ Seed complete!');
await connection.end();
