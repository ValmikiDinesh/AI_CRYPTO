import fs from 'fs';
import path from 'path';

const logDir = 'logs';
const files = fs.readdirSync(logDir).map(file => {
  const filePath = path.join(logDir, file);
  const stats = fs.statSync(filePath);
  return {
    file,
    mtime: stats.mtime,
    size: stats.size
  };
});

files.sort((a, b) => b.mtime - a.mtime);
console.log('Log files sorted by last modified time:');
files.forEach(f => console.log(`${f.file} | mtime: ${f.mtime.toISOString()} | size: ${f.size} bytes`));
