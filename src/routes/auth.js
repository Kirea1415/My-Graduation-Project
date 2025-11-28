import express from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import passport from 'passport';
import { pool, db } from '../config/database.js';
import { logger } from '../config/logger.js';
import * as dataManager from '../../data/data-manager.js';
import { sendOtp, verifyOtp } from '../services/otpService.js';

const router = express.Router();

// Get values from process.env or globals (these should be set in server.js)
const ADMIN_BACKUP_PASSWORD = process.env.ADMIN_BACKUP_PASSWORD || '141514';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// In-memory store for login attempts (for lockout mechanism)
const loginAttempts = new Map();

// Helper function to get lockout settings from database
async function getLockoutSettings() {
  try {
    const maxAttempts = parseInt((await getSetting('lockout_max_attempts', '3')) || 3);
    const durationMinutes = parseInt((await getSetting('lockout_duration_minutes', '5')) || 5);
    const reason = await getSetting('lockout_reason', 'Tài khoản đã bị khóa do nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau.');
    const durationMs = durationMinutes * 60 * 1000;
    return { maxAttempts, durationMinutes, reason, durationMs };
  } catch (error) {
    logger.error('Error loading lockout settings:', error);
    return {
      maxAttempts: 3,
      durationMinutes: 5,
      reason: 'Tài khoản đã bị khóa do nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau.',
      durationMs: 5 * 60 * 1000
    };
  }
}

// Helper function to get settings from database
async function getSetting(key, defaultValue = '') {
  try {
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const setting = await stmt.get(key);
    return setting ? setting.value : defaultValue;
  } catch (error) {
    logger.debug(`Setting not found: ${key}`);
    return defaultValue;
  }
}

// Export loginAttempts for use in other modules (for admin lockout page, etc.)
export { loginAttempts };

// GET /register - Show registration form
router.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Đăng ký - SafeKeyS' });
});

// POST /register - Handle registration
router.post('/register',
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
      // Insert with activated = false so user must activate via OTP
      const result = await pool.query(
        'INSERT INTO users (name, email, password_hash, role, activated) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [name, email, password_hash, 'customer', false]
      );
      const userId = result.rows[0]?.id;
      if (!userId) {
        throw new Error('Không thể tạo tài khoản');
      }

      // Save to file in data/
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

      // Don't auto-login. Send activation OTP and redirect to activation page.
      await sendOtp(email, 'Mã kích hoạt tài khoản');
      req.flash('success', 'Đăng ký thành công. Vui lòng kiểm tra email để lấy mã kích hoạt.');
      res.redirect(`/activate?email=${encodeURIComponent(email)}`);
    } catch (error) {
      logger.error('Register error:', error);
      req.flash('error', 'Có lỗi xảy ra khi đăng ký');
      res.redirect('/register');
    }
  }
);

// GET /login - Show login form
router.get('/login', (req, res) => {
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

// POST /login - Handle login
router.post('/login',
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
      let isValid = user && bcrypt.compareSync(password, user.password_hash);

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
      // If account exists but not activated, redirect user to activation page
      if (user && (user.activated === false || user.activated === 0)) {
        req.flash('error', 'Tài khoản chưa kích hoạt. Vui lòng kiểm tra email để lấy mã kích hoạt.');
        return res.redirect(`/activate?email=${encodeURIComponent(normalizedEmail)}`);
      }
      // If account exists but not activated, redirect user to activation page
      if (user && (user.activated === false || user.activated === 0)) {
        req.flash('error', 'Tài khoản chưa kích hoạt. Vui lòng kiểm tra email để lấy mã kích hoạt.');
        return res.redirect(`/activate?email=${encodeURIComponent(normalizedEmail)}`);
      }
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };

      // Restore cart from database
      try {
        const cartResult = await pool.query(
          'SELECT cart_data FROM carts WHERE user_id = $1',
          [user.id]
        );
        if (cartResult.rows && cartResult.rows.length > 0 && cartResult.rows[0].cart_data) {
          const savedCart = cartResult.rows[0].cart_data;
          if (typeof savedCart === 'string') {
            req.session.cart = JSON.parse(savedCart);
          } else {
            req.session.cart = savedCart;
          }
          logger.debug('✅ Cart restored from database for user:', user.id);
          logger.debug('🛒 Restored cart:', { totalQty: req.session.cart.totalQty || 0 });
        } else {
          // Initialize empty cart if no saved cart
          req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
        }
      } catch (cartError) {
        logger.error('Error restoring cart from database:', cartError);
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
      logger.error('Login error:', error);
      req.flash('error', 'Có lỗi xảy ra khi đăng nhập');
      res.redirect('/login');
    }
  }
);

// POST /login/backup-password - Handle admin backup password login
router.post('/login/backup-password',
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
          'SELECT cart_data FROM carts WHERE user_id = $1',
          [user.id]
        );
        if (cartResult.rows && cartResult.rows.length > 0 && cartResult.rows[0].cart_data) {
          const savedCart = cartResult.rows[0].cart_data;
          if (typeof savedCart === 'string') {
            req.session.cart = JSON.parse(savedCart);
          } else {
            req.session.cart = savedCart;
          }
          logger.debug('✅ Cart restored from database for backup password user:', user.id);
        } else {
          req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
        }
      } catch (cartError) {
        logger.error('Error restoring cart from database:', cartError);
        req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
      }

      req.flash('success', 'Đăng nhập thành công bằng mã dự phòng. Vui lòng đổi mật khẩu mới.');
      const redirectTo = req.query.redirect || '/';
      res.redirect(redirectTo);
    } catch (error) {
      logger.error('Backup password login error:', error);
      req.flash('error', 'Có lỗi xảy ra khi đăng nhập');
      res.redirect('/login');
    }
  }
);

// Google OAuth routes
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  router.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
  );

  router.get('/auth/google/callback',
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
          'SELECT cart_data FROM carts WHERE user_id = $1',
          [req.user.id]
        );
        if (cartResult.rows && cartResult.rows.length > 0 && cartResult.rows[0].cart_data) {
          const savedCart = cartResult.rows[0].cart_data;
          if (typeof savedCart === 'string') {
            req.session.cart = JSON.parse(savedCart);
          } else {
            req.session.cart = savedCart;
          }
          logger.debug('✅ Cart restored from database for Google user:', req.user.id);
        } else {
          req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
        }
      } catch (cartError) {
        logger.error('Error restoring cart from database:', cartError);
        req.session.cart = { items: {}, totalQty: 0, totalCents: 0 };
      }

      const redirectTo = req.session.redirectTo || req.query.redirect || '/';
      delete req.session.redirectTo;
      req.flash('success', 'Đăng nhập bằng Google thành công!');
      res.redirect(redirectTo);
    }
  );
}

// GET /activate - render activation page
router.get('/activate', (req, res) => {
  const email = req.query.email || '';
  res.render('auth/activate', { title: 'Kích hoạt tài khoản', email, csrfToken: req.csrfToken ? req.csrfToken() : '' });
});

// POST /send-activation - send activation OTP
router.post('/send-activation', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) {
      req.flash('error', 'Thiếu email');
      return res.redirect('/activate');
    }

    // Check user exists
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    const user = await stmt.get(email);
    if (!user) {
      req.flash('error', 'Tài khoản không tồn tại');
      return res.redirect('/activate');
    }

    await sendOtp(email, 'Mã kích hoạt tài khoản');
    req.flash('success', 'Đã gửi mã kích hoạt đến email');
    res.redirect(`/activate?email=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error('send-activation error:', err);
    req.flash('error', 'Lỗi khi gửi mã kích hoạt');
    res.redirect('/activate');
  }
});

// POST /verify-activation - verify OTP and set activated=true
router.post('/verify-activation', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const otp = req.body.otp;
    if (!email || !otp) {
      req.flash('error', 'Thiếu dữ liệu');
      return res.redirect('/activate');
    }

    const result = verifyOtp(email, otp);
    if (!result.success) {
      req.flash('error', result.message || 'OTP không hợp lệ');
      return res.redirect(`/activate?email=${encodeURIComponent(email)}`);
    }

    // Update DB to set activated true
    await pool.query('UPDATE users SET activated = $1 WHERE email = $2', [true, email]);
    req.flash('success', 'Kích hoạt thành công. Bạn có thể đăng nhập.');
    res.redirect('/login');
  } catch (err) {
    logger.error('verify-activation error:', err);
    req.flash('error', 'Lỗi khi xác nhận OTP');
    res.redirect('/activate');
  }
});

// POST /logout - Handle logout
router.post('/logout', async (req, res) => {
  try {
    // Save cart to database before destroying session
    if (req.session && req.session.user && req.session.user.id && req.session.cart) {
      const userId = req.session.user.id;
      const cart = req.session.cart;

      // Save cart to database
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
        logger.debug('✅ Cart saved to database before logout for user:', userId);
      } catch (cartError) {
        logger.error('Error saving cart before logout:', cartError);
        // Continue with logout even if cart save fails
      }
    }
  } catch (error) {
    logger.error('Error in logout process:', error);
    // Continue with logout even if there's an error
  }

  // Logout passport if available
  if (req.logout) {
    req.logout((err) => {
      if (err) {
        logger.error('Logout error:', err);
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

export default router;
