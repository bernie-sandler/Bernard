import { openDb, runMigrations } from './client.js';

const path = process.env.DATABASE_PATH ?? './data/bernard.db';
const handle = openDb(path);
runMigrations(handle, process.env.MIGRATIONS_DIR ?? 'src/db/migrations');
handle.close();
console.log(`Migrations applied to ${path}`);
