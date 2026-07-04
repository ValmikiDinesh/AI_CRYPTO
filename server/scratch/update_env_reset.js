import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  let content = fs.readFileSync(envPath, 'utf8');
  
  // Update or append DASHBOARD_RESET_TIMESTAMP
  if (content.includes('DASHBOARD_RESET_TIMESTAMP=')) {
    content = content.replace(/DASHBOARD_RESET_TIMESTAMP=.*/g, 'DASHBOARD_RESET_TIMESTAMP=2026-07-04T09:53:00.000Z');
  } else {
    content += '\nDASHBOARD_RESET_TIMESTAMP=2026-07-04T09:53:00.000Z\n';
  }
  
  // Update or append BASKET_PROFIT_TARGET
  if (content.includes('BASKET_PROFIT_TARGET=')) {
    content = content.replace(/BASKET_PROFIT_TARGET=.*/g, 'BASKET_PROFIT_TARGET=20');
  } else {
    content += '\nBASKET_PROFIT_TARGET=20\n';
  }
  
  fs.writeFileSync(envPath, content, 'utf8');
  console.log("Successfully updated .env file on server.");
} else {
  console.error(".env file not found!");
}
