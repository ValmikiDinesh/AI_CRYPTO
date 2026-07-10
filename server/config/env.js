import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Force the Node.js process to run in Indian Standard Time (IST)
process.env.TZ = 'Asia/Kolkata';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname is 'server/config', so .env is located at '../.env'
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
// Reload trigger

