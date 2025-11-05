import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PATH = path.join(__dirname, 'data');
const db = new Database(path.join(DATA_PATH, 'safekeys.db'));

console.log('📊 Exporting database to PostgreSQL format...\n');

let sqlOutput = '';
sqlOutput += '-- ============================================\n';
sqlOutput += '-- SafeKeyS Database Export for PostgreSQL\n';
sqlOutput += `-- Export Date: ${new Date().toISOString()}\n`;
sqlOutput += '-- ============================================\n\n';

sqlOutput += '-- Disable foreign key checks temporarily\n';
sqlOutput += 'SET session_replication_role = replica;\n\n';

// Define table schemas manually (more reliable)
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

// Foreign key constraints
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

// Export schema
sqlOutput += '-- ============================================\n';
sqlOutput += '-- SCHEMA: CREATE TABLES\n';
sqlOutput += '-- ============================================\n\n';

Object.keys(tableSchemas).forEach(tableName => {
    sqlOutput += `-- Table: ${tableName}\n`;
    sqlOutput += `DROP TABLE IF EXISTS ${tableName} CASCADE;\n`;
    sqlOutput += `CREATE TABLE ${tableName} (\n`;

    const schema = tableSchemas[tableName];
    const columns = Object.entries(schema).map(([colName, colDef]) => {
        return `  ${colName} ${colDef}`;
    });

    sqlOutput += columns.join(',\n');

    // Add foreign keys and constraints
    if (foreignKeys[tableName]) {
        sqlOutput += ',\n';
        sqlOutput += foreignKeys[tableName].map(fk => `  ${fk}`).join(',\n');
    }

    sqlOutput += '\n);\n\n';
});

// Export indexes
sqlOutput += '-- ============================================\n';
sqlOutput += '-- INDEXES\n';
sqlOutput += '-- ============================================\n\n';

const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);',
    'CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);',
    'CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);',
    'CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured) WHERE featured = 1;',
    'CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);',
    'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);',
    'CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);',
    'CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_wishlist_product ON wishlist(product_id);',
    'CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);',
    'CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;'
];

indexes.forEach(idx => {
    sqlOutput += idx + '\n';
});
sqlOutput += '\n';

// Export data
sqlOutput += '\n-- ============================================\n';
sqlOutput += '-- DATA: INSERT RECORDS\n';
sqlOutput += '-- ============================================\n\n';

// Get all tables
const tables = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all();

tables.forEach(table => {
    const tableName = table.name;

    try {
        const rows = db.prepare(`SELECT * FROM ${tableName}`).all();

        if (rows.length > 0) {
            const columns = Object.keys(rows[0]);

            sqlOutput += `-- Table: ${tableName} (${rows.length} rows)\n`;

            // Get column info to handle types
            const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all();
            const columnTypes = {};
            tableInfo.forEach(col => {
                columnTypes[col.name] = col.type.toUpperCase();
            });

            rows.forEach((row, rowIdx) => {
                const values = columns.map(col => {
                    const value = row[col];

                    if (value === null || value === undefined) {
                        return 'NULL';
                    }

                    const colType = columnTypes[col] || 'TEXT';

                    if (colType.includes('INT') || colType === 'NUMERIC' || colType === 'REAL') {
                        return String(value);
                    }

                    if (colType === 'BLOB') {
                        return `'\\x${Buffer.from(value).toString('hex')}'`;
                    }

                    // Escape single quotes for TEXT
                    const escaped = String(value).replace(/'/g, "''").replace(/\\/g, '\\\\');
                    return `'${escaped}'`;
                });

                sqlOutput += `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;

                // Add newline every 50 rows for readability
                if ((rowIdx + 1) % 50 === 0) {
                    sqlOutput += '\n';
                }
            });

            sqlOutput += '\n';
        }
    } catch (error) {
        console.error(`Warning: Could not export data from ${tableName}:`, error.message);
    }
});

// Re-enable foreign key checks
sqlOutput += '\n-- ============================================\n';
sqlOutput += '-- Re-enable foreign key checks\n';
sqlOutput += '-- ============================================\n';
sqlOutput += 'SET session_replication_role = DEFAULT;\n';

// Save to file
const outputPath = path.join(DATA_PATH, 'safekeys-export-postgresql.sql');
fs.writeFileSync(outputPath, sqlOutput, 'utf8');

console.log(`✅ Export completed successfully!`);
console.log(`📁 File saved to: ${outputPath}`);
console.log(`📊 Tables exported: ${tables.length}`);
tables.forEach(table => {
    try {
        const count = db.prepare(`SELECT COUNT(*) as c FROM ${table.name}`).get().c;
        console.log(`   - ${table.name}: ${count} rows`);
    } catch (e) {
        console.log(`   - ${table.name}: (error reading)`);
    }
});

console.log(`\n💡 To import into PostgreSQL:`);
console.log(`   1. Open pgAdmin`);
console.log(`   2. Create a new database (if not exists)`);
console.log(`   3. Right-click on your database → Query Tool`);
console.log(`   4. Copy and paste the SQL from: ${outputPath}`);
console.log(`   5. Click Execute or press F5`);
console.log(`\n   Or use command line:`);
console.log(`   psql -U your_username -d your_database -f ${outputPath}`);

db.close();
