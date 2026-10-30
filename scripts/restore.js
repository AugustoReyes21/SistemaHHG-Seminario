const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not configured; provide a Postgres connection string to run restores.');
  process.exit(1);
}

const inputFile = process.env.BACKUP_FILE || process.argv[2];
if (!inputFile) {
  console.error('BACKUP_FILE not provided. Use BACKUP_FILE env or pass a .sql file path.');
  process.exit(1);
}

const filePath = path.isAbsolute(inputFile) ? inputFile : path.join(process.cwd(), inputFile);
if (!fs.existsSync(filePath)) {
  console.error(`Backup file not found: ${filePath}`);
  process.exit(1);
}

const psql = process.env.PSQL_PATH || 'psql';
const args = ['--dbname', dbUrl, '--file', filePath];

console.info(`Restaurando base desde ${filePath}`);
const proc = spawn(psql, args, { stdio: 'inherit' });
proc.on('exit', (code) => {
  if (code === 0) {
    console.info('Restore completo.');
    process.exit(0);
  }
  console.error(`psql finalizó con código ${code}`);
  process.exit(code || 1);
});
