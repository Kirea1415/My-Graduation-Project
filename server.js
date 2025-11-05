import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import SQLiteStoreFactory from 'better-sqlite3-session-store';
import connectFlash from 'connect-flash';
import methodOverride from 'method-override';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import csrf from 'csurf';
import Database from 'better-sqlite3';
import fs from 'fs';
import layouts from 'express-ejs-layouts';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const VIEWS_PATH = path.join(__dirname, 'views');
const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, 'data');
const ICONS_PATH = path.join(PUBLIC_PATH, 'img', 'icons');
if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true });
if (!fs.existsSync(ICONS_PATH)) fs.mkdirSync(ICONS_PATH, { recursive: true });

// Ensure DB and tables exist
const db = new Database(path.join(DATA_PATH, 'safekeys.db'));
db.pragma('journal_mode = WAL');
// Performance optimizations
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 10000');
db.pragma('foreign_keys = ON');

// Create indexes for better query performance
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
  CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
  CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id);
  CREATE INDEX IF NOT EXISTS idx_wishlist_product ON wishlist(product_id);
  CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
`);

// Migrate existing users table to add new columns
// Must run BEFORE creating indexes on those columns
try {
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const columnNames = userColumns.map(c => c.name);

  if (!columnNames.includes('google_id')) {
    db.exec("ALTER TABLE users ADD COLUMN google_id TEXT");
    // Create unique index after adding column
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL");
    } catch (e) {
      // Index might already exist, ignore
    }
  }
  if (!columnNames.includes('avatar')) {
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
  }
  if (!columnNames.includes('phone')) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  }
  if (!columnNames.includes('address')) {
    db.exec("ALTER TABLE users ADD COLUMN address TEXT");
  }
  if (!columnNames.includes('updated_at')) {
    db.exec("ALTER TABLE users ADD COLUMN updated_at DATETIME");
    // Set default value for existing rows
    db.exec("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL");
  }
  // Make password_hash nullable - SQLite doesn't support ALTER COLUMN, handled in code
} catch (e) {
  console.error('Migration error:', e);
}

// Create index for google_id if column exists
try {
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const columnNames = userColumns.map(c => c.name);
  if (columnNames.includes('google_id')) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL");
  }
} catch (e) {
  // Ignore if index already exists
}

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    google_id TEXT UNIQUE,
    avatar TEXT,
    phone TEXT,
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL,
    image TEXT,
    category_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// Seed default users (admin & user) if not exists
try {
  const hasAdmin = db.prepare('SELECT 1 FROM users WHERE email = ?').get('admin@safekeys.local');
  const hasUser = db.prepare('SELECT 1 FROM users WHERE email = ?').get('user@safekeys.local');
  if (!hasAdmin || !hasUser) {
    const adminHash = bcrypt.hashSync('123456', 10);
    const userHash = bcrypt.hashSync('123456', 10);
    const insertUser = db.prepare('INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
    insertUser.run('Admin', 'admin@safekeys.local', adminHash, 'admin');
    insertUser.run('User', 'user@safekeys.local', userHash, 'customer');
  }
} catch (e) {
  // ignore seed error
}

// Add inventory column if missing
const productColumns = db.prepare("PRAGMA table_info(products)").all();
const hasStock = productColumns.some(c => c.name === 'stock');
if (!hasStock) {
  db.exec("ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 100");
}

// Add featured column if missing
const hasFeatured = productColumns.some(c => c.name === 'featured');
if (!hasFeatured) {
  try {
    db.exec("ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0");
    // Create index for featured products
    db.exec("CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured) WHERE featured = 1");
  } catch (e) {
    console.error('Error adding featured column:', e);
  }
}

// Add status column to orders if missing
const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
const hasStatus = orderColumns.some(c => c.name === 'status');
if (!hasStatus) {
  try {
    db.exec("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  } catch (e) {
    // Column might already exist, ignore
  }
}

// Seed data if empty
const categoryCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
if (categoryCount === 0) {
  const insertCategory = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)');
  const insertProduct = db.prepare(`INSERT INTO products (title, slug, description, price_cents, image, category_id, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    const categories = [
      ['Game Keys', 'game-keys'],
      ['Software Keys', 'software-keys'],
      ['Gift Cards', 'gift-cards']
    ];
    const catIds = categories.map(([name, slug]) => insertCategory.run(name, slug).lastInsertRowid);
    const products = [
      ['Windows 11 Pro Key', 'windows-11-pro-key', 'Product key bản quyền Windows 11 Pro.', 399000, '/img/placeholder.jpg', catIds[1], 50],
      ['Steam Wallet 200K', 'steam-wallet-200k', 'Nạp ví Steam 200.000 VND.', 210000, '/img/placeholder.jpg', catIds[2], 200],
      ['FIFA 24 (EA FC) Key', 'fifa-24-key', 'Key game EA FC 24.', 890000, '/img/placeholder.jpg', catIds[0], 30]
    ];
    products.forEach(p => insertProduct.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6]));
  });
  tx();
}

// Top-up sample products for display if too few
const productCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (productCount < 13) {
  const cats = db.prepare('SELECT id, slug FROM categories ORDER BY id ASC').all();
  const catIdBySlug = Object.fromEntries(cats.map(c => [c.slug, c.id]));
  const insertProduct = db.prepare(`INSERT OR IGNORE INTO products (title, slug, description, price_cents, image, category_id, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const more = [
    ['Kaspersky Internet Security 1y', 'kaspersky-is-1y', 'Key bản quyền Kaspersky Internet Security 1 năm.', 249000, '/img/placeholder.jpg', catIdBySlug['software-keys'] || null, 100],
    ['Office 2021 Professional Plus', 'office-2021-pro-plus', 'Key bản quyền Microsoft Office 2021 Pro Plus.', 590000, '/img/placeholder.jpg', catIdBySlug['software-keys'] || null, 80],
    ['Windows 10 Pro Key', 'windows-10-pro-key', 'Key bản quyền Windows 10 Pro.', 290000, '/img/placeholder.jpg', catIdBySlug['software-keys'] || null, 120],
    ['Steam Wallet 500K', 'steam-wallet-500k', 'Nạp ví Steam 500.000 VND.', 520000, '/img/placeholder.jpg', catIdBySlug['gift-cards'] || null, 200],
    ['Steam Wallet 1000K', 'steam-wallet-1000k', 'Nạp ví Steam 1.000.000 VND.', 1020000, '/img/placeholder.jpg', catIdBySlug['gift-cards'] || null, 150],
    ['Google Play Gift Card $10', 'google-play-10', 'Thẻ Google Play trị giá $10.', 260000, '/img/placeholder.jpg', catIdBySlug['gift-cards'] || null, 90],
    ['EA FC 24 Points 1600', 'ea-fc-24-points-1600', 'Gói 1600 FC Points cho EA FC 24.', 399000, '/img/placeholder.jpg', catIdBySlug['game-keys'] || null, 60],
    ['Minecraft Java Edition Key', 'minecraft-java-key', 'Key bản quyền Minecraft Java Edition.', 690000, '/img/placeholder.jpg', catIdBySlug['game-keys'] || null, 40],
    ['Ubisoft Wallet €20', 'ubisoft-wallet-20-eur', 'Nạp ví Ubisoft €20.', 560000, '/img/placeholder.jpg', catIdBySlug['gift-cards'] || null, 70],
    ['Spotify Premium 3 tháng', 'spotify-premium-3m', 'Gói Spotify Premium thời hạn 3 tháng.', 159000, '/img/placeholder.jpg', catIdBySlug['gift-cards'] || null, 130]
  ];
  const txMore = db.transaction(() => { more.forEach(p => insertProduct.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6])); });
  txMore();
}

// Normalize legacy image paths to placeholder to avoid 404s
db.exec(`
  UPDATE products SET image='/img/placeholder.jpg'
  WHERE image IN ('/img/win11.jpg','/img/steam.jpg','/img/fifa24.jpg');
`);

const app = express();

// Settings table for editable pages & social links
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Wishlist table
db.exec(`
  CREATE TABLE IF NOT EXISTS wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
    UNIQUE(user_id, product_id)
  );
`);
function getSetting(key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (row && row.value !== null && row.value !== undefined) {
      return String(row.value).trim();
    }
    return String(def).trim();
  } catch (error) {
    console.error(`Error getting setting ${key}:`, error);
    return String(def).trim();
  }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function formatPageContentToHtml(content) {
  const raw = (content || '').toString();
  if (!raw.trim()) return '';
  const hasHtmlTag = /<[^>]+>/.test(raw);
  if (hasHtmlTag) return raw;
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

// Seed default static page content and social/icon settings if empty
try {
  const defaults = {
    page_about: 'SafeKeyS là cửa hàng cung cấp key phần mềm, game và thẻ nạp chính hãng.\nChúng tôi cam kết: giao hàng nhanh, hỗ trợ tận tâm, hoàn tiền nếu sản phẩm lỗi.\nTầm nhìn: mang lại trải nghiệm mua sắm bản quyền dễ dàng và minh bạch.',
    page_policy: 'Chính sách đổi trả:\n- Key số: không đổi trả sau khi kích hoạt thành công.\n- Nếu key lỗi/không kích hoạt: hoàn tiền hoặc đổi key khác.\n\nBảo mật:\n- Bảo vệ dữ liệu khách hàng theo quy định pháp luật.\n\nLiên hệ hỗ trợ khi cần thiết.',
    page_payment: 'Phương thức thanh toán:\n- Ví điện tử (mô phỏng).\n- Chuyển khoản ngân hàng: ghi nội dung SafeKeyS + mã đơn.\n- Thẻ ngân hàng (sẽ tích hợp khi triển khai thật).',
    page_contact: 'Hỗ trợ khách hàng:\nEmail: support@safekeys.local\nHotline: 0123 456 789\nThời gian: 8:00 - 22:00 hằng ngày.',
    social_facebook: '',
    social_zalo: '',
    social_youtube: '',
    social_facebook_icon: '/img/icon-fb.png',
    social_zalo_icon: '/img/icon-zalo.png',
    social_youtube_icon: '/img/icon-yt.png'
  };
  Object.entries(defaults).forEach(([k, v]) => {
    if (!getSetting(k)) setSetting(k, v);
  });
} catch { }

// Security & performance middlewares
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6
}));
app.use(morgan('dev'));

// Rate limiting middleware (simple)
// Disabled or very relaxed in development mode
const isDevelopment = process.env.NODE_ENV !== 'production';
const rateLimitMap = new Map();
const RATE_LIMIT = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: isDevelopment ? 10000 : 100 // Very high limit in dev, normal in production
};

function rateLimit(req, res, next) {
  // Skip rate limiting for localhost/127.0.0.1 in development
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const ipStr = String(ip).toLowerCase();
  const isLocalhost = ipStr.includes('127.0.0.1') ||
    ipStr.includes('::1') ||
    ipStr.includes('localhost') ||
    ipStr.includes('::ffff:127.0.0.1') ||
    ipStr === ''; // Empty IP means localhost

  // Always skip rate limiting for localhost in development
  if (isDevelopment && isLocalhost) {
    return next(); // Skip rate limiting for localhost in development
  }

  // Also skip if no IP detected (likely localhost)
  if (isDevelopment && !ip) {
    return next();
  }

  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT.windowMs });
    return next();
  }

  const limit = rateLimitMap.get(ip);

  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT.windowMs;
    return next();
  }

  if (limit.count >= RATE_LIMIT.maxRequests) {
    return res.status(429).send('Quá nhiều requests. Vui lòng thử lại sau.');
  }

  limit.count++;
  next();
}

// Apply rate limiting (will skip localhost in development automatically)
app.use(rateLimit);

// Cleanup rate limit map every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimitMap.entries()) {
    if (now > limit.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 60 * 60 * 1000);

// Passport configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
  },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists by Google ID
        let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);

        if (user) {
          // Update user info if needed
          db.prepare(`
          UPDATE users 
          SET name = ?, avatar = ?, email = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE google_id = ?
        `).run(profile.displayName, profile.photos?.[0]?.value || null, profile.emails?.[0]?.value, profile.id);
          user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
          return done(null, user);
        }

        // Check if user exists by email
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.emails?.[0]?.value);

        if (user) {
          // Link Google account to existing user
          db.prepare('UPDATE users SET google_id = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(profile.id, profile.photos?.[0]?.value || null, user.id);
          user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
          return done(null, user);
        }

        // Create new user
        const result = db.prepare(`
        INSERT INTO users (email, name, google_id, avatar, role)
        VALUES (?, ?, ?, ?, 'customer')
      `).run(
          profile.emails?.[0]?.value,
          profile.displayName,
          profile.id,
          profile.photos?.[0]?.value || null
        );

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }));

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser((id, done) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user);
  });
} else {
  console.warn('⚠️  Google OAuth credentials not set. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.');
}

// Static & views
app.set('view engine', 'ejs');
app.set('views', VIEWS_PATH);
app.use(layouts);
app.set('layout', 'partials/layout');
app.use(express.static(PUBLIC_PATH));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, ICONS_PATH);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: social_facebook_icon_timestamp.extension
    const fieldName = file.fieldname || 'icon';
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '.png';
    const filename = `${fieldName}_${timestamp}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    // Accept only images
    const allowedTypes = /jpeg|jpg|png|gif|webp|svg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file ảnh (JPEG, PNG, GIF, WEBP, SVG)'));
    }
  }
});
app.use(methodOverride('_method'));

// Sessions - MUST be before passport
const SQLiteStore = SQLiteStoreFactory(session);
app.use(
  session({
    store: new SQLiteStore({
      client: db,
      expired: { clear: true, intervalMs: 900000 }
    }),
    secret: 'safekeys-secret-please-change',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
  })
);

// Passport - MUST be after session
app.use(passport.initialize());
app.use(passport.session());

app.use(connectFlash());

// CSRF - but skip for API routes and AJAX settings save
const csrfProtection = csrf();
app.use((req, res, next) => {
  // Skip CSRF for API routes and AJAX settings routes
  if (req.path.startsWith('/api/') || req.path === '/admin/settings/save') {
    return next();
  }
  csrfProtection(req, res, next);
});

// Locals - Must be after session and CSRF
// CRITICAL: This must run before any route handlers
app.use((req, res, next) => {
  // Always set currentUser first, even if null
  res.locals.currentUser = null;

  try {
    // Get user from session or passport
    const sessionUser = req.session?.user;
    const passportUser = req.user;
    res.locals.currentUser = sessionUser || passportUser || null;

    // Ensure it's never undefined
    if (typeof res.locals.currentUser === 'undefined') {
      res.locals.currentUser = null;
    }
  } catch (e) {
    // If any error, ensure currentUser is null
    res.locals.currentUser = null;
  }

  try {
    res.locals.csrfToken = req.csrfToken();
  } catch (e) {
    res.locals.csrfToken = '';
  }

  res.locals.flash = {
    success: req.flash('success') || [],
    error: req.flash('error') || []
  };
  res.locals.theme = { primary: '#16a34a' };

  // Add cart info to locals for header display
  if (req.session?.user || req.user) {
    try {
      const cart = getCart(req);
      res.locals.cart = {
        totalQty: cart.totalQty || 0,
        totalCents: cart.totalCents || 0,
        items: cart.items || {}
      };
    } catch (err) {
      console.error('Cart error:', err);
      res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
    }
  } else {
    res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
  }

  // expose settings used in footer icons - use getSetting() for consistency
  try {
    // Load social media list from JSON
    let socialMediaList = [];
    const socialMediaJson = getSetting('social_media_list', '');
    if (socialMediaJson) {
      try {
        socialMediaList = JSON.parse(socialMediaJson);
      } catch (e) {
        console.error('Error parsing social media list:', e);
      }
    }

    // Fallback to old format for migration
    if (socialMediaList.length === 0) {
      const fb = getSetting('social_facebook', '').trim();
      const zalo = getSetting('social_zalo', '').trim();
      const yt = getSetting('social_youtube', '').trim();
      if (fb || zalo || yt) {
        if (fb) socialMediaList.push({ name: 'Facebook', url: fb, icon: getSetting('social_facebook_icon', '').trim() });
        if (zalo) socialMediaList.push({ name: 'Zalo', url: zalo, icon: getSetting('social_zalo_icon', '').trim() });
        if (yt) socialMediaList.push({ name: 'YouTube', url: yt, icon: getSetting('social_youtube_icon', '').trim() });
      }
    }

    res.locals.settings = {
      social_media_list: socialMediaList
    };
  } catch (error) {
    console.error('Error loading settings for footer:', error);
    res.locals.settings = {
      social_media_list: []
    };
  }
  next();
});

// Helpers
function getUser(req) {
  return req.session?.user || req.user || null;
}

function getUserId(req) {
  const user = getUser(req);
  return user?.id || null;
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) {
    req.flash('error', 'Vui lòng đăng nhập để tiếp tục');
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  // Sync to session if using passport
  if (req.user && !req.session.user) {
    req.session.user = {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      avatar: req.user.avatar || null
    };
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = getUser(req);
  if (!user) {
    req.flash('error', 'Vui lòng đăng nhập');
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  if (user.role !== 'admin') {
    return res.status(403).render('403', {
      title: '403 - Truy cập bị từ chối - SafeKeyS'
    });
  }
  next();
}

// Home & catalog
app.get('/', (req, res) => {
  const categories = db.prepare(`
    SELECT c.*, COUNT(p.id) as product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
    GROUP BY c.id
    ORDER BY c.name ASC
  `).all();
  const q = (req.query.q || '').trim();
  const sort = req.query.sort || 'newest';
  const category = req.query.category || '';
  const priceRange = req.query.price || '';

  // Get homepage settings
  const homepageSettings = {
    hero_title: getSetting('homepage_hero_title', 'SafeKeyS'),
    hero_subtitle: getSetting('homepage_hero_subtitle', 'Mua key phần mềm, game nhanh chóng - Uy tín - Nhanh gọn - Hỗ trợ 24/7'),
    hero_features: getSetting('homepage_hero_features', 'Thanh toán an toàn•Giao key ngay lập tức•Bảo hành chính hãng'),
    carousel_title: getSetting('homepage_carousel_title', 'Sản phẩm nổi bật'),
    carousel_subtitle: getSetting('homepage_carousel_subtitle', 'Khám phá những sản phẩm hot nhất hiện nay')
  };

  // Get featured products for carousel - ensure unique products
  const featuredProducts = db.prepare(`
    SELECT DISTINCT * FROM products 
    WHERE active=1 AND featured=1 
    ORDER BY id DESC 
    LIMIT 20
  `).all();

  let products = [];
  let whereConditions = ['active=1'];
  let params = [];

  // Search query
  if (q) {
    whereConditions.push('(title LIKE ? OR description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  // Category filter
  if (category) {
    whereConditions.push('category_id = (SELECT id FROM categories WHERE slug = ?)');
    params.push(category);
  }

  // Price range filter
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

  // Build ORDER BY clause
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

  // Build final query
  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
  const limitClause = !q && !category && !priceRange ? 'LIMIT 12' : '';

  const query = `SELECT * FROM products ${whereClause} ${orderBy} ${limitClause}`;
  products = db.prepare(query).all(...params);

  // Generate structured data for SEO
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
    homepageSettings,
    q,
    sort,
    category,
    priceRange,
    structuredData,
    description: 'Cửa hàng chuyên cung cấp key bản quyền phần mềm, game và thẻ nạp uy tín, nhanh chóng. Giao hàng tự động trong 5 phút, hỗ trợ 24/7.',
    canonical: req.protocol + "://" + req.get('host') + req.originalUrl
  });
});

// API: Filter products (AJAX) - Skip CSRF for GET requests
app.get('/api/products/filter', (req, res) => {
  const q = (req.query.q || '').trim();
  const sort = req.query.sort || 'newest';
  const category = req.query.category || '';
  const priceRange = req.query.price || '';

  let products = [];
  let whereConditions = ['active=1'];
  let params = [];

  // Search query
  if (q) {
    whereConditions.push('(title LIKE ? OR description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  // Category filter
  if (category) {
    whereConditions.push('category_id = (SELECT id FROM categories WHERE slug = ?)');
    params.push(category);
  }

  // Price range filter
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

  // Build ORDER BY clause
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

  // Build final query
  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
  const limitClause = !q && !category && !priceRange ? 'LIMIT 12' : '';

  const query = `SELECT * FROM products ${whereClause} ${orderBy} ${limitClause}`;
  products = db.prepare(query).all(...params);

  // Get categories for product category names
  const categoriesMap = {};
  db.prepare('SELECT id, name FROM categories').all().forEach(cat => {
    categoriesMap[cat.id] = cat.name;
  });

  // Get CSRF token from res.locals (set by middleware)
  const csrfToken = res.locals.csrfToken || '';
  const isLoggedIn = req.session && req.session.user;

  // Render products HTML
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
});

app.get('/category/:slug', (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!category) {
    req.flash('error', 'Danh mục không tồn tại');
    return res.status(404).render('404');
  }

  const products = db.prepare(`
    SELECT * FROM products 
    WHERE active=1 AND category_id=? 
    ORDER BY id DESC
  `).all(category.id);

  res.render('category', {
    title: category.name + ' - SafeKeyS',
    category,
    products: products || []
  });
});

// Categories page
app.get('/categories', (req, res) => {
  const categories = db.prepare(`
    SELECT c.*, COUNT(p.id) as product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
    GROUP BY c.id
    ORDER BY c.name ASC
  `).all();
  res.render('categories', { title: 'Danh mục - SafeKeyS', categories });
});

app.get('/product/:slug', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE slug=? AND active=1').get(req.params.slug);
  if (!product) return res.status(404).render('404');

  // Get category if exists
  let category = null;
  if (product.category_id) {
    category = db.prepare('SELECT * FROM categories WHERE id=?').get(product.category_id);
  }

  // Generate structured data for product
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
});

// Auth

app.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Đăng ký - SafeKeyS' });
});

app.post('/register',
  body('name').isLength({ min: 2 }).withMessage('Tên tối thiểu 2 ký tự'),
  body('email').isEmail().normalizeEmail().withMessage('Email không hợp lệ'),
  body('password').isLength({ min: 6 }).withMessage('Mật khẩu tối thiểu 6 ký tự'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join('\n'));
      return res.redirect('/register');
    }
    const { name, email, password } = req.body;
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      req.flash('error', 'Email đã tồn tại');
      return res.redirect('/register');
    }
    const password_hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, password_hash, 'customer');
    req.session.user = { id: result.lastInsertRowid, name, email, role: 'customer' };
    req.flash('success', 'Đăng ký thành công');
    res.redirect('/');
  }
);

app.get('/login', (req, res) => {
  const hasGoogleAuth = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  res.render('auth/login', {
    title: 'Đăng nhập - SafeKeyS',
    hasGoogleAuth,
    redirect: req.query.redirect || '/'
  });
});

app.post('/login',
  body('email').isEmail().withMessage('Email không hợp lệ'),
  body('password').notEmpty().withMessage('Vui lòng nhập mật khẩu'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join('\n'));
      return res.redirect('/login');
    }
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      req.flash('error', 'Sai email hoặc mật khẩu');
      return res.redirect('/login');
    }
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.flash('success', 'Đăng nhập thành công');

    // Redirect to original page if exists
    const redirectTo = req.query.redirect || '/';
    res.redirect(redirectTo);
  }
);

// Google OAuth routes
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
  );

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?error=google_auth_failed' }),
    (req, res) => {
      // Successfully authenticated
      req.session.user = {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        avatar: req.user.avatar || null
      };
      const redirectTo = req.session.redirectTo || req.query.redirect || '/';
      delete req.session.redirectTo;
      req.flash('success', 'Đăng nhập bằng Google thành công!');
      res.redirect(redirectTo);
    }
  );
}

app.post('/logout', (req, res) => {
  // Logout passport if available
  if (req.logout) {
    req.logout((err) => {
      if (err) {
        console.error('Logout error:', err);
      }
      req.session.destroy(() => {
        res.redirect('/');
      });
    });
  } else {
    // Direct logout without passport
    req.session.destroy(() => {
      res.redirect('/');
    });
  }
});

// Cart
function getCart(req) {
  if (!req.session.cart) req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
  if (!req.session.cart.items) req.session.cart.items = {};
  if (typeof req.session.cart.totalQty !== 'number') req.session.cart.totalQty = 0;
  if (typeof req.session.cart.totalCents !== 'number') req.session.cart.totalCents = 0;
  return req.session.cart;
}

// AJAX endpoint for adding to cart
app.post('/api/cart/add/:productId', requireAuth, (req, res) => {
  // For API routes, we can skip CSRF since user is authenticated via requireAuth
  // Still validate session exists
  if (!req.session) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active=1').get(req.params.productId);
  if (!product) {
    return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
  }

  const availableStock = product.stock ?? 0;
  if (availableStock <= 0) {
    return res.json({ success: false, message: 'Sản phẩm đã hết hàng' });
  }

  const cart = getCart(req);
  const key = String(product.id);
  if (!cart.items[key]) cart.items[key] = { product, qty: 0 };

  // Respect stock: do not exceed available stock
  if (cart.items[key].qty + 1 > availableStock) {
    return res.json({ success: false, message: 'Sản phẩm đã hết hàng hoặc không đủ tồn kho' });
  }

  cart.items[key].qty += 1;
  cart.totalQty += 1;
  cart.totalCents += product.price_cents;

  return res.json({
    success: true,
    message: 'Đã thêm vào giỏ hàng',
    cart: {
      totalQty: cart.totalQty,
      totalCents: cart.totalCents
    }
  });
});

// Original route for buy_now (redirects to checkout)
app.post('/cart/add/:productId', requireAuth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active=1').get(req.params.productId);
  if (!product) {
    req.flash('error', 'Sản phẩm không tồn tại');
    return res.redirect('back');
  }

  const availableStock = product.stock ?? 0;
  if (availableStock <= 0) {
    req.flash('error', 'Sản phẩm đã hết hàng');
    return res.redirect('back');
  }

  const cart = getCart(req);
  const key = String(product.id);
  if (!cart.items[key]) cart.items[key] = { product, qty: 0 };

  // Respect stock: do not exceed available stock
  if (cart.items[key].qty + 1 > availableStock) {
    req.flash('error', 'Sản phẩm đã hết hàng hoặc không đủ tồn kho');
    return res.redirect('back');
  }

  cart.items[key].qty += 1;
  cart.totalQty += 1;
  cart.totalCents += product.price_cents;
  req.flash('success', 'Đã thêm vào giỏ hàng');

  // If buy_now parameter is set, redirect to checkout
  if (req.query.buy_now === '1') {
    return res.redirect('/checkout');
  }

  const referer = req.get('Referer') || '/';
  res.redirect(referer);
});

app.post('/cart/remove/:productId', requireAuth, (req, res) => {
  const cart = getCart(req);
  const key = String(req.params.productId);
  const entry = cart.items[key];
  if (entry) {
    cart.totalQty = Math.max(0, cart.totalQty - entry.qty);
    cart.totalCents = Math.max(0, cart.totalCents - (entry.qty * entry.product.price_cents));
    delete cart.items[key];
    req.flash('success', 'Đã xóa sản phẩm khỏi giỏ hàng');
  }
  const referer = req.get('Referer') || '/cart';
  res.redirect(referer.includes('/cart') ? referer : '/cart');
});

// Update quantity in cart
app.post('/cart/update/:productId', requireAuth, (req, res) => {
  const { quantity } = req.body;
  const newQty = Math.max(0, parseInt(quantity || '0', 10));
  const productId = req.params.productId;

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active=1').get(productId);
  if (!product) {
    req.flash('error', 'Sản phẩm không tồn tại');
    return res.redirect('/cart');
  }

  const cart = getCart(req);
  const key = String(productId);

  if (newQty === 0) {
    // Remove item if quantity is 0
    if (cart.items[key]) {
      cart.totalQty -= cart.items[key].qty;
      cart.totalCents -= cart.items[key].qty * cart.items[key].product.price_cents;
      delete cart.items[key];
      req.flash('success', 'Đã xóa sản phẩm khỏi giỏ hàng');
    }
  } else {
    // Check stock availability
    if (newQty > (product.stock ?? 0)) {
      req.flash('error', 'Không đủ tồn kho cho sản phẩm này');
      return res.redirect('/cart');
    }

    if (cart.items[key]) {
      // Update existing item - recalculate totals properly
      const oldQty = cart.items[key].qty;
      const oldTotal = oldQty * cart.items[key].product.price_cents;
      const newTotal = newQty * product.price_cents;

      cart.totalQty = cart.totalQty - oldQty + newQty;
      cart.totalCents = cart.totalCents - oldTotal + newTotal;
      cart.items[key].qty = newQty;
      cart.items[key].product = product; // Update product info
      req.flash('success', 'Đã cập nhật số lượng sản phẩm');
    } else {
      // Add new item
      cart.items[key] = { product, qty: newQty };
      cart.totalQty += newQty;
      cart.totalCents += newQty * product.price_cents;
      req.flash('success', 'Đã thêm sản phẩm vào giỏ hàng');
    }
  }

  res.redirect('/cart');
});

// AJAX wishlist toggle endpoint
app.post('/api/wishlist/toggle/:productId', requireAuth, (req, res) => {
  const productId = req.params.productId;
  const userId = getUserId(req);

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active=1').get(productId);
  if (!product) {
    return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
  }

  // Check if already in wishlist
  const existing = db.prepare('SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?').get(userId, productId);

  if (existing) {
    // Remove from wishlist
    db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?').run(userId, productId);
    return res.json({ success: true, message: 'Đã xóa khỏi danh sách yêu thích', action: 'removed' });
  } else {
    // Add to wishlist
    try {
      db.prepare('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)').run(userId, productId);
      return res.json({ success: true, message: 'Đã thêm vào danh sách yêu thích', action: 'added' });
    } catch (err) {
      return res.json({ success: false, message: 'Lỗi khi thêm vào danh sách yêu thích' });
    }
  }
});

// Original wishlist routes (for form submissions)
app.post('/wishlist/add/:productId', requireAuth, (req, res) => {
  const productId = req.params.productId;
  const userId = getUserId(req);

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active=1').get(productId);
  if (!product) {
    req.flash('error', 'Sản phẩm không tồn tại');
    return res.redirect('back');
  }

  try {
    db.prepare('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)').run(userId, productId);
    req.flash('success', 'Đã thêm vào danh sách yêu thích');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('info', 'Sản phẩm đã có trong danh sách yêu thích');
    } else {
      req.flash('error', 'Lỗi khi thêm vào danh sách yêu thích');
    }
  }

  res.redirect('back');
});

app.post('/wishlist/remove/:productId', requireAuth, (req, res) => {
  const productId = req.params.productId;
  const userId = getUserId(req);

  const result = db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?').run(userId, productId);

  if (result.changes > 0) {
    req.flash('success', 'Đã xóa khỏi danh sách yêu thích');
  } else {
    req.flash('info', 'Sản phẩm không có trong danh sách yêu thích');
  }

  res.redirect('back');
});

app.get('/wishlist', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const wishlistItems = db.prepare(`
    SELECT p.*, w.created_at as added_at
    FROM wishlist w
    JOIN products p ON w.product_id = p.id
    WHERE w.user_id = ? AND p.active = 1
    ORDER BY w.created_at DESC
  `).all(userId);

  res.render('wishlist', { title: 'Danh sách yêu thích - SafeKeyS', wishlistItems });
});

app.get('/cart', requireAuth, (req, res) => {
  const cart = getCart(req);

  // Recalculate cart totals to prevent inconsistencies
  let totalQty = 0;
  let totalCents = 0;

  // Validate and fix cart data
  for (const key in cart.items) {
    const item = cart.items[key];
    if (!item || !item.product) {
      delete cart.items[key];
      continue;
    }

    // Get fresh product data from database
    const fresh = db.prepare('SELECT stock, price_cents, title, slug, image FROM products WHERE id=? AND active=1').get(item.product.id);
    if (!fresh) {
      delete cart.items[key];
      continue;
    }

    // Update product data with fresh info
    item.product = {
      id: item.product.id,
      title: fresh.title,
      slug: fresh.slug,
      image: fresh.image,
      price_cents: fresh.price_cents,
      stock: fresh.stock
    };

    totalQty += item.qty;
    totalCents += item.qty * fresh.price_cents;
  }

  cart.totalQty = totalQty;
  cart.totalCents = totalCents;

  res.render('cart', { title: 'Giỏ hàng - SafeKeyS', cart });
});

// Checkout step 1: confirm
app.get('/checkout', requireAuth, (req, res) => {
  const cart = getCart(req);
  if (cart.totalQty === 0) {
    req.flash('error', 'Giỏ hàng trống');
    return res.redirect('/cart');
  }

  // Filter items based on selected_items from session
  const selectedItems = req.session.selectedItems || [];
  const filteredCart = {
    items: {},
    totalQty: 0,
    totalCents: 0
  };

  if (selectedItems.length > 0) {
    // Only include selected items
    selectedItems.forEach(productId => {
      const key = String(productId);
      if (cart.items[key]) {
        filteredCart.items[key] = cart.items[key];
        filteredCart.totalQty += cart.items[key].qty;
        filteredCart.totalCents += cart.items[key].qty * cart.items[key].product.price_cents;
      }
    });
  } else {
    // If no selection, use all items (backward compatibility)
    filteredCart.items = cart.items;
    filteredCart.totalQty = cart.totalQty;
    filteredCart.totalCents = cart.totalCents;
  }

  if (filteredCart.totalQty === 0) {
    req.flash('error', 'Vui lòng chọn ít nhất một sản phẩm để thanh toán');
    return res.redirect('/cart');
  }

  // Check stock availability for selected items
  const insufficient = [];
  Object.values(filteredCart.items).forEach(({ product, qty }) => {
    const fresh = db.prepare('SELECT stock FROM products WHERE id=?').get(product.id);
    if (!fresh || qty > (fresh.stock ?? 0)) insufficient.push(product.title);
  });

  res.render('checkout', { title: 'Xác nhận thanh toán - SafeKeyS', cart: filteredCart, insufficient });
});

// Fix POST /checkout - handle selected items from cart
app.post('/checkout', requireAuth, (req, res) => {
  const cart = getCart(req);
  const selectedItems = Array.isArray(req.body.selected_items)
    ? req.body.selected_items.map(id => String(id))
    : req.body.selected_items ? [String(req.body.selected_items)] : [];

  if (selectedItems.length === 0) {
    req.flash('error', 'Vui lòng chọn ít nhất một sản phẩm để thanh toán');
    return res.redirect('/cart');
  }

  // Store selected items in session for checkout
  req.session.selectedItems = selectedItems;
  res.redirect('/checkout');
});

// Checkout step 2: pay (mock) with stock deduction
app.post('/checkout/pay', requireAuth, (req, res) => {
  const cart = getCart(req);
  if (!cart || cart.totalQty === 0 || !cart.items || Object.keys(cart.items).length === 0) {
    req.flash('error', 'Giỏ hàng trống');
    return res.redirect('/cart');
  }

  // Get selected items from session
  const selectedItems = req.session.selectedItems || [];
  let itemsToProcess = {};
  let totalCents = 0;

  if (selectedItems.length > 0) {
    // Only process selected items
    selectedItems.forEach(productId => {
      const key = String(productId);
      if (cart.items[key]) {
        itemsToProcess[key] = cart.items[key];
        totalCents += cart.items[key].qty * cart.items[key].product.price_cents;
      }
    });
  } else {
    // If no selection, use all items (backward compatibility)
    itemsToProcess = cart.items;
    totalCents = cart.totalCents;
  }

  if (Object.keys(itemsToProcess).length === 0) {
    req.flash('error', 'Không có sản phẩm nào được chọn để thanh toán');
    return res.redirect('/cart');
  }

  // Verify stock before deduct
  const stockIssues = [];
  for (const entry of Object.values(itemsToProcess)) {
    if (!entry || !entry.product) {
      stockIssues.push('Sản phẩm không hợp lệ');
      continue;
    }

    const fresh = db.prepare('SELECT stock, title FROM products WHERE id=?').get(entry.product.id);
    if (!fresh) {
      stockIssues.push(`Sản phẩm "${entry.product.title || 'Unknown'}" không tồn tại`);
      continue;
    }

    if (entry.qty > (fresh.stock ?? 0)) {
      stockIssues.push(`Không đủ tồn kho cho: ${fresh.title}`);
    }
  }

  if (stockIssues.length > 0) {
    req.flash('error', stockIssues.join('; '));
    return res.redirect('/checkout');
  }

  try {
    const tx = db.transaction(() => {
      const orderRes = db.prepare('INSERT INTO orders (user_id, total_cents, status) VALUES (?, ?, ?)')
        .run(getUserId(req), totalCents, 'pending');
      const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price_cents) VALUES (?, ?, ?, ?)');
      const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');

      Object.values(itemsToProcess).forEach((entry) => {
        if (entry && entry.product && entry.qty) {
          insertItem.run(orderRes.lastInsertRowid, entry.product.id, entry.qty, entry.product.price_cents);
          decStock.run(entry.qty, entry.product.id);
        }
      });

      return orderRes.lastInsertRowid;
    });

    const orderId = tx();

    // Remove purchased items from cart
    selectedItems.forEach(productId => {
      const key = String(productId);
      if (cart.items[key]) {
        cart.totalQty -= cart.items[key].qty;
        cart.totalCents -= cart.items[key].qty * cart.items[key].product.price_cents;
        delete cart.items[key];
      }
    });

    // Clean up session
    delete req.session.selectedItems;

    req.flash('success', `Thanh toán thành công! Mã đơn: #${orderId}`);
    res.redirect('/orders');
  } catch (error) {
    console.error('Payment error:', error);
    req.flash('error', 'Có lỗi xảy ra khi thanh toán. Vui lòng thử lại.');
    res.redirect('/checkout');
  }
});

// Order history
// Profile routes
app.get('/profile', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    req.flash('error', 'Không tìm thấy thông tin người dùng');
    return res.redirect('/');
  }

  // Get statistics
  const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?').get(userId).count || 0;
  const wishlistCount = db.prepare('SELECT COUNT(*) as count FROM wishlist WHERE user_id = ?').get(userId).count || 0;

  res.render('profile', {
    title: 'Thông tin cá nhân - SafeKeyS',
    user,
    orderCount,
    wishlistCount
  });
});

app.post('/profile', requireAuth,
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Tên không được để trống và tối đa 100 ký tự'),
  body('phone').optional().matches(/^[0-9]{10,11}$/).withMessage('Số điện thoại phải có 10-11 chữ số'),
  body('new_password').optional().isLength({ min: 6 }).withMessage('Mật khẩu mới tối thiểu 6 ký tự'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/profile');
    }

    const { name, phone, address, current_password, new_password } = req.body;
    const userId = getUserId(req);

    try {
      // Get current user
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        req.flash('error', 'Không tìm thấy người dùng');
        return res.redirect('/profile');
      }

      // Update password if provided (only for non-Google users)
      if (!user.google_id && new_password && new_password.trim()) {
        if (!current_password) {
          req.flash('error', 'Vui lòng nhập mật khẩu hiện tại');
          return res.redirect('/profile');
        }

        if (!bcrypt.compareSync(current_password, user.password_hash)) {
          req.flash('error', 'Mật khẩu hiện tại không đúng');
          return res.redirect('/profile');
        }

        const newPasswordHash = bcrypt.hashSync(new_password, 10);
        db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(newPasswordHash, userId);
      }

      // Update profile info
      db.prepare(`
        UPDATE users 
        SET name = ?, phone = ?, address = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(
        name.trim(),
        phone ? phone.trim() : null,
        address ? address.trim() : null,
        userId
      );

      // Update session
      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      req.session.user = {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        avatar: updatedUser.avatar || null
      };

      req.flash('success', 'Đã cập nhật thông tin thành công');
      res.redirect('/profile');
    } catch (err) {
      console.error('Profile update error:', err);
      req.flash('error', 'Có lỗi xảy ra khi cập nhật thông tin');
      res.redirect('/profile');
    }
  }
);

app.get('/orders', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(userId);
  const itemsByOrder = {};
  const qItems = db.prepare(`SELECT oi.*, p.title FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?`);
  orders.forEach(o => {
    itemsByOrder[o.id] = qItems.all(o.id);
  });
  res.render('orders', { title: 'Đơn hàng của tôi - SafeKeyS', orders, itemsByOrder });
});

// User cancel order
app.post('/orders/:id/cancel', requireAuth, (req, res) => {
  const orderId = req.params.id;
  const userId = getUserId(req);
  const order = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(orderId, userId);

  if (!order) {
    req.flash('error', 'Đơn hàng không tồn tại');
    return res.redirect('/orders');
  }

  if (order.status === 'completed' || order.status === 'cancelled') {
    req.flash('error', 'Không thể hủy đơn hàng này');
    return res.redirect('/orders');
  }

  // Restore stock
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  const restoreStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
  items.forEach(item => {
    restoreStock.run(item.quantity, item.product_id);
  });

  // Update order status
  db.prepare('UPDATE orders SET status=? WHERE id=?').run('cancelled', orderId);

  req.flash('success', 'Đã hủy đơn hàng và hoàn trả tồn kho');
  res.redirect('/orders');
});

// Admin update order status
app.post('/admin/orders/:id/status', requireAdmin, (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body;

  const validStatuses = ['pending', 'processing', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    req.flash('error', 'Trạng thái không hợp lệ');
    return res.redirect('back');
  }

  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, orderId);
  req.flash('success', 'Đã cập nhật trạng thái đơn hàng');
  res.redirect('back');
});

// Admin delete order
app.post('/admin/orders/:id/delete', requireAdmin, (req, res) => {
  const orderId = req.params.id;

  // Restore stock if not cancelled
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (order && order.status !== 'cancelled') {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
    const restoreStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    items.forEach(item => {
      restoreStock.run(item.quantity, item.product_id);
    });
  }

  // Delete order items first (foreign key constraint)
  db.prepare('DELETE FROM order_items WHERE order_id=?').run(orderId);
  // Delete order
  db.prepare('DELETE FROM orders WHERE id=?').run(orderId);

  req.flash('success', 'Đã xóa đơn hàng');
  res.redirect('back');
});

// Admin minimal
app.get('/admin', requireAdmin, (req, res) => {
  const prodCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  const catCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const orderCount = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;

  // Calculate revenue
  const revenueRow = db.prepare('SELECT COALESCE(SUM(total_cents), 0) as total FROM orders').get();
  const totalRevenue = revenueRow ? revenueRow.total : 0;

  // Calculate stock
  const stockRow = db.prepare('SELECT COALESCE(SUM(stock), 0) as total FROM products').get();
  const totalStock = stockRow ? stockRow.total : 0;

  // Out of stock count
  const outOfStockCount = db.prepare('SELECT COUNT(*) as c FROM products WHERE stock = 0').get().c;

  // In stock count
  const inStockCount = db.prepare('SELECT COUNT(*) as c FROM products WHERE stock > 0').get().c;

  // Today's orders
  const today = new Date().toISOString().split('T')[0];
  const todayOrdersCount = db.prepare('SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = ?').get(today).c;

  // New users (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const newUsersCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at >= ?').get(sevenDaysAgo.toISOString()).c;

  res.render('admin/dashboard', {
    title: 'Admin - SafeKeyS',
    prodCount,
    catCount,
    userCount,
    orderCount,
    totalRevenue: Math.floor(totalRevenue / 100), // Convert cents to VND
    totalStock,
    outOfStockCount,
    inStockCount,
    todayOrdersCount,
    newUsersCount
  });
});

// Admin settings: pages + social links
app.get('/admin/settings', requireAdmin, (req, res) => {
  try {
    // Load social media list (JSON) or migrate from old format
    let socialMediaList = [];
    const socialMediaJson = getSetting('social_media_list', '');
    if (socialMediaJson) {
      try {
        socialMediaList = JSON.parse(socialMediaJson);
      } catch (e) {
        console.error('Error parsing social media list:', e);
      }
    }

    // Migrate old format if exists and list is empty
    if (socialMediaList.length === 0) {
      const fb = getSetting('social_facebook', '');
      const zalo = getSetting('social_zalo', '');
      const yt = getSetting('social_youtube', '');
      if (fb || zalo || yt) {
        if (fb) socialMediaList.push({ name: 'Facebook', url: fb, icon: getSetting('social_facebook_icon', '') });
        if (zalo) socialMediaList.push({ name: 'Zalo', url: zalo, icon: getSetting('social_zalo_icon', '') });
        if (yt) socialMediaList.push({ name: 'YouTube', url: yt, icon: getSetting('social_youtube_icon', '') });
      }
    }

    // Always load fresh settings from database
    const settings = {
      page_about: getSetting('page_about', ''),
      page_policy: getSetting('page_policy', ''),
      page_payment: getSetting('page_payment', ''),
      page_contact: getSetting('page_contact', ''),
      social_media_list: socialMediaList,
      homepage_hero_title: getSetting('homepage_hero_title', 'SafeKeyS'),
      homepage_hero_subtitle: getSetting('homepage_hero_subtitle', 'Mua key phần mềm, game nhanh chóng - Uy tín - Nhanh gọn - Hỗ trợ 24/7'),
      homepage_hero_features: getSetting('homepage_hero_features', 'Thanh toán an toàn•Giao key ngay lập tức•Bảo hành chính hãng'),
      homepage_carousel_title: getSetting('homepage_carousel_title', 'Sản phẩm nổi bật'),
      homepage_carousel_subtitle: getSetting('homepage_carousel_subtitle', 'Khám phá những sản phẩm hot nhất hiện nay')
    };

    console.log('Loading settings for admin:', {
      social_facebook: settings.social_facebook ? '✓' : '✗',
      social_facebook_icon: settings.social_facebook_icon ? '✓' : '✗',
      social_zalo: settings.social_zalo ? '✓' : '✗',
      social_zalo_icon: settings.social_zalo_icon ? '✓' : '✗',
      social_youtube: settings.social_youtube ? '✓' : '✗',
      social_youtube_icon: settings.social_youtube_icon ? '✓' : '✗',
      homepage_hero_title: settings.homepage_hero_title,
    });

    res.render('admin/settings', { title: 'Cài đặt trang', settings });
  } catch (error) {
    console.error('Error loading settings:', error);
    req.flash('error', 'Lỗi khi tải cài đặt: ' + error.message);
    res.redirect('/admin');
  }
});

// Save settings by section (AJAX)
app.post('/admin/settings/save', requireAdmin, upload.any(), (req, res) => {
  try {
    const section = req.body.section;

    if (section === 'social') {
      // Parse social media items from JSON
      let socialItems = [];
      try {
        const socialData = req.body.social_media_data;
        if (socialData && typeof socialData === 'string') {
          socialItems = JSON.parse(socialData);
        } else if (Array.isArray(socialData)) {
          socialItems = socialData;
        }
      } catch (e) {
        console.error('Error parsing social media data:', e);
      }

      // Handle uploaded icon files - map to item indices
      const uploadedIcons = {};
      if (req.files) {
        Object.keys(req.files).forEach(key => {
          const match = key.match(/social_icon_file_(\d+)/);
          if (match && req.files[key] && req.files[key][0]) {
            const index = parseInt(match[1]);
            const file = req.files[key][0];
            const filePath = `/img/icons/${file.filename}`;
            uploadedIcons[index] = filePath;
            console.log(`Icon uploaded for item ${index}: ${filePath}`);
          }
        });
      }

      // Update icons for items
      socialItems = socialItems.map((item, index) => {
        if (uploadedIcons[index]) {
          item.icon = uploadedIcons[index];
        }
        // Validate URL
        if (item.url && !item.url.match(/^https?:\/\//)) {
          throw new Error(`URL không hợp lệ cho "${item.name}". URL phải bắt đầu bằng http:// hoặc https://`);
        }
        return item;
      });

      // Save as JSON
      setSetting('social_media_list', JSON.stringify(socialItems));

      return res.json({ success: true, message: 'Đã lưu mạng xã hội thành công!' });
    }

    if (section === 'homepage') {
      // Validate required fields
      const requiredFields = ['homepage_hero_title', 'homepage_hero_subtitle', 'homepage_hero_features', 'homepage_carousel_title', 'homepage_carousel_subtitle'];
      const missingFields = requiredFields.filter(field => !req.body[field] || !req.body[field].trim());

      if (missingFields.length > 0) {
        return res.json({ success: false, message: 'Vui lòng điền đầy đủ các trường bắt buộc' });
      }

      // Save homepage settings
      const homepageFields = ['homepage_hero_title', 'homepage_hero_subtitle', 'homepage_hero_features', 'homepage_carousel_title', 'homepage_carousel_subtitle'];
      homepageFields.forEach(k => {
        const value = (req.body[k] || '').trim();
        setSetting(k, value);
      });

      return res.json({ success: true, message: 'Đã lưu nội dung trang chủ thành công!' });
    }

    if (section === 'pages') {
      // Validate required fields
      const requiredFields = ['page_about', 'page_policy', 'page_payment', 'page_contact'];
      const missingFields = requiredFields.filter(field => !req.body[field] || !req.body[field].trim());

      if (missingFields.length > 0) {
        return res.json({ success: false, message: 'Vui lòng điền đầy đủ các trường bắt buộc' });
      }

      // Save page content
      const pageFields = ['page_about', 'page_policy', 'page_payment', 'page_contact'];
      pageFields.forEach(k => {
        const value = (req.body[k] || '').trim();
        setSetting(k, value);
      });

      return res.json({ success: true, message: 'Đã lưu nội dung trang thành công!' });
    }

    return res.json({ success: false, message: 'Section không hợp lệ' });
  } catch (error) {
    console.error('Error saving settings:', error);

    // Clean up uploaded files on error
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        if (Array.isArray(fileArray)) {
          fileArray.forEach(file => {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          });
        }
      });
    }

    return res.json({ success: false, message: 'Lỗi khi lưu cài đặt: ' + error.message });
  }
});

// Legacy route (keep for compatibility)
app.post('/admin/settings', requireAdmin, upload.fields([
  { name: 'social_facebook_icon_file', maxCount: 1 },
  { name: 'social_zalo_icon_file', maxCount: 1 },
  { name: 'social_youtube_icon_file', maxCount: 1 }
]), (req, res) => {
  try {
    // Validate required fields
    const requiredFields = ['page_about', 'page_policy', 'page_payment', 'page_contact', 'homepage_hero_title', 'homepage_hero_subtitle', 'homepage_hero_features', 'homepage_carousel_title', 'homepage_carousel_subtitle'];
    const missingFields = requiredFields.filter(field => !req.body[field] || !req.body[field].trim());

    if (missingFields.length > 0) {
      req.flash('error', 'Vui lòng điền đầy đủ các trường bắt buộc');
      return res.redirect('/admin/settings');
    }

    // Handle uploaded icon files
    const iconFields = {
      'social_facebook_icon': req.files && req.files['social_facebook_icon_file'] ? req.files['social_facebook_icon_file'][0] : null,
      'social_zalo_icon': req.files && req.files['social_zalo_icon_file'] ? req.files['social_zalo_icon_file'][0] : null,
      'social_youtube_icon': req.files && req.files['social_youtube_icon_file'] ? req.files['social_youtube_icon_file'][0] : null
    };

    // Validate social media URLs if provided
    const urlFields = ['social_facebook', 'social_zalo', 'social_youtube'];
    for (const field of urlFields) {
      const value = (req.body[field] || '').trim();
      if (value && !value.match(/^https?:\/\/.+/)) {
        req.flash('error', `URL không hợp lệ cho ${field}. URL phải bắt đầu bằng http:// hoặc https://`);
        return res.redirect('/admin/settings');
      }
    }

    // Handle icon files (only file upload, no URL input)
    const iconSettings = {};
    for (const [key, file] of Object.entries(iconFields)) {
      if (file) {
        // File was uploaded, save the path
        const filePath = `/img/icons/${file.filename}`;
        iconSettings[key] = filePath;
        console.log(`Icon uploaded for ${key}: ${filePath}`);
      } else {
        // No file uploaded, keep existing value
        const existing = getSetting(key, '');
        iconSettings[key] = existing;
      }
    }

    // Save settings
    const fields = ['page_about', 'page_policy', 'page_payment', 'page_contact', 'social_facebook', 'social_zalo', 'social_youtube', 'homepage_hero_title', 'homepage_hero_subtitle', 'homepage_hero_features', 'homepage_carousel_title', 'homepage_carousel_subtitle'];
    const savedSettings = {};
    fields.forEach(k => {
      const value = (req.body[k] || '').trim();
      try {
        setSetting(k, value);
        savedSettings[k] = value;
      } catch (err) {
        console.error(`Error saving setting ${k}:`, err);
      }
    });

    // Save icon settings
    Object.keys(iconSettings).forEach(k => {
      try {
        setSetting(k, iconSettings[k]);
        savedSettings[k] = iconSettings[k];
      } catch (err) {
        console.error(`Error saving icon setting ${k}:`, err);
      }
    });

    console.log('Settings saved successfully:', Object.keys(savedSettings).length, 'fields');
    console.log('Social media settings:', {
      fb: savedSettings.social_facebook ? '✓' : '✗',
      fbIcon: savedSettings.social_facebook_icon ? '✓' : '✗',
      zalo: savedSettings.social_zalo ? '✓' : '✗',
      zaloIcon: savedSettings.social_zalo_icon ? '✓' : '✗',
      yt: savedSettings.social_youtube ? '✓' : '✗',
      ytIcon: savedSettings.social_youtube_icon ? '✓' : '✗'
    });

    req.flash('success', 'Đã lưu cài đặt thành công! Các thay đổi đã được áp dụng.');
    res.redirect('/admin/settings');
  } catch (error) {
    console.error('Error saving settings:', error);

    // Clean up uploaded files on error
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        if (Array.isArray(fileArray)) {
          fileArray.forEach(file => {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          });
        }
      });
    }

    req.flash('error', 'Lỗi khi lưu cài đặt: ' + error.message);
    res.redirect('/admin/settings');
  }
});

// Disable Products & Categories admin sections
// (removed) Previously disabled per request

app.get('/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare(`SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.id DESC`).all();
  const categories = db.prepare('SELECT * FROM categories').all();
  res.render('admin/products', { title: 'Quản lý sản phẩm', products, categories });
});

app.post('/admin/products', requireAdmin,
  body('title').trim().isLength({ min: 1, max: 255 }).withMessage('Tiêu đề không được để trống và tối đa 255 ký tự'),
  body('slug').trim().matches(/^[a-z0-9-]+$/).withMessage('Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  body('price_cents').isInt({ min: 0 }).withMessage('Giá phải là số nguyên dương'),
  body('stock').optional().isInt({ min: 0 }).withMessage('Tồn kho phải là số nguyên dương'),
  body('image').optional().isURL().withMessage('URL ảnh không hợp lệ'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/admin/products');
    }

    const { title, slug, description, price_cents, image, category_id, stock } = req.body;

    // Check slug uniqueness
    const existingSlug = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug);
    if (existingSlug) {
      req.flash('error', 'Slug đã tồn tại, vui lòng chọn slug khác');
      return res.redirect('/admin/products');
    }

    try {
      db.prepare('INSERT INTO products (title, slug, description, price_cents, image, category_id, active, stock) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
        .run(
          title.trim(),
          slug.trim(),
          description ? description.trim() : null,
          Math.max(0, Number(price_cents || 0)),
          image ? image.trim() : null,
          category_id ? Number(category_id) : null,
          Math.max(0, parseInt(String(stock || 0), 10))
        );
      req.flash('success', 'Đã thêm sản phẩm thành công');
    } catch (err) {
      console.error('Product creation error:', err);
      req.flash('error', 'Có lỗi xảy ra khi thêm sản phẩm');
    }
    res.redirect('/admin/products');
  }
);

// Admin edit product
app.get('/admin/products/:id/edit', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!product) return res.status(404).render('404');
  const categories = db.prepare('SELECT * FROM categories').all();
  res.render('admin/product_edit', { title: 'Sửa sản phẩm', product, categories });
});

app.post('/admin/products/:id/edit', requireAdmin,
  body('title').trim().isLength({ min: 1, max: 255 }).withMessage('Tiêu đề không được để trống và tối đa 255 ký tự'),
  body('slug').trim().matches(/^[a-z0-9-]+$/).withMessage('Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  body('price_cents').isInt({ min: 0 }).withMessage('Giá phải là số nguyên dương'),
  body('stock').optional().isInt({ min: 0 }).withMessage('Tồn kho phải là số nguyên dương'),
  body('image').optional().isURL().withMessage('URL ảnh không hợp lệ'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect(`/admin/products/${req.params.id}/edit`);
    }

    const { title, slug, description, price_cents, image, category_id, stock, active } = req.body;
    const id = Number(req.params.id);
    const price = Math.max(0, Number(price_cents || 0));
    const stockNum = Math.max(0, parseInt(String(stock || 0), 10));
    const act = active === '1' ? 1 : 0;

    if (!title || !slug) {
      req.flash('error', 'Thiếu tiêu đề hoặc slug');
      return res.redirect(`/admin/products/${id}/edit`);
    }

    const conflict = db.prepare('SELECT id FROM products WHERE slug=? AND id<>?').get(slug, id);
    if (conflict) {
      req.flash('error', 'Slug đã tồn tại, vui lòng chọn slug khác');
      return res.redirect(`/admin/products/${id}/edit`);
    }
    try {
      const featured = req.body.featured === '1' ? 1 : 0;
      db.prepare('UPDATE products SET title=?, slug=?, description=?, price_cents=?, image=?, category_id=?, stock=?, active=?, featured=? WHERE id=?')
        .run(title, slug, description, price, image, category_id ? Number(category_id) : null, stockNum, act, featured, id);
      req.flash('success', 'Đã lưu sản phẩm');
    } catch (e) {
      req.flash('error', 'Lỗi lưu sản phẩm');
      return res.redirect(`/admin/products/${id}/edit`);
    }
    res.redirect('/admin/products');
  });

app.post('/admin/products/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.redirect('/admin/products');
});

app.post('/admin/products/:id/toggle', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT active FROM products WHERE id=?').get(req.params.id);
  if (p) db.prepare('UPDATE products SET active=? WHERE id=?').run(p.active ? 0 : 1, req.params.id);
  res.redirect('/admin/products');
});

// Toggle featured product (legacy redirect)
app.post('/admin/products/:id/toggle-featured', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT featured FROM products WHERE id=?').get(req.params.id);
  if (p) {
    const newFeatured = p.featured ? 0 : 1;
    db.prepare('UPDATE products SET featured=? WHERE id=?').run(newFeatured, req.params.id);
    req.flash('success', newFeatured ? 'Đã đánh dấu sản phẩm nổi bật' : 'Đã bỏ đánh dấu sản phẩm nổi bật');
  }
  res.redirect('/admin/products');
});

// AJAX API endpoints for admin products
app.post('/api/admin/products/:id/toggle-featured', requireAdmin, (req, res) => {
  const productId = req.params.id;
  const p = db.prepare('SELECT featured FROM products WHERE id=?').get(productId);
  if (!p) {
    return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
  }

  const newFeatured = p.featured ? 0 : 1;
  db.prepare('UPDATE products SET featured=? WHERE id=?').run(newFeatured, productId);

  res.json({
    success: true,
    message: newFeatured ? 'Đã đánh dấu sản phẩm nổi bật' : 'Đã bỏ đánh dấu sản phẩm nổi bật',
    featured: newFeatured
  });
});

app.post('/api/admin/products/:id/toggle', requireAdmin, (req, res) => {
  const productId = req.params.id;
  const p = db.prepare('SELECT active FROM products WHERE id=?').get(productId);
  if (!p) {
    return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
  }

  const newActive = p.active ? 0 : 1;
  db.prepare('UPDATE products SET active=? WHERE id=?').run(newActive, productId);

  res.json({
    success: true,
    message: newActive ? 'Đã hiển thị sản phẩm' : 'Đã ẩn sản phẩm',
    active: newActive
  });
});

app.post('/api/admin/products/:id/delete', requireAdmin, (req, res) => {
  const productId = req.params.id;
  const p = db.prepare('SELECT id FROM products WHERE id=?').get(productId);
  if (!p) {
    return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
  }

  try {
    db.prepare('DELETE FROM products WHERE id=?').run(productId);
    res.json({
      success: true,
      message: 'Đã xóa sản phẩm'
    });
  } catch (err) {
    res.json({ success: false, message: 'Lỗi khi xóa sản phẩm' });
  }
});

app.get('/admin/categories', requireAdmin, (req, res) => {
  const categories = db.prepare(`
    SELECT c.*, 
           (SELECT COUNT(*) FROM products WHERE category_id = c.id AND active = 1) as product_count
    FROM categories c
    ORDER BY c.id DESC
  `).all();
  res.render('admin/categories', { title: 'Quản lý danh mục', categories });
});

app.post('/admin/categories', requireAdmin,
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Tên danh mục không được để trống và tối đa 100 ký tự'),
  body('slug').trim().matches(/^[a-z0-9-]+$/).withMessage('Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/admin/categories');
    }

    const { name, slug } = req.body;
    const conflict = db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
    if (conflict) {
      req.flash('error', 'Slug danh mục đã tồn tại');
      return res.redirect('/admin/categories');
    }
    db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
    res.redirect('/admin/categories');
  });

app.get('/admin/categories/:id/edit', requireAdmin, (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!category) return res.status(404).render('404');
  res.render('admin/category_edit', { title: 'Sửa danh mục', category });
});

app.post('/admin/categories/:id/edit', requireAdmin, (req, res) => {
  const { name, slug } = req.body;
  const conflict = db.prepare('SELECT id FROM categories WHERE slug=? AND id<>?').get(slug, req.params.id);
  if (conflict) {
    req.flash('error', 'Slug danh mục đã tồn tại');
    return res.redirect(`/admin/categories/${req.params.id}/edit`);
  }
  db.prepare('UPDATE categories SET name=?, slug=? WHERE id=?').run(name, slug, req.params.id);
  res.redirect('/admin/categories');
});

// Static pages
app.get('/payment', (req, res) => {
  const html = formatPageContentToHtml(getSetting('page_payment', ''));
  res.render('pages/payment', { title: 'Thanh toán - SafeKeyS', html });
});
app.get('/policy', (req, res) => {
  const html = formatPageContentToHtml(getSetting('page_policy', ''));
  res.render('pages/policy', { title: 'Chính sách - SafeKeyS', html });
});
app.get('/about', (req, res) => {
  const html = formatPageContentToHtml(getSetting('page_about', ''));
  res.render('pages/about', { title: 'Giới thiệu - SafeKeyS', html });
});
app.get('/contact', (req, res) => {
  const html = formatPageContentToHtml(getSetting('page_contact', ''));
  res.render('pages/contact', { title: 'Liên hệ - SafeKeyS', html });
});

// News table
db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    author TEXT,
    thumbnail TEXT
  );
`);

// Ensure new columns exist for news
const newsColumns = db.prepare("PRAGMA table_info(news)").all();
const newsColNames = newsColumns.map(c => c.name);
if (!newsColNames.includes('updated_at')) {
  db.exec("ALTER TABLE news ADD COLUMN updated_at DATETIME");
}
if (!newsColNames.includes('author')) {
  db.exec("ALTER TABLE news ADD COLUMN author TEXT");
}
if (!newsColNames.includes('thumbnail')) {
  db.exec("ALTER TABLE news ADD COLUMN thumbnail TEXT");
}

// Utilities
function slugify(input) {
  const base = (input || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'bai-viet';
  return base;
}
function generateUniqueSlug(baseSlug, excludeId) {
  let slug = slugify(baseSlug);
  const exists = (s) => db.prepare('SELECT id FROM news WHERE slug = ?' + (excludeId ? ' AND id<>?' : '')).get(excludeId ? [s, excludeId] : [s]);
  if (!exists(slug)) return slug;
  let i = 2;
  while (exists(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

// Public news
app.get('/news', (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const pageSize = 10;
  const where = q ? 'WHERE published=1 AND (title LIKE ? OR content LIKE ?)' : 'WHERE published=1';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) as c FROM news ${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  const posts = db.prepare(`SELECT id, title, slug, content, created_at, thumbnail FROM news ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.render('news/index', { title: 'Tin tức - SafeKeyS', posts, q, page, totalPages });
});
app.get('/news/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM news WHERE slug=? AND published=1').get(req.params.slug);
  if (!post) return res.status(404).render('404');
  const words = (post.content || '').split(/\s+/).filter(Boolean).length;
  const readingTimeMin = Math.max(1, Math.round(words / 200));
  res.render('news/show', { title: post.title + ' - Tin tức', post, readingTimeMin });
});

// Admin news CRUD
app.get('/admin/news', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const pageSize = 15;
  const where = q ? 'WHERE (title LIKE ? OR content LIKE ?)' : '';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) as c FROM news ${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  const posts = db.prepare(`SELECT * FROM news ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.render('admin/news', { title: 'Quản lý Tin tức', posts, q, page, totalPages });
});
app.post('/admin/news', requireAdmin, (req, res) => {
  const { title, slug, content, published, author, thumbnail } = req.body;
  if (!title || !content) { req.flash('error', 'Thiếu tiêu đề hoặc nội dung'); return res.redirect('/admin/news'); }
  const finalSlug = generateUniqueSlug(slug && slug.trim() ? slug : title);
  db.prepare('INSERT INTO news (title, slug, content, published, author, thumbnail, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .run(title, finalSlug, content, published === '1' ? 1 : 0, author || null, thumbnail || null);
  req.flash('success', 'Đã tạo bài viết');
  res.redirect('/admin/news');
});
app.get('/admin/news/:id/edit', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM news WHERE id=?').get(req.params.id);
  if (!post) { req.flash('error', 'Bài viết không tồn tại'); return res.redirect('/admin/news'); }
  res.render('admin/news_edit', { title: 'Sửa Tin tức', post });
});
app.post('/admin/news/:id/edit', requireAdmin, (req, res) => {
  const { title, slug, content, published, author, thumbnail } = req.body;
  if (!title || !content) { req.flash('error', 'Thiếu tiêu đề hoặc nội dung'); return res.redirect(`/admin/news/${req.params.id}/edit`); }
  const finalSlug = generateUniqueSlug(slug && slug.trim() ? slug : title, req.params.id);
  db.prepare('UPDATE news SET title=?, slug=?, content=?, published=?, author=?, thumbnail=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(title, finalSlug, content, published === '1' ? 1 : 0, author || null, thumbnail || null, req.params.id);
  req.flash('success', 'Đã lưu bài viết');
  res.redirect('/admin/news');
});

app.post('/admin/news/:id/toggle', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT published FROM news WHERE id=?').get(req.params.id);
  if (p) db.prepare('UPDATE news SET published=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.published ? 0 : 1, req.params.id);
  res.redirect('/admin/news');
});
app.post('/admin/news/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM news WHERE id=?').run(req.params.id);
  req.flash('success', 'Đã xóa bài viết');
  res.redirect('/admin/news');
});

// Admin view/edit user carts via session store
app.get('/admin/carts', requireAdmin, (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const rows = db.prepare('SELECT sid, sess FROM sessions ORDER BY rowid DESC LIMIT 200').all();
    const carts = [];
    rows.forEach(r => {
      try {
        const s = JSON.parse(r.sess);
        // Hiển thị giỏ hàng của TẤT CẢ người dùng (không chỉ admin)
        if (s && s.user && s.cart && Object.keys(s.cart.items || {}).length > 0) {
          // Lọc theo tên hoặc email nếu có query
          if (!q ||
            s.user.name.toLowerCase().includes(q) ||
            s.user.email.toLowerCase().includes(q)) {
            carts.push({ sid: r.sid, user: s.user, cart: s.cart });
          }
        }
      } catch { }
    });
    res.render('admin/carts', { title: 'Giỏ hàng người dùng', carts, q });
  } catch {
    res.render('admin/carts', { title: 'Giỏ hàng người dùng', carts: [], q: '' });
  }
});
app.post('/admin/carts/:sid/clear', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT sess FROM sessions WHERE sid=?').get(req.params.sid);
    if (row) {
      const s = JSON.parse(row.sess);
      if (s && s.cart) {
        s.cart = { items: {}, totalQty: 0, totalCents: 0 };
        db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s), req.params.sid);
        req.flash('success', 'Đã xóa toàn bộ giỏ hàng');
      }
    }
  } catch (e) {
    req.flash('error', 'Lỗi xóa giỏ hàng');
  }
  res.redirect('/admin/carts');
});
app.post('/admin/carts/:sid/item/:pid/update', requireAdmin, (req, res) => {
  try {
    const { qty } = req.body;
    const newQty = Math.max(0, parseInt(qty || '0', 10));
    const row = db.prepare('SELECT sess FROM sessions WHERE sid=?').get(req.params.sid);
    if (row) {
      const s = JSON.parse(row.sess);
      if (s && s.cart && s.cart.items && s.cart.items[req.params.pid]) {
        const entry = s.cart.items[req.params.pid];
        const oldQty = entry.qty;

        if (newQty === 0) {
          // Xóa sản phẩm nếu số lượng = 0
          s.cart.totalQty -= oldQty;
          s.cart.totalCents -= oldQty * entry.product.price_cents;
          delete s.cart.items[req.params.pid];
          req.flash('success', 'Đã xóa sản phẩm khỏi giỏ hàng');
        } else {
          // Cập nhật số lượng
          const diff = newQty - oldQty;
          s.cart.totalQty += diff;
          s.cart.totalCents += diff * entry.product.price_cents;
          entry.qty = newQty;
          req.flash('success', 'Đã cập nhật số lượng sản phẩm');
        }

        db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s), req.params.sid);
      }
    }
  } catch (e) {
    req.flash('error', 'Lỗi cập nhật sản phẩm');
  }
  res.redirect('/admin/carts');
});
app.post('/admin/carts/:sid/item/:pid/remove', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT sess FROM sessions WHERE sid=?').get(req.params.sid);
    if (row) {
      const s = JSON.parse(row.sess);
      if (s && s.cart && s.cart.items && s.cart.items[req.params.pid]) {
        const entry = s.cart.items[req.params.pid];
        s.cart.totalQty -= entry.qty;
        s.cart.totalCents -= entry.qty * entry.product.price_cents;
        delete s.cart.items[req.params.pid];
        db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s), req.params.sid);
        req.flash('success', 'Đã xóa sản phẩm khỏi giỏ hàng');
      }
    }
  } catch (e) {
    req.flash('error', 'Lỗi xóa sản phẩm');
  }
  res.redirect('/admin/carts');
});

app.post('/admin/categories/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  // Also nullify category on products
  db.prepare('UPDATE products SET category_id=NULL WHERE category_id=?').run(req.params.id);
  res.redirect('/admin/categories');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);

  // CSRF token errors
  if (err.code === 'EBADCSRFTOKEN') {
    req.flash('error', 'Phiên đăng nhập đã hết hạn. Vui lòng thử lại.');
    return res.redirect('back');
  }

  // Database errors
  if (err.code && err.code.startsWith('SQLITE_')) {
    req.flash('error', 'Có lỗi xảy ra với cơ sở dữ liệu. Vui lòng thử lại sau.');
    return res.redirect('back');
  }

  // General errors
  res.status(err.status || 500).render('500', {
    title: 'Lỗi Server - SafeKeyS',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Đã xảy ra lỗi'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('404', {
    title: '404 - Không tìm thấy - SafeKeyS'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SafeKeyS running at http://localhost:${PORT}`);
});



