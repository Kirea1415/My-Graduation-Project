import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = __dirname;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// File paths
const FILES = {
    users: path.join(DATA_DIR, 'users.json'),
    products: path.join(DATA_DIR, 'products.json'),
    orders: path.join(DATA_DIR, 'orders.json'),
    order_items: path.join(DATA_DIR, 'order_items.json'),
    order_keys: path.join(DATA_DIR, 'order_keys.json'),
    categories: path.join(DATA_DIR, 'categories.json'),
    wishlist: path.join(DATA_DIR, 'wishlist.json'),
    news: path.join(DATA_DIR, 'news.json'),
    settings: path.join(DATA_DIR, 'settings.json')
};

// Initialize empty files if they don't exist
Object.entries(FILES).forEach(([key, filePath]) => {
    if (!fs.existsSync(filePath)) {
        if (key === 'settings') {
            fs.writeFileSync(filePath, '{}', 'utf8');
        } else {
            fs.writeFileSync(filePath, '[]', 'utf8');
        }
    }
});

// Read data from file
export function readData(table) {
    try {
        const filePath = FILES[table];
        if (!filePath) {
            throw new Error(`Unknown table: ${table}`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        if (table === 'settings') {
            return JSON.parse(content || '{}');
        }
        return JSON.parse(content || '[]');
    } catch (error) {
        console.error(`Error reading ${table}:`, error);
        return table === 'settings' ? {} : [];
    }
}

// Write data to file
export function writeData(table, data) {
    try {
        const filePath = FILES[table];
        if (!filePath) {
            throw new Error(`Unknown table: ${table}`);
        }
        const content = JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, content, 'utf8');
        return true;
    } catch (error) {
        console.error(`Error writing ${table}:`, error);
        return false;
    }
}

// Add item to array
export function addItem(table, item) {
    const data = readData(table);
    if (!Array.isArray(data)) {
        throw new Error(`${table} is not an array`);
    }
    // Auto-increment ID if not provided or is null
    if (!item.id || item.id === null) {
        const maxId = data.length > 0 ? Math.max(...data.map(i => (i.id || 0))) : 0;
        item.id = maxId + 1;
    }
    // Check if item with this ID already exists, update instead
    const existingIndex = data.findIndex(i => i.id === item.id);
    if (existingIndex !== -1) {
        data[existingIndex] = { ...data[existingIndex], ...item };
    } else {
        data.push(item);
    }
    writeData(table, data);
    return item;
}

// Update item in array
export function updateItem(table, id, updates) {
    const data = readData(table);
    if (!Array.isArray(data)) {
        throw new Error(`${table} is not an array`);
    }
    const index = data.findIndex(item => item.id === id);
    if (index === -1) {
        return null;
    }
    data[index] = { ...data[index], ...updates };
    writeData(table, data);
    return data[index];
}

// Delete item from array
export function deleteItem(table, id) {
    const data = readData(table);
    if (!Array.isArray(data)) {
        throw new Error(`${table} is not an array`);
    }
    const index = data.findIndex(item => item.id === id);
    if (index === -1) {
        return false;
    }
    data.splice(index, 1);
    writeData(table, data);
    return true;
}

// Find item by ID
export function findById(table, id) {
    const data = readData(table);
    if (!Array.isArray(data)) {
        throw new Error(`${table} is not an array`);
    }
    return data.find(item => item.id === id) || null;
}

// Find items by condition
export function findWhere(table, condition) {
    const data = readData(table);
    if (!Array.isArray(data)) {
        throw new Error(`${table} is not an array`);
    }
    return data.filter(item => {
        for (const [key, value] of Object.entries(condition)) {
            if (item[key] !== value) {
                return false;
            }
        }
        return true;
    });
}

// Get setting
export function getSetting(key, defaultValue = '') {
    const settings = readData('settings');
    return settings[key] !== undefined ? settings[key] : defaultValue;
}

// Set setting
export function setSetting(key, value) {
    const settings = readData('settings');
    settings[key] = value;
    writeData('settings', settings);
}

// Sync from PostgreSQL to files (one-time migration)
export async function syncFromPostgreSQL(pool) {
    try {
        console.log('🔄 Đang đồng bộ dữ liệu từ PostgreSQL sang file...');

        // Sync users
        const usersResult = await pool.query('SELECT * FROM users ORDER BY id');
        writeData('users', usersResult.rows);
        console.log(`✅ Đã sync ${usersResult.rows.length} users`);

        // Sync products
        const productsResult = await pool.query('SELECT * FROM products ORDER BY id');
        writeData('products', productsResult.rows);
        console.log(`✅ Đã sync ${productsResult.rows.length} products`);

        // Sync orders
        const ordersResult = await pool.query('SELECT * FROM orders ORDER BY id');
        writeData('orders', ordersResult.rows);
        console.log(`✅ Đã sync ${ordersResult.rows.length} orders`);

        // Sync order_items
        const orderItemsResult = await pool.query('SELECT * FROM order_items ORDER BY id');
        writeData('order_items', orderItemsResult.rows);
        console.log(`✅ Đã sync ${orderItemsResult.rows.length} order_items`);

        // Sync order_keys
        const orderKeysResult = await pool.query('SELECT * FROM order_keys ORDER BY id');
        writeData('order_keys', orderKeysResult.rows);
        console.log(`✅ Đã sync ${orderKeysResult.rows.length} order_keys`);

        // Sync categories
        const categoriesResult = await pool.query('SELECT * FROM categories ORDER BY id');
        writeData('categories', categoriesResult.rows);
        console.log(`✅ Đã sync ${categoriesResult.rows.length} categories`);

        // Sync wishlist
        const wishlistResult = await pool.query('SELECT * FROM wishlist ORDER BY id');
        writeData('wishlist', wishlistResult.rows);
        console.log(`✅ Đã sync ${wishlistResult.rows.length} wishlist items`);

        // Sync news
        const newsResult = await pool.query('SELECT * FROM news ORDER BY id');
        writeData('news', newsResult.rows);
        console.log(`✅ Đã sync ${newsResult.rows.length} news`);

        // Sync settings
        const settingsResult = await pool.query('SELECT * FROM settings ORDER BY key');
        const settings = {};
        settingsResult.rows.forEach(row => {
            settings[row.key] = row.value;
        });
        writeData('settings', settings);
        console.log(`✅ Đã sync ${settingsResult.rows.length} settings`);

        console.log('✅ Hoàn thành đồng bộ dữ liệu!');
    } catch (error) {
        console.error('❌ Lỗi khi đồng bộ:', error);
        throw error;
    }
}

// Sync to PostgreSQL from files
export async function syncToPostgreSQL(pool) {
    try {
        console.log('🔄 Đang đồng bộ dữ liệu từ file sang PostgreSQL...');

        // Sync users
        const users = readData('users');
        for (const user of users) {
            await pool.query(
                `INSERT INTO users (id, email, password_hash, name, role, google_id, avatar, phone, address, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
         google_id = EXCLUDED.google_id, avatar = EXCLUDED.avatar,
         phone = EXCLUDED.phone, address = EXCLUDED.address,
         updated_at = EXCLUDED.updated_at`,
                [user.id, user.email, user.password_hash, user.name, user.role, user.google_id, user.avatar, user.phone, user.address, user.created_at, user.updated_at]
            );
        }
        console.log(`✅ Đã sync ${users.length} users`);

        // Sync other tables similarly...
        // (Implement for other tables as needed)

        console.log('✅ Hoàn thành đồng bộ dữ liệu!');
    } catch (error) {
        console.error('❌ Lỗi khi đồng bộ:', error);
        throw error;
    }
}

