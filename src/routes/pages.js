import express from 'express';

const router = express.Router();

/**
 * Page routes - home, catalog, categories, product detail
 */

export function createExcerpt(content, maxLength = 200) {
    if (!content) return '';
    const text = content.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
    if (text.length <= maxLength) return text;
    const truncated = text.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 0 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
}

export function setupPageRoutes(app, { pool, db, getSetting, logger }) {
    // Home page
    app.get('/', async (req, res) => {
        try {
            const q = (req.query.q || '').trim();
            const sort = req.query.sort || 'newest';
            const category = req.query.category || '';
            const priceRange = req.query.price || '';

            const homepageSettings = {
                hero_title: await getSetting('homepage_hero_title', 'SafeKeyS'),
                hero_subtitle: await getSetting('homepage_hero_subtitle', 'Mua key phần mềm, game nhanh chóng - Uy tín - Nhanh gọn - Hỗ trợ 24/7'),
                hero_features: await getSetting('homepage_hero_features', 'Thanh toán an toàn•Giao key ngay lập tức•Bảo hành chính hãng'),
                carousel_title: await getSetting('homepage_carousel_title', 'Sản phẩm nổi bật'),
                carousel_subtitle: await getSetting('homepage_carousel_subtitle', 'Khám phá những sản phẩm hot nhất hiện nay')
            };

            const categoriesResult = await pool.query(`
        SELECT c.*, COUNT(p.id) as product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
        GROUP BY c.id
        ORDER BY c.name ASC
      `);
            const categories = categoriesResult.rows;

            const featuredProductsResult = await pool.query(`
        SELECT DISTINCT * FROM products 
        WHERE active = 1 AND featured = 1 
        ORDER BY id DESC 
        LIMIT 20
      `);
            const featuredProducts = featuredProductsResult.rows;

            let products = [];
            let whereConditions = ['active = 1'];
            let params = [];
            let paramIndex = 1;

            if (q) {
                whereConditions.push(`(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex + 1})`);
                params.push(`%${q}%`, `%${q}%`);
                paramIndex += 2;
            }

            if (category) {
                whereConditions.push(`category_id = (SELECT id FROM categories WHERE slug = $${paramIndex})`);
                params.push(category);
                paramIndex++;
            }

            if (priceRange) {
                const [min, max] = priceRange.split('-').map(Number);
                if (min !== undefined && max !== undefined) {
                    whereConditions.push(`price_cents BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
                    params.push(min * 100, max * 100);
                    paramIndex += 2;
                } else if (min !== undefined) {
                    whereConditions.push(`price_cents >= $${paramIndex}`);
                    params.push(min * 100);
                    paramIndex++;
                }
            }

            let orderBy = 'ORDER BY ';
            switch (sort) {
                case 'oldest':
                    orderBy += 'id ASC';
                    break;
                case 'price-low':
                    orderBy += 'price_cents ASC';
                    break;
                case 'price-high':
                    orderBy += 'price_cents DESC';
                    break;
                case 'name':
                    orderBy += 'title ASC';
                    break;
                case 'stock':
                    orderBy += 'stock DESC, id DESC';
                    break;
                case 'newest':
                default:
                    orderBy += 'id DESC';
                    break;
            }

            const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
            const limitClause = !q && !category && !priceRange ? 'LIMIT 12' : '';

            let query = `SELECT * FROM products ${whereClause} ${orderBy}`;
            if (limitClause) {
                query += ` ${limitClause}`;
            }

            const productsResult = params.length > 0
                ? await pool.query(query, params)
                : await pool.query(query);
            products = productsResult.rows;

            let latestNews = [];
            if (!q && !category && !priceRange) {
                try {
                    const newsResult = await pool.query(`
            SELECT id, title, slug, content, COALESCE(excerpt, '') as excerpt, created_at, thumbnail, COALESCE(author, '') as author 
            FROM news 
            WHERE published = 1 
            ORDER BY id DESC 
            LIMIT 6
          `);
                    latestNews = newsResult.rows.map(post => ({
                        ...post,
                        excerpt: (post.excerpt && post.excerpt.trim()) ? post.excerpt : createExcerpt(post.content || '', 150),
                        readingTime: Math.max(1, Math.round((post.content || '').split(/\s+/).filter(Boolean).length / 200)),
                        author: post.author && post.author.trim() ? post.author : null
                    }));
                } catch (newsError) {
                    console.error('⚠️ Lỗi khi lấy tin tức cho trang chủ:', newsError);
                    latestNews = [];
                }
            }

            const structuredData = {
                "@context": "https://schema.org",
                "@type": "WebSite",
                "name": "SafeKeyS",
                "url": req.protocol + "://" + req.get('host'),
                "description": "Cửa hàng chuyên cung cấp key bản quyền phần mềm, game và thẻ nạp uy tín",
                "potentialAction": {
                    "@type": "SearchAction",
                    "target": req.protocol + "://" + req.get('host') + "/?q={search_term_string}",
                    "query-input": "required name=search_term_string"
                }
            };

            res.render('home', {
                title: 'SafeKeyS',
                categories,
                products,
                featuredProducts: featuredProducts || [],
                latestNews,
                homepageSettings,
                q,
                sort,
                category,
                priceRange,
                structuredData,
                description: 'Cửa hàng chuyên cung cấp key bản quyền phần mềm, game và thẻ nạp uy tín, nhanh chóng. Giao hàng tự động trong 5 phút, hỗ trợ 24/7.',
                canonical: req.protocol + "://" + req.get('host') + req.originalUrl
            });
        } catch (error) {
            console.error('❌ Error in home route:', error);
            console.error('Error stack:', error.stack);
            req.flash('error', 'Có lỗi xảy ra khi tải trang chủ');
            res.status(500).render('500', {
                title: 'Lỗi Server - SafeKeyS',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // API: Filter products
    app.get('/api/products/filter', async (req, res) => {
        try {
            const q = (req.query.q || '').trim();
            const sort = req.query.sort || 'newest';
            const category = req.query.category || '';
            const priceRange = req.query.price || '';

            let products = [];
            let whereConditions = ['active=1'];
            let params = [];

            if (q) {
                whereConditions.push('(title LIKE ? OR description LIKE ?)');
                params.push(`%${q}%`, `%${q}%`);
            }

            if (category) {
                whereConditions.push('category_id = (SELECT id FROM categories WHERE slug = ?)');
                params.push(category);
            }

            if (priceRange) {
                const [min, max] = priceRange.split('-').map(Number);
                if (min !== undefined && max !== undefined) {
                    whereConditions.push('price_cents BETWEEN ? AND ?');
                    params.push(min * 100, max * 100);
                } else if (min !== undefined) {
                    whereConditions.push('price_cents >= ?');
                    params.push(min * 100);
                }
            }

            let orderBy = 'ORDER BY ';
            switch (sort) {
                case 'oldest':
                    orderBy += 'id ASC';
                    break;
                case 'price-low':
                    orderBy += 'price_cents ASC';
                    break;
                case 'price-high':
                    orderBy += 'price_cents DESC';
                    break;
                case 'name':
                    orderBy += 'title ASC';
                    break;
                case 'stock':
                    orderBy += 'stock DESC, id DESC';
                    break;
                case 'newest':
                default:
                    orderBy += 'id DESC';
                    break;
            }

            const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
            const limitClause = !q && !category && !priceRange ? 'LIMIT 12' : '';

            const query = `SELECT * FROM products ${whereClause} ${orderBy} ${limitClause}`;
            const stmt1 = db.prepare(query);
            products = await stmt1.all(...params);

            const csrfToken = res.locals.csrfToken || '';
            const isLoggedIn = req.session && req.session.user;

            let html = '';
            if (products.length === 0) {
                html = `
        <div class="no-products">
          <div class="no-products-icon">🔍</div>
          <h3>Không tìm thấy sản phẩm</h3>
          <p class="muted">Thử thay đổi bộ lọc hoặc tìm kiếm với từ khóa khác.</p>
        </div>
      `;
            } else {
                products.forEach(p => {
                    const priceVnd = (p.price_cents / 100).toLocaleString('vi-VN');
                    const stockBadge = p.stock > 0
                        ? `<span class="in-stock">✅ Còn hàng (${p.stock})</span>`
                        : '<span class="out-of-stock">❌ Hết hàng</span>';
                    const escapedTitle = (p.title || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    const escapedDesc = ((p.description || '').slice(0, 80)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

                    html += `
          <div class="product-card">
            <div class="product-image">
              <img src="${(p.image || '/img/placeholder.jpg').replace(/"/g, '&quot;')}" alt="${escapedTitle}" loading="lazy" decoding="async">
              <div class="product-overlay">
                <a href="/product/${p.slug}" class="btn quick-view">Xem chi tiết</a>
              </div>
            </div>
            <div class="product-info">
              <h3 class="product-title">
                <a href="/product/${p.slug}">${escapedTitle}</a>
              </h3>
              <p class="product-description">${escapedDesc}${(p.description && p.description.length > 80) ? '...' : ''}</p>
              <div class="product-stock">${stockBadge}</div>
              <div class="product-price">
                <span class="price">${priceVnd} VND</span>
              </div>
              <div class="product-actions">
                <button class="btn primary" onclick="addToCart(${p.id}, false, '${csrfToken}')" ${p.stock === 0 ? 'disabled' : ''}>
                  ${p.stock === 0 ? 'Hết hàng' : 'Thêm vào giỏ'}
                </button>
                ${isLoggedIn ? `
                  <form class="wishlist-form" onsubmit="event.preventDefault(); toggleWishlist(${p.id}, '${csrfToken}');">
                    <button type="submit" class="btn wishlist-btn" title="Thêm vào yêu thích">
                      <span>🤍</span>
                    </button>
                  </form>
                ` : ''}
              </div>
            </div>
          </div>
        `;
                });
            }

            res.json({
                success: true,
                html: html,
                count: products.length
            });
        } catch (error) {
            console.error('Error in filter API:', error);
            res.status(500).json({ success: false, message: 'Có lỗi xảy ra khi lọc sản phẩm' });
        }
    });

    // Category page
    app.get('/category/:slug', async (req, res) => {
        try {
            const stmt1 = db.prepare('SELECT * FROM categories WHERE slug = ?');
            const category = await stmt1.get(req.params.slug);
            if (!category) {
                req.flash('error', 'Danh mục không tồn tại');
                return res.status(404).render('404');
            }

            const stmt2 = db.prepare(`
        SELECT * FROM products 
        WHERE active=1 AND category_id=? 
        ORDER BY id DESC
      `);
            const products = await stmt2.all(category.id);

            res.render('category', {
                title: category.name + ' - SafeKeyS',
                category,
                products: products || []
            });
        } catch (error) {
            console.error('Error in category route:', error);
            req.flash('error', 'Có lỗi xảy ra khi tải danh mục');
            res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
        }
    });

    // Categories page
    app.get('/categories', async (req, res) => {
        try {
            const stmt = db.prepare(`
        SELECT c.*, COUNT(p.id) as product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
        GROUP BY c.id
        ORDER BY c.name ASC
      `);
            const categories = await stmt.all();
            res.render('categories', { title: 'Danh mục - SafeKeyS', categories });
        } catch (error) {
            console.error('Error in categories route:', error);
            req.flash('error', 'Có lỗi xảy ra khi tải danh mục');
            res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
        }
    });

    // Product detail page
    app.get('/product/:slug', async (req, res) => {
        try {
            const stmt1 = db.prepare('SELECT * FROM products WHERE slug=? AND active=1');
            const product = await stmt1.get(req.params.slug);
            if (!product) return res.status(404).render('404');

            let category = null;
            if (product.category_id) {
                const stmt2 = db.prepare('SELECT * FROM categories WHERE id=?');
                category = await stmt2.get(product.category_id);
            }

            const structuredData = {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": product.title,
                "description": product.description || '',
                "image": product.image || req.protocol + "://" + req.get('host') + "/img/placeholder.jpg",
                "offers": {
                    "@type": "Offer",
                    "price": (product.price_cents / 100).toFixed(2),
                    "priceCurrency": "VND",
                    "availability": product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
                }
            };

            res.render('product', {
                title: product.title + ' - SafeKeyS',
                product,
                category,
                structuredData,
                description: product.description || `Mua ${product.title} với giá tốt nhất tại SafeKeyS`,
                canonical: req.protocol + "://" + req.get('host') + req.originalUrl,
                ogUrl: req.protocol + "://" + req.get('host') + req.originalUrl,
                ogImage: product.image || req.protocol + "://" + req.get('host') + "/img/placeholder.jpg"
            });
        } catch (error) {
            console.error('Error in product route:', error);
            req.flash('error', 'Có lỗi xảy ra khi tải sản phẩm');
            res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
        }
    });
}

export default router;
