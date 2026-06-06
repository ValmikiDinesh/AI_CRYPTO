import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname is 'server/config', so .env is located at '../.env'
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
