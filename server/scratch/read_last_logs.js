import fs from 'fs';
import path from 'path';

const logPath = path.resolve('logs/combined2.log');
if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  console.log(`Total lines: ${lines.length}`);
  console.log('Last 100 lines:');
  console.log(lines.slice(-100).join('\n'));
} else {
  console.log('Log file not found at', logPath);
}
