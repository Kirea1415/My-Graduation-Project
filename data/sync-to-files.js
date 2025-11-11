import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;
import * as dataManager from './data-manager.js';

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'safekeys',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
});

async function syncToFiles() {
    try {
        console.log('🔄 Đang đồng bộ dữ liệu từ PostgreSQL sang file trong data/...\n');
        await dataManager.syncFromPostgreSQL(pool);
        console.log('\n✅ Hoàn thành! Tất cả dữ liệu đã được lưu vào file trong data/');
    } catch (error) {
        console.error('❌ Lỗi:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

syncToFiles();

