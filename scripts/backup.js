const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not configured; provide a Postgres connection string to run backups.');
  process.exit(1);
}

const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const filePath = path.join(dir, `hhg-backup-${stamp}.sql`);

const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
const args = ['--dbname', dbUrl, '--file', filePath];

console.info(`Respaldando base en ${filePath}`);
const proc = spawn(pgDump, args, { stdio: 'inherit' });
proc.on('exit', (code) => {
  if (code === 0) {
    console.info('Backup completo.');
    process.exit(0);
  }
  console.error(`pg_dump finalizó con código ${code}`);
  process.exit(code || 1);
});
