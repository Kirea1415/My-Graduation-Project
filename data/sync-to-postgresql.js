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

async function syncToPostgreSQL() {
    const client = await pool.connect();
    try {
        console.log('🔄 Đang đồng bộ dữ liệu từ file lên PostgreSQL...\n');
        await client.query('BEGIN');

        // 1. Sync users
        console.log('📦 Đang sync users...');
        const users = dataManager.readData('users');
        for (const user of users) {
            await client.query(
                `INSERT INTO users (id, email, password_hash, name, role, google_id, avatar, phone, address, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         google_id = EXCLUDED.google_id,
         avatar = EXCLUDED.avatar,
         phone = EXCLUDED.phone,
         address = EXCLUDED.address,
         updated_at = EXCLUDED.updated_at`,
                [
                    user.id,
                    user.email,
                    user.password_hash,
                    user.name,
                    user.role,
                    user.google_id || null,
                    user.avatar || null,
                    user.phone || null,
                    user.address || null,
                    user.created_at || new Date().toISOString(),
                    user.updated_at || new Date().toISOString()
                ]
            );
        }
        console.log(`   ✅ Đã sync ${users.length} users`);

        // 2. Sync categories
        console.log('📦 Đang sync categories...');
        const categories = dataManager.readData('categories');
        for (const category of categories) {
            await client.query(
                `INSERT INTO categories (id, name, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug`,
                [category.id, category.name, category.slug]
            );
        }
        console.log(`   ✅ Đã sync ${categories.length} categories`);

        // 3. Sync products
        console.log('📦 Đang sync products...');
        const products = dataManager.readData('products');
        for (const product of products) {
            await client.query(
                `INSERT INTO products (id, title, slug, description, price_cents, image, category_id, active, stock, featured, key_value, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         slug = EXCLUDED.slug,
         description = EXCLUDED.description,
         price_cents = EXCLUDED.price_cents,
         image = EXCLUDED.image,
         category_id = EXCLUDED.category_id,
         active = EXCLUDED.active,
         stock = EXCLUDED.stock,
         featured = EXCLUDED.featured,
         key_value = EXCLUDED.key_value,
         updated_at = EXCLUDED.updated_at`,
                [
                    product.id,
                    product.title,
                    product.slug,
                    product.description || null,
                    product.price_cents,
                    product.image || null,
                    product.category_id || null,
                    product.active !== undefined ? product.active : 1,
                    product.stock || 0,
                    product.featured || 0,
                    product.key_value || null,
                    product.created_at || new Date().toISOString(),
                    product.updated_at || new Date().toISOString()
                ]
            );
        }
        console.log(`   ✅ Đã sync ${products.length} products`);

        // 4. Sync orders
        console.log('📦 Đang sync orders...');
        const orders = dataManager.readData('orders');
        for (const order of orders) {
            await client.query(
                `INSERT INTO orders (id, user_id, total_cents, status, payment_method, payment_trans_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         total_cents = EXCLUDED.total_cents,
         status = EXCLUDED.status,
         payment_method = EXCLUDED.payment_method,
         payment_trans_id = EXCLUDED.payment_trans_id,
         updated_at = EXCLUDED.updated_at`,
                [
                    order.id,
                    order.user_id,
                    order.total_cents,
                    order.status || 'pending',
                    order.payment_method || null,
                    order.payment_trans_id || null,
                    order.created_at || new Date().toISOString(),
                    order.updated_at || new Date().toISOString()
                ]
            );
        }
        console.log(`   ✅ Đã sync ${orders.length} orders`);

        // 5. Sync order_items
        console.log('📦 Đang sync order_items...');
        const orderItems = dataManager.readData('order_items');
        for (const item of orderItems) {
            await client.query(
                `INSERT INTO order_items (id, order_id, product_id, quantity, price_cents)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
         order_id = EXCLUDED.order_id,
         product_id = EXCLUDED.product_id,
         quantity = EXCLUDED.quantity,
         price_cents = EXCLUDED.price_cents`,
                [
                    item.id,
                    item.order_id,
                    item.product_id,
                    item.quantity,
                    item.price_cents
                ]
            );
        }
        console.log(`   ✅ Đã sync ${orderItems.length} order_items`);

        // 6. Sync order_keys
        console.log('📦 Đang sync order_keys...');
        const orderKeys = dataManager.readData('order_keys');
        for (const key of orderKeys) {
            await client.query(
                `INSERT INTO order_keys (id, order_item_id, key_value, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
         order_item_id = EXCLUDED.order_item_id,
         key_value = EXCLUDED.key_value,
         created_at = EXCLUDED.created_at`,
                [
                    key.id,
                    key.order_item_id,
                    key.key_value,
                    key.created_at || new Date().toISOString()
                ]
            );
        }
        console.log(`   ✅ Đã sync ${orderKeys.length} order_keys`);

        // 7. Sync wishlist
        console.log('📦 Đang sync wishlist...');
        const wishlist = dataManager.readData('wishlist');
        for (const item of wishlist) {
            await client.query(
                `INSERT INTO wishlist (id, user_id, product_id, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         product_id = EXCLUDED.product_id,
         created_at = EXCLUDED.created_at`,
                [
                    item.id,
                    item.user_id,
                    item.product_id,
                    item.created_at || new Date().toISOString()
                ]
            );
        }
        console.log(`   ✅ Đã sync ${wishlist.length} wishlist items`);

        // 8. Sync news
        console.log('📦 Đang sync news...');
        const news = dataManager.readData('news');
        for (const article of news) {
            await client.query(
                `INSERT INTO news (id, title, slug, content, excerpt, published, author, thumbnail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         slug = EXCLUDED.slug,
         content = EXCLUDED.content,
         excerpt = EXCLUDED.excerpt,
         published = EXCLUDED.published,
         author = EXCLUDED.author,
         thumbnail = EXCLUDED.thumbnail,
         updated_at = EXCLUDED.updated_at`,
                [
                    article.id,
                    article.title,
                    article.slug,
                    article.content || null,
                    article.excerpt || null,
                    article.published !== undefined ? article.published : 0,
                    article.author || null,
                    article.thumbnail || null,
                    article.created_at || new Date().toISOString(),
                    article.updated_at || new Date().toISOString()
                ]
            );
        }
        console.log(`   ✅ Đã sync ${news.length} news`);

        // 9. Sync settings
        console.log('📦 Đang sync settings...');
        const settings = dataManager.readData('settings');
        for (const [key, value] of Object.entries(settings)) {
            await client.query(
                `INSERT INTO settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value`,
                [key, value]
            );
        }
        console.log(`   ✅ Đã sync ${Object.keys(settings).length} settings`);

        await client.query('COMMIT');
        console.log('\n✅ Hoàn thành đồng bộ dữ liệu từ file lên PostgreSQL!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Lỗi khi đồng bộ:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

syncToPostgreSQL();

