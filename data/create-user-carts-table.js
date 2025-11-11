import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'safekeys',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
});

async function createUserCartsTable() {
    const client = await pool.connect();
    try {
        console.log('🔄 Đang tạo bảng user_carts...');

        await client.query(`
      CREATE TABLE IF NOT EXISTS user_carts (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        cart_data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

        console.log('✅ Đã tạo bảng user_carts thành công!');
    } catch (error) {
        console.error('❌ Lỗi khi tạo bảng:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

createUserCartsTable();

