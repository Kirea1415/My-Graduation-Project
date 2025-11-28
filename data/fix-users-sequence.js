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

async function fixSequence() {
    const client = await pool.connect();
    try {
        console.log('🔄 Fixing users id sequence...');
        const res = await client.query("SELECT COALESCE(MAX(id), 0) AS maxid FROM users");
        const maxId = res.rows[0].maxid || 0;
        const next = Number(maxId) + 1;
        // set sequence to next-1 and mark last_value accordingly so next nextval returns next
        const seqNameRes = await client.query("SELECT pg_get_serial_sequence('users','id') AS seq");
        const seqName = seqNameRes.rows[0].seq;
        if (!seqName) {
            console.warn('⚠️ Could not determine users id sequence name.');
            return;
        }
        await client.query(`SELECT setval($1, $2, false)`, [seqName, next]);
        console.log(`✅ Sequence ${seqName} set so next id will be ${next}`);
    } catch (err) {
        console.error('❌ Error fixing sequence:', err.message || err);
    } finally {
        client.release();
        await pool.end();
    }
}

fixSequence();
