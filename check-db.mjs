import { createConnection } from 'mysql2/promise';
import * as dotenv from 'dotenv';
dotenv.config();

const conn = await createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute(
  `SELECT p.name, vr.id, vr.authStatus, vr.sessionsRemaining, vr.sessionNumber
   FROM visit_records vr
   JOIN patients p ON vr.patientId = p.id
   ORDER BY vr.id DESC LIMIT 10`
);
console.table(rows);
await conn.end();
