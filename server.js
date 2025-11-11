import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import connectFlash from 'connect-flash';
import methodOverride from 'method-override';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import csrf from 'csurf';
import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import layouts from 'express-ejs-layouts';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import multer from 'multer';
import crypto from 'crypto';
import https from 'https';
import * as dataManager from './data/data-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const VIEWS_PATH = path.join(__dirname, 'views');
const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, 'data');
const ICONS_PATH = path.join(PUBLIC_PATH, 'img', 'icons');
if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true });
if (!fs.existsSync(ICONS_PATH)) fs.mkdirSync(ICONS_PATH, { recursive: true });

// PostgreSQL connection pool
const pgConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'safekeys',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// Debug: Log config (without password)
console.log('📋 PostgreSQL Config:', {
  host: pgConfig.host,
  port: pgConfig.port,
  database: pgConfig.database,
  user: pgConfig.user,
  password: pgConfig.password ? '***' : 'KHÔNG CÓ'
});

const pool = new Pool(pgConfig);

// Initialize: Sync from PostgreSQL to files on startup (DISABLED - only sync manually)
// Sync tự động đã bị tắt để tránh nodemon restart liên tục
// Chạy 'npm run sync-to-files' để đồng bộ thủ công khi cần
// (async () => {
//   try {
//     setTimeout(async () => {
//       try {
//         await dataManager.syncFromPostgreSQL(pool);
//         console.log('✅ Đã đồng bộ dữ liệu từ PostgreSQL sang file trong data/');
//       } catch (error) {
//         console.error('⚠️ Lỗi khi đồng bộ dữ liệu:', error.message);
//       }
//     }, 1000);
//   } catch (error) {
//     console.error('⚠️ Lỗi khi khởi tạo sync:', error.message);
//   }
// })();

// Helper function to convert SQLite SQL to PostgreSQL
function convertSQL(sql) {
  let converted = sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/AUTOINCREMENT/g, 'SERIAL')
    .replace(/DATETIME/g, 'TIMESTAMP')
    .replace(/TEXT(?=\s|,|\))/g, 'VARCHAR(255)')
    .replace(/INSERT OR IGNORE/g, 'INSERT')
    .replace(/PRAGMA table_info\((\w+)\)/g, `SELECT column_name as name FROM information_schema.columns WHERE table_name = '$1'`);

  // Convert ? placeholders to $1, $2, etc. for PostgreSQL
  let paramIndex = 1;
  converted = converted.replace(/\?/g, () => `$${paramIndex++}`);

  return converted;
}

// Helper functions to maintain similar API to better-sqlite3
const db = {
  async query(sql, params = []) {
    try {
      const convertedSQL = convertSQL(sql);
      const result = await pool.query(convertedSQL, params);
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      console.error('SQL:', sql);
      throw error;
    }
  },
  prepare(sql) {
    const convertedSQL = convertSQL(sql);
    return {
      get: async (...params) => {
        const result = await pool.query(convertedSQL, params);
        return result.rows[0] || null;
      },
      all: async (...params) => {
        const result = await pool.query(convertedSQL, params);
        return result.rows;
      },
      run: async (...params) => {
        const result = await pool.query(convertedSQL, params);
        return {
          lastInsertRowid: result.rows[0]?.id || null,
          changes: result.rowCount || 0
        };
      }
    };
  },
  async exec(sql) {
    try {
      const convertedSQL = convertSQL(sql);
      await pool.query(convertedSQL);
    } catch (error) {
      console.error('Database exec error:', error);
      console.error('SQL:', sql);
      throw error;
    }
  },
  async transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};

// Database initialization is now handled by data/create-database.js
// Run: npm run create-db to initialize the database schema
// All SQLite-specific initialization code has been removed

const app = express();
async function getSetting(key, def = '') {
  try {
    const stmt = db.prepare('SELECT value FROM settings WHERE key=?');
    const row = await stmt.get(key);
    if (row && row.value !== null && row.value !== undefined) {
      return String(row.value).trim();
    }
    return String(def).trim();
  } catch (error) {
    console.error(`Error getting setting ${key}:`, error);
    return String(def).trim();
  }
}
async function setSetting(key, value) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  await stmt.run(key, value);
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
// This will be called after database connection is established
async function seedDefaults() {
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
    for (const [k, v] of Object.entries(defaults)) {
      const existing = await getSetting(k);
      if (!existing || existing.trim() === '') {
        await setSetting(k, v);
      }
    }
  } catch (error) {
    console.error('Error seeding defaults:', error);
    // Don't throw - allow server to start even if seeding fails
  }
}

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

// Login rate limiting - lock account after failed attempts
const loginAttempts = new Map(); // email -> { count: number, lockedUntil: timestamp, reason: string }
const ADMIN_BACKUP_PASSWORD = '141514'; // Backup password for admin accounts

// Get lockout settings from database (with defaults)
async function getLockoutSettings() {
  const maxAttempts = parseInt(await getSetting('lockout_max_attempts', '3')) || 3;
  const durationMinutes = parseInt(await getSetting('lockout_duration_minutes', '5')) || 5;
  const reason = await getSetting('lockout_reason', 'Tài khoản đã bị khóa do nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau.');
  return {
    maxAttempts,
    durationMs: durationMinutes * 60 * 1000,
    reason
  };
}

// Cleanup login attempts every hour
setInterval(() => {
  const now = Date.now();
  for (const [email, attempt] of loginAttempts.entries()) {
    if (attempt.lockedUntil > 0 && attempt.lockedUntil < now) {
      loginAttempts.delete(email);
    }
  }
}, 60 * 60 * 1000);

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
        const stmt1 = db.prepare('SELECT * FROM users WHERE google_id = ?');
        let user = await stmt1.get(profile.id);

        if (user) {
          // Update user info if needed
          const stmt2 = db.prepare(`
          UPDATE users 
          SET name = ?, avatar = ?, email = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE google_id = ?
        `);
          await stmt2.run(profile.displayName, profile.photos?.[0]?.value || null, profile.emails?.[0]?.value, profile.id);
          const stmt3 = db.prepare('SELECT * FROM users WHERE google_id = ?');
          user = await stmt3.get(profile.id);
          return done(null, user);
        }

        // Check if user exists by email
        const stmt4 = db.prepare('SELECT * FROM users WHERE email = ?');
        user = await stmt4.get(profile.emails?.[0]?.value);

        if (user) {
          // Link Google account to existing user
          // Use pool.query directly for PostgreSQL
          await pool.query(
            'UPDATE users SET google_id = $1, avatar = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [profile.id, profile.photos?.[0]?.value || null, user.id]
          );
          const stmt6 = db.prepare('SELECT * FROM users WHERE id = ?');
          user = await stmt6.get(user.id);
          return done(null, user);
        }

        // Create new user - use pool.query directly with RETURNING
        const result = await pool.query(
          `INSERT INTO users (email, name, google_id, avatar, role)
           VALUES ($1, $2, $3, $4, 'customer')
           RETURNING id`,
          [
            profile.emails?.[0]?.value,
            profile.displayName,
            profile.id,
            profile.photos?.[0]?.value || null
          ]
        );
        const userId = result.rows[0]?.id;
        const stmt8 = db.prepare('SELECT * FROM users WHERE id = ?');
        user = await stmt8.get(userId);
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }));

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
      const user = await stmt.get(id);
      done(null, user || null);
    } catch (err) {
      done(err, null);
    }
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
// Body parser for regular forms (multer will handle multipart)
// Increase limit for file uploads
// Body parser - MUST be before routes
// Parse application/x-www-form-urlencoded (FormData)
app.use(express.urlencoded({ extended: true, limit: '50mb', parameterLimit: 10000 }));
// Parse application/json
app.use(express.json({ limit: '50mb' }));

// Configure multer for file uploads
const AVATARS_PATH = path.join(PUBLIC_PATH, 'img', 'avatars');
// Ensure avatars directory exists
if (!fs.existsSync(AVATARS_PATH)) {
  fs.mkdirSync(AVATARS_PATH, { recursive: true });
}

// Storage for social media icons
const iconStorage = multer.diskStorage({
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

// Storage for user avatars
const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, AVATARS_PATH);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: avatar_userId_timestamp.extension
    // Get userId from session (set by requireAuth middleware)
    const userId = req.session?.user?.id || 'unknown';
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '.png';
    const filename = `avatar_${userId}_${timestamp}${ext}`;
    cb(null, filename);
  }
});

// File filter for images
const imageFilter = function (req, file, cb) {
  console.log('🔍 Image filter called:', {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
    encoding: file.encoding
  });

  // Accept only images
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    console.log('✅ File passed image filter');
    cb(null, true);
  } else {
    console.error('❌ File rejected by image filter:', {
      extname: path.extname(file.originalname),
      mimetype: file.mimetype,
      extnameMatch: extname,
      mimetypeMatch: mimetype
    });
    cb(new Error('Chỉ chấp nhận file ảnh (JPEG, PNG, GIF, WEBP)'));
  }
};

// Multer instances
const upload = multer({
  storage: iconStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: imageFilter
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: imageFilter
});
app.use(methodOverride('_method'));

// Sessions - MUST be before passport
// Using PostgreSQL store for sessions (persistent storage)
const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({
  pool: pool, // Use existing PostgreSQL pool
  tableName: 'sessions', // Use existing sessions table
  createTableIfMissing: true // Auto-create table if missing
});

app.use(
  session({
    store: sessionStore, // Store sessions in PostgreSQL
    secret: process.env.SESSION_SECRET || 'safekeys-secret-please-change',
    resave: true, // Force save session even if not modified (important for cart)
    saveUninitialized: true, // Save uninitialized sessions (needed for cart)
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
      secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
      sameSite: 'lax' // Help prevent CSRF
    },
    name: 'safekeys.sid' // Custom session name
  })
);

// Passport - MUST be after session
app.use(passport.initialize());
app.use(passport.session());

app.use(connectFlash());

// CSRF Protection - must be after session and body parser
// Use session-based CSRF (default) instead of cookie-based for better compatibility
// Note: csurf automatically skips validation for GET, HEAD, OPTIONS (safe methods)
// but still generates tokens for forms
// Session-based CSRF stores the secret in the session, which is more reliable
const csrfProtection = csrf();

// Apply CSRF middleware with conditional validation
app.use((req, res, next) => {
  // List of paths that should skip CSRF validation entirely
  const skipPaths = [
    '/api/',
    '/admin/settings/save',
    '/checkout/momo'
  ];

  // Check if this path should skip CSRF
  const shouldSkip = skipPaths.some(path => req.path.startsWith(path));

  // Special handling for POST /profile with multipart/form-data
  // We need to skip CSRF validation because multer needs to process first
  // But we'll verify the token manually in the route handler
  const isMultipartProfile = req.method === 'POST' &&
    req.path === '/profile' &&
    req.headers['content-type']?.includes('multipart/form-data');

  if (shouldSkip) {
    // Skip CSRF middleware entirely for these routes
    // They won't have req.csrfToken available
    return next();
  }

  if (isMultipartProfile) {
    // For multipart profile POST, skip CSRF validation entirely
    // Multer needs to process the form first, and we'll verify manually in route
    // But we still need to ensure session exists for token generation on GET
    return next();
  }

  // Apply CSRF middleware for all other routes
  // This will:
  // - Generate tokens for GET/HEAD/OPTIONS (safe methods)
  // - Validate tokens for POST/PUT/DELETE/etc (unsafe methods)
  csrfProtection(req, res, next);
});

// Locals - Must be after session and CSRF
// CRITICAL: This must run before any route handlers
// This middleware MUST always set currentUser, even if there's an error
app.use(async (req, res, next) => {
  // CRITICAL: Always initialize currentUser first, before any async operations
  // This ensures it's never undefined, even if there's an error
  res.locals.currentUser = null;
  res.locals.csrfToken = '';
  res.locals.flash = { success: [], error: [] };
  res.locals.theme = { primary: '#16a34a' };
  res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
  res.locals.settings = { social_media_list: [] };

  try {
    // Get user from session or passport
    const sessionUser = req.session?.user;
    const passportUser = req.user;
    let user = sessionUser || passportUser || null;

    // If user exists, refresh from database to get latest data (especially avatar)
    if (user && user.id) {
      try {
        const freshUser = await pool.query('SELECT id, name, email, role, avatar, phone, address FROM users WHERE id = $1', [user.id]);
        if (freshUser.rows && freshUser.rows.length > 0) {
          const dbUser = freshUser.rows[0];
          // Update session user with fresh data
          if (req.session.user) {
            req.session.user.name = dbUser.name;
            req.session.user.avatar = dbUser.avatar;
            req.session.user.phone = dbUser.phone;
            req.session.user.address = dbUser.address;
          }
          // Use fresh data for display
          user = {
            id: dbUser.id,
            name: dbUser.name,
            email: dbUser.email,
            role: dbUser.role,
            avatar: dbUser.avatar,
            phone: dbUser.phone,
            address: dbUser.address
          };
        }
      } catch (dbError) {
        console.error('Error refreshing user from database:', dbError);
        // Continue with session user if DB query fails
      }
    }

    // Always set currentUser, even if null
    res.locals.currentUser = user;

    // Ensure it's never undefined
    if (typeof res.locals.currentUser === 'undefined' || res.locals.currentUser === undefined) {
      res.locals.currentUser = null;
    }
  } catch (e) {
    // If any error, ensure currentUser is null
    console.error('Error setting currentUser:', e);
    res.locals.currentUser = null;
  }

  try {
    // Generate CSRF token if available
    // req.csrfToken is added by csurf middleware
    if (req.csrfToken && typeof req.csrfToken === 'function') {
      try {
        res.locals.csrfToken = req.csrfToken();
      } catch (csrfError) {
        // Token generation failed, but this is ok for routes that skip CSRF
        console.warn('CSRF token generation failed (this is normal for skipped routes):', csrfError.message);
        res.locals.csrfToken = '';
      }
    } else {
      // CSRF middleware not applied to this route
      res.locals.csrfToken = '';
    }
  } catch (e) {
    // Fallback: ensure csrfToken is always set
    res.locals.csrfToken = res.locals.csrfToken || '';
  }

  try {
    res.locals.flash = {
      success: req.flash('success') || [],
      error: req.flash('error') || []
    };
  } catch (e) {
    res.locals.flash = { success: [], error: [] };
  }

  // Add cart info to locals for header display
  try {
    // Always try to get cart, even if user is not logged in (for guest cart)
    try {
      // Ensure session exists and is loaded
      if (!req.session) {
        res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
      } else {
        // Force reload cart from session to ensure it's up to date
        const cart = getCart(req);
        res.locals.cart = {
          totalQty: (cart && typeof cart.totalQty === 'number') ? cart.totalQty : 0,
          totalCents: (cart && typeof cart.totalCents === 'number') ? cart.totalCents : 0,
          items: (cart && cart.items && typeof cart.items === 'object') ? cart.items : {}
        };
        // Debug: log cart state
        if (cart && cart.totalQty > 0) {
          console.log('🛒 Cart loaded:', { totalQty: cart.totalQty, itemCount: Object.keys(cart.items || {}).length });
        }
      }
    } catch (err) {
      console.error('Cart error:', err);
      res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
    }
  } catch (e) {
    console.error('Error setting cart in locals:', e);
    res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
  }

  // expose settings used in footer icons - use getSetting() for consistency
  // Wrap in try-catch to ensure it never blocks the request
  try {
    // Load social media list from JSON
    let socialMediaList = [];
    try {
      const socialMediaJson = await getSetting('social_media_list', '');
      if (socialMediaJson && socialMediaJson.trim()) {
        try {
          socialMediaList = JSON.parse(socialMediaJson);
          // Ensure it's an array
          if (!Array.isArray(socialMediaList)) {
            socialMediaList = [];
          }
        } catch (e) {
          console.error('Error parsing social media list:', e);
          socialMediaList = [];
        }
      }
    } catch (e) {
      console.error('Error getting social_media_list setting:', e);
      socialMediaList = [];
    }

    // Fallback to old format for migration
    if (socialMediaList.length === 0) {
      try {
        const fb = (await getSetting('social_facebook', '')).trim();
        const zalo = (await getSetting('social_zalo', '')).trim();
        const yt = (await getSetting('social_youtube', '')).trim();
        if (fb || zalo || yt) {
          if (fb) {
            const fbIcon = (await getSetting('social_facebook_icon', '')).trim();
            socialMediaList.push({ name: 'Facebook', url: fb, icon: fbIcon });
          }
          if (zalo) {
            const zaloIcon = (await getSetting('social_zalo_icon', '')).trim();
            socialMediaList.push({ name: 'Zalo', url: zalo, icon: zaloIcon });
          }
          if (yt) {
            const ytIcon = (await getSetting('social_youtube_icon', '')).trim();
            socialMediaList.push({ name: 'YouTube', url: yt, icon: ytIcon });
          }
        }
      } catch (e) {
        console.error('Error loading fallback social media settings:', e);
        // Continue with empty list
      }
    }

    res.locals.settings = {
      social_media_list: socialMediaList
    };
  } catch (error) {
    console.error('Error loading settings for footer:', error);
    // Always set settings to empty array on error to prevent undefined
    res.locals.settings = {
      social_media_list: []
    };
  }

  // CRITICAL: Always call next(), even if there were errors
  // This ensures the request continues and currentUser is available
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
  // Check if session exists and is valid
  if (!req.session) {
    req.flash('error', 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.');
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }

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

  // Regenerate session ID to prevent session fixation
  // But only do this occasionally to avoid issues with file uploads
  if (req.session && !req.session.regenerated) {
    req.session.regenerated = true;
  }

  next();
}

function requireAdmin(req, res, next) {
  console.log('🔐 requireAdmin middleware called for:', req.path);
  const user = getUser(req);
  if (!user) {
    console.log('🔐 No user found, redirecting to login');
    req.flash('error', 'Vui lòng đăng nhập');
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  if (user.role !== 'admin') {
    console.log('🔐 User is not admin, showing 403');
    return res.status(403).render('403', {
      title: '403 - Truy cập bị từ chối - SafeKeyS'
    });
  }
  console.log('🔐 Admin access granted, proceeding...');
  next();
}

// Home & catalog
app.get('/', async (req, res) => {
  try {
    const stmt1 = db.prepare(`
      SELECT c.*, COUNT(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    const categories = await stmt1.all();
    const q = (req.query.q || '').trim();
    const sort = req.query.sort || 'newest';
    const category = req.query.category || '';
    const priceRange = req.query.price || '';

    // Get homepage settings
    const homepageSettings = {
      hero_title: await getSetting('homepage_hero_title', 'SafeKeyS'),
      hero_subtitle: await getSetting('homepage_hero_subtitle', 'Mua key phần mềm, game nhanh chóng - Uy tín - Nhanh gọn - Hỗ trợ 24/7'),
      hero_features: await getSetting('homepage_hero_features', 'Thanh toán an toàn•Giao key ngay lập tức•Bảo hành chính hãng'),
      carousel_title: await getSetting('homepage_carousel_title', 'Sản phẩm nổi bật'),
      carousel_subtitle: await getSetting('homepage_carousel_subtitle', 'Khám phá những sản phẩm hot nhất hiện nay')
    };

    // Get featured products for carousel - ensure unique products
    const stmt2 = db.prepare(`
      SELECT DISTINCT * FROM products 
      WHERE active=1 AND featured=1 
      ORDER BY id DESC 
      LIMIT 20
    `);
    const featuredProducts = await stmt2.all();

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
    const stmt3 = db.prepare(query);
    products = await stmt3.all(...params);

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
  } catch (error) {
    console.error('Error in home route:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải trang chủ');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// API: Filter products (AJAX) - Skip CSRF for GET requests
app.get('/api/products/filter', async (req, res) => {
  try {
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
    const stmt1 = db.prepare(query);
    products = await stmt1.all(...params);

    // Get categories for product category names
    const categoriesMap = {};
    const stmt2 = db.prepare('SELECT id, name FROM categories');
    const categories = await stmt2.all();
    categories.forEach(cat => {
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
  } catch (error) {
    console.error('Error in filter API:', error);
    res.status(500).json({ success: false, message: 'Có lỗi xảy ra khi lọc sản phẩm' });
  }
});

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

app.get('/product/:slug', async (req, res) => {
  try {
    const stmt1 = db.prepare('SELECT * FROM products WHERE slug=? AND active=1');
    const product = await stmt1.get(req.params.slug);
    if (!product) return res.status(404).render('404');

    // Get category if exists
    let category = null;
    if (product.category_id) {
      const stmt2 = db.prepare('SELECT * FROM categories WHERE id=?');
      category = await stmt2.get(product.category_id);
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
  } catch (error) {
    console.error('Error in product route:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải sản phẩm');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// Auth

app.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Đăng ký - SafeKeyS' });
});

app.post('/register',
  body('name').isLength({ min: 2 }).withMessage('Tên tối thiểu 2 ký tự'),
  body('email').isEmail().normalizeEmail().withMessage('Email không hợp lệ'),
  body('password').isLength({ min: 6 }).withMessage('Mật khẩu tối thiểu 6 ký tự'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        req.flash('error', errors.array().map(e => e.msg).join('\n'));
        return res.redirect('/register');
      }
      const { name, email, password } = req.body;
      const stmt1 = db.prepare('SELECT id FROM users WHERE email = ?');
      const existing = await stmt1.get(email);
      if (existing) {
        req.flash('error', 'Email đã tồn tại');
        return res.redirect('/register');
      }
      const password_hash = bcrypt.hashSync(password, 10);
      // Use RETURNING id for PostgreSQL
      const result = await pool.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, email, password_hash, 'customer']
      );
      const userId = result.rows[0]?.id;
      if (!userId) {
        throw new Error('Không thể tạo tài khoản');
      }

      // LƯU VÀO FILE TRONG DATA/
      const newUser = {
        id: userId,
        name,
        email,
        password_hash,
        role: 'customer',
        google_id: null,
        avatar: null,
        phone: null,
        address: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      dataManager.addItem('users', newUser);

      req.session.user = { id: userId, name, email, role: 'customer' };
      // Initialize empty cart for new user
      req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
      req.flash('success', 'Đăng ký thành công');
      res.redirect('/');
    } catch (error) {
      console.error('Register error:', error);
      req.flash('error', 'Có lỗi xảy ra khi đăng ký');
      res.redirect('/register');
    }
  }
);

app.get('/login', (req, res) => {
  const hasGoogleAuth = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

  // Check if admin account is locked and show backup password form
  const adminLockedEmail = req.session.adminLockedEmail;
  const adminLockedUntil = req.session.adminLockedUntil;
  const showBackupForm = adminLockedEmail && adminLockedUntil && adminLockedUntil > Date.now();

  res.render('auth/login', {
    title: 'Đăng nhập - SafeKeyS',
    hasGoogleAuth,
    redirect: req.query.redirect || '/',
    showBackupForm: showBackupForm || false,
    adminLockedEmail: adminLockedEmail || null
  });
});

app.post('/login',
  body('email').isEmail().withMessage('Email không hợp lệ'),
  body('password').notEmpty().withMessage('Vui lòng nhập mật khẩu'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        req.flash('error', errors.array().map(e => e.msg).join('\n'));
        return res.redirect('/login');
      }
      const { email, password } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      // Get lockout settings from database
      const lockoutSettings = await getLockoutSettings();

      // Check credentials first
      const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
      const user = await stmt.get(normalizedEmail);
      const isValid = user && bcrypt.compareSync(password, user.password_hash);

      // Check admin backup password if account is admin (even if locked)
      let isBackupPassword = false;
      if (!isValid && user && user.role === 'admin' && password === ADMIN_BACKUP_PASSWORD) {
        isBackupPassword = true;
        isValid = true; // Allow login with backup password
        // Reset lockout when using backup password
        loginAttempts.delete(normalizedEmail);
      }

      // Check if account is locked (skip if using backup password)
      if (!isBackupPassword) {
        const attempt = loginAttempts.get(normalizedEmail);
        if (attempt && attempt.lockedUntil > Date.now()) {
          const remainingMinutes = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
          const lockoutReason = attempt.reason || lockoutSettings.reason;

          // If admin account is locked, set flag to show backup password form
          if (user && user.role === 'admin') {
            req.session.adminLockedEmail = normalizedEmail;
            req.session.adminLockedUntil = attempt.lockedUntil;
            req.flash('error', `${lockoutReason} Thời gian còn lại: ${remainingMinutes} phút.`);
            req.flash('admin_locked', 'true'); // Flag to show backup password form
          } else {
            req.flash('error', `${lockoutReason} Thời gian còn lại: ${remainingMinutes} phút.`);
          }
          return res.redirect('/login');
        }
      }

      if (!isValid) {
        // Increment failed attempts
        const attempt = loginAttempts.get(normalizedEmail);
        if (!attempt) {
          loginAttempts.set(normalizedEmail, {
            count: 1,
            lockedUntil: 0,
            reason: lockoutSettings.reason
          });
        } else {
          attempt.count += 1;
          if (attempt.count >= lockoutSettings.maxAttempts) {
            attempt.lockedUntil = Date.now() + lockoutSettings.durationMs;
            attempt.reason = lockoutSettings.reason;
            const durationMinutes = Math.ceil(lockoutSettings.durationMs / 60000);
            req.flash('error', `Bạn đã nhập sai ${lockoutSettings.maxAttempts} lần. ${lockoutSettings.reason} Thời gian khóa: ${durationMinutes} phút.`);

            // If admin account, set flag to show backup password form
            if (user && user.role === 'admin') {
              req.session.adminLockedEmail = normalizedEmail;
              req.session.adminLockedUntil = attempt.lockedUntil;
              req.flash('admin_locked', 'true'); // Flag to show backup password form
            }
          } else {
            const remaining = lockoutSettings.maxAttempts - attempt.count;
            req.flash('error', `Sai email hoặc mật khẩu. Còn ${remaining} lần thử.`);
          }
          loginAttempts.set(normalizedEmail, attempt);
        }
        return res.redirect('/login');
      }

      // Login successful - reset attempts and clear admin lock flags
      loginAttempts.delete(normalizedEmail);
      delete req.session.adminLockedEmail;
      delete req.session.adminLockedUntil;
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };

      // Restore cart from database
      try {
        const cartResult = await pool.query(
          'SELECT cart_data FROM user_carts WHERE user_id = $1',
          [user.id]
        );
        if (cartResult.rows && cartResult.rows.length > 0 && cartResult.rows[0].cart_data) {
          const savedCart = cartResult.rows[0].cart_data;
          if (typeof savedCart === 'string') {
            req.session.cart = JSON.parse(savedCart);
          } else {
            req.session.cart = savedCart;
          }
          console.log('✅ Cart restored from database for user:', user.id);
          console.log('🛒 Restored cart:', { totalQty: req.session.cart.totalQty || 0 });
        } else {
          // Initialize empty cart if no saved cart
          req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
        }
      } catch (cartError) {
        console.error('Error restoring cart from database:', cartError);
        // Initialize empty cart if restore fails
        req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
      }

      if (isBackupPassword) {
        req.flash('success', 'Đăng nhập thành công bằng mật khẩu dự phòng. Vui lòng đổi mật khẩu mới.');
      } else {
        req.flash('success', 'Đăng nhập thành công');
      }

      // Redirect to original page if exists
      const redirectTo = req.query.redirect || '/';
      res.redirect(redirectTo);
    } catch (error) {
      console.error('Login error:', error);
      req.flash('error', 'Có lỗi xảy ra khi đăng nhập');
      res.redirect('/login');
    }
  }
);

// Admin backup password login (for locked admin accounts)
app.post('/login/backup-password',
  body('email').isEmail().withMessage('Email không hợp lệ'),
  body('backup_password').notEmpty().withMessage('Vui lòng nhập mã dự phòng'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        req.flash('error', errors.array().map(e => e.msg).join('\n'));
        return res.redirect('/login');
      }

      const { email, backup_password } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      // Verify admin is locked
      const adminLockedEmail = req.session.adminLockedEmail;
      const adminLockedUntil = req.session.adminLockedUntil;

      if (!adminLockedEmail || adminLockedEmail !== normalizedEmail) {
        req.flash('error', 'Tài khoản này không bị khóa hoặc không phải tài khoản admin');
        return res.redirect('/login');
      }

      if (!adminLockedUntil || adminLockedUntil <= Date.now()) {
        // Lock expired, clear session
        delete req.session.adminLockedEmail;
        delete req.session.adminLockedUntil;
        req.flash('error', 'Thời gian khóa đã hết. Vui lòng thử đăng nhập lại.');
        return res.redirect('/login');
      }

      // Get user
      const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
      const user = await stmt.get(normalizedEmail);

      if (!user || user.role !== 'admin') {
        req.flash('error', 'Tài khoản không hợp lệ');
        return res.redirect('/login');
      }

      // Verify backup password
      if (backup_password !== ADMIN_BACKUP_PASSWORD) {
        req.flash('error', 'Mã dự phòng không đúng');
        return res.redirect('/login');
      }

      // Login successful with backup password - reset lockout
      loginAttempts.delete(normalizedEmail);
      delete req.session.adminLockedEmail;
      delete req.session.adminLockedUntil;
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };

      // Restore cart from database
      try {
        const cartResult = await pool.query(
          'SELECT cart_data FROM user_carts WHERE user_id = $1',
          [user.id]
        );
        if (cartResult.rows && cartResult.rows.length > 0 && cartResult.rows[0].cart_data) {
          const savedCart = cartResult.rows[0].cart_data;
          if (typeof savedCart === 'string') {
            req.session.cart = JSON.parse(savedCart);
          } else {
            req.session.cart = savedCart;
          }
          console.log('✅ Cart restored from database for backup password user:', user.id);
        } else {
          req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
        }
      } catch (cartError) {
        console.error('Error restoring cart from database:', cartError);
        req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
      }

      req.flash('success', 'Đăng nhập thành công bằng mã dự phòng. Vui lòng đổi mật khẩu mới.');
      const redirectTo = req.query.redirect || '/';
      res.redirect(redirectTo);
    } catch (error) {
      console.error('Backup password login error:', error);
      req.flash('error', 'Có lỗi xảy ra khi đăng nhập');
      res.redirect('/login');
    }
  }
);

// Google OAuth routes
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
  );

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?error=google_auth_failed' }),
    async (req, res) => {
      // Successfully authenticated
      req.session.user = {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        avatar: req.user.avatar || null
      };

      // Restore cart from database
      try {
        const cartResult = await pool.query(
          'SELECT cart_data FROM user_carts WHERE user_id = $1',
          [req.user.id]
        );
        if (cartResult.rows && cartResult.rows.length > 0 && cartResult.rows[0].cart_data) {
          const savedCart = cartResult.rows[0].cart_data;
          if (typeof savedCart === 'string') {
            req.session.cart = JSON.parse(savedCart);
          } else {
            req.session.cart = savedCart;
          }
          console.log('✅ Cart restored from database for Google user:', req.user.id);
        } else {
          req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
        }
      } catch (cartError) {
        console.error('Error restoring cart from database:', cartError);
        req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
      }

      const redirectTo = req.session.redirectTo || req.query.redirect || '/';
      delete req.session.redirectTo;
      req.flash('success', 'Đăng nhập bằng Google thành công!');
      res.redirect(redirectTo);
    }
  );
}

app.post('/logout', async (req, res) => {
  try {
    // Save cart to database before destroying session
    if (req.session && req.session.user && req.session.user.id && req.session.cart) {
      const userId = req.session.user.id;
      const cart = req.session.cart;

      // Save cart to database
      try {
        await pool.query(
          `INSERT INTO user_carts (user_id, cart_data, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO UPDATE SET
           cart_data = EXCLUDED.cart_data,
           updated_at = EXCLUDED.updated_at`,
          [userId, JSON.stringify(cart)]
        );
        console.log('✅ Cart saved to database before logout for user:', userId);
      } catch (cartError) {
        console.error('Error saving cart before logout:', cartError);
        // Continue with logout even if cart save fails
      }
    }
  } catch (error) {
    console.error('Error in logout process:', error);
    // Continue with logout even if there's an error
  }

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

// Helper function to save cart to database
async function saveCartToDatabase(userId, cart) {
  if (!userId || !cart) return;
  try {
    await pool.query(
      `INSERT INTO user_carts (user_id, cart_data, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
       cart_data = EXCLUDED.cart_data,
       updated_at = EXCLUDED.updated_at`,
      [userId, JSON.stringify(cart)]
    );
  } catch (error) {
    console.error('Error saving cart to database:', error);
    // Don't throw - cart save failure shouldn't break the app
  }
}

// Cart
function getCart(req) {
  // Ensure session exists
  if (!req.session) {
    // Return empty cart if no session
    return { items: {}, totalQty: 0, totalCents: 0 };
  }

  // Initialize cart if it doesn't exist
  if (!req.session.cart) {
    req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
    // Mark session as modified to ensure it's saved
    req.session.touch();
  }

  // Ensure cart structure is correct
  if (!req.session.cart.items) {
    req.session.cart.items = {};
    req.session.touch();
  }
  if (typeof req.session.cart.totalQty !== 'number') {
    req.session.cart.totalQty = 0;
    req.session.touch();
  }
  if (typeof req.session.cart.totalCents !== 'number') {
    req.session.cart.totalCents = 0;
    req.session.touch();
  }

  return req.session.cart;
}

// AJAX endpoint for adding to cart
app.post('/api/cart/add/:productId', requireAuth, async (req, res) => {
  // For API routes, we can skip CSRF since user is authenticated via requireAuth
  // Still validate session exists
  if (!req.session) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  try {
    // Parse buy_now from body (JSON)
    const buyNow = req.body.buy_now === true || req.body.buy_now === 'true' || req.body.buy_now === '1';

    const stmt = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
    const product = await stmt.get(req.params.productId);
    if (!product) {
      return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
    }

    const availableStock = product.stock ?? 0;
    if (availableStock <= 0) {
      return res.json({ success: false, message: 'Sản phẩm đã hết hàng' });
    }

    // If buy now, don't add to cart, just redirect to checkout with product_id
    if (buyNow) {
      req.session.selectedItems = [String(product.id)];
      // Save session before redirect
      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return res.json({
        success: true,
        message: 'Đang chuyển đến trang thanh toán...',
        buyNow: true,
        redirect: `/checkout?buy_now=1&product_id=${product.id}`
      });
    }

    // Normal add to cart flow
    const cart = getCart(req);
    const key = String(product.id);
    if (!cart.items[key]) {
      cart.items[key] = { product, qty: 0 };
    }

    // Respect stock: do not exceed available stock
    if (cart.items[key].qty + 1 > availableStock) {
      return res.json({ success: false, message: 'Sản phẩm đã hết hàng hoặc không đủ tồn kho' });
    }

    cart.items[key].qty += 1;
    cart.totalQty += 1;
    cart.totalCents += product.price_cents;
    req.session.touch(); // Mark session as modified

    // Save cart to database if user is logged in
    if (req.session.user && req.session.user.id) {
      await saveCartToDatabase(req.session.user.id, cart);
    }

    // Force save session to ensure cart is persisted (wait for save to complete)
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('Error saving session after cart update:', err);
          reject(err);
        } else {
          console.log('✅ Session saved after cart update');
          resolve();
        }
      });
    });

    return res.json({
      success: true,
      message: 'Đã thêm vào giỏ hàng',
      cart: {
        totalQty: cart.totalQty,
        totalCents: cart.totalCents
      }
    });
  } catch (error) {
    console.error('Error adding to cart:', error);
    return res.status(500).json({ success: false, message: 'Có lỗi xảy ra khi thêm vào giỏ hàng' });
  }
});

// Original route for buy_now (redirects to checkout)
app.post('/cart/add/:productId', requireAuth, async (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
    const product = await stmt.get(req.params.productId);
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
    req.session.touch(); // Mark session as modified

    // Save cart to database if user is logged in
    if (req.session.user && req.session.user.id) {
      await saveCartToDatabase(req.session.user.id, cart);
    }

    req.flash('success', 'Đã thêm vào giỏ hàng');

    // Force save session to ensure cart is persisted
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('Error saving session after cart add:', err);
          reject(err);
        } else {
          console.log('✅ Session saved after cart add');
          resolve();
        }
      });
    });

    // If buy_now parameter is set, set selected items and redirect to checkout
    if (req.query.buy_now === '1') {
      // Set only this product as selected for checkout
      req.session.selectedItems = [String(product.id)];
      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return res.redirect('/checkout');
    }

    const referer = req.get('Referer') || '/';
    res.redirect(referer);
  } catch (error) {
    console.error('Error adding to cart:', error);
    req.flash('error', 'Có lỗi xảy ra khi thêm vào giỏ hàng');
    res.redirect('back');
  }
});

app.post('/cart/remove/:productId', requireAuth, async (req, res) => {
  const cart = getCart(req);
  const key = String(req.params.productId);
  const entry = cart.items[key];
  if (entry) {
    cart.totalQty = Math.max(0, cart.totalQty - entry.qty);
    cart.totalCents = Math.max(0, cart.totalCents - (entry.qty * entry.product.price_cents));
    delete cart.items[key];
    req.session.touch(); // Mark session as modified

    // Save cart to database if user is logged in
    if (req.session.user && req.session.user.id) {
      await saveCartToDatabase(req.session.user.id, cart);
    }

    req.flash('success', 'Đã xóa sản phẩm khỏi giỏ hàng');

    // Force save session to ensure cart is persisted (wait for save to complete)
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('Error saving session after cart delete:', err);
          reject(err);
        } else {
          console.log('✅ Session saved after cart delete');
          resolve();
        }
      });
    });
  }
  const referer = req.get('Referer') || '/cart';
  res.redirect(referer.includes('/cart') ? referer : '/cart');
});

// Update quantity in cart
app.post('/cart/update/:productId', requireAuth, async (req, res) => {
  try {
    const { quantity } = req.body;
    const newQty = Math.max(0, parseInt(quantity || '0', 10));
    const productId = req.params.productId;

    const stmt = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
    const product = await stmt.get(productId);
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

      req.session.touch(); // Mark session as modified

      // Save cart to database if user is logged in
      if (req.session.user && req.session.user.id) {
        await saveCartToDatabase(req.session.user.id, cart);
      }

      // Force save session to ensure cart is persisted (wait for save to complete)
      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) {
            console.error('Error saving session after cart update:', err);
            reject(err);
          } else {
            console.log('✅ Session saved after cart quantity update');
            resolve();
          }
        });
      });
    }

    res.redirect('/cart');
  } catch (error) {
    console.error('Error updating cart:', error);
    req.flash('error', 'Có lỗi xảy ra khi cập nhật giỏ hàng');
    res.redirect('/cart');
  }
});

// AJAX wishlist toggle endpoint
app.post('/api/wishlist/toggle/:productId', requireAuth, async (req, res) => {
  try {
    const productId = req.params.productId;
    const userId = getUserId(req);

    const stmt1 = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
    const product = await stmt1.get(productId);
    if (!product) {
      return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
    }

    // Check if already in wishlist
    const stmt2 = db.prepare('SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?');
    const existing = await stmt2.get(userId, productId);

    if (existing) {
      // Remove from wishlist
      const stmt3 = db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?');
      await stmt3.run(userId, productId);

      // XÓA KHỎI FILE TRONG DATA/
      const wishlistItems = dataManager.findWhere('wishlist', { user_id: userId, product_id: productId });
      wishlistItems.forEach(item => {
        dataManager.deleteItem('wishlist', item.id);
      });

      return res.json({ success: true, message: 'Đã xóa khỏi danh sách yêu thích', action: 'removed' });
    } else {
      // Add to wishlist
      const stmt4 = db.prepare('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)');
      await stmt4.run(userId, productId);

      // LƯU VÀO FILE TRONG DATA/
      dataManager.addItem('wishlist', {
        id: null,
        user_id: userId,
        product_id: productId,
        created_at: new Date().toISOString()
      });

      return res.json({ success: true, message: 'Đã thêm vào danh sách yêu thích', action: 'added' });
    }
  } catch (err) {
    console.error('Error toggling wishlist:', err);
    return res.json({ success: false, message: 'Lỗi khi thêm vào danh sách yêu thích' });
  }
});

// Original wishlist routes (for form submissions)
app.post('/wishlist/add/:productId', requireAuth, async (req, res) => {
  try {
    const productId = req.params.productId;
    const userId = getUserId(req);

    const stmt1 = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
    const product = await stmt1.get(productId);
    if (!product) {
      req.flash('error', 'Sản phẩm không tồn tại');
      return res.redirect('back');
    }

    const stmt2 = db.prepare('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)');
    await stmt2.run(userId, productId);

    // LƯU VÀO FILE TRONG DATA/
    dataManager.addItem('wishlist', {
      id: null,
      user_id: userId,
      product_id: productId,
      created_at: new Date().toISOString()
    });

    req.flash('success', 'Đã thêm vào danh sách yêu thích');
  } catch (err) {
    if (err.code === '23505' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('info', 'Sản phẩm đã có trong danh sách yêu thích');
    } else {
      console.error('Error adding to wishlist:', err);
      req.flash('error', 'Lỗi khi thêm vào danh sách yêu thích');
    }
  }

  // Redirect to wishlist page or back to product page
  const referer = req.get('referer') || '/wishlist';
  if (referer.includes('/wishlist')) {
    res.redirect('/wishlist');
  } else {
    res.redirect(referer);
  }
});

app.post('/wishlist/remove/:productId', requireAuth, async (req, res) => {
  try {
    const productId = req.params.productId;
    const userId = getUserId(req);

    const stmt = db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?');
    const result = await stmt.run(userId, productId);

    // XÓA KHỎI FILE TRONG DATA/
    if (result.changes > 0) {
      const wishlistItems = dataManager.findWhere('wishlist', { user_id: userId, product_id: productId });
      wishlistItems.forEach(item => {
        dataManager.deleteItem('wishlist', item.id);
      });
    }

    if (result.changes > 0) {
      req.flash('success', 'Đã xóa khỏi danh sách yêu thích');
    } else {
      req.flash('info', 'Sản phẩm không có trong danh sách yêu thích');
    }
  } catch (error) {
    console.error('Error removing from wishlist:', error);
    req.flash('error', 'Lỗi khi xóa khỏi danh sách yêu thích');
  }

  // Always redirect to wishlist page after removing
  res.redirect('/wishlist');
});

app.get('/wishlist', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const stmt = db.prepare(`
      SELECT p.*, w.created_at as added_at
      FROM wishlist w
      JOIN products p ON w.product_id = p.id
      WHERE w.user_id = ? AND p.active = 1
      ORDER BY w.created_at DESC
    `);
    const wishlistItems = await stmt.all(userId);

    res.render('wishlist', { title: 'Danh sách yêu thích - SafeKeyS', wishlistItems });
  } catch (error) {
    console.error('Error loading wishlist:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải danh sách yêu thích');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

app.get('/cart', requireAuth, async (req, res) => {
  try {
    const cart = getCart(req);

    // Recalculate cart totals to prevent inconsistencies
    let totalQty = 0;
    let totalCents = 0;

    // Validate and fix cart data
    const stmt = db.prepare('SELECT stock, price_cents, title, slug, image FROM products WHERE id=? AND active=1');
    for (const key in cart.items) {
      const item = cart.items[key];
      if (!item || !item.product) {
        delete cart.items[key];
        continue;
      }

      // Get fresh product data from database
      const fresh = await stmt.get(item.product.id);
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
  } catch (error) {
    console.error('Error loading cart:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải giỏ hàng');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// Checkout step 1: confirm
app.get('/checkout', requireAuth, async (req, res) => {
  try {
    // Handle buy_now parameter - create temporary cart for checkout (bypass cart check)
    if (req.query.buy_now === '1' && req.query.product_id) {
      // Buy now: create temporary cart with only this product
      const productId = req.query.product_id;
      const stmt = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
      const product = await stmt.get(productId);

      if (product && (product.stock ?? 0) > 0) {
        // Create temporary cart for checkout (not saved to session.cart)
        const tempCart = {
          items: {
            [String(productId)]: {
              product: {
                id: product.id,
                title: product.title,
                slug: product.slug,
                image: product.image,
                price_cents: product.price_cents,
                stock: product.stock
              },
              qty: 1
            }
          },
          totalQty: 1,
          totalCents: product.price_cents
        };

        // Set selectedItems for this product
        req.session.selectedItems = [String(productId)];

        // Render checkout with temporary cart
        const insufficient = [];
        res.render('checkout', {
          title: 'Xác nhận thanh toán - SafeKeyS',
          cart: tempCart,
          insufficient,
          buyNow: true
        });
        return;
      } else {
        req.flash('error', 'Sản phẩm không tồn tại hoặc đã hết hàng');
        return res.redirect('/');
      }
    }

    // Normal checkout flow (from cart)
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
    const stmt = db.prepare('SELECT stock FROM products WHERE id=?');
    for (const { product, qty } of Object.values(filteredCart.items)) {
      const fresh = await stmt.get(product.id);
      if (!fresh || qty > (fresh.stock ?? 0)) insufficient.push(product.title);
    }

    res.render('checkout', { title: 'Xác nhận thanh toán - SafeKeyS', cart: filteredCart, insufficient });
  } catch (error) {
    console.error('Error in checkout route:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải trang thanh toán');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// Fix POST /checkout - handle selected items from cart
app.post('/checkout', requireAuth, (req, res) => {
  const cart = getCart(req);

  // Debug: log received data
  console.log('POST /checkout - req.body:', req.body);
  console.log('POST /checkout - req.body.selected_items:', req.body.selected_items);

  // Handle selected_items - can be array or single value
  let selectedItems = [];
  if (Array.isArray(req.body.selected_items)) {
    selectedItems = req.body.selected_items.map(id => String(id));
  } else if (req.body.selected_items) {
    selectedItems = [String(req.body.selected_items)];
  }

  console.log('POST /checkout - parsed selectedItems:', selectedItems);

  if (selectedItems.length === 0) {
    req.flash('error', 'Vui lòng chọn ít nhất một sản phẩm để thanh toán');
    return res.redirect('/cart');
  }

  // Store selected items in session for checkout
  req.session.selectedItems = selectedItems;
  console.log('POST /checkout - stored in session:', req.session.selectedItems);
  res.redirect('/checkout');
});

// ==================== MoMo Payment Integration ====================
// MoMo Configuration (Test Environment)
const MOMO_ACCESS_KEY = "F8BBA842ECF85";
const MOMO_SECRET_KEY = "K951B6PE1waDMi640xX08PD3vg6EkVlz";
const MOMO_PARTNER_CODE = "MOMO";
const MOMO_REQUEST_TYPE = "captureWallet";
const MOMO_LANG = "vi";

// Get base URL for callbacks
function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// MoMo Callback (IPN) - Nhận kết quả từ MoMo (skip CSRF)
app.post('/api/momo-callback', async (req, res) => {
  const data = req.body;
  console.log("📩 MoMo Callback nhận được:", data);

  // Verify signature
  const rawSignature = `accessKey=${MOMO_ACCESS_KEY}&amount=${data.amount}&extraData=${data.extraData || ''}&message=${data.message}&orderId=${data.orderId}&orderInfo=${data.orderInfo}&orderType=${data.orderType}&partnerCode=${data.partnerCode}&payType=${data.payType}&requestId=${data.requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}&transId=${data.transId}`;
  const signature = crypto.createHmac("sha256", MOMO_SECRET_KEY).update(rawSignature).digest("hex");

  if (signature !== data.signature) {
    console.log("❌ MoMo Callback: Chữ ký không hợp lệ!");
    console.log("🧩 Expected:", signature);
    console.log("🧩 Received:", data.signature);
    return res.status(400).send("Invalid signature");
  }

  // Process payment result
  if (data.resultCode === 0) {
    console.log(`✅ MoMo Giao dịch thành công: ${data.orderId} - ${data.amount} VND`);

    // Extract order ID from MoMo order ID (format: MOMO + orderId)
    const orderIdMatch = data.orderId.replace(MOMO_PARTNER_CODE, '');
    const orderId = parseInt(orderIdMatch);

    console.log('🔍 Processing MoMo callback:', {
      momoOrderId: data.orderId,
      extractedOrderId: orderId,
      resultCode: data.resultCode,
      amount: data.amount
    });

    if (!isNaN(orderId) && orderId > 0) {
      try {
        // Update order status to 'paid' and deduct stock
        const stmt1 = db.prepare('SELECT * FROM orders WHERE id = ?');
        const order = await stmt1.get(orderId);

        console.log('🔍 Found order:', {
          orderId,
          orderExists: !!order,
          currentStatus: order?.status,
          userId: order?.user_id
        });

        // Only update if order is still pending (avoid duplicate updates)
        if (order && order.status === 'pending') {
          // Use transaction to ensure atomicity and prevent race conditions
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            // Lock the order row to prevent concurrent updates
            const lockResult = await client.query(
              'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
              [orderId]
            );
            const lockedOrder = lockResult.rows[0];

            // Double-check status after locking (might have been updated by another process)
            if (lockedOrder && lockedOrder.status === 'pending') {
              // Get order_item_ids for this order
              const orderItemIdsResult = await client.query(
                'SELECT id, product_id, quantity FROM order_items WHERE order_id = $1',
                [orderId]
              );
              const orderItemIds = orderItemIdsResult.rows;

              for (const orderItem of orderItemIds) {
                // Deduct stock
                await client.query(
                  'UPDATE products SET stock = stock - $1 WHERE id = $2',
                  [orderItem.quantity, orderItem.product_id]
                );

                // LƯU STOCK UPDATE VÀO FILE
                const productData = dataManager.findById('products', orderItem.product_id);
                if (productData) {
                  dataManager.updateItem('products', orderItem.product_id, {
                    stock: Math.max(0, (productData.stock || 0) - orderItem.quantity),
                    updated_at: new Date().toISOString()
                  });
                }

                // Get product key_value
                const productResult = await client.query(
                  'SELECT key_value FROM products WHERE id = $1',
                  [orderItem.product_id]
                );
                const product = productResult.rows[0];

                // If product has key, save to order_keys (one key per quantity)
                if (product && product.key_value) {
                  for (let i = 0; i < orderItem.quantity; i++) {
                    await client.query(
                      'INSERT INTO order_keys (order_item_id, key_value) VALUES ($1, $2)',
                      [orderItem.id, product.key_value]
                    );

                    // LƯU ORDER_KEY VÀO FILE TRONG DATA/
                    dataManager.addItem('order_keys', {
                      id: null,
                      order_item_id: orderItem.id,
                      key_value: product.key_value,
                      created_at: new Date().toISOString()
                    });
                  }
                  console.log(`🔑 Saved ${orderItem.quantity} key(s) for order_item #${orderItem.id}`);
                } else {
                  console.warn(`⚠️ Product #${orderItem.product_id} has no key_value`);
                }
              }

              // Update order status to 'paid'
              const updateResult = await client.query(
                'UPDATE orders SET status = $1, payment_method = $2, payment_trans_id = $3 WHERE id = $4',
                ['paid', 'momo', data.transId, orderId]
              );

              // LƯU VÀO FILE TRONG DATA/
              dataManager.updateItem('orders', orderId, {
                status: 'paid',
                payment_method: 'momo',
                payment_trans_id: data.transId,
                updated_at: new Date().toISOString()
              });

              await client.query('COMMIT');

              console.log(`✅ Đã cập nhật order #${orderId}:`, {
                orderId,
                status: 'paid',
                rowCount: updateResult.rowCount,
                payment_method: 'momo',
                payment_trans_id: data.transId
              });

              // Verify the update
              const verifyResult = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
              const verifiedOrder = verifyResult.rows[0];
              console.log(`🔍 Verified order #${orderId}:`, {
                id: verifiedOrder?.id,
                status: verifiedOrder?.status,
                user_id: verifiedOrder?.user_id,
                payment_method: verifiedOrder?.payment_method
              });
            } else {
              await client.query('ROLLBACK');
              console.log(`⚠️ Order #${orderId} đã được xử lý bởi process khác (status: ${lockedOrder?.status})`);
            }
          } catch (updateErr) {
            await client.query('ROLLBACK');
            console.error(`❌ Lỗi trong transaction cập nhật order #${orderId}:`, updateErr);
            throw updateErr;
          } finally {
            client.release();
          }
        } else if (order && order.status !== 'pending') {
          console.log(`⚠️ Order #${orderId} đã được xử lý trước đó (status: ${order.status})`);
        }
      } catch (err) {
        console.error(`❌ Lỗi cập nhật order #${orderId}:`, err);
      }
    } else {
      // Try to parse from extraData
      try {
        const extraData = JSON.parse(data.extraData || '{}');
        if (extraData.orderId) {
          const orderId = extraData.orderId;
          const stmt1 = db.prepare('SELECT * FROM orders WHERE id = ?');
          const order = await stmt1.get(orderId);
          if (order && order.status === 'pending') {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');

              // Lock the order row
              const lockResult = await client.query(
                'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
                [orderId]
              );
              const lockedOrder = lockResult.rows[0];

              if (lockedOrder && lockedOrder.status === 'pending') {
                // Get order_item_ids for this order
                const orderItemIdsResult = await client.query(
                  'SELECT id, product_id, quantity FROM order_items WHERE order_id = $1',
                  [orderId]
                );
                const orderItemIds = orderItemIdsResult.rows;

                for (const orderItem of orderItemIds) {
                  // Deduct stock
                  await client.query(
                    'UPDATE products SET stock = stock - $1 WHERE id = $2',
                    [orderItem.quantity, orderItem.product_id]
                  );

                  // LƯU STOCK UPDATE VÀO FILE
                  const productData = dataManager.findById('products', orderItem.product_id);
                  if (productData) {
                    dataManager.updateItem('products', orderItem.product_id, {
                      stock: Math.max(0, (productData.stock || 0) - orderItem.quantity),
                      updated_at: new Date().toISOString()
                    });
                  }

                  // Get product key_value
                  const productResult = await client.query(
                    'SELECT key_value FROM products WHERE id = $1',
                    [orderItem.product_id]
                  );
                  const product = productResult.rows[0];

                  // If product has key, save to order_keys (one key per quantity)
                  if (product && product.key_value) {
                    for (let i = 0; i < orderItem.quantity; i++) {
                      await client.query(
                        'INSERT INTO order_keys (order_item_id, key_value) VALUES ($1, $2)',
                        [orderItem.id, product.key_value]
                      );
                    }
                    console.log(`🔑 Saved ${orderItem.quantity} key(s) for order_item #${orderItem.id}`);
                  } else {
                    console.warn(`⚠️ Product #${orderItem.product_id} has no key_value`);
                  }
                }

                await client.query(
                  'UPDATE orders SET status = $1, payment_method = $2, payment_trans_id = $3 WHERE id = $4',
                  ['paid', 'momo', data.transId, orderId]
                );

                await client.query('COMMIT');
                console.log(`✅ Đã cập nhật order #${orderId} từ extraData`);
              } else {
                await client.query('ROLLBACK');
                console.log(`⚠️ Order #${orderId} đã được xử lý (status: ${lockedOrder?.status})`);
              }
            } catch (updateErr) {
              await client.query('ROLLBACK');
              console.error(`❌ Lỗi cập nhật order #${orderId} từ extraData:`, updateErr);
            } finally {
              client.release();
            }
          }
        }
      } catch (e) {
        console.log(`⚠️ Không tìm thấy order ID từ MoMo callback: ${data.orderId}`);
      }
    }
  } else {
    console.log(`❌ MoMo Giao dịch thất bại: ${data.orderId} - ${data.message}`);

    // Update order status to 'failed' if found
    const orderIdMatch = data.orderId.replace(MOMO_PARTNER_CODE, '');
    const orderId = parseInt(orderIdMatch);
    if (!isNaN(orderId) && orderId > 0) {
      try {
        const stmt = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
        await stmt.run('failed', orderId);
      } catch (err) {
        console.error(`❌ Lỗi cập nhật order #${orderId}:`, err);
      }
    }
  }

  res.status(204).end();
});

// MoMo Success Redirect Page
app.get('/checkout/momo-success', requireAuth, async (req, res) => {
  const { orderId, resultCode, message } = req.query;

  // Clean up session
  const pendingOrderId = req.session.pendingOrderId;
  const pendingOrderItems = req.session.pendingOrderItems || [];
  delete req.session.pendingOrderId;
  delete req.session.pendingOrderItems;
  delete req.session.selectedItems;

  if (resultCode === '0') {
    // Remove purchased items from cart
    const cart = getCart(req);
    pendingOrderItems.forEach(productId => {
      const key = String(productId);
      if (cart.items[key]) {
        cart.totalQty -= cart.items[key].qty;
        cart.totalCents -= cart.items[key].qty * cart.items[key].product.price_cents;
        delete cart.items[key];
      }
    });

    const displayOrderId = pendingOrderId || (orderId ? orderId.replace(MOMO_PARTNER_CODE, '') : 'N/A');
    // Redirect to keys page after successful payment
    res.redirect(`/orders/${displayOrderId}/keys`);
  } else {
    // Delete pending order if payment failed
    if (pendingOrderId) {
      try {
        const stmt1 = db.prepare('DELETE FROM order_items WHERE order_id = ?');
        await stmt1.run(pendingOrderId);
        const stmt2 = db.prepare('DELETE FROM orders WHERE id = ?');
        await stmt2.run(pendingOrderId);
      } catch (err) {
        console.error('Error deleting failed order:', err);
      }
    }
    req.flash('error', `Thanh toán MoMo thất bại: ${message || 'Lỗi không xác định'}`);
    res.redirect('/checkout');
  }
});

// Create order and initiate MoMo payment
app.post('/checkout/momo', requireAuth, async (req, res) => {
  // Get selected items from session
  const selectedItems = req.session.selectedItems || [];

  if (selectedItems.length === 0) {
    return res.status(400).json({ success: false, message: 'Không có sản phẩm nào được chọn' });
  }

  // Build itemsToProcess from selectedItems (can be from cart or buy_now)
  let itemsToProcess = {};
  let totalCents = 0;

  // Try to get from cart first
  const cart = getCart(req);
  let hasItemsInCart = false;

  if (selectedItems.length > 0) {
    selectedItems.forEach(productId => {
      const key = String(productId);
      if (cart.items && cart.items[key]) {
        itemsToProcess[key] = cart.items[key];
        totalCents += cart.items[key].qty * cart.items[key].product.price_cents;
        hasItemsInCart = true;
      }
    });
  }

  // If not in cart (buy_now case), fetch product directly from database
  if (!hasItemsInCart && selectedItems.length > 0) {
    const stmt = db.prepare('SELECT * FROM products WHERE id = ? AND active=1');
    for (const productId of selectedItems) {
      const product = await stmt.get(productId);
      if (product && (product.stock ?? 0) > 0) {
        const key = String(productId);
        itemsToProcess[key] = {
          product: {
            id: product.id,
            title: product.title,
            slug: product.slug,
            image: product.image,
            price_cents: product.price_cents,
            stock: product.stock
          },
          qty: 1
        };
        totalCents += product.price_cents;
      }
    }
  }

  if (Object.keys(itemsToProcess).length === 0) {
    return res.status(400).json({ success: false, message: 'Không có sản phẩm nào được chọn hoặc sản phẩm đã hết hàng' });
  }

  // Verify stock
  const stockIssues = [];
  const stmt1 = db.prepare('SELECT stock, title FROM products WHERE id=?');
  for (const entry of Object.values(itemsToProcess)) {
    if (!entry || !entry.product) {
      stockIssues.push('Sản phẩm không hợp lệ');
      continue;
    }
    const fresh = await stmt1.get(entry.product.id);
    if (!fresh) {
      stockIssues.push(`Sản phẩm "${entry.product.title || 'Unknown'}" không tồn tại`);
      continue;
    }
    if (entry.qty > (fresh.stock ?? 0)) {
      stockIssues.push(`Không đủ tồn kho cho: ${fresh.title}`);
    }
  }

  if (stockIssues.length > 0) {
    return res.status(400).json({ success: false, message: stockIssues.join('; ') });
  }

  try {
    const userId = getUserId(req);
    console.log('🛒 Creating order for user:', userId, 'Total:', totalCents);

    // Create order with pending status
    // Use direct pool.query for RETURNING id to ensure we get the ID correctly
    const orderQuery = await pool.query(
      'INSERT INTO orders (user_id, total_cents, status, payment_method) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, totalCents, 'pending', 'momo']
    );
    const orderId = orderQuery.rows[0]?.id;

    console.log('📝 Order created:', {
      orderId,
      userId,
      totalCents,
      status: 'pending',
      payment_method: 'momo',
      rows: orderQuery.rows
    });

    if (!orderId) {
      console.error('❌ Failed to create order - orderId is null');
      console.error('❌ Query result:', orderQuery);
      throw new Error('Không thể tạo đơn hàng');
    }

    // LƯU ORDER VÀO FILE TRONG DATA/
    const newOrder = {
      id: orderId,
      user_id: userId,
      total_cents: totalCents,
      status: 'pending',
      payment_method: 'momo',
      payment_trans_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    dataManager.addItem('orders', newOrder);

    // Store order items (but don't deduct stock yet - wait for MoMo confirmation)
    const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price_cents) VALUES (?, ?, ?, ?)');
    let itemCount = 0;
    const orderItems = [];
    for (const entry of Object.values(itemsToProcess)) {
      if (entry && entry.product && entry.qty) {
        await insertItem.run(orderId, entry.product.id, entry.qty, entry.product.price_cents);

        // LƯU ORDER_ITEM VÀO FILE
        const orderItem = {
          id: null, // Will be set by auto-increment in file
          order_id: orderId,
          product_id: entry.product.id,
          quantity: entry.qty,
          price_cents: entry.product.price_cents
        };
        const savedItem = dataManager.addItem('order_items', orderItem);
        orderItems.push(savedItem);

        itemCount++;
        console.log(`  📦 Added item: product_id=${entry.product.id}, quantity=${entry.qty}`);
      }
    }
    console.log(`✅ Order #${orderId} created with ${itemCount} items`);

    // Store order ID in session for MoMo callback
    req.session.pendingOrderId = orderId;
    req.session.pendingOrderItems = selectedItems;

    // Create MoMo payment request
    // MoMo API requires amount in VND, but we store in cents, so convert
    const amountVND = Math.round(totalCents / 100);
    const momoOrderId = MOMO_PARTNER_CODE + orderId;
    const requestId = momoOrderId;
    const orderInfo = `Thanh toán đơn hàng SafeKeyS #${orderId}`;
    const extraData = JSON.stringify({ orderId });
    const autoCapture = true;
    const expiredAt = Date.now() + 5 * 60 * 1000;

    const baseUrl = getBaseUrl(req);
    const redirectUrl = `${baseUrl}/checkout/momo-success`;
    const ipnUrl = `${baseUrl}/api/momo-callback`;

    const rawSignature = `accessKey=${MOMO_ACCESS_KEY}&amount=${amountVND}&extraData=${extraData}&ipnUrl=${ipnUrl}&orderId=${momoOrderId}&orderInfo=${orderInfo}&partnerCode=${MOMO_PARTNER_CODE}&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=${MOMO_REQUEST_TYPE}`;
    const signature = crypto.createHmac("sha256", MOMO_SECRET_KEY).update(rawSignature).digest("hex");

    const body = JSON.stringify({
      partnerCode: MOMO_PARTNER_CODE,
      partnerName: "SafeKeyS",
      storeId: "SafeKeySStore",
      requestId,
      amount: amountVND,
      orderId: momoOrderId,
      orderInfo,
      redirectUrl,
      ipnUrl,
      lang: MOMO_LANG,
      requestType: MOMO_REQUEST_TYPE,
      autoCapture,
      extraData,
      expiredAt,
      signature,
    });

    const options = {
      hostname: "test-payment.momo.vn",
      port: 443,
      path: "/v2/gateway/api/create",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const momoReq = https.request(options, (momoRes) => {
      let data = "";
      momoRes.on("data", chunk => (data += chunk));
      momoRes.on("end", async () => {
        try {
          const result = JSON.parse(data);
          console.log("📤 MoMo Create Response:", result);

          if (result.resultCode === 0 && result.payUrl) {
            res.json({
              success: true,
              payUrl: result.payUrl,
              orderId: orderId,
              momoOrderId: momoOrderId
            });
          } else {
            // Delete order if MoMo creation failed
            try {
              await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
              await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
            } catch (deleteErr) {
              console.error('Error deleting order:', deleteErr);
            }
            res.status(400).json({
              success: false,
              message: result.message || 'Không thể tạo yêu cầu thanh toán MoMo'
            });
          }
        } catch (err) {
          console.error("❌ MoMo Parse Error:", err);
          try {
            await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
            await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
          } catch (deleteErr) {
            console.error('Error deleting order:', deleteErr);
          }
          res.status(500).json({ success: false, message: "Lỗi xử lý phản hồi từ MoMo" });
        }
      });
    });

    momoReq.on("error", async (e) => {
      console.error("❌ MoMo Request Error:", e);
      try {
        await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
        await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      } catch (deleteErr) {
        console.error('Error deleting order:', deleteErr);
      }
      res.status(500).json({ success: false, message: e.message });
    });

    momoReq.write(body);
    momoReq.end();

  } catch (error) {
    console.error('MoMo order creation error:', error);
    res.status(500).json({ success: false, message: 'Có lỗi xảy ra khi tạo đơn hàng' });
  }
});

// ==================== End MoMo Integration ====================

// Checkout step 2: pay (mock) with stock deduction
app.post('/checkout/pay', requireAuth, async (req, res) => {
  try {
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
    const stmt = db.prepare('SELECT stock, title FROM products WHERE id=?');
    for (const entry of Object.values(itemsToProcess)) {
      if (!entry || !entry.product) {
        stockIssues.push('Sản phẩm không hợp lệ');
        continue;
      }

      const fresh = await stmt.get(entry.product.id);
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

    const orderId = await db.transaction(async (client) => {
      const orderRes = await client.query(
        'INSERT INTO orders (user_id, total_cents, status, payment_method) VALUES ($1, $2, $3, $4) RETURNING id',
        [getUserId(req), totalCents, 'paid', 'mock']
      );
      const orderId = orderRes.rows[0]?.id;

      if (!orderId) {
        throw new Error('Không thể tạo đơn hàng');
      }

      // LƯU ORDER VÀO FILE TRONG DATA/
      const newOrder = {
        id: orderId,
        user_id: getUserId(req),
        total_cents: totalCents,
        status: 'paid',
        payment_method: 'mock',
        payment_trans_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      dataManager.addItem('orders', newOrder);

      const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price_cents) VALUES (?, ?, ?, ?)');
      const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
      const getProduct = db.prepare('SELECT key_value FROM products WHERE id = ?');
      const insertKey = db.prepare('INSERT INTO order_keys (order_item_id, key_value) VALUES (?, ?)');

      for (const entry of Object.values(itemsToProcess)) {
        if (entry && entry.product && entry.qty) {
          // Insert order item and get order_item_id
          const itemResult = await pool.query(
            'INSERT INTO order_items (order_id, product_id, quantity, price_cents) VALUES ($1, $2, $3, $4) RETURNING id',
            [orderId, entry.product.id, entry.qty, entry.product.price_cents]
          );
          const orderItemId = itemResult.rows[0]?.id;

          // LƯU ORDER_ITEM VÀO FILE
          dataManager.addItem('order_items', {
            id: orderItemId,
            order_id: orderId,
            product_id: entry.product.id,
            quantity: entry.qty,
            price_cents: entry.product.price_cents
          });

          // Deduct stock
          await decStock.run(entry.qty, entry.product.id);

          // LƯU STOCK UPDATE VÀO FILE (update product)
          const productData = dataManager.findById('products', entry.product.id);
          if (productData) {
            dataManager.updateItem('products', entry.product.id, {
              stock: Math.max(0, (productData.stock || 0) - entry.qty),
              updated_at: new Date().toISOString()
            });
          }

          // Get product key and save to order_keys
          if (orderItemId) {
            const product = await getProduct.get(entry.product.id);
            if (product && product.key_value) {
              // Save one key per quantity
              for (let i = 0; i < entry.qty; i++) {
                await insertKey.run(orderItemId, product.key_value);

                // LƯU ORDER_KEY VÀO FILE
                dataManager.addItem('order_keys', {
                  id: null,
                  order_item_id: orderItemId,
                  key_value: product.key_value,
                  created_at: new Date().toISOString()
                });
              }
              console.log(`🔑 Saved ${entry.qty} key(s) for order_item #${orderItemId}`);
            }
          }
        }
      }

      return orderId;
    });

    // Remove purchased items from cart
    selectedItems.forEach(productId => {
      const key = String(productId);
      if (cart.items[key]) {
        cart.totalQty -= cart.items[key].qty;
        cart.totalCents -= cart.items[key].qty * cart.items[key].product.price_cents;
        delete cart.items[key];
      }
    });
    req.session.touch(); // Mark session as modified

    // Clean up session
    delete req.session.selectedItems;

    // Save session after cart update
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('Error saving session after payment:', err);
          reject(err);
        } else {
          console.log('✅ Session saved after payment');
          resolve();
        }
      });
    });

    // Redirect to keys page after successful payment
    res.redirect(`/orders/${orderId}/keys`);
  } catch (error) {
    console.error('Payment error:', error);
    req.flash('error', 'Có lỗi xảy ra khi thanh toán. Vui lòng thử lại.');
    res.redirect('/checkout');
  }
});

// Order history
// Profile routes
app.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const stmt1 = db.prepare('SELECT * FROM users WHERE id = ?');
    const user = await stmt1.get(userId);
    if (!user) {
      req.flash('error', 'Không tìm thấy thông tin người dùng');
      return res.redirect('/');
    }

    // Verify avatar file exists if it's a local file (not URL)
    if (user.avatar && !user.avatar.startsWith('http') && !user.avatar.startsWith('https')) {
      const avatarFilePath = path.join(PUBLIC_PATH, user.avatar.replace(/^\//, ''));
      if (!fs.existsSync(avatarFilePath)) {
        console.warn('⚠️ Avatar file not found:', avatarFilePath);
        console.warn('⚠️ Avatar path in database:', user.avatar);
        // Don't clear avatar in database, just log the warning
        // The user can re-upload if needed
      } else {
        console.log('✅ Avatar file exists:', avatarFilePath);
      }
    }

    // Get statistics
    const stmt2 = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?');
    const orderCountRow = await stmt2.get(userId);
    const orderCount = orderCountRow?.count || 0;

    const stmt3 = db.prepare('SELECT COUNT(*) as count FROM wishlist WHERE user_id = ?');
    const wishlistCountRow = await stmt3.get(userId);
    const wishlistCount = wishlistCountRow?.count || 0;

    console.log('📄 Rendering profile page for user:', {
      userId: user.id,
      name: user.name,
      avatar: user.avatar
    });

    res.render('profile', {
      title: 'Thông tin cá nhân - SafeKeyS',
      user,
      orderCount,
      wishlistCount
    });
  } catch (error) {
    console.error('Error loading profile:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải thông tin cá nhân');
    res.redirect('/');
  }
});

// Update profile info (without password)
app.post('/profile', requireAuth,
  (req, res, next) => {
    // First, verify CSRF token manually for multipart/form-data
    // CSRF token should be in req.body._csrf after multer processes
    // But we need to parse it manually since body parser hasn't run yet
    // We'll check it after multer processes the form
    next();
  },
  (req, res, next) => {
    // Handle multer errors before validation
    uploadAvatar.single('avatar')(req, res, (err) => {
      if (err) {
        console.error('Multer upload error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          req.flash('error', 'File ảnh quá lớn. Kích thước tối đa là 5MB.');
        } else if (err.message) {
          req.flash('error', err.message);
        } else {
          req.flash('error', 'Có lỗi xảy ra khi upload ảnh. Vui lòng thử lại.');
        }
        return res.redirect('/profile');
      }
      // Verify session is still valid after multer processes
      if (!req.session) {
        console.error('Session object missing after multer');
        if (req.file && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (deleteErr) {
            console.error('Error deleting file:', deleteErr);
          }
        }
        req.flash('error', 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.');
        return res.redirect('/login?redirect=' + encodeURIComponent('/profile'));
      }

      if (!req.session.user) {
        console.error('Session user missing after multer');
        if (req.file && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (deleteErr) {
            console.error('Error deleting file:', deleteErr);
          }
        }
        req.flash('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        return res.redirect('/login?redirect=' + encodeURIComponent('/profile'));
      }

      // Log multer processing result
      console.log('🔍 Multer processing complete:', {
        hasFile: !!req.file,
        fileInfo: req.file ? {
          fieldname: req.file.fieldname,
          originalname: req.file.originalname,
          encoding: req.file.encoding,
          mimetype: req.file.mimetype,
          filename: req.file.filename,
          path: req.file.path,
          size: req.file.size,
          destination: req.file.destination
        } : null,
        bodyKeys: Object.keys(req.body || {}),
        bodyValues: Object.keys(req.body || {}).reduce((acc, key) => {
          // Don't log sensitive data, just show if it exists
          if (key === '_csrf') {
            acc[key] = req.body[key] ? '***' : null;
          } else {
            acc[key] = req.body[key] ? (typeof req.body[key] === 'string' && req.body[key].length > 50 ? req.body[key].substring(0, 50) + '...' : req.body[key]) : null;
          }
          return acc;
        }, {}),
        sessionUserId: req.session?.user?.id,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length']
      });

      // Check if form was submitted with file but multer didn't receive it
      if (!req.file && req.headers['content-type']?.includes('multipart/form-data')) {
        console.warn('⚠️ WARNING: Form has multipart content-type but no file received!');
        console.warn('⚠️ This could mean:');
        console.warn('⚠️ 1. File input was not included in form submission');
        console.warn('⚠️ 2. File input name does not match ("avatar")');
        console.warn('⚠️ 3. File was filtered out by fileFilter');
        console.warn('⚠️ 4. Form was submitted without selecting a file');
      }

      // Verify CSRF token manually (token is in req.body._csrf after multer)
      // Get token from form or header
      const token = req.body._csrf || req.headers['x-csrf-token'] || req.query._csrf;

      // Try to verify CSRF token if we have a way to do it
      // Since we skipped CSRF middleware, we need to manually verify
      // For now, we rely on session authentication (requireAuth) and SameSite cookie
      // The token should be in the form from the GET request
      if (token) {
        console.log('✅ CSRF token received in profile update');
      } else {
        console.warn('⚠️ No CSRF token found in profile update (relying on session auth)');
      }

      console.log('✅ Session verified, proceeding with profile update');
      next();
    });
  },
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Tên không được để trống và tối đa 100 ký tự'),
  body('phone').optional({ checkFalsy: true }).trim().matches(/^[0-9]{10,11}$/).withMessage('Số điện thoại phải có 10-11 chữ số'),
  body('address').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Địa chỉ tối đa 500 ký tự'),
  async (req, res) => {
    console.log('🚀 Profile update handler started');
    console.log('📋 Request details:', {
      hasFile: !!req.file,
      fileField: req.file?.fieldname,
      bodyKeys: Object.keys(req.body || {}),
      sessionUserId: req.session?.user?.id,
      method: req.method,
      contentType: req.headers['content-type']
    });

    // Double-check session is valid
    if (!req.session || !req.session.user) {
      console.error('❌ Session lost during profile update');
      if (req.file && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
          console.log('🗑️ Deleted uploaded file due to session loss');
        } catch (err) {
          console.error('Error deleting uploaded file:', err);
        }
      }
      req.flash('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return res.redirect('/login?redirect=' + encodeURIComponent('/profile'));
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('❌ Validation errors:', errors.array());
      // If there's a validation error and a file was uploaded, delete it
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
          console.log('🗑️ Deleted uploaded file due to validation error');
        } catch (err) {
          console.error('Error deleting uploaded file after validation error:', err);
        }
      }
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/profile');
    }

    console.log('✅ Validation passed');

    const { name, phone, address, originalPhone, originalAddress } = req.body;
    const userId = getUserId(req);

    // Verify userId is still valid
    if (!userId) {
      console.error('User ID not found in session');
      if (req.file && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (err) {
          console.error('Error deleting uploaded file:', err);
        }
      }
      req.flash('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return res.redirect('/login?redirect=' + encodeURIComponent('/profile'));
    }

    try {
      // Get current user
      const stmt1 = db.prepare('SELECT * FROM users WHERE id = ?');
      const user = await stmt1.get(userId);
      if (!user) {
        // If user not found and file was uploaded, delete it
        if (req.file) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (err) {
            console.error('Error deleting uploaded file:', err);
          }
        }
        req.flash('error', 'Không tìm thấy người dùng');
        return res.redirect('/profile');
      }

      // Initialize avatarPath - will be set based on whether file is uploaded
      let avatarPath = null;

      // Handle avatar upload
      if (req.file) {
        console.log('📸 Avatar upload detected:', {
          filename: req.file.filename,
          path: req.file.path,
          size: req.file.size,
          mimetype: req.file.mimetype,
          destination: req.file.destination,
          fieldname: req.file.fieldname
        });

        // Verify file was actually saved
        if (!fs.existsSync(req.file.path)) {
          console.error('❌ Uploaded file does not exist at path:', req.file.path);
          req.flash('error', 'Có lỗi xảy ra khi lưu ảnh. Vui lòng thử lại.');
          return res.redirect('/profile');
        }

        console.log('✅ File exists at path:', req.file.path);
        console.log('✅ File size on disk:', fs.statSync(req.file.path).size, 'bytes');

        // Delete old avatar if exists (except Google avatars which are URLs)
        if (user.avatar && !user.avatar.startsWith('http') && !user.avatar.startsWith('https')) {
          const oldAvatarPath = path.join(PUBLIC_PATH, user.avatar.replace(/^\//, ''));
          console.log('🗑️ Checking old avatar path:', oldAvatarPath);
          if (fs.existsSync(oldAvatarPath)) {
            try {
              fs.unlinkSync(oldAvatarPath);
              console.log('✅ Deleted old avatar:', oldAvatarPath);
            } catch (err) {
              console.error('⚠️ Error deleting old avatar (non-critical):', err.message);
              // Don't fail the update if old avatar deletion fails
            }
          } else {
            console.log('ℹ️ Old avatar not found at path (may have been deleted already):', oldAvatarPath);
          }
        }

        // Save new avatar path (relative to public folder)
        avatarPath = `/img/avatars/${req.file.filename}`;
        console.log('💾 New avatar path to save:', avatarPath);
        console.log('💾 Current user avatar before update:', user.avatar);
      } else {
        // No file uploaded - keep existing avatar
        avatarPath = user.avatar || null;
        console.log('ℹ️ No avatar file uploaded, keeping existing avatar:', avatarPath);
        console.log('ℹ️ req.file is:', req.file);
        console.log('ℹ️ Request content-type:', req.headers['content-type']);
        console.log('ℹ️ Request body keys:', Object.keys(req.body || {}));
      }

      // Update profile info - always update with form values
      // This ensures data is saved correctly
      const updateName = (name && name.trim()) ? name.trim() : user.name;
      const updatePhone = (phone && phone.trim()) ? phone.trim() : null;
      const updateAddress = (address && address.trim()) ? address.trim() : null;

      // Use pool.query directly for PostgreSQL to ensure data is saved
      console.log('Updating user profile:', {
        userId,
        updateName,
        updatePhone: updatePhone ? '***' : null,
        updateAddress: updateAddress ? '***' : null,
        avatarPath
      });

      // Execute update using pool.query directly
      // avatarPath is already set correctly above:
      // - If req.file exists: avatarPath = `/img/avatars/${req.file.filename}`
      // - If req.file doesn't exist: avatarPath = user.avatar || null
      console.log('💾 Executing database update with values:', {
        updateName,
        updatePhone: updatePhone ? '***' : null,
        updateAddress: updateAddress ? '***' : null,
        avatarPath: avatarPath || 'NULL',
        userId,
        hasFile: !!req.file,
        currentAvatar: user.avatar,
        avatarWillChange: avatarPath !== user.avatar
      });

      const updateResult = await pool.query(
        `UPDATE users 
         SET name = $1, phone = $2, address = $3, avatar = $4, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $5`,
        [updateName, updatePhone || null, updateAddress || null, avatarPath, userId]
      );

      // LƯU VÀO FILE TRONG DATA/
      dataManager.updateItem('users', userId, {
        name: updateName,
        phone: updatePhone || null,
        address: updateAddress || null,
        avatar: avatarPath,
        updated_at: new Date().toISOString()
      });

      // UPDATE SESSION USER để hiển thị ngay lập tức
      if (req.session.user) {
        req.session.user.name = updateName;
        req.session.user.avatar = avatarPath;
        // Save session to persist changes
        await new Promise((resolve, reject) => {
          req.session.save((err) => {
            if (err) {
              console.error('Error saving session after profile update:', err);
              reject(err);
            } else {
              console.log('✅ Session saved after profile update');
              resolve();
            }
          });
        });
      }

      console.log('📊 Database update result:', {
        rowCount: updateResult.rowCount || 0,
        userId,
        success: (updateResult.rowCount || 0) > 0
      });

      if ((updateResult.rowCount || 0) === 0) {
        console.warn('⚠️ Database update returned 0 changes - user may not exist or no changes made');
        console.warn('⚠️ This might be because all values are the same as before');
      }

      // Verify update was successful by fetching updated user
      const stmt3 = db.prepare('SELECT * FROM users WHERE id = ?');
      const updatedUser = await stmt3.get(userId);

      if (!updatedUser) {
        console.error('❌ User not found after update - this should not happen');
        throw new Error('User not found after update');
      }

      console.log('✅ Updated user from database:', {
        id: updatedUser.id,
        name: updatedUser.name,
        avatar: updatedUser.avatar,
        phone: updatedUser.phone ? '***' : null,
        address: updatedUser.address ? '***' : null
      });

      // Verify avatar was saved correctly
      console.log('🔍 Verifying avatar update:', {
        hadFileUpload: !!req.file,
        avatarPathInRequest: avatarPath,
        avatarPathInDatabase: updatedUser.avatar,
        match: avatarPath === updatedUser.avatar
      });

      if (req.file) {
        // We uploaded a new file, verify it was saved
        const savedAvatarPath = updatedUser.avatar;
        if (savedAvatarPath !== avatarPath) {
          console.error('❌ Avatar path mismatch!', {
            expected: avatarPath,
            actual: savedAvatarPath,
            issue: 'Database avatar does not match what we tried to save'
          });
          req.flash('error', 'Có lỗi xảy ra khi lưu avatar. Vui lòng thử lại.');
          // Don't redirect yet, let it continue to show the error
        } else {
          console.log('✅ Avatar path matches in database:', savedAvatarPath);
        }

        // Double-check file exists on disk
        const avatarFilePath = path.join(PUBLIC_PATH, avatarPath.replace(/^\//, ''));
        if (fs.existsSync(avatarFilePath)) {
          const fileStats = fs.statSync(avatarFilePath);
          console.log('✅ Avatar file verified on disk:', {
            path: avatarFilePath,
            size: fileStats.size,
            created: fileStats.birthtime
          });
        } else {
          console.error('❌ Avatar file NOT found on disk:', avatarFilePath);
          console.error('❌ This is a critical error - file was uploaded but not found!');
          req.flash('error', 'File ảnh đã được upload nhưng không tìm thấy trên server. Vui lòng thử lại.');
        }
      } else {
        // No file upload, just verify existing avatar is preserved
        if (updatedUser.avatar !== user.avatar) {
          console.warn('⚠️ Avatar changed without file upload:', {
            old: user.avatar,
            new: updatedUser.avatar
          });
        } else {
          console.log('✅ Existing avatar preserved:', updatedUser.avatar);
        }
      }

      // Update session with new user data
      req.session.user = {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        avatar: updatedUser.avatar || null
      };

      console.log('✅ Session updated:', {
        userId: req.session.user.id,
        name: req.session.user.name,
        avatar: req.session.user.avatar
      });

      if (req.file) {
        req.flash('success', 'Đã cập nhật thông tin và avatar thành công');
      } else {
        req.flash('success', 'Đã cập nhật thông tin thành công');
      }

      // Redirect with cache-busting query parameter to force reload
      console.log('🔄 Redirecting to profile page with cache-busting timestamp');
      res.redirect('/profile?t=' + Date.now());
    } catch (err) {
      console.error('Profile update error:', err);
      // If there's an error and file was uploaded, delete it
      if (req.file && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
          console.log('Deleted uploaded file due to error');
        } catch (deleteErr) {
          console.error('Error deleting uploaded file:', deleteErr);
        }
      }
      req.flash('error', 'Có lỗi xảy ra khi cập nhật thông tin: ' + err.message);
      res.redirect('/profile');
    }
  }
);

// Change password (separate route)
app.post('/profile/change-password', requireAuth,
  body('current_password').notEmpty().withMessage('Vui lòng nhập mật khẩu hiện tại'),
  body('new_password').isLength({ min: 6 }).withMessage('Mật khẩu mới tối thiểu 6 ký tự'),
  body('confirm_password').custom((value, { req }) => {
    if (value !== req.body.new_password) {
      throw new Error('Mật khẩu xác nhận không khớp');
    }
    return true;
  }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/profile');
    }

    const { current_password, new_password } = req.body;
    const userId = getUserId(req);

    try {
      // Get current user
      const stmt1 = db.prepare('SELECT * FROM users WHERE id = ?');
      const user = await stmt1.get(userId);
      if (!user) {
        req.flash('error', 'Không tìm thấy người dùng');
        return res.redirect('/profile');
      }

      // Check if user has password (not Google login)
      if (user.google_id) {
        req.flash('error', 'Tài khoản đăng nhập bằng Google không thể đổi mật khẩu');
        return res.redirect('/profile');
      }

      // Verify current password
      if (!bcrypt.compareSync(current_password, user.password_hash)) {
        req.flash('error', 'Mật khẩu hiện tại không đúng');
        return res.redirect('/profile');
      }

      // Update password - use pool.query directly
      const newPasswordHash = bcrypt.hashSync(new_password, 10);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newPasswordHash, userId]
      );

      // LƯU VÀO FILE TRONG DATA/
      dataManager.updateItem('users', userId, {
        password_hash: newPasswordHash,
        updated_at: new Date().toISOString()
      });

      req.flash('success', 'Đã đổi mật khẩu thành công');
      res.redirect('/profile');
    } catch (err) {
      console.error('Password change error:', err);
      req.flash('error', 'Có lỗi xảy ra khi đổi mật khẩu');
      res.redirect('/profile');
    }
  }
);

app.get('/orders', requireAuth, async (req, res) => {
  try {
    // Check if user needs to verify password first
    const needsPasswordVerification = !req.session.ordersPasswordVerified;

    // If password not verified, only show password form
    if (needsPasswordVerification) {
      return res.render('orders', {
        title: 'Lịch sử giao dịch - SafeKeyS',
        orders: [],
        itemsByOrder: {},
        keysByProduct: {},
        keyDisplayTitle: '',
        keyDisplayMessage: '',
        needsPasswordVerification: true
      });
    }

    // Password verified - load and display transaction history
    // Filter out pending orders - only show paid/completed orders
    const userId = getUserId(req);

    console.log('🔍 Loading orders for user:', userId);

    // First, check all orders for this user (for debugging)
    const stmtAll = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC');
    const allOrders = await stmtAll.all(userId);
    console.log('📋 All orders for user:', {
      userId,
      totalOrders: allOrders.length,
      orders: allOrders.map(o => ({ id: o.id, status: o.status, total_cents: o.total_cents, created_at: o.created_at }))
    });

    // Filter for paid/completed orders only
    const stmt1 = db.prepare('SELECT * FROM orders WHERE user_id = ? AND (status = ? OR status = ?) ORDER BY id DESC');
    const orders = await stmt1.all(userId, 'paid', 'completed');

    console.log('✅ Paid/Completed orders:', {
      userId,
      count: orders.length,
      orders: orders.map(o => ({ id: o.id, status: o.status, total_cents: o.total_cents }))
    });

    const itemsByOrder = {};
    const keysByOrderItem = {}; // Keys by order_item_id (array of keys)
    const qItems = db.prepare(`SELECT oi.*, p.title, p.image FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id = ?`);

    for (const o of orders) {
      itemsByOrder[o.id] = await qItems.all(o.id);
      console.log(`📦 Order #${o.id} items:`, itemsByOrder[o.id].length);

      // Get keys from order_keys table for each order_item
      for (const item of itemsByOrder[o.id]) {
        const keysStmt = db.prepare('SELECT key_value FROM order_keys WHERE order_item_id = ? ORDER BY id');
        const keys = await keysStmt.all(item.id);
        if (keys && keys.length > 0) {
          keysByOrderItem[item.id] = keys.map(k => k.key_value);
          console.log(`🔑 Found ${keys.length} key(s) for order_item #${item.id}`);
        }
      }
    }

    // Get key display settings
    const keyDisplayTitle = await getSetting('key_display_title') || '🔑 Key của bạn';
    const keyDisplayMessage = await getSetting('key_display_message') || 'Key đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư spam nếu không thấy.';

    res.render('orders', {
      title: 'Lịch sử giao dịch - SafeKeyS',
      orders,
      itemsByOrder,
      keysByOrderItem,
      keyDisplayTitle,
      keyDisplayMessage,
      needsPasswordVerification: false
    });
  } catch (error) {
    console.error('Error loading orders:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải lịch sử giao dịch');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// Password verification for viewing keys
app.post('/orders/verify-password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const userId = getUserId(req);

    // Get user's password hash
    const stmt = db.prepare('SELECT password_hash FROM users WHERE id=?');
    const user = await stmt.get(userId);

    if (!user || !user.password_hash) {
      req.flash('error', 'Không tìm thấy tài khoản');
      return res.redirect('/orders');
    }

    // Verify password
    if (bcrypt.compareSync(password, user.password_hash)) {
      req.session.ordersPasswordVerified = true;
      req.flash('success', 'Xác thực thành công');
      return res.redirect('/orders');
    } else {
      req.flash('error', 'Mật khẩu không đúng');
      return res.redirect('/orders');
    }
  } catch (error) {
    console.error('Error verifying password:', error);
    req.flash('error', 'Có lỗi xảy ra khi xác thực');
    res.redirect('/orders');
  }
});

// Order keys page - Display keys after successful payment
app.get('/orders/:orderId/keys', requireAuth, async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const userId = getUserId(req);

    // Get order
    const stmt1 = db.prepare('SELECT * FROM orders WHERE id=?');
    const order = await stmt1.get(orderId);

    if (!order) {
      req.flash('error', 'Giao dịch không tồn tại');
      return res.redirect('/orders');
    }

    // Check if user owns this order or is admin
    const isAdmin = req.user && req.user.role === 'admin';
    if (order.user_id !== userId && !isAdmin) {
      req.flash('error', 'Bạn không có quyền xem giao dịch này');
      return res.redirect('/orders');
    }

    // Get order items with product info
    const stmt2 = db.prepare(`
      SELECT oi.*, p.title, p.image
      FROM order_items oi 
      JOIN products p ON p.id=oi.product_id 
      WHERE oi.order_id=?
    `);
    const items = await stmt2.all(orderId);

    // Get keys from order_keys table for each order_item
    const keysByOrderItem = {};
    for (const item of items) {
      const keysStmt = db.prepare('SELECT key_value FROM order_keys WHERE order_item_id = ? ORDER BY id');
      const keys = await keysStmt.all(item.id);
      if (keys && keys.length > 0) {
        keysByOrderItem[item.id] = keys.map(k => k.key_value);
        console.log(`🔑 Found ${keys.length} key(s) for order_item #${item.id}`);
      }
    }

    // Get key display settings
    const keyDisplayTitle = await getSetting('key_display_title') || '🔑 Key của bạn';
    const keyDisplayMessage = await getSetting('key_display_message') || 'Key đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư spam nếu không thấy.';

    res.render('order-keys', {
      title: `Key giao dịch #${orderId} - SafeKeyS`,
      order,
      items,
      keysByOrderItem, // Changed from keysByOrderItem
      keyDisplayTitle,
      keyDisplayMessage
    });
  } catch (error) {
    console.error('Error loading order keys:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải key giao dịch');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// Removed: User cancel order - không cần hủy đơn hàng

// Removed: Admin update order status - không cần quản lý đơn hàng

// Admin update product key (each product has 1 key)
app.post('/admin/products/:productId/key', requireAdmin, requireKeysPassword, async (req, res) => {
  try {
    const productId = req.params.productId;
    const { key_value } = req.body;

    // Verify product exists
    const stmt1 = db.prepare('SELECT * FROM products WHERE id=?');
    const product = await stmt1.get(productId);
    if (!product) {
      req.flash('error', 'Sản phẩm không tồn tại');
      return res.redirect('/admin/keys');
    }

    // Update product key (removed updated_at as it doesn't exist in products table)
    const stmt2 = db.prepare('UPDATE products SET key_value = ? WHERE id = ?');
    await stmt2.run(key_value ? key_value.trim() : null, productId);
    req.flash('success', 'Đã cập nhật key cho sản phẩm thành công');
  } catch (error) {
    console.error('Error updating product key:', error);
    req.flash('error', 'Lỗi khi cập nhật key: ' + error.message);
  }

  res.redirect('/admin/keys');
});

// Admin delete product key
app.post('/admin/products/:productId/key/delete', requireAdmin, requireKeysPassword, async (req, res) => {
  try {
    const productId = req.params.productId;
    // Removed updated_at as it doesn't exist in products table
    const stmt = db.prepare('UPDATE products SET key_value = NULL WHERE id = ?');
    await stmt.run(productId);
    req.flash('success', 'Đã xóa key thành công');
  } catch (error) {
    console.error('Error deleting product key:', error);
    req.flash('error', 'Lỗi khi xóa key: ' + error.message);
  }

  res.redirect('/admin/keys');
});

// Removed: Admin delete order - không cần quản lý đơn hàng

// ==================== Admin Keys Management - Password Protected ====================
// MUST be registered BEFORE /admin route to ensure correct route matching
const KEYS_MANAGEMENT_PASSWORD = '141514';

// Middleware to check keys management password
function requireKeysPassword(req, res, next) {
  console.log('🔒 requireKeysPassword middleware called');
  console.log('🔒 Session keysPasswordVerified:', req.session.keysPasswordVerified);
  console.log('🔒 Request path:', req.path);
  console.log('🔒 Request method:', req.method);
  console.log('🔒 Request originalUrl:', req.originalUrl);

  if (req.session.keysPasswordVerified) {
    console.log('🔒 Password verified, proceeding...');
    return next();
  }

  // Show password form - render directly without layout to avoid conflicts
  console.log('🔒 Password not verified, showing password form');
  // Get CSRF token safely
  let csrfToken = '';
  try {
    if (req.csrfToken && typeof req.csrfToken === 'function') {
      csrfToken = req.csrfToken();
    } else if (res.locals.csrfToken) {
      csrfToken = res.locals.csrfToken;
    }
  } catch (e) {
    // CSRF token not available, use empty string
    csrfToken = '';
  }
  const hasError = req.query.error === '1' || req.query.error === 'true';

  // Disable layout for this route by setting res.locals.layout to false
  res.locals.layout = false;

  // Render without layout - use callback to bypass layout middleware
  return res.render('admin/keys-password-standalone', {
    title: 'Xác thực mật khẩu - Quản lý Key',
    error: hasError,
    csrfToken: csrfToken
  }, (err, html) => {
    if (err) {
      console.error('Error rendering password form:', err);
      // Send minimal HTML error page
      return res.status(500).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lỗi</title><style>body{font-family:Arial;padding:40px;text-align:center;background:#0f172a;color:#e5e7eb;}</style></head><body><h1>Lỗi hiển thị form</h1><p>${err.message}</p><a href="/admin" style="color:#16a34a;">Quay lại Admin</a></body></html>`);
    }
    // Send HTML directly without layout
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

// Keys management password verification
app.post('/admin/keys/verify', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;

    if (password === KEYS_MANAGEMENT_PASSWORD) {
      req.session.keysPasswordVerified = true;
      res.redirect('/admin/keys');
    } else {
      res.redirect('/admin/keys?error=1');
    }
  } catch (error) {
    console.error('Error verifying password:', error);
    res.redirect('/admin/keys?error=1');
  }
});

// Logout from keys management
app.post('/admin/keys/logout', requireAdmin, (req, res) => {
  delete req.session.keysPasswordVerified;
  res.redirect('/admin');
});

// Keys management page - MUST be registered before /admin route
app.get('/admin/keys', requireAdmin, requireKeysPassword, async (req, res) => {
  console.log('🔑 Accessing /admin/keys route - SUCCESS!');
  try {
    // Get all products with their keys (each product has 1 key stored in key_value column)
    const products = await db.prepare(`
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.id DESC
    `).all();

    // Get order count for each product
    const orderCounts = {};
    const qOrderCount = db.prepare(`
      SELECT product_id, COUNT(*) as count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('paid', 'completed') AND oi.product_id = ?
      GROUP BY product_id
    `);

    for (const product of products) {
      const countResult = await qOrderCount.get(product.id);
      orderCounts[product.id] = countResult ? parseInt(countResult.count) : 0;
    }

    // Get key display settings
    const keyDisplayTitle = await getSetting('key_display_title') || '🔑 Key của bạn';
    const keyDisplayMessage = await getSetting('key_display_message') || 'Key đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư spam nếu không thấy.';

    res.render('admin/keys', {
      title: 'Quản lý Key - SafeKeyS',
      products,
      orderCounts,
      keyDisplayTitle,
      keyDisplayMessage
    });
  } catch (error) {
    console.error('Error loading keys management:', error);
    req.flash('error', 'Lỗi khi tải trang quản lý key: ' + error.message);
    res.redirect('/admin');
  }
});

// Save key display settings
app.post('/admin/keys/settings', requireAdmin, requireKeysPassword, async (req, res) => {
  try {
    const { key_display_title, key_display_message } = req.body;

    if (!key_display_title || !key_display_title.trim()) {
      req.flash('error', 'Tiêu đề không được để trống');
      return res.redirect('/admin/keys');
    }

    if (!key_display_message || !key_display_message.trim()) {
      req.flash('error', 'Thông báo không được để trống');
      return res.redirect('/admin/keys');
    }

    await setSetting('key_display_title', key_display_title.trim());
    await setSetting('key_display_message', key_display_message.trim());

    req.flash('success', 'Đã lưu cài đặt hiển thị key thành công!');
    res.redirect('/admin/keys');
  } catch (error) {
    console.error('Error saving key settings:', error);
    req.flash('error', 'Lỗi khi lưu cài đặt: ' + error.message);
    res.redirect('/admin/keys');
  }
});
// ==================== End Admin Keys Management ====================

// Admin minimal - MUST be after /admin/keys
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    console.log('📊 Accessing /admin dashboard');
    const stmt1 = db.prepare('SELECT COUNT(*) as c FROM products');
    const prodCount = (await stmt1.get()).c;
    const stmt2 = db.prepare('SELECT COUNT(*) as c FROM categories');
    const catCount = (await stmt2.get()).c;
    const stmt3 = db.prepare('SELECT COUNT(*) as c FROM users');
    const userCount = (await stmt3.get()).c;

    // Calculate revenue - only count paid/completed orders
    const stmt5 = db.prepare("SELECT COALESCE(SUM(total_cents), 0) as total FROM orders WHERE status IN ('paid', 'completed')");
    const revenueRow = await stmt5.get();
    const totalRevenue = revenueRow ? revenueRow.total : 0;

    // Calculate stock
    const stmt6 = db.prepare('SELECT COALESCE(SUM(stock), 0) as total FROM products');
    const stockRow = await stmt6.get();
    const totalStock = stockRow ? stockRow.total : 0;

    // Out of stock count
    const stmt7 = db.prepare('SELECT COUNT(*) as c FROM products WHERE stock = 0');
    const outOfStockCount = (await stmt7.get()).c;

    // In stock count
    const stmt8 = db.prepare('SELECT COUNT(*) as c FROM products WHERE stock > 0');
    const inStockCount = (await stmt8.get()).c;

    // Today's orders - use PostgreSQL date casting
    const today = new Date().toISOString().split('T')[0];
    const stmt9 = db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = DATE(?)");
    const todayOrdersCount = (await stmt9.get(today)).c;

    // New users (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const stmt10 = db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at >= ?');
    const newUsersCount = (await stmt10.get(sevenDaysAgo.toISOString())).c;

    res.render('admin/dashboard', {
      title: 'Admin - SafeKeyS',
      prodCount,
      catCount,
      userCount,
      totalRevenue: Math.floor(totalRevenue / 100), // Convert cents to VND
      totalStock,
      outOfStockCount,
      inStockCount,
      todayOrdersCount,
      newUsersCount
    });
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải dashboard');
    res.status(500).render('500', { title: 'Lỗi Server - SafeKeyS' });
  }
});

// Admin revenue management with charts
app.get('/admin/revenue', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || 'month'; // day, week, month, year
    const status = req.query.status || '';

    // Calculate date range based on period
    const now = new Date();
    let startDate = new Date();
    switch (period) {
      case 'day':
        startDate.setDate(now.getDate() - 7);
        break;
      case 'week':
        startDate.setDate(now.getDate() - 30);
        break;
      case 'month':
        startDate.setMonth(now.getMonth() - 6);
        break;
      case 'year':
        startDate.setFullYear(now.getFullYear() - 2);
        break;
    }

    // Get revenue stats
    let revenueStats;
    let revenueStatsQuery = `
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(total_cents), 0) as total_revenue,
        COUNT(CASE WHEN status IN ('paid', 'completed') THEN 1 END) as paid_orders,
        COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN total_cents ELSE 0 END), 0) as paid_revenue,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
        AVG(CASE WHEN status IN ('paid', 'completed') THEN total_cents ELSE NULL END) as avg_order_value
      FROM orders
    `;
    if (status) {
      revenueStatsQuery += ' WHERE status = ?';
      revenueStats = await db.prepare(revenueStatsQuery).get(status);
    } else {
      revenueStats = await db.prepare(revenueStatsQuery).get();
    }

    // Get daily revenue for chart - use DATE() function for PostgreSQL
    const chartData = await db.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as order_count,
        COALESCE(SUM(total_cents), 0) as revenue
      FROM orders
      WHERE status IN ('paid', 'completed') AND created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(startDate.toISOString());

    // Get monthly revenue for chart
    const monthlyData = await db.prepare(`
      SELECT 
        TO_CHAR(created_at, 'YYYY-MM') as month,
        COUNT(*) as order_count,
        COALESCE(SUM(total_cents), 0) as revenue
      FROM orders
      WHERE status IN ('paid', 'completed') AND created_at >= ?::timestamp
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month ASC
    `).all(startDate.toISOString());

    res.render('admin/revenue', {
      title: 'Quản lý doanh thu - SafeKeyS',
      period,
      status,
      revenueStats: {
        totalOrders: parseInt(revenueStats.total_orders) || 0,
        totalRevenue: Math.floor((parseInt(revenueStats.total_revenue) || 0) / 100),
        paidOrders: parseInt(revenueStats.paid_orders) || 0,
        paidRevenue: Math.floor((parseInt(revenueStats.paid_revenue) || 0) / 100),
        pendingOrders: parseInt(revenueStats.pending_orders) || 0,
        cancelledOrders: parseInt(revenueStats.cancelled_orders) || 0,
        avgOrderValue: Math.floor((parseInt(revenueStats.avg_order_value) || 0) / 100)
      },
      chartData: chartData.map(d => ({
        date: d.date,
        orders: parseInt(d.order_count) || 0,
        revenue: Math.floor((parseInt(d.revenue) || 0) / 100)
      })),
      monthlyData: monthlyData.map(d => ({
        month: d.month,
        orders: parseInt(d.order_count) || 0,
        revenue: Math.floor((parseInt(d.revenue) || 0) / 100)
      }))
    });
  } catch (error) {
    console.error('Error loading revenue:', error);
    req.flash('error', 'Lỗi khi tải trang doanh thu');
    res.redirect('/admin');
  }
});

// Removed: Admin orders list - không cần quản lý đơn hàng

// Admin users list
// Admin: View user's order history
app.get('/admin/users/:userId/orders', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      req.flash('error', 'ID người dùng không hợp lệ');
      return res.redirect('/admin/users');
    }

    // Get user info
    const userStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const user = await userStmt.get(userId);

    if (!user) {
      req.flash('error', 'Không tìm thấy người dùng');
      return res.redirect('/admin/users');
    }

    // Get all orders for this user
    const ordersStmt = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC');
    const orders = await ordersStmt.all(userId);

    // Get order items and keys
    const itemsByOrder = {};
    const keysByProduct = {};
    const qItems = db.prepare(`SELECT oi.*, p.title, p.image, p.key_value FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id = ?`);

    for (const o of orders) {
      itemsByOrder[o.id] = await qItems.all(o.id);
      for (const item of itemsByOrder[o.id]) {
        if (item.key_value) {
          if (!keysByProduct[item.product_id]) {
            keysByProduct[item.product_id] = item.key_value;
          }
        }
      }
    }

    res.render('admin/user-orders', {
      title: `Lịch sử giao dịch - ${user.name}`,
      user,
      orders,
      itemsByOrder,
      keysByProduct
    });
  } catch (error) {
    console.error('Error loading user orders:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải lịch sử giao dịch');
    res.redirect('/admin/users');
  }
});

app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = 20;

    let whereClause = '';
    let params = [];

    if (q) {
      whereClause = 'WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ?';
      params = [`%${q}%`, `%${q}%`];
    }

    const total = (await db.prepare(`SELECT COUNT(*) as c FROM users ${whereClause}`).get(...params)).c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    const users = await db.prepare(`
      SELECT u.*, 
             (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as order_count,
             (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE user_id = u.id AND status IN ('paid', 'completed')) as total_spent
      FROM users u
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    // Check lockout status for each user
    const usersWithLockStatus = users.map(user => {
      const attempt = loginAttempts.get(user.email.toLowerCase().trim());
      const isLocked = attempt && attempt.lockedUntil > Date.now();
      const remainingMinutes = isLocked ? Math.ceil((attempt.lockedUntil - Date.now()) / 60000) : 0;
      return {
        ...user,
        isLocked,
        remainingMinutes,
        lockoutReason: attempt?.reason || null
      };
    });

    res.render('admin/users', {
      title: 'Quản lý người dùng - SafeKeyS',
      users: usersWithLockStatus,
      q,
      page,
      totalPages,
      total
    });
  } catch (error) {
    console.error('Error loading users:', error);
    req.flash('error', 'Lỗi khi tải danh sách người dùng');
    res.redirect('/admin');
  }
});

// Admin unlock user account
app.post('/admin/users/:email/unlock', requireAdmin, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase().trim();
    loginAttempts.delete(email);
    req.flash('success', `Đã mở khóa tài khoản: ${email}`);
  } catch (error) {
    console.error('Error unlocking user:', error);
    req.flash('error', 'Lỗi khi mở khóa tài khoản');
  }
  res.redirect('/admin/users');
});

// Admin lockout settings page
app.get('/admin/lockout-settings', requireAdmin, async (req, res) => {
  try {
    const maxAttempts = parseInt(await getSetting('lockout_max_attempts', '3')) || 3;
    const durationMinutes = parseInt(await getSetting('lockout_duration_minutes', '5')) || 5;
    const reason = await getSetting('lockout_reason', 'Tài khoản đã bị khóa do nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau.');

    // Get locked accounts
    const lockedAccounts = [];
    const now = Date.now();
    for (const [email, attempt] of loginAttempts.entries()) {
      if (attempt.lockedUntil > now) {
        const remainingMinutes = Math.ceil((attempt.lockedUntil - now) / 60000);
        lockedAccounts.push({
          email,
          remainingMinutes,
          reason: attempt.reason || reason,
          lockedUntil: new Date(attempt.lockedUntil).toLocaleString('vi-VN')
        });
      }
    }

    res.render('admin/lockout-settings', {
      title: 'Cài đặt khóa tài khoản - SafeKeyS',
      maxAttempts,
      durationMinutes,
      reason,
      lockedAccounts
    });
  } catch (error) {
    console.error('Error loading lockout settings:', error);
    req.flash('error', 'Lỗi khi tải cài đặt khóa tài khoản');
    res.redirect('/admin');
  }
});

// Admin save lockout settings
app.post('/admin/lockout-settings', requireAdmin, async (req, res) => {
  try {
    const { max_attempts, duration_minutes, reason } = req.body;

    if (!max_attempts || parseInt(max_attempts) < 1) {
      req.flash('error', 'Số lần thử tối đa phải lớn hơn 0');
      return res.redirect('/admin/lockout-settings');
    }

    if (!duration_minutes || parseInt(duration_minutes) < 1) {
      req.flash('error', 'Thời gian khóa phải lớn hơn 0 phút');
      return res.redirect('/admin/lockout-settings');
    }

    if (!reason || !reason.trim()) {
      req.flash('error', 'Lý do khóa không được để trống');
      return res.redirect('/admin/lockout-settings');
    }

    await setSetting('lockout_max_attempts', String(parseInt(max_attempts)));
    await setSetting('lockout_duration_minutes', String(parseInt(duration_minutes)));
    await setSetting('lockout_reason', reason.trim());

    // Update existing locked accounts with new reason
    for (const [email, attempt] of loginAttempts.entries()) {
      if (attempt.lockedUntil > Date.now()) {
        attempt.reason = reason.trim();
        loginAttempts.set(email, attempt);
      }
    }

    req.flash('success', 'Đã lưu cài đặt khóa tài khoản thành công!');
    res.redirect('/admin/lockout-settings');
  } catch (error) {
    console.error('Error saving lockout settings:', error);
    req.flash('error', 'Lỗi khi lưu cài đặt: ' + error.message);
    res.redirect('/admin/lockout-settings');
  }
});

// Admin settings: pages + social links
app.get('/admin/settings', requireAdmin, async (req, res) => {
  try {
    // Load social media list (JSON) or migrate from old format
    let socialMediaList = [];
    const socialMediaJson = await getSetting('social_media_list', '');
    if (socialMediaJson) {
      try {
        socialMediaList = JSON.parse(socialMediaJson);
      } catch (e) {
        console.error('Error parsing social media list:', e);
      }
    }

    // Migrate old format if exists and list is empty
    if (socialMediaList.length === 0) {
      const fb = await getSetting('social_facebook', '');
      const zalo = await getSetting('social_zalo', '');
      const yt = await getSetting('social_youtube', '');
      if (fb || zalo || yt) {
        if (fb) socialMediaList.push({ name: 'Facebook', url: fb, icon: await getSetting('social_facebook_icon', '') });
        if (zalo) socialMediaList.push({ name: 'Zalo', url: zalo, icon: await getSetting('social_zalo_icon', '') });
        if (yt) socialMediaList.push({ name: 'YouTube', url: yt, icon: await getSetting('social_youtube_icon', '') });
      }
    }

    // Always load fresh settings from database
    const settings = {
      page_about: await getSetting('page_about', ''),
      page_policy: await getSetting('page_policy', ''),
      page_payment: await getSetting('page_payment', ''),
      page_contact: await getSetting('page_contact', ''),
      social_media_list: socialMediaList,
      homepage_hero_title: await getSetting('homepage_hero_title', 'SafeKeyS'),
      homepage_hero_subtitle: await getSetting('homepage_hero_subtitle', 'Mua key phần mềm, game nhanh chóng - Uy tín - Nhanh gọn - Hỗ trợ 24/7'),
      homepage_hero_features: await getSetting('homepage_hero_features', 'Thanh toán an toàn•Giao key ngay lập tức•Bảo hành chính hãng'),
      homepage_carousel_title: await getSetting('homepage_carousel_title', 'Sản phẩm nổi bật'),
      homepage_carousel_subtitle: await getSetting('homepage_carousel_subtitle', 'Khám phá những sản phẩm hot nhất hiện nay')
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
]), async (req, res) => {
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
        const existing = await getSetting(key, '');
        iconSettings[key] = existing;
      }
    }

    // Save settings
    const fields = ['page_about', 'page_policy', 'page_payment', 'page_contact', 'social_facebook', 'social_zalo', 'social_youtube', 'homepage_hero_title', 'homepage_hero_subtitle', 'homepage_hero_features', 'homepage_carousel_title', 'homepage_carousel_subtitle'];
    const savedSettings = {};
    for (const k of fields) {
      const value = (req.body[k] || '').trim();
      try {
        await setSetting(k, value);
        savedSettings[k] = value;
      } catch (err) {
        console.error(`Error saving setting ${k}:`, err);
      }
    }

    // Save icon settings
    for (const k of Object.keys(iconSettings)) {
      try {
        await setSetting(k, iconSettings[k]);
        savedSettings[k] = iconSettings[k];
      } catch (err) {
        console.error(`Error saving icon setting ${k}:`, err);
      }
    }

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

app.get('/admin/products', requireAdmin, async (req, res) => {
  try {
    const stmt1 = db.prepare(`SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.id DESC`);
    const products = await stmt1.all();
    const stmt2 = db.prepare('SELECT * FROM categories');
    const categories = await stmt2.all();
    res.render('admin/products', { title: 'Quản lý sản phẩm', products, categories });
  } catch (error) {
    console.error('Error loading products:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải danh sách sản phẩm');
    res.redirect('/admin');
  }
});

app.post('/admin/products', requireAdmin,
  body('title').trim().isLength({ min: 1, max: 255 }).withMessage('Tiêu đề không được để trống và tối đa 255 ký tự'),
  body('slug').trim().matches(/^[a-z0-9-]+$/).withMessage('Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  body('price_vnd').isFloat({ min: 0 }).withMessage('Giá phải là số dương'),
  body('stock').optional().isInt({ min: 0 }).withMessage('Tồn kho phải là số nguyên dương'),
  body('image').optional().isURL().withMessage('URL ảnh không hợp lệ'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/admin/products');
    }

    const { title, slug, description, price_vnd, image, category_id, stock } = req.body;

    try {
      // Check slug uniqueness
      const stmt1 = db.prepare('SELECT id FROM products WHERE slug = ?');
      const existingSlug = await stmt1.get(slug);
      if (existingSlug) {
        req.flash('error', 'Slug đã tồn tại, vui lòng chọn slug khác');
        return res.redirect('/admin/products');
      }

      // Convert VND to cents (admin enters VND, we store as cents)
      const priceCents = Math.max(0, Math.round(Number(price_vnd || 0) * 100));

      // Use pool.query with RETURNING id for PostgreSQL
      const result = await pool.query(
        'INSERT INTO products (title, slug, description, price_cents, image, category_id, active, stock) VALUES ($1, $2, $3, $4, $5, $6, 1, $7) RETURNING id',
        [
          title.trim(),
          slug.trim(),
          description ? description.trim() : null,
          priceCents,
          image ? image.trim() : null,
          category_id ? Number(category_id) : null,
          Math.max(0, parseInt(String(stock || 0), 10))
        ]
      );
      const productId = result.rows[0]?.id;

      // LƯU VÀO FILE TRONG DATA/
      if (productId) {
        dataManager.addItem('products', {
          id: productId,
          title: title.trim(),
          slug: slug.trim(),
          description: description ? description.trim() : null,
          price_cents: priceCents,
          image: image ? image.trim() : null,
          category_id: category_id ? Number(category_id) : null,
          active: 1,
          stock: Math.max(0, parseInt(String(stock || 0), 10)),
          featured: 0,
          key_value: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
      req.flash('success', 'Đã thêm sản phẩm thành công');
    } catch (err) {
      console.error('Product creation error:', err);
      req.flash('error', 'Có lỗi xảy ra khi thêm sản phẩm');
    }
    res.redirect('/admin/products');
  }
);

// Admin edit product
app.get('/admin/products/:id/edit', requireAdmin, async (req, res) => {
  try {
    const stmt1 = db.prepare('SELECT * FROM products WHERE id=?');
    const product = await stmt1.get(req.params.id);
    if (!product) return res.status(404).render('404');
    const stmt2 = db.prepare('SELECT * FROM categories');
    const categories = await stmt2.all();
    res.render('admin/product_edit', { title: 'Sửa sản phẩm', product, categories });
  } catch (error) {
    console.error('Error loading product:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải sản phẩm');
    res.redirect('/admin/products');
  }
});

app.post('/admin/products/:id/edit', requireAdmin,
  body('title').trim().isLength({ min: 1, max: 255 }).withMessage('Tiêu đề không được để trống và tối đa 255 ký tự'),
  body('slug').trim().matches(/^[a-z0-9-]+$/).withMessage('Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  body('price_vnd').isFloat({ min: 0 }).withMessage('Giá phải là số dương'),
  body('stock').optional().isInt({ min: 0 }).withMessage('Tồn kho phải là số nguyên dương'),
  body('image').optional().isURL().withMessage('URL ảnh không hợp lệ'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect(`/admin/products/${req.params.id}/edit`);
    }

    const { title, slug, description, price_vnd, image, category_id, stock, active } = req.body;
    const id = Number(req.params.id);
    // Convert VND to cents (admin enters VND, we store as cents)
    const price = Math.max(0, Math.round(Number(price_vnd || 0) * 100));
    const stockNum = Math.max(0, parseInt(String(stock || 0), 10));
    const act = active === '1' ? 1 : 0;

    if (!title || !slug) {
      req.flash('error', 'Thiếu tiêu đề hoặc slug');
      return res.redirect(`/admin/products/${id}/edit`);
    }

    try {
      const stmt1 = db.prepare('SELECT id FROM products WHERE slug=? AND id<>?');
      const conflict = await stmt1.get(slug, id);
      if (conflict) {
        req.flash('error', 'Slug đã tồn tại, vui lòng chọn slug khác');
        return res.redirect(`/admin/products/${id}/edit`);
      }
      const featured = req.body.featured === '1' ? 1 : 0;
      const stmt2 = db.prepare('UPDATE products SET title=?, slug=?, description=?, price_cents=?, image=?, category_id=?, stock=?, active=?, featured=? WHERE id=?');
      await stmt2.run(title, slug, description, price, image, category_id ? Number(category_id) : null, stockNum, act, featured, id);
      req.flash('success', 'Đã lưu sản phẩm');
    } catch (e) {
      console.error('Error updating product:', e);
      req.flash('error', 'Lỗi lưu sản phẩm');
      return res.redirect(`/admin/products/${id}/edit`);
    }
    res.redirect('/admin/products');
  });

app.post('/admin/products/:id/delete', requireAdmin, async (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM products WHERE id=?');
    await stmt.run(req.params.id);
    req.flash('success', 'Đã xóa sản phẩm');
  } catch (error) {
    console.error('Error deleting product:', error);
    req.flash('error', 'Có lỗi xảy ra khi xóa sản phẩm');
  }
  res.redirect('/admin/products');
});

app.post('/admin/products/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const stmt1 = db.prepare('SELECT active FROM products WHERE id=?');
    const p = await stmt1.get(req.params.id);
    if (p) {
      const stmt2 = db.prepare('UPDATE products SET active=? WHERE id=?');
      await stmt2.run(p.active ? 0 : 1, req.params.id);
    }
  } catch (error) {
    console.error('Error toggling product:', error);
  }
  res.redirect('/admin/products');
});

// Toggle featured product (legacy redirect)
app.post('/admin/products/:id/toggle-featured', requireAdmin, async (req, res) => {
  try {
    const stmt1 = db.prepare('SELECT featured FROM products WHERE id=?');
    const p = await stmt1.get(req.params.id);
    if (p) {
      const newFeatured = p.featured ? 0 : 1;
      const stmt2 = db.prepare('UPDATE products SET featured=? WHERE id=?');
      await stmt2.run(newFeatured, req.params.id);
      req.flash('success', newFeatured ? 'Đã đánh dấu sản phẩm nổi bật' : 'Đã bỏ đánh dấu sản phẩm nổi bật');
    }
  } catch (error) {
    console.error('Error toggling featured:', error);
  }
  res.redirect('/admin/products');
});

// AJAX API endpoints for admin products
app.post('/api/admin/products/:id/toggle-featured', requireAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const stmt1 = db.prepare('SELECT featured FROM products WHERE id=?');
    const p = await stmt1.get(productId);
    if (!p) {
      return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
    }

    const newFeatured = p.featured ? 0 : 1;
    const stmt2 = db.prepare('UPDATE products SET featured=? WHERE id=?');
    await stmt2.run(newFeatured, productId);

    res.json({
      success: true,
      message: newFeatured ? 'Đã đánh dấu sản phẩm nổi bật' : 'Đã bỏ đánh dấu sản phẩm nổi bật',
      featured: newFeatured
    });
  } catch (error) {
    console.error('Error toggling featured:', error);
    res.json({ success: false, message: 'Có lỗi xảy ra' });
  }
});

app.post('/api/admin/products/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const stmt1 = db.prepare('SELECT active FROM products WHERE id=?');
    const p = await stmt1.get(productId);
    if (!p) {
      return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
    }

    const newActive = p.active ? 0 : 1;
    const stmt2 = db.prepare('UPDATE products SET active=? WHERE id=?');
    await stmt2.run(newActive, productId);

    res.json({
      success: true,
      message: newActive ? 'Đã hiển thị sản phẩm' : 'Đã ẩn sản phẩm',
      active: newActive
    });
  } catch (error) {
    console.error('Error toggling product:', error);
    res.json({ success: false, message: 'Có lỗi xảy ra' });
  }
});

app.post('/api/admin/products/:id/delete', requireAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const stmt1 = db.prepare('SELECT id FROM products WHERE id=?');
    const p = await stmt1.get(productId);
    if (!p) {
      return res.json({ success: false, message: 'Sản phẩm không tồn tại' });
    }

    const stmt2 = db.prepare('DELETE FROM products WHERE id=?');
    await stmt2.run(productId);
    res.json({
      success: true,
      message: 'Đã xóa sản phẩm'
    });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.json({ success: false, message: 'Lỗi khi xóa sản phẩm' });
  }
});

app.get('/admin/categories', requireAdmin, async (req, res) => {
  const categories = await db.prepare(`
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
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(e => e.msg).join(', '));
      return res.redirect('/admin/categories');
    }

    const { name, slug } = req.body;
    const conflict = await db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
    if (conflict) {
      req.flash('error', 'Slug danh mục đã tồn tại');
      return res.redirect('/admin/categories');
    }
    await db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
    res.redirect('/admin/categories');
  });

app.get('/admin/categories/:id/edit', requireAdmin, async (req, res) => {
  const category = await db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!category) return res.status(404).render('404');
  res.render('admin/category_edit', { title: 'Sửa danh mục', category });
});

app.post('/admin/categories/:id/edit', requireAdmin, async (req, res) => {
  const { name, slug } = req.body;
  const conflict = await db.prepare('SELECT id FROM categories WHERE slug=? AND id<>?').get(slug, req.params.id);
  if (conflict) {
    req.flash('error', 'Slug danh mục đã tồn tại');
    return res.redirect(`/admin/categories/${req.params.id}/edit`);
  }
  await db.prepare('UPDATE categories SET name=?, slug=? WHERE id=?').run(name, slug, req.params.id);
  res.redirect('/admin/categories');
});

// Static pages
app.get('/payment', async (req, res) => {
  const html = formatPageContentToHtml(await getSetting('page_payment', ''));
  res.render('pages/payment', { title: 'Thanh toán - SafeKeyS', html });
});
app.get('/policy', async (req, res) => {
  const html = formatPageContentToHtml(await getSetting('page_policy', ''));
  res.render('pages/policy', { title: 'Chính sách - SafeKeyS', html });
});
app.get('/about', async (req, res) => {
  const html = formatPageContentToHtml(await getSetting('page_about', ''));
  res.render('pages/about', { title: 'Giới thiệu - SafeKeyS', html });
});
app.get('/contact', async (req, res) => {
  const html = formatPageContentToHtml(await getSetting('page_contact', ''));
  res.render('pages/contact', { title: 'Liên hệ - SafeKeyS', html });
});

// News table initialization moved to data/create-database.js
// All SQLite-specific initialization code has been removed

// Utilities
function slugify(input) {
  const base = (input || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'bai-viet';
  return base;
}
async function generateUniqueSlug(baseSlug, excludeId) {
  let slug = slugify(baseSlug);
  const exists = async (s) => {
    const stmt = db.prepare('SELECT id FROM news WHERE slug = ?' + (excludeId ? ' AND id<>?' : ''));
    const result = await stmt.get(excludeId ? [s, excludeId] : [s]);
    return !!result;
  };
  if (!(await exists(slug))) return slug;
  let i = 2;
  while (await exists(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

// Public news
app.get('/news', async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const pageSize = 10;
  const where = q ? 'WHERE published=1 AND (title LIKE ? OR content LIKE ?)' : 'WHERE published=1';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const total = (await db.prepare(`SELECT COUNT(*) as c FROM news ${where}`).get(...params)).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  const posts = await db.prepare(`SELECT id, title, slug, content, created_at, thumbnail FROM news ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.render('news/index', { title: 'Tin tức - SafeKeyS', posts, q, page, totalPages });
});
app.get('/news/:slug', async (req, res) => {
  const post = await db.prepare('SELECT * FROM news WHERE slug=? AND published=1').get(req.params.slug);
  if (!post) return res.status(404).render('404');
  const words = (post.content || '').split(/\s+/).filter(Boolean).length;
  const readingTimeMin = Math.max(1, Math.round(words / 200));
  res.render('news/show', { title: post.title + ' - Tin tức', post, readingTimeMin });
});

// Admin news CRUD
app.get('/admin/news', requireAdmin, async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const pageSize = 15;
  const where = q ? 'WHERE (title LIKE ? OR content LIKE ?)' : '';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const total = (await db.prepare(`SELECT COUNT(*) as c FROM news ${where}`).get(...params)).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  const posts = await db.prepare(`SELECT * FROM news ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.render('admin/news', { title: 'Quản lý Tin tức', posts, q, page, totalPages });
});
app.post('/admin/news', requireAdmin, async (req, res) => {
  try {
    const { title, slug, content, published, author, thumbnail, excerpt } = req.body;
    if (!title || !content) {
      req.flash('error', 'Thiếu tiêu đề hoặc nội dung');
      return res.redirect('/admin/news');
    }
    const finalSlug = await generateUniqueSlug(slug && slug.trim() ? slug : title);
    await db.prepare('INSERT INTO news (title, slug, content, excerpt, published, author, thumbnail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(title, finalSlug, content, excerpt || null, published === '1' ? 1 : 0, author || null, thumbnail || null);
    req.flash('success', 'Đã tạo bài viết');
    res.redirect('/admin/news');
  } catch (error) {
    console.error('❌ Lỗi khi thêm tin tức:', error);
    req.flash('error', `Lỗi khi thêm tin tức: ${error.message}`);
    res.redirect('/admin/news');
  }
});
app.get('/admin/news/:id/edit', requireAdmin, async (req, res) => {
  const post = await db.prepare('SELECT * FROM news WHERE id=?').get(req.params.id);
  if (!post) { req.flash('error', 'Bài viết không tồn tại'); return res.redirect('/admin/news'); }
  res.render('admin/news_edit', { title: 'Sửa Tin tức', post });
});
app.post('/admin/news/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { title, slug, content, published, author, thumbnail, excerpt } = req.body;
    if (!title || !content) {
      req.flash('error', 'Thiếu tiêu đề hoặc nội dung');
      return res.redirect(`/admin/news/${req.params.id}/edit`);
    }
    const finalSlug = await generateUniqueSlug(slug && slug.trim() ? slug : title, req.params.id);
    await db.prepare('UPDATE news SET title=?, slug=?, content=?, excerpt=?, published=?, author=?, thumbnail=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(title, finalSlug, content, excerpt || null, published === '1' ? 1 : 0, author || null, thumbnail || null, req.params.id);
    req.flash('success', 'Đã lưu bài viết');
    res.redirect('/admin/news');
  } catch (error) {
    console.error('❌ Lỗi khi sửa tin tức:', error);
    req.flash('error', `Lỗi khi sửa tin tức: ${error.message}`);
    res.redirect(`/admin/news/${req.params.id}/edit`);
  }
});

app.post('/admin/news/:id/toggle', requireAdmin, async (req, res) => {
  const p = await db.prepare('SELECT published FROM news WHERE id=?').get(req.params.id);
  if (p) await db.prepare('UPDATE news SET published=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.published ? 0 : 1, req.params.id);
  res.redirect('/admin/news');
});
app.post('/admin/news/:id/delete', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM news WHERE id=?').run(req.params.id);
  req.flash('success', 'Đã xóa bài viết');
  res.redirect('/admin/news');
});

// Admin view/edit user carts via session store
// Admin: View all orders
app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || '';
    const page = parseInt(req.query.page || '1', 10);
    const perPage = 20;
    const offset = (page - 1) * perPage;

    // Build query
    let query = `
      SELECT o.*, u.name as user_name, u.email as user_email
      FROM orders o
      JOIN users u ON u.id = o.user_id
    `;
    const params = [];

    if (status) {
      query += ' WHERE o.status = ?';
      params.push(status);
    }

    query += ' ORDER BY o.id DESC LIMIT ? OFFSET ?';
    params.push(perPage, offset);

    const stmt = db.prepare(query);
    const orders = await stmt.all(...params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM orders o';
    const countParams = [];
    if (status) {
      countQuery += ' WHERE o.status = ?';
      countParams.push(status);
    }
    const countStmt = db.prepare(countQuery);
    const countResult = await countStmt.get(...countParams);
    const totalOrders = countResult.total || 0;
    const totalPages = Math.ceil(totalOrders / perPage);

    // Get order items for each order
    const itemsStmt = db.prepare(`
      SELECT oi.*, p.title as product_title
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
    `);

    for (const order of orders) {
      order.items = await itemsStmt.all(order.id);
    }

    res.render('admin/orders', {
      title: 'Quản lý đơn hàng - SafeKeyS',
      orders,
      status,
      page,
      totalPages,
      totalOrders
    });
  } catch (error) {
    console.error('Error loading admin orders:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải danh sách đơn hàng');
    res.render('admin/orders', {
      title: 'Quản lý đơn hàng - SafeKeyS',
      orders: [],
      status: '',
      page: 1,
      totalPages: 0,
      totalOrders: 0
    });
  }
});

app.get('/admin/carts', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const rows = await db.prepare('SELECT sid, sess FROM sessions ORDER BY sid DESC LIMIT 200').all();
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
app.post('/admin/carts/:sid/clear', requireAdmin, async (req, res) => {
  try {
    const row = await db.prepare('SELECT sess FROM sessions WHERE sid=?').get(req.params.sid);
    if (row) {
      const s = JSON.parse(row.sess);
      if (s && s.cart) {
        s.cart = { items: {}, totalQty: 0, totalCents: 0 };
        await db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s), req.params.sid);
        req.flash('success', 'Đã xóa toàn bộ giỏ hàng');
      }
    }
  } catch (e) {
    req.flash('error', 'Lỗi xóa giỏ hàng');
  }
  res.redirect('/admin/carts');
});
app.post('/admin/carts/:sid/item/:pid/update', requireAdmin, async (req, res) => {
  try {
    const { qty } = req.body;
    const newQty = Math.max(0, parseInt(qty || '0', 10));
    const row = await db.prepare('SELECT sess FROM sessions WHERE sid=?').get(req.params.sid);
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

        await db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s), req.params.sid);
      }
    }
  } catch (e) {
    req.flash('error', 'Lỗi cập nhật sản phẩm');
  }
  res.redirect('/admin/carts');
});
app.post('/admin/carts/:sid/item/:pid/remove', requireAdmin, async (req, res) => {
  try {
    const row = await db.prepare('SELECT sess FROM sessions WHERE sid=?').get(req.params.sid);
    if (row) {
      const s = JSON.parse(row.sess);
      if (s && s.cart && s.cart.items && s.cart.items[req.params.pid]) {
        const entry = s.cart.items[req.params.pid];
        s.cart.totalQty -= entry.qty;
        s.cart.totalCents -= entry.qty * entry.product.price_cents;
        delete s.cart.items[req.params.pid];
        await db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s), req.params.sid);
        req.flash('success', 'Đã xóa sản phẩm khỏi giỏ hàng');
      }
    }
  } catch (e) {
    req.flash('error', 'Lỗi xóa sản phẩm');
  }
  res.redirect('/admin/carts');
});

app.post('/admin/categories/:id/delete', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  // Also nullify category on products
  await db.prepare('UPDATE products SET category_id=NULL WHERE category_id=?').run(req.params.id);
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

  // Database errors (PostgreSQL error codes)
  if (err.code && (err.code.startsWith('SQLITE_') || err.code.startsWith('23') || err.code.startsWith('42'))) {
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
  console.log('❌ 404 - Route not found:', req.method, req.path);
  res.status(404).render('404', {
    title: '404 - Không tìm thấy - SafeKeyS'
  });
});

// Initialize database and start server
async function startServer() {
  try {
    // Test database connection
    console.log('🔄 Đang kết nối đến PostgreSQL...');
    console.log(`   Host: ${process.env.PG_HOST || 'localhost'}`);
    console.log(`   Port: ${process.env.PG_PORT || '5432'}`);
    console.log(`   Database: ${process.env.PG_DATABASE || 'safekeys'}`);
    console.log(`   User: ${process.env.PG_USER || 'postgres'}`);

    await pool.query('SELECT 1');
    console.log('✅ Đã kết nối thành công đến PostgreSQL database');

    // Check if database is initialized (check if settings table exists)
    try {
      const checkTable = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'settings'
        )
      `);
      const tableExists = checkTable.rows[0].exists;

      if (!tableExists) {
        console.log('⚠️  Database chưa được khởi tạo. Đang khởi tạo...');
        console.log('💡 Chạy lệnh sau để khởi tạo database: npm run create-db');
        console.log('💡 Hoặc đợi vài giây để tự động khởi tạo...\n');

        // Initialize database automatically
        console.log('🔄 Đang khởi tạo database schema...');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Create all tables
          await client.query(`
            CREATE TABLE IF NOT EXISTS users (
              id SERIAL PRIMARY KEY,
              email VARCHAR(255) UNIQUE NOT NULL,
              password_hash TEXT,
              name VARCHAR(255) NOT NULL,
              role VARCHAR(50) NOT NULL DEFAULT 'customer',
              google_id VARCHAR(255) UNIQUE,
              avatar TEXT,
              phone VARCHAR(50),
              address TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
              id SERIAL PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              slug VARCHAR(255) UNIQUE NOT NULL
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS products (
              id SERIAL PRIMARY KEY,
              title VARCHAR(255) NOT NULL,
              slug VARCHAR(255) UNIQUE NOT NULL,
              description TEXT,
              price_cents INTEGER NOT NULL DEFAULT 0,
              image TEXT,
              category_id INTEGER,
              active INTEGER NOT NULL DEFAULT 1,
              stock INTEGER NOT NULL DEFAULT 0,
              featured INTEGER NOT NULL DEFAULT 0,
              key_value TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
            )
          `);

          // Add key_value column if it doesn't exist (for existing databases)
          try {
            await client.query(`
              ALTER TABLE products 
              ADD COLUMN IF NOT EXISTS key_value TEXT
            `);
          } catch (e) {
            // Column might already exist, ignore
          }

          await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
              id SERIAL PRIMARY KEY,
              user_id INTEGER,
              status VARCHAR(50) NOT NULL DEFAULT 'pending',
              total_cents INTEGER NOT NULL DEFAULT 0,
              payment_method VARCHAR(50),
              payment_trans_id VARCHAR(255),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS order_items (
              id SERIAL PRIMARY KEY,
              order_id INTEGER NOT NULL,
              product_id INTEGER NOT NULL,
              quantity INTEGER NOT NULL,
              price_cents INTEGER NOT NULL,
              FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS order_keys (
              id SERIAL PRIMARY KEY,
              order_item_id INTEGER NOT NULL,
              key_value TEXT NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
              key VARCHAR(255) PRIMARY KEY,
              value TEXT
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS wishlist (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              product_id INTEGER NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
              UNIQUE(user_id, product_id)
            )
          `);

          await client.query(`
            CREATE TABLE IF NOT EXISTS news (
              id SERIAL PRIMARY KEY,
              title VARCHAR(255) NOT NULL,
              slug VARCHAR(255) UNIQUE NOT NULL,
              content TEXT NOT NULL,
              excerpt TEXT,
              author VARCHAR(255),
              thumbnail TEXT,
              published INTEGER NOT NULL DEFAULT 0,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);

          // Create indexes
          await client.query('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_order_keys_item ON order_keys(order_item_id)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id)');

          await client.query('COMMIT');
          console.log('✅ Đã khởi tạo database schema thành công!\n');
        } catch (initError) {
          await client.query('ROLLBACK');
          console.error('❌ Lỗi khi khởi tạo database:', initError.message);
          console.error('💡 Vui lòng chạy thủ công: npm run create-db\n');
        } finally {
          client.release();
        }
      } else {
        console.log('✅ Database đã được khởi tạo');
      }
    } catch (checkError) {
      console.error('⚠️  Không thể kiểm tra database:', checkError.message);
    }

    // Seed default settings
    await seedDefaults();

    // Initialize database schema (run once)
    // Uncomment the line below to run initialization
    // await initDatabase();

    // Start server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`\n🚀 SafeKeyS đang chạy tại http://localhost:${PORT}`);
      console.log(`📝 Admin Dashboard: http://localhost:${PORT}/admin`);
      console.log(`🔑 Quản lý Key: http://localhost:${PORT}/admin/keys (Mật khẩu: 141514)\n`);
    });
  } catch (error) {
    console.error('\n❌ Lỗi kết nối PostgreSQL:', error.message);
    console.error('\n💡 HƯỚNG DẪN KHẮC PHỤC:');
    console.error('   1. Kiểm tra file .env có tồn tại và cấu hình đúng không');
    console.error('   2. Kiểm tra mật khẩu PostgreSQL trong file .env:');
    console.error('      PG_PASSWORD=your_actual_postgres_password');
    console.error('   3. Kiểm tra PostgreSQL service có đang chạy không');
    console.error('   4. Thử kết nối bằng psql: psql -U postgres -d safekeys');
    console.error('   5. Nếu chưa có database, chạy: npm run create-db\n');
    console.error('📖 Xem file data/HUONG_DAN.md để biết thêm chi tiết\n');
    process.exit(1);
  }
}

startServer();



