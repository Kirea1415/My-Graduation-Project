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

async function checkOrders() {
    try {
        console.log('🔍 Checking orders in PostgreSQL database...\n');

        // Check all orders
        const allOrders = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 10');
        console.log('📋 All orders (last 10):');
        console.log(`   Total: ${allOrders.rows.length} orders`);
        allOrders.rows.forEach(order => {
            console.log(`   - Order #${order.id}: user_id=${order.user_id}, status=${order.status}, total=${order.total_cents}, created=${order.created_at}`);
        });

        // Check orders by status
        const statusCounts = await pool.query(`
      SELECT status, COUNT(*) as count 
      FROM orders 
      GROUP BY status
    `);
        console.log('\n📊 Orders by status:');
        statusCounts.rows.forEach(row => {
            console.log(`   - ${row.status}: ${row.count} orders`);
        });

        // Check orders for a specific user (if provided)
        if (process.argv[2]) {
            const userId = parseInt(process.argv[2]);
            console.log(`\n👤 Orders for user ${userId}:`);
            const userOrders = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
            console.log(`   Total: ${userOrders.rows.length} orders`);
            userOrders.rows.forEach(order => {
                console.log(`   - Order #${order.id}: status=${order.status}, total=${order.total_cents}, created=${order.created_at}`);
            });

            // Check order items
            if (userOrders.rows.length > 0) {
                console.log('\n📦 Order items:');
                for (const order of userOrders.rows) {
                    const items = await pool.query(`
            SELECT oi.*, p.title, p.key_value 
            FROM order_items oi 
            JOIN products p ON p.id = oi.product_id 
            WHERE oi.order_id = $1
          `, [order.id]);
                    console.log(`   Order #${order.id}:`);
                    items.rows.forEach(item => {
                        console.log(`     - ${item.title}: qty=${item.quantity}, has_key=${!!item.key_value}`);
                    });
                }
            }
        }

        // Check if orders table exists
        const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'orders'
      )
    `);
        console.log(`\n✅ Orders table exists: ${tableExists.rows[0].exists}`);

        // Check if order_items table exists
        const itemsTableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'order_items'
      )
    `);
        console.log(`✅ Order_items table exists: ${itemsTableExists.rows[0].exists}`);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

checkOrders();

