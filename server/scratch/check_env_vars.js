import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { RISK } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load dotenv just like the server does
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

console.log("process.env.MAX_DAILY_LOSS:", process.env.MAX_DAILY_LOSS);
console.log("RISK.MAX_DAILY_LOSS:", RISK.MAX_DAILY_LOSS);
