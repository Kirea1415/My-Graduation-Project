import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'safekeys',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || ''
});

async function addColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Checking/adding `activated` column to users table...');

        // Add column if not exists. Default TRUE for existing users so we don't lock existing accounts.
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activated BOOLEAN DEFAULT true`);

        console.log('✅ Column `activated` ensured on users table (default true).');
    } catch (err) {
        console.error('❌ Error adding activated column:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

addColumn();
