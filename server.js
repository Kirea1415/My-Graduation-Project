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
import authRouter from './src/routes/auth.js';
import cartRouter from './src/routes/cart.js';
import checkoutRouter from './src/routes/checkout.js';
import setupOrderRoutes from './src/routes/orders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const VIEWS_PATH = path.join(__dirname, 'views');
const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, 'data');
const ICONS_PATH = path.join(PUBLIC_PATH, 'img', 'icons');
if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true });
if (!fs.existsSync(ICONS_PATH)) fs.mkdirSync(ICONS_PATH, { recursive: true });

const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');
const isDebugLoggingEnabled = LOG_LEVEL === 'debug';

const logger = {
  debug: (...args) => {
    if (isDebugLoggingEnabled) console.debug(...args);
  },
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

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
logger.debug('📋 PostgreSQL Config:', {
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
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (result.rows.length > 0 && result.rows[0].value !== null && result.rows[0].value !== undefined) {
      return String(result.rows[0].value).trim();
    }
    return String(def).trim();
  } catch (error) {
    console.error(`Error getting setting ${key}:`, error);
    return String(def).trim();
  }
}
async function setSetting(key, value) {
  try {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
  } catch (error) {
    console.error(`Error setting ${key}:`, error);
    throw error;
  }
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
const csrfProtection = csrf({
  cookie: false,  // Sử dụng session-based
  sessionKey: 'session',  // Rõ ràng chỉ định session key
  value: (req) => {
    // Thứ tự ưu tiên: body._csrf > query._csrf > headers
    return (
      req.body && req.body._csrf ||
      req.query && req.query._csrf ||
      req.headers['csrf-token'] ||
      req.headers['xsrf-token'] ||
      req.headers['x-csrf-token'] ||
      req.headers['x-xsrf-token']
    );
  }
});

// Apply CSRF middleware with conditional validation
app.use((req, res, next) => {
  const skipPaths = [
    '/api/',
    '/admin/settings/save',
    '/checkout/momo',
    '/profile',
    '/admin/products'  // ← THÊM DÒNG NÀY để skip tất cả routes /admin/products/*
  ];

  const shouldSkip = skipPaths.some(path => req.path.startsWith(path));

  if (shouldSkip) {
    return next();
  }

  // CSRF tự động bỏ qua GET, HEAD, OPTIONS
  // Nhưng vẫn cần session hợp lệ để generate token
  csrfProtection(req, res, (err) => {
    if (err) {
      // Log chi tiết lỗi để debug
      console.error('❌ CSRF Error:', {
        path: req.path,
        method: req.method,
        error: err.message,
        hasSession: !!req.session,
        sessionID: req.sessionID,
        cookies: req.cookies
      });

      // Nếu là GET request và lỗi CSRF, bỏ qua lỗi
      // Vì GET không cần validate CSRF
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        console.warn('⚠️  CSRF error on safe method, ignoring');
        return next();
      }

      // Với POST/PUT/DELETE, redirect về trang trước với thông báo lỗi
      req.flash('error', 'Phiên làm việc đã hết hạn. Vui lòng thử lại.');
      return res.redirect('back');
    }
    next();
  });
});
// CSRF Error Handler - đặt sau tất cả routes
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    console.error('❌ CSRF Token Error:', {
      path: req.path,
      method: req.method,
      hasSession: !!req.session
    });

    // Nếu là GET request, cho phép tiếp tục
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    // Với các method khác, trả về lỗi
    req.flash('error', 'Token bảo mật không hợp lệ. Vui lòng thử lại.');
    return res.redirect('back');
  }

  // Các lỗi khác
  next(err);
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
        // Force reload cart from database/session to ensure it's up to date
        try {
          const cart = await getCart(req);
          res.locals.cart = {
            totalQty: (cart && typeof cart.totalQty === 'number') ? cart.totalQty : 0,
            totalCents: (cart && typeof cart.totalCents === 'number') ? cart.totalCents : 0,
            items: (cart && cart.items && typeof cart.items === 'object') ? cart.items : {}
          };
          // Debug: log cart state
          if (cart && cart.totalQty > 0) {
            logger.debug('🛒 Cart loaded:', { totalQty: cart.totalQty, itemCount: Object.keys(cart.items || {}).length });
          }
        } catch (cartError) {
          console.error('Error loading cart in middleware:', cartError);
          res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
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

// Helper functions for news
function createExcerpt(content, maxLength = 200) {
  if (!content) return '';
  // Remove HTML tags if any
  const text = content.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
  if (text.length <= maxLength) return text;
  // Find the last space before maxLength to avoid cutting words
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
}

// Helper function to format content for display (convert newlines to paragraphs)
function formatContentForDisplay(content) {
  if (!content) return '';

  // Escape HTML first to prevent XSS, then process
  const escapeHtml = (text) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  };

  // Split by double newlines (paragraphs)
  let paragraphs = content.split(/\n\n+/).filter(p => p.trim());

  // If no double newlines, split by single newlines
  if (paragraphs.length === 1) {
    paragraphs = content.split(/\n/).filter(p => p.trim());
  }

  return paragraphs.map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';

    // Check if it's a heading (starts with #)
    if (trimmed.startsWith('# ')) {
      return `<h2>${escapeHtml(trimmed.substring(2).trim())}</h2>`;
    } else if (trimmed.startsWith('## ')) {
      return `<h3>${escapeHtml(trimmed.substring(3).trim())}</h3>`;
    } else if (trimmed.startsWith('### ')) {
      return `<h4>${escapeHtml(trimmed.substring(4).trim())}</h4>`;
    } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
      // Bold text
      return `<p><strong>${escapeHtml(trimmed.substring(2, trimmed.length - 2).trim())}</strong></p>`;
    } else {
      // Regular paragraph
      // Replace single newlines within paragraph with <br>
      const formatted = trimmed.split('\n').map(line => {
        const lineTrimmed = line.trim();
        if (!lineTrimmed) return '';
        // Simple markdown-like formatting
        let formattedLine = escapeHtml(lineTrimmed);
        // Bold: **text**
        formattedLine = formattedLine.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic: *text*
        formattedLine = formattedLine.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Links: [text](url)
        formattedLine = formattedLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        return formattedLine;
      }).filter(l => l).join('<br>');

      return formatted ? `<p>${formatted}</p>` : '';
    }
  }).filter(p => p).join('');
}

// Mount route modules
app.use('/', authRouter);
app.use('/', cartRouter);
app.use('/', checkoutRouter);

// Home & catalog
app.get('/', async (req, res) => {
  try {
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

    // Get categories using PostgreSQL
    const categoriesResult = await pool.query(`
      SELECT c.*, COUNT(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    const categories = categoriesResult.rows;

    // Get featured products using PostgreSQL
    const featuredProductsResult = await pool.query(`
      SELECT DISTINCT * FROM products 
      WHERE active = 1 AND featured = 1 
      ORDER BY id DESC 
      LIMIT 20
    `);
    const featuredProducts = featuredProductsResult.rows;

    // Get products using PostgreSQL
    let products = [];
    let whereConditions = ['active = 1'];
    let params = [];
    let paramIndex = 1;

    // Search query
    if (q) {
      whereConditions.push(`(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex + 1})`);
      params.push(`%${q}%`, `%${q}%`);
      paramIndex += 2;
    }

    // Category filter
    if (category) {
      whereConditions.push(`category_id = (SELECT id FROM categories WHERE slug = $${paramIndex})`);
      params.push(category);
      paramIndex++;
    }

    // Price range filter
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

    let query = `SELECT * FROM products ${whereClause} ${orderBy}`;
    if (limitClause) {
      query += ` ${limitClause}`;
    }

    // Only pass params if we have any
    const productsResult = params.length > 0
      ? await pool.query(query, params)
      : await pool.query(query);
    products = productsResult.rows;

    // Get latest news for homepage (only when not searching/filtering)
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

// Auth routes have been moved to `src/routes/auth.js` and are mounted as a router.
// Inline auth handlers (register/login/logout and related endpoints) removed.

// Helper function to save cart to database
async function saveCartToDatabase(userId, cart) {
  if (!userId || !cart) return;
  try {
    // Check if cart exists for this user
    const checkResult = await pool.query(
      'SELECT id FROM carts WHERE user_id = $1',
      [userId]
    );

    if (checkResult.rows.length > 0) {
      // Update existing cart
      await pool.query(
        `UPDATE carts 
         SET cart_data = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $2`,
        [JSON.stringify(cart), userId]
      );
    } else {
      // Insert new cart
      await pool.query(
        `INSERT INTO carts (user_id, cart_data, created_at, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, JSON.stringify(cart)]
      );
    }
  } catch (error) {
    // If table doesn't exist (42P01), try to create it and retry
    if (error.code === '42P01') {
      console.warn('⚠️  Bảng carts chưa tồn tại. Đang tạo bảng...');
      await ensureCartsTableExists();
      // Retry once after creating table
      try {
        const checkResult = await pool.query(
          'SELECT id FROM carts WHERE user_id = $1',
          [userId]
        );

        if (checkResult.rows.length > 0) {
          await pool.query(
            `UPDATE carts 
             SET cart_data = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE user_id = $2`,
            [JSON.stringify(cart), userId]
          );
        } else {
          await pool.query(
            `INSERT INTO carts (user_id, cart_data, created_at, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [userId, JSON.stringify(cart)]
          );
        }
      } catch (retryError) {
        console.error('Error saving cart after table creation:', retryError);
      }
      return;
    }
    console.error('Error saving cart to database:', error);
    // Don't throw - cart save failure shouldn't break the app
  }
}

// Helper function to ensure carts table exists
async function ensureCartsTableExists() {
  try {
    // Check if table exists
    const checkResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'carts'
      )
    `);

    if (!checkResult.rows[0].exists) {
      console.log('🔄 Đang tạo bảng carts...');
      await pool.query(`
        CREATE TABLE carts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          cart_data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_carts_user ON carts(user_id)');
      console.log('✅ Đã tạo bảng carts thành công!');
    }
  } catch (error) {
    console.error('Error ensuring carts table exists:', error);
  }
}

// Helper function to load cart from database
async function loadCartFromDatabase(userId) {
  if (!userId) return null;
  try {
    const result = await pool.query(
      'SELECT cart_data FROM carts WHERE user_id = $1',
      [userId]
    );
    if (result.rows && result.rows.length > 0 && result.rows[0].cart_data) {
      const cartData = result.rows[0].cart_data;
      // Handle both string and object formats
      if (typeof cartData === 'string') {
        return JSON.parse(cartData);
      }
      return cartData;
    }
    return null;
  } catch (error) {
    // If table doesn't exist (42P01), try to create it and retry
    if (error.code === '42P01') {
      console.warn('⚠️  Bảng carts chưa tồn tại. Đang tạo bảng...');
      await ensureCartsTableExists();
      // Retry once after creating table
      try {
        const result = await pool.query(
          'SELECT cart_data FROM carts WHERE user_id = $1',
          [userId]
        );
        if (result.rows && result.rows.length > 0 && result.rows[0].cart_data) {
          const cartData = result.rows[0].cart_data;
          if (typeof cartData === 'string') {
            return JSON.parse(cartData);
          }
          return cartData;
        }
      } catch (retryError) {
        console.error('Error loading cart after table creation:', retryError);
      }
      return null;
    }
    console.error('Error loading cart from database:', error);
    // Log the actual error message to help debug
    if (error.message && error.message.includes('user_carts')) {
      console.error('⚠️  PHÁT HIỆN: Code vẫn đang tìm bảng user_carts. Có thể server chưa restart hoặc có code cũ đang chạy.');
    }
    return null;
  }
}

// Cart - Get cart from database if user is logged in, otherwise from session
async function getCart(req) {
  // Ensure session exists
  if (!req.session) {
    return { items: {}, totalQty: 0, totalCents: 0 };
  }

  // If user is logged in, try to load from database first
  if (req.session.user && req.session.user.id) {
    try {
      const dbCart = await loadCartFromDatabase(req.session.user.id);
      if (dbCart) {
        // Sync to session for consistency
        req.session.cart = dbCart;
        req.session.touch();
        return dbCart;
      }
    } catch (error) {
      console.error('Error loading cart from database, falling back to session:', error);
    }
  }

  // Fallback to session cart (for guests or if database load fails)
  if (!req.session.cart) {
    req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
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

// Cart & wishlist routes have been moved to `src/routes/cart.js` and are mounted as a router.
// Inline cart/wishlist handlers removed to keep `server.js` concise.

// Checkout routes have been moved to `src/routes/checkout.js` and are mounted as a router.
// The inline checkout handlers (GET/POST /checkout, MoMo callbacks, /checkout/momo, /checkout/pay)
// have been removed to keep this file concise.

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
      logger.debug('🔍 Multer processing complete:', {
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
        logger.debug('✅ CSRF token received in profile update');
      } else {
        console.warn('⚠️ No CSRF token found in profile update (relying on session auth)');
      }

      logger.debug('✅ Session verified, proceeding with profile update');
      next();
    });
  },
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Tên không được để trống và tối đa 100 ký tự'),
  body('phone').optional({ checkFalsy: true }).trim().matches(/^[0-9]{10,11}$/).withMessage('Số điện thoại phải có 10-11 chữ số'),
  body('address').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Địa chỉ tối đa 500 ký tự'),
  async (req, res) => {
    logger.debug('🚀 Profile update handler started');
    logger.debug('📋 Request details:', {
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

    logger.debug('✅ Validation passed');

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
              logger.debug('✅ Session saved after profile update');
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

// Orders routes moved to `src/routes/orders.js`
setupOrderRoutes(app, { pool, db, getSetting, requireAuth, getUserId, getCart, saveCartToDatabase, dataManager, logger });

// Admin update order status
app.post('/admin/orders/:orderId/status', requireAdmin, async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);
    if (isNaN(orderId)) {
      req.flash('error', 'ID đơn hàng không hợp lệ');
      return res.redirect('/admin/orders');
    }

    const { status } = req.body;
    // Removed 'processing' status - only allow: pending, paid, completed, cancelled, failed
    const validStatuses = ['pending', 'paid', 'completed', 'cancelled', 'failed'];

    if (!validStatuses.includes(status)) {
      req.flash('error', 'Trạng thái không hợp lệ');
      return res.redirect('/admin/orders');
    }

    // Update order status
    await pool.query(
      'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, orderId]
    );

    // If cancelling, restore stock
    if (status === 'cancelled') {
      const itemsResult = await pool.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [orderId]
      );

      for (const item of itemsResult.rows) {
        await pool.query(
          'UPDATE products SET stock = stock + $1 WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }
    }

    // Sync to data file
    try {
      const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderResult.rows.length > 0) {
        dataManager.updateItem('orders', orderId, {
          status: status,
          updated_at: new Date().toISOString()
        });
      }
    } catch (dataError) {
      console.error('Error syncing order status to data file:', dataError);
    }

    req.flash('success', `Đã cập nhật trạng thái đơn hàng thành "${status}"`);
    res.redirect('/admin/orders');
  } catch (error) {
    console.error('❌ Error updating order status:', error);
    req.flash('error', 'Có lỗi xảy ra khi cập nhật trạng thái đơn hàng');
    res.redirect('/admin/orders');
  }
});

// Admin update product key (each product has 1 key) - AJAX version
app.post('/admin/products/:productId/key', requireAdmin, requireKeysPassword, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) {
      return res.status(400).json({ success: false, error: 'ID sản phẩm không hợp lệ' });
    }

    const { key_value } = req.body;

    // Verify product exists using PostgreSQL
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sản phẩm không tồn tại' });
    }

    // Update product key using PostgreSQL
    const trimmedKey = key_value ? key_value.trim() : null;
    await pool.query('UPDATE products SET key_value = $1 WHERE id = $2', [trimmedKey, productId]);

    // Sync to data file
    try {
      dataManager.updateItem('products', productId, { key_value: trimmedKey });
    } catch (dataError) {
      console.error('Error syncing key to data file:', dataError);
    }

    return res.json({ success: true, message: 'Đã cập nhật key cho sản phẩm thành công' });
  } catch (error) {
    console.error('Error updating product key:', error);
    return res.status(500).json({ success: false, error: 'Lỗi khi cập nhật key: ' + error.message });
  }
});

// Admin delete product key - AJAX version
app.post('/admin/products/:productId/key/delete', requireAdmin, requireKeysPassword, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) {
      return res.status(400).json({ success: false, error: 'ID sản phẩm không hợp lệ' });
    }

    // Delete product key using PostgreSQL
    await pool.query('UPDATE products SET key_value = NULL WHERE id = $1', [productId]);

    // Sync to data file
    try {
      dataManager.updateItem('products', productId, { key_value: null });
    } catch (dataError) {
      console.error('Error syncing key deletion to data file:', dataError);
    }

    return res.json({ success: true, message: 'Đã xóa key thành công' });
  } catch (error) {
    console.error('Error deleting product key:', error);
    return res.status(500).json({ success: false, error: 'Lỗi khi xóa key: ' + error.message });
  }
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

    // Get counts using PostgreSQL
    const prodResult = await pool.query('SELECT COUNT(*) as c FROM products');
    const prodCount = parseInt(prodResult.rows[0].c, 10) || 0;

    const catResult = await pool.query('SELECT COUNT(*) as c FROM categories');
    const catCount = parseInt(catResult.rows[0].c, 10) || 0;

    const userResult = await pool.query('SELECT COUNT(*) as c FROM users');
    const userCount = parseInt(userResult.rows[0].c, 10) || 0;

    // Calculate revenue - only count paid/completed orders using PostgreSQL
    const revenueResult = await pool.query(
      "SELECT COALESCE(SUM(total_cents), 0) as total FROM orders WHERE status IN ('paid', 'completed')"
    );
    const totalRevenue = parseInt(revenueResult.rows[0].total, 10) || 0;

    // Calculate stock using PostgreSQL
    const stockResult = await pool.query('SELECT COALESCE(SUM(stock), 0) as total FROM products');
    const totalStock = parseInt(stockResult.rows[0].total, 10) || 0;

    // Out of stock count using PostgreSQL
    const outOfStockResult = await pool.query('SELECT COUNT(*) as c FROM products WHERE stock = 0');
    const outOfStockCount = parseInt(outOfStockResult.rows[0].c, 10) || 0;

    // In stock count using PostgreSQL
    const inStockResult = await pool.query('SELECT COUNT(*) as c FROM products WHERE stock > 0');
    const inStockCount = parseInt(inStockResult.rows[0].c, 10) || 0;

    // Today's orders using PostgreSQL
    const today = new Date().toISOString().split('T')[0];
    const todayOrdersResult = await pool.query(
      "SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = $1::date",
      [today]
    );
    const todayOrdersCount = parseInt(todayOrdersResult.rows[0].c, 10) || 0;

    // New users (last 7 days) using PostgreSQL
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const newUsersResult = await pool.query(
      'SELECT COUNT(*) as c FROM users WHERE created_at >= $1',
      [sevenDaysAgo.toISOString()]
    );
    const newUsersCount = parseInt(newUsersResult.rows[0].c, 10) || 0;

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
    console.error('❌ Error loading admin dashboard:', error);
    console.error('Error stack:', error.stack);
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

    // Get revenue stats using PostgreSQL
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
      revenueStatsQuery += ' WHERE status = $1';
      const revenueResult = await pool.query(revenueStatsQuery, [status]);
      revenueStats = revenueResult.rows[0];
    } else {
      const revenueResult = await pool.query(revenueStatsQuery);
      revenueStats = revenueResult.rows[0];
    }

    // Get daily revenue for chart using PostgreSQL
    const chartDataResult = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as order_count,
        COALESCE(SUM(total_cents), 0) as revenue
      FROM orders
      WHERE status IN ('paid', 'completed') AND created_at >= $1
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [startDate.toISOString()]);
    const chartData = chartDataResult.rows;

    // Get monthly revenue for chart using PostgreSQL
    const monthlyDataResult = await pool.query(`
      SELECT 
        TO_CHAR(created_at, 'YYYY-MM') as month,
        COUNT(*) as order_count,
        COALESCE(SUM(total_cents), 0) as revenue
      FROM orders
      WHERE status IN ('paid', 'completed') AND created_at >= $1::timestamp
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month ASC
    `, [startDate.toISOString()]);
    const monthlyData = monthlyDataResult.rows;

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

    // Get user info using PostgreSQL
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      req.flash('error', 'Không tìm thấy người dùng');
      return res.redirect('/admin/users');
    }
    const user = userResult.rows[0];

    // Get all orders for this user using PostgreSQL
    const ordersResult = await pool.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC',
      [userId]
    );
    const orders = ordersResult.rows;

    // Get order items and keys using PostgreSQL
    const itemsByOrder = {};
    const keysByOrderItem = {};

    for (const o of orders) {
      // Get order items
      const itemsResult = await pool.query(`
        SELECT oi.*, p.title, p.image
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id
      `, [o.id]);
      itemsByOrder[o.id] = itemsResult.rows;

      // Get keys for each order item
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

    res.render('admin/user-orders', {
      title: `Lịch sử giao dịch - ${user.name}`,
      user,
      orders,
      itemsByOrder,
      keysByOrderItem
    });
  } catch (error) {
    console.error('❌ Error loading user orders:', error);
    console.error('Error stack:', error.stack);
    req.flash('error', 'Có lỗi xảy ra khi tải lịch sử giao dịch: ' + error.message);
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
    const productId = parseInt(req.params.id, 10);
    if (isNaN(productId)) {
      req.flash('error', 'ID sản phẩm không hợp lệ');
      return res.redirect('/admin/products');
    }

    // Get product using PostgreSQL
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    if (productResult.rows.length === 0) {
      return res.status(404).render('404');
    }
    const product = productResult.rows[0];

    // Get categories using PostgreSQL
    const categoriesResult = await pool.query('SELECT * FROM categories ORDER BY name');
    const categories = categoriesResult.rows;

    res.render('admin/product_edit', { title: 'Sửa sản phẩm', product, categories });
  } catch (error) {
    console.error('❌ Error loading product:', error);
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
      // Check slug conflict using PostgreSQL
      const conflictResult = await pool.query(
        'SELECT id FROM products WHERE slug = $1 AND id <> $2',
        [slug, id]
      );
      if (conflictResult.rows.length > 0) {
        req.flash('error', 'Slug đã tồn tại, vui lòng chọn slug khác');
        return res.redirect(`/admin/products/${id}/edit`);
      }

      const featured = req.body.featured === '1' ? 1 : 0;

      // Update product using PostgreSQL
      await pool.query(
        `UPDATE products 
         SET title = $1, slug = $2, description = $3, price_cents = $4, image = $5, 
             category_id = $6, stock = $7, active = $8, featured = $9 
         WHERE id = $10`,
        [title, slug, description || null, price, image || null,
          category_id ? Number(category_id) : null, stockNum, act, featured, id]
      );

      // Sync to data file
      try {
        dataManager.updateItem('products', id, {
          title,
          slug,
          description: description || null,
          price_cents: price,
          image: image || null,
          category_id: category_id ? Number(category_id) : null,
          stock: stockNum,
          active: act,
          featured
        });
      } catch (dataError) {
        console.error('Error syncing product update to data file:', dataError);
      }

      req.flash('success', 'Đã lưu sản phẩm');
    } catch (e) {
      console.error('❌ Error updating product:', e);
      req.flash('error', 'Lỗi lưu sản phẩm: ' + e.message);
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
    let query = 'SELECT id FROM news WHERE slug = $1';
    let params = [s];
    if (excludeId) {
      query += ' AND id <> $2';
      params.push(excludeId);
    }
    const result = await pool.query(query, params);
    return result.rows.length > 0;
  };
  if (!(await exists(slug))) return slug;
  let i = 2;
  while (await exists(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

// Public news
app.get('/news', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = 10;

    let whereClause = 'WHERE published = 1';
    let params = [];

    if (q) {
      whereClause += ' AND (title ILIKE $1 OR content ILIKE $2)';
      params = [`%${q}%`, `%${q}%`];
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as c FROM news ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].c, 10);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    // Get posts - use COALESCE to handle missing excerpt column
    let postsQuery = `SELECT id, title, slug, content, COALESCE(excerpt, '') as excerpt, created_at, thumbnail, COALESCE(author, '') as author FROM news ${whereClause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const postsParams = [...params, pageSize, offset];
    const postsResult = await pool.query(postsQuery, postsParams);
    const posts = postsResult.rows.map(post => ({
      ...post,
      excerpt: (post.excerpt && post.excerpt.trim()) ? post.excerpt : createExcerpt(post.content || '', 200),
      readingTime: Math.max(1, Math.round((post.content || '').split(/\s+/).filter(Boolean).length / 200)),
      author: post.author && post.author.trim() ? post.author : null
    }));

    res.render('news/index', { title: 'Tin tức - SafeKeyS', posts, q, page, totalPages });
  } catch (error) {
    console.error('❌ Lỗi khi lấy danh sách tin tức:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải tin tức');
    res.render('news/index', { title: 'Tin tức - SafeKeyS', posts: [], q: '', page: 1, totalPages: 1 });
  }
});

app.get('/news/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM news WHERE slug = $1 AND published = 1', [req.params.slug]);
    if (result.rows.length === 0) {
      return res.status(404).render('404');
    }

    const post = result.rows[0];
    const words = (post.content || '').split(/\s+/).filter(Boolean).length;
    const readingTimeMin = Math.max(1, Math.round(words / 200));

    // Get related posts (same category or recent posts)
    const relatedResult = await pool.query(
      'SELECT id, title, slug, thumbnail, created_at, COALESCE(excerpt, \'\') as excerpt, content FROM news WHERE id != $1 AND published = 1 ORDER BY id DESC LIMIT 5',
      [post.id]
    );
    const relatedPosts = relatedResult.rows.map(p => ({
      ...p,
      excerpt: (p.excerpt && p.excerpt.trim()) ? p.excerpt : createExcerpt(p.content || '', 100)
    }));

    // Format content for display
    const formattedContent = formatContentForDisplay(post.content || '');

    res.render('news/show', {
      title: post.title + ' - Tin tức',
      post: {
        ...post,
        formattedContent
      },
      readingTimeMin,
      relatedPosts
    });
  } catch (error) {
    console.error('❌ Lỗi khi lấy bài viết:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải bài viết');
    return res.status(404).render('404');
  }
});

// Admin news CRUD
app.get('/admin/news', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = 15;

    let whereClause = '';
    let params = [];

    if (q) {
      whereClause = 'WHERE (title ILIKE $1 OR content ILIKE $2)';
      params = [`%${q}%`, `%${q}%`];
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as c FROM news ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].c, 10);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    // Get posts
    let postsQuery = `SELECT * FROM news ${whereClause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const postsParams = [...params, pageSize, offset];
    const postsResult = await pool.query(postsQuery, postsParams);
    const posts = postsResult.rows;

    res.render('admin/news', { title: 'Quản lý Tin tức', posts, q, page, totalPages });
  } catch (error) {
    console.error('❌ Lỗi khi lấy danh sách tin tức admin:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải danh sách tin tức');
    res.render('admin/news', { title: 'Quản lý Tin tức', posts: [], q: '', page: 1, totalPages: 1 });
  }
});

app.post('/admin/news', requireAdmin, async (req, res) => {
  try {
    const { title, slug, content, published, author, thumbnail, excerpt } = req.body;
    if (!title || !content) {
      req.flash('error', 'Thiếu tiêu đề hoặc nội dung');
      return res.redirect('/admin/news');
    }
    const finalSlug = await generateUniqueSlug(slug && slug.trim() ? slug : title);
    // Convert published to boolean first, then to integer (0 or 1) for PostgreSQL
    const isPublishedBool = published === '1' || published === true || published === 'true' || published === 1;
    const isPublished = isPublishedBool ? 1 : 0;

    // Insert into PostgreSQL
    const result = await pool.query(
      `INSERT INTO news (title, slug, content, excerpt, published, author, thumbnail, created_at, updated_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) 
       RETURNING *`,
      [title, finalSlug, content, excerpt || null, isPublished, author || null, thumbnail || null]
    );

    const newPost = result.rows[0];

    // Sync to file JSON
    try {
      dataManager.addItem('news', {
        id: newPost.id,
        title: newPost.title,
        slug: newPost.slug,
        content: newPost.content,
        excerpt: newPost.excerpt || null,
        published: newPost.published,
        author: newPost.author || null,
        thumbnail: newPost.thumbnail || null,
        created_at: newPost.created_at,
        updated_at: newPost.updated_at
      });
    } catch (fileError) {
      console.error('⚠️ Lỗi khi đồng bộ tin tức vào file:', fileError);
    }

    req.flash('success', 'Đã tạo bài viết');
    res.redirect('/admin/news');
  } catch (error) {
    console.error('❌ Lỗi khi thêm tin tức:', error);
    req.flash('error', `Lỗi khi thêm tin tức: ${error.message}`);
    res.redirect('/admin/news');
  }
});

app.get('/admin/news/:id/edit', requireAdmin, async (req, res) => {
  try {
    const newsId = parseInt(req.params.id, 10);
    if (isNaN(newsId)) {
      req.flash('error', 'ID không hợp lệ');
      return res.redirect('/admin/news');
    }
    const result = await pool.query('SELECT * FROM news WHERE id = $1', [newsId]);
    if (result.rows.length === 0) {
      req.flash('error', 'Bài viết không tồn tại');
      return res.redirect('/admin/news');
    }
    const post = result.rows[0];
    res.render('admin/news_edit', { title: 'Sửa Tin tức', post });
  } catch (error) {
    console.error('❌ Lỗi khi lấy bài viết:', error);
    req.flash('error', 'Có lỗi xảy ra khi tải bài viết');
    res.redirect('/admin/news');
  }
});

app.post('/admin/news/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { title, slug, content, published, author, thumbnail, excerpt } = req.body;
    if (!title || !content) {
      req.flash('error', 'Thiếu tiêu đề hoặc nội dung');
      return res.redirect(`/admin/news/${req.params.id}/edit`);
    }
    const newsId = parseInt(req.params.id, 10);
    if (isNaN(newsId)) {
      req.flash('error', 'ID không hợp lệ');
      return res.redirect('/admin/news');
    }
    const finalSlug = await generateUniqueSlug(slug && slug.trim() ? slug : title, newsId);
    // Convert published to boolean first, then to integer (0 or 1) for PostgreSQL
    const isPublishedBool = published === '1' || published === true || published === 'true' || published === 1;
    const isPublished = isPublishedBool ? 1 : 0;

    // Update in PostgreSQL
    const result = await pool.query(
      `UPDATE news SET title = $1, slug = $2, content = $3, excerpt = $4, published = $5, author = $6, thumbnail = $7, updated_at = NOW() 
       WHERE id = $8 
       RETURNING *`,
      [title, finalSlug, content, excerpt || null, isPublished, author || null, thumbnail || null, newsId]
    );

    if (result.rows.length === 0) {
      req.flash('error', 'Bài viết không tồn tại');
      return res.redirect('/admin/news');
    }

    const updatedPost = result.rows[0];

    // Sync to file JSON
    try {
      dataManager.updateItem('news', newsId, {
        title: updatedPost.title,
        slug: updatedPost.slug,
        content: updatedPost.content,
        excerpt: updatedPost.excerpt || null,
        published: updatedPost.published,
        author: updatedPost.author || null,
        thumbnail: updatedPost.thumbnail || null,
        updated_at: updatedPost.updated_at
      });
    } catch (fileError) {
      console.error('⚠️ Lỗi khi đồng bộ tin tức vào file:', fileError);
    }

    req.flash('success', 'Đã lưu bài viết');
    res.redirect('/admin/news');
  } catch (error) {
    console.error('❌ Lỗi khi sửa tin tức:', error);
    req.flash('error', `Lỗi khi sửa tin tức: ${error.message}`);
    res.redirect(`/admin/news/${req.params.id}/edit`);
  }
});

app.post('/admin/news/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const newsId = parseInt(req.params.id, 10);
    if (isNaN(newsId)) {
      req.flash('error', 'ID không hợp lệ');
      return res.redirect('/admin/news');
    }
    const result = await pool.query('SELECT published FROM news WHERE id = $1', [newsId]);
    if (result.rows.length === 0) {
      req.flash('error', 'Bài viết không tồn tại');
      return res.redirect('/admin/news');
    }

    const currentPublished = result.rows[0].published;
    // Convert to integer (0 or 1) for PostgreSQL
    const newPublished = currentPublished ? 0 : 1;

    // Update in PostgreSQL
    const updateResult = await pool.query(
      'UPDATE news SET published = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newPublished, newsId]
    );

    if (updateResult.rows.length > 0) {
      const updatedPost = updateResult.rows[0];

      // Sync to file JSON
      try {
        dataManager.updateItem('news', newsId, {
          published: updatedPost.published,
          updated_at: updatedPost.updated_at
        });
      } catch (fileError) {
        console.error('⚠️ Lỗi khi đồng bộ tin tức vào file:', fileError);
      }
    }

    res.redirect('/admin/news');
  } catch (error) {
    console.error('❌ Lỗi khi toggle tin tức:', error);
    req.flash('error', 'Có lỗi xảy ra khi cập nhật trạng thái');
    res.redirect('/admin/news');
  }
});

app.post('/admin/news/:id/delete', requireAdmin, async (req, res) => {
  try {
    const newsId = parseInt(req.params.id, 10);
    if (isNaN(newsId)) {
      req.flash('error', 'ID không hợp lệ');
      return res.redirect('/admin/news');
    }
    // Delete from PostgreSQL
    await pool.query('DELETE FROM news WHERE id = $1', [newsId]);

    // Delete from file JSON
    try {
      dataManager.deleteItem('news', newsId);
    } catch (fileError) {
      console.error('⚠️ Lỗi khi xóa tin tức khỏi file:', fileError);
    }

    req.flash('success', 'Đã xóa bài viết');
    res.redirect('/admin/news');
  } catch (error) {
    console.error('❌ Lỗi khi xóa tin tức:', error);
    req.flash('error', 'Có lỗi xảy ra khi xóa bài viết');
    res.redirect('/admin/news');
  }
});

// Admin view/edit user carts via session store
// Admin: View all orders
app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || '';
    const page = parseInt(req.query.page || '1', 10);
    const perPage = 20;
    const offset = (page - 1) * perPage;

    // Build query using PostgreSQL (admin sees all orders, including user-deleted ones)
    let query = `
      SELECT o.*, u.name as user_name, u.email as user_email
      FROM orders o
      JOIN users u ON u.id = o.user_id
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` WHERE o.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY o.id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(perPage, offset);

    const ordersResult = await pool.query(query, params);
    const orders = ordersResult.rows;

    // Get total count for pagination using PostgreSQL
    let countQuery = 'SELECT COUNT(*) as total FROM orders o';
    const countParams = [];
    if (status) {
      countQuery += ' WHERE o.status = $1';
      countParams.push(status);
    }
    const countResult = await pool.query(countQuery, countParams);
    const totalOrders = parseInt(countResult.rows[0].total, 10) || 0;
    const totalPages = Math.ceil(totalOrders / perPage);

    // Get order items for each order using PostgreSQL
    for (const order of orders) {
      const itemsResult = await pool.query(`
        SELECT oi.*, p.title as product_title
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id
      `, [order.id]);
      order.items = itemsResult.rows;
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
    console.error('❌ Error loading admin orders:', error);
    console.error('Error stack:', error.stack);
    req.flash('error', 'Có lỗi xảy ra khi tải danh sách đơn hàng: ' + error.message);
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
              user_deleted_at TIMESTAMP NULL,
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
          await client.query('CREATE INDEX IF NOT EXISTS idx_orders_user_deleted ON orders(user_deleted_at)');

          // Add user_deleted_at column if it doesn't exist (for existing databases)
          await client.query(`
            DO $$ 
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'orders' AND column_name = 'user_deleted_at'
              ) THEN
                ALTER TABLE orders ADD COLUMN user_deleted_at TIMESTAMP NULL;
              END IF;
            END $$;
          `);
          await client.query('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_order_keys_item ON order_keys(order_item_id)');
          await client.query('CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id)');

          // Create carts table for storing user carts (if not exists)
          // Note: Table may already exist with different structure
          await client.query(`
            CREATE TABLE IF NOT EXISTS carts (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
              cart_data JSONB NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await client.query('CREATE INDEX IF NOT EXISTS idx_carts_user ON carts(user_id)');

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
        // Ensure carts table exists even if database was already initialized
        await ensureCartsTableExists();
      }
    } catch (checkError) {
      console.error('⚠️  Không thể kiểm tra database:', checkError.message);
    }

    // Seed default settings
    await seedDefaults();

    // Ensure user_deleted_at column exists in orders table
    try {
      const checkResult = await pool.query(`
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'orders' AND column_name = 'user_deleted_at'
      `);

      if (checkResult.rows.length === 0) {
        await pool.query(`
          ALTER TABLE orders ADD COLUMN user_deleted_at TIMESTAMP NULL
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_orders_user_deleted ON orders(user_deleted_at)
        `);
        console.log('✅ Đã thêm cột user_deleted_at vào bảng orders');
      }
    } catch (migrationError) {
      console.error('⚠️  Lỗi khi kiểm tra/thêm cột user_deleted_at:', migrationError.message);
      // Continue anyway - column might already exist or will be added manually
    }

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



