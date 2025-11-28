import bcrypt from 'bcryptjs';

export function setupOrderRoutes(app, {
    pool,
    db,
    getSetting,
    requireAuth,
    getUserId,
    getCart,
    saveCartToDatabase,
    dataManager,
    logger
}) {
    // User order history
    app.get('/orders', requireAuth, async (req, res) => {
        try {
            const needsPasswordVerification = !req.session.ordersPasswordVerified;
            if (needsPasswordVerification) {
                return res.render('orders', {
                    title: 'Lịch sử giao dịch - SafeKeyS',
                    pendingOrders: [],
                    completedOrders: [],
                    itemsByOrder: {},
                    keysByOrderItem: {},
                    keyDisplayTitle: '',
                    keyDisplayMessage: '',
                    needsPasswordVerification: true
                });
            }

            const userId = getUserId(req);
            const allOrdersResult = await pool.query(
                'SELECT * FROM orders WHERE user_id = $1 AND (user_deleted_at IS NULL) ORDER BY id DESC',
                [userId]
            );
            const allOrders = allOrdersResult.rows;

            const pendingOrders = allOrders.filter(o => o.status === 'pending');
            const completedOrders = allOrders.filter(o => ['paid', 'completed', 'cancelled', 'failed'].includes(o.status));

            const itemsByOrder = {};
            const keysByOrderItem = {};

            for (const o of allOrders) {
                const itemsResult = await pool.query(`
          SELECT oi.*, p.title, p.image
          FROM order_items oi
          JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1
          ORDER BY oi.id
        `, [o.id]);
                itemsByOrder[o.id] = itemsResult.rows;

                if (o.status === 'paid' || o.status === 'completed') {
                    for (const item of itemsByOrder[o.id]) {
                        const keysResult = await pool.query(
                            'SELECT key_value FROM order_keys WHERE order_item_id = $1 ORDER BY id',
                            [item.id]
                        );
                        if (keysResult.rows && keysResult.rows.length > 0) {
                            keysByOrderItem[item.id] = keysResult.rows.map(k => k.key_value);
                        }
                    }
                }
            }

            const keyDisplayTitle = await getSetting('key_display_title') || '🔑 Key của bạn';
            const keyDisplayMessage = await getSetting('key_display_message') || 'Key đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư spam nếu không thấy.';

            res.render('orders', {
                title: 'Lịch sử giao dịch - SafeKeyS',
                pendingOrders,
                completedOrders,
                itemsByOrder,
                keysByOrderItem,
                keyDisplayTitle,
                keyDisplayMessage,
                needsPasswordVerification: false
            });
        } catch (error) {
            logger.error('Error loading orders:', error);
            req.flash('error', 'Có lỗi xảy ra khi tải lịch sử giao dịch');
            res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
        }
    });

    // Password verification for viewing keys
    app.post('/orders/verify-password', requireAuth, async (req, res) => {
        try {
            const { password } = req.body;
            const userId = getUserId(req);
            const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
            if (userResult.rows.length === 0 || !userResult.rows[0].password_hash) {
                req.flash('error', 'Không tìm thấy tài khoản');
                return res.redirect('/orders');
            }
            const user = userResult.rows[0];
            if (bcrypt.compareSync(password, user.password_hash)) {
                req.session.ordersPasswordVerified = true;
                req.flash('success', 'Xác thực thành công');
                return res.redirect('/orders');
            } else {
                req.flash('error', 'Mật khẩu không đúng');
                return res.redirect('/orders');
            }
        } catch (error) {
            logger.error('Error verifying orders password:', error);
            req.flash('error', 'Có lỗi xảy ra khi xác thực');
            res.redirect('/orders');
        }
    });

    // Order keys page
    app.get('/orders/:orderId/keys', requireAuth, async (req, res) => {
        try {
            const orderId = parseInt(req.params.orderId, 10);
            if (isNaN(orderId)) return res.redirect('/orders');
            const userId = getUserId(req);
            const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (orderResult.rows.length === 0) return res.redirect('/orders');
            const order = orderResult.rows[0];
            const isAdmin = req.user && req.user.role === 'admin';
            if (order.user_id !== userId && !isAdmin) {
                req.flash('error', 'Bạn không có quyền xem giao dịch này');
                return res.redirect('/orders');
            }
            const itemsResult = await pool.query(`
        SELECT oi.*, p.title, p.image
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id
      `, [orderId]);
            const items = itemsResult.rows;
            const keysByOrderItem = {};
            for (const item of items) {
                const keysResult = await pool.query('SELECT key_value FROM order_keys WHERE order_item_id = $1 ORDER BY id', [item.id]);
                if (keysResult.rows && keysResult.rows.length > 0) keysByOrderItem[item.id] = keysResult.rows.map(k => k.key_value);
            }
            const keyDisplayTitle = await getSetting('key_display_title') || '🔑 Key của bạn';
            const keyDisplayMessage = await getSetting('key_display_message') || 'Key đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư spam nếu không thấy.';
            res.render('order-keys', { title: `Key giao dịch #${orderId} - SafeKeyS`, order, items, keysByOrderItem, keyDisplayTitle, keyDisplayMessage });
        } catch (error) {
            logger.error('Error loading order keys:', error);
            req.flash('error', 'Có lỗi xảy ra khi tải key giao dịch');
            res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
        }
    });

    // Cancel single order
    app.post('/orders/:orderId/cancel', requireAuth, async (req, res) => {
        try {
            const orderId = parseInt(req.params.orderId, 10);
            if (isNaN(orderId)) return res.redirect('/orders');
            const userId = getUserId(req);
            const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
            if (orderResult.rows.length === 0) {
                req.flash('error', 'Không tìm thấy đơn hàng hoặc bạn không có quyền hủy đơn hàng này');
                return res.redirect('/orders');
            }
            const order = orderResult.rows[0];
            if (order.status !== 'pending') {
                req.flash('error', 'Chỉ có thể hủy đơn hàng đang chờ thanh toán');
                return res.redirect('/orders');
            }
            await pool.query('UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', ['cancelled', orderId]);
            const itemsResult = await pool.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [orderId]);
            for (const item of itemsResult.rows) {
                await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
            }
            try { dataManager.updateItem('orders', orderId, { status: 'cancelled', updated_at: new Date().toISOString() }); } catch (e) { logger.error(e); }
            req.flash('success', 'Đã hủy đơn hàng thành công');
            res.redirect('/orders');
        } catch (error) {
            logger.error('Error canceling order:', error);
            req.flash('error', 'Có lỗi xảy ra khi hủy đơn hàng');
            res.redirect('/orders');
        }
    });

    // Soft-delete order
    app.post('/orders/:orderId/delete', requireAuth, async (req, res) => {
        try {
            const orderId = parseInt(req.params.orderId, 10);
            if (isNaN(orderId)) return res.redirect('/orders');
            const userId = getUserId(req);
            const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
            if (orderResult.rows.length === 0) {
                req.flash('error', 'Không tìm thấy đơn hàng hoặc bạn không có quyền xóa đơn hàng này');
                return res.redirect('/orders');
            }
            await pool.query('UPDATE orders SET user_deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [orderId]);
            try { dataManager.updateItem('orders', orderId, { user_deleted_at: new Date().toISOString() }); } catch (e) { logger.error(e); }
            req.flash('success', 'Đã xóa đơn hàng khỏi lịch sử');
            res.redirect('/orders');
        } catch (error) {
            logger.error('Error deleting order:', error);
            req.flash('error', 'Có lỗi xảy ra khi xóa đơn hàng');
            res.redirect('/orders');
        }
    });

    // Cancel all pending orders
    app.post('/orders/cancel-all', requireAuth, async (req, res) => {
        try {
            const userId = getUserId(req);
            const ordersResult = await pool.query('SELECT id FROM orders WHERE user_id = $1 AND status = $2 AND (user_deleted_at IS NULL)', [userId, 'pending']);
            if (ordersResult.rows.length === 0) { req.flash('info', 'Không có đơn hàng nào đang chờ thanh toán'); return res.redirect('/orders'); }
            const orderIds = ordersResult.rows.map(o => o.id);
            for (const orderId of orderIds) {
                await pool.query('UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', ['cancelled', orderId]);
                const itemsResult = await pool.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [orderId]);
                for (const item of itemsResult.rows) await pool.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
                try { dataManager.updateItem('orders', orderId, { status: 'cancelled', updated_at: new Date().toISOString() }); } catch (e) { logger.error(e); }
            }
            req.flash('success', `Đã hủy ${orderIds.length} đơn hàng đang chờ thanh toán`);
            res.redirect('/orders');
        } catch (error) {
            logger.error('Error canceling all orders:', error);
            req.flash('error', 'Có lỗi xảy ra khi hủy đơn hàng');
            res.redirect('/orders');
        }
    });

    // Continue payment for pending order
    app.get('/orders/:orderId/pay', requireAuth, async (req, res) => {
        try {
            const orderId = parseInt(req.params.orderId, 10);
            if (isNaN(orderId)) { req.flash('error', 'ID đơn hàng không hợp lệ'); return res.redirect('/orders'); }
            const userId = getUserId(req);
            const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
            if (orderResult.rows.length === 0) { req.flash('error', 'Không tìm thấy đơn hàng'); return res.redirect('/orders'); }
            const order = orderResult.rows[0];
            if (order.status !== 'pending') { req.flash('error', 'Đơn hàng này không thể thanh toán'); return res.redirect('/orders'); }
            const itemsResult = await pool.query(`SELECT oi.*, p.* FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`, [orderId]);
            const cart = await getCart(req);
            for (const item of itemsResult.rows) {
                const key = String(item.product_id);
                cart.items[key] = { product: { id: item.product_id, title: item.title, slug: item.slug, image: item.image, price_cents: item.price_cents, stock: item.stock }, qty: item.quantity };
            }
            cart.totalQty = Object.values(cart.items).reduce((sum, entry) => sum + entry.qty, 0);
            cart.totalCents = Object.values(cart.items).reduce((sum, entry) => sum + (entry.qty * entry.product.price_cents), 0);
            req.session.cart = cart; req.session.touch();
            if (req.session.user && req.session.user.id) await saveCartToDatabase(req.session.user.id, cart);
            await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
            res.redirect('/checkout');
        } catch (error) {
            logger.error('Error continuing payment:', error);
            req.flash('error', 'Có lỗi xảy ra khi tiếp tục thanh toán');
            res.redirect('/orders');
        }
    });
}

export default setupOrderRoutes;
