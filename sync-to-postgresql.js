import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Client } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PATH = path.join(__dirname, 'data');
const sqliteDb = new Database(path.join(DATA_PATH, 'safekeys.db'));

// PostgreSQL connection config
// Có thể cấu hình bằng environment variables hoặc sửa trực tiếp ở đây
const pgConfig = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'safekeys',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'your_password',
};

console.log('🔄 Starting database sync from SQLite to PostgreSQL...\n');
console.log(`📊 PostgreSQL Config:`);
console.log(`   Host: ${pgConfig.host}`);
console.log(`   Port: ${pgConfig.port}`);
console.log(`   Database: ${pgConfig.database}`);
console.log(`   User: ${pgConfig.user}\n`);

const pgClient = new Client(pgConfig);

// Table schemas for PostgreSQL
const tableSchemas = {
    users: {
        id: 'SERIAL PRIMARY KEY',
        email: 'TEXT UNIQUE NOT NULL',
        password_hash: 'TEXT',
        name: 'TEXT NOT NULL',
        role: 'TEXT NOT NULL DEFAULT \'customer\'',
        google_id: 'TEXT UNIQUE',
        avatar: 'TEXT',
        phone: 'TEXT',
        address: 'TEXT',
        created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
        updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
    },
    categories: {
        id: 'SERIAL PRIMARY KEY',
        name: 'TEXT NOT NULL',
        slug: 'TEXT UNIQUE NOT NULL'
    },
    products: {
        id: 'SERIAL PRIMARY KEY',
        title: 'TEXT NOT NULL',
        slug: 'TEXT UNIQUE NOT NULL',
        description: 'TEXT',
        price_cents: 'INTEGER NOT NULL',
        image: 'TEXT',
        category_id: 'INTEGER',
        active: 'INTEGER NOT NULL DEFAULT 1',
        stock: 'INTEGER NOT NULL DEFAULT 100',
        featured: 'INTEGER NOT NULL DEFAULT 0'
    },
    orders: {
        id: 'SERIAL PRIMARY KEY',
        user_id: 'INTEGER',
        total_cents: 'INTEGER NOT NULL',
        status: 'TEXT NOT NULL DEFAULT \'pending\'',
        created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
    },
    order_items: {
        id: 'SERIAL PRIMARY KEY',
        order_id: 'INTEGER NOT NULL',
        product_id: 'INTEGER NOT NULL',
        quantity: 'INTEGER NOT NULL',
        price_cents: 'INTEGER NOT NULL'
    },
    wishlist: {
        id: 'SERIAL PRIMARY KEY',
        user_id: 'INTEGER NOT NULL',
        product_id: 'INTEGER NOT NULL',
        created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
    },
    settings: {
        key: 'TEXT PRIMARY KEY',
        value: 'TEXT'
    },
    news: {
        id: 'SERIAL PRIMARY KEY',
        title: 'TEXT NOT NULL',
        slug: 'TEXT UNIQUE NOT NULL',
        content: 'TEXT NOT NULL',
        published: 'INTEGER NOT NULL DEFAULT 1',
        created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
        updated_at: 'TIMESTAMP',
        author: 'TEXT',
        thumbnail: 'TEXT'
    },
    sessions: {
        sid: 'TEXT NOT NULL PRIMARY KEY',
        sess: 'JSONB NOT NULL',
        expire: 'TIMESTAMP NOT NULL'
    }
};

// Foreign keys
const foreignKeys = {
    products: ['FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL'],
    orders: ['FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL'],
    order_items: [
        'FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE',
        'FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE'
    ],
    wishlist: [
        'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
        'FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE',
        'UNIQUE(user_id, product_id)'
    ]
};

async function createTables() {
    console.log('📋 Creating tables...');

    for (const [tableName, schema] of Object.entries(tableSchemas)) {
        // Drop table if exists
        await pgClient.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);

        // Create table
        const columns = Object.entries(schema).map(([colName, colDef]) => {
            return `${colName} ${colDef}`;
        });

        let createSQL = `CREATE TABLE ${tableName} (\n  ${columns.join(',\n  ')}`;

        if (foreignKeys[tableName]) {
            createSQL += ',\n  ' + foreignKeys[tableName].join(',\n  ');
        }

        createSQL += '\n)';

        await pgClient.query(createSQL);
        console.log(`   ✓ Created table: ${tableName}`);
    }
}

async function createIndexes() {
    console.log('\n📇 Creating indexes...');

    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)',
        'CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)',
        'CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug)',
        'CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured) WHERE featured = 1',
        'CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
        'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)',
        'CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)',
        'CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_wishlist_product ON wishlist(product_id)',
        'CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug)',
        'CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL'
    ];

    for (const idxSQL of indexes) {
        try {
            await pgClient.query(idxSQL);
        } catch (err) {
            console.warn(`   ⚠ Index creation warning: ${err.message}`);
        }
    }

    console.log('   ✓ All indexes created');
}

async function syncData() {
    console.log('\n💾 Syncing data...');

    const tables = ['users', 'categories', 'products', 'orders', 'order_items', 'wishlist', 'settings', 'news', 'sessions'];

    for (const tableName of tables) {
        try {
            // Get data from SQLite
            const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all();

            if (rows.length === 0) {
                console.log(`   ⏭ Skipped ${tableName}: No data`);
                continue;
            }

            // Clear existing data in PostgreSQL
            await pgClient.query(`TRUNCATE TABLE ${tableName} CASCADE`);

            if (rows.length === 0) continue;

            // Get columns
            const columns = Object.keys(rows[0]);

            // Build INSERT query with ON CONFLICT for updates
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            const updateClause = columns
                .filter(col => col !== 'id') // Don't update ID
                .map(col => `${col} = EXCLUDED.${col}`)
                .join(', ');

            let insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

            // Add ON CONFLICT for tables with UNIQUE constraints
            if (tableName === 'settings') {
                insertSQL += ` ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
            } else if (tableName === 'categories' || tableName === 'products' || tableName === 'news') {
                insertSQL += ` ON CONFLICT (id) DO UPDATE SET ${updateClause}`;
            } else if (tableName === 'wishlist') {
                insertSQL += ` ON CONFLICT (user_id, product_id) DO NOTHING`;
            }

            // Insert rows
            let inserted = 0;
            for (const row of rows) {
                const values = columns.map(col => {
                    const value = row[col];
                    if (value === null || value === undefined) return null;

                    // Handle JSON for sessions table
                    if (tableName === 'sessions' && col === 'sess' && typeof value === 'string') {
                        try {
                            return JSON.parse(value);
                        } catch {
                            return value;
                        }
                    }

                    return value;
                });

                try {
                    await pgClient.query(insertSQL, values);
                    inserted++;
                } catch (err) {
                    console.error(`   ✗ Error inserting row into ${tableName}:`, err.message);
                }
            }

            console.log(`   ✓ Synced ${tableName}: ${inserted}/${rows.length} rows`);

            // Reset sequence for SERIAL columns
            if (tableName !== 'settings' && tableName !== 'sessions') {
                try {
                    const maxId = await pgClient.query(`SELECT MAX(id) as max_id FROM ${tableName}`);
                    if (maxId.rows[0]?.max_id) {
                        await pgClient.query(`SELECT setval('${tableName}_id_seq', ${maxId.rows[0].max_id}, true)`);
                    }
                } catch (err) {
                    // Ignore sequence errors
                }
            }
        } catch (err) {
            console.error(`   ✗ Error syncing ${tableName}:`, err.message);
        }
    }
}

async function main() {
    try {
        // Connect to PostgreSQL
        console.log('🔌 Connecting to PostgreSQL...');
        await pgClient.connect();
        console.log('   ✓ Connected successfully!\n');

        // Create tables
        await createTables();

        // Create indexes
        await createIndexes();

        // Sync data
        await syncData();

        console.log('\n✅ Sync completed successfully!');
        console.log('\n💡 You can now query and manage your data in pgAdmin.');
        console.log('   Open pgAdmin → Connect to your database → Browse your tables');

    } catch (error) {
        console.error('\n❌ Sync failed:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error('\n💡 Make sure PostgreSQL is running and connection details are correct.');
            console.error('   You can set connection details via environment variables:');
            console.error('   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD');
        } else if (error.code === '3D000') {
            console.error('\n💡 Database does not exist. Please create it first:');
            console.error(`   CREATE DATABASE ${pgConfig.database};`);
        } else if (error.code === '28P01') {
            console.error('\n💡 Authentication failed. Check your username and password.');
        }
        process.exit(1);
    } finally {
        await pgClient.end();
        sqliteDb.close();
    }
}

main();

