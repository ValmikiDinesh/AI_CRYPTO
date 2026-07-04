import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  let content = fs.readFileSync(envPath, 'utf8');
  if (content.includes('DASHBOARD_RESET_TIMESTAMP=')) {
    content = content.replace(/DASHBOARD_RESET_TIMESTAMP=.*/g, 'DASHBOARD_RESET_TIMESTAMP=2026-07-04T09:53:00.000Z');
  } else {
    content += '\nDASHBOARD_RESET_TIMESTAMP=2026-07-04T09:53:00.000Z\n';
  }
  fs.writeFileSync(envPath, content, 'utf8');
  console.log("Successfully updated DASHBOARD_RESET_TIMESTAMP in .env on server.");
} else {
  console.error(".env file not found!");
}
