import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import csrf from 'csurf';
import connectFlash from 'connect-flash';
import methodOverride from 'method-override';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { body, validationResult } from 'express-validator';

/**
 * Setup all middleware for Express app
 * This module centralizes all middleware configuration from server.js
 */

export function setupSecurityMiddleware(app) {
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }));
}

export function setupCompressionMiddleware(app) {
    app.use(compression({
        filter: (req, res) => {
            if (req.headers['x-no-compression']) return false;
            return compression.filter(req, res);
        },
        level: 6
    }));
}

export function setupLoggingMiddleware(app) {
    app.use(morgan('dev'));
}

export function setupBodyParser(app) {
    app.use(express.urlencoded({ extended: true, limit: '50mb', parameterLimit: 10000 }));
    app.use(express.json({ limit: '50mb' }));
}

export function setupStaticAndViews(app, VIEWS_PATH, PUBLIC_PATH) {
    app.set('view engine', 'ejs');
    app.set('views', VIEWS_PATH);
    app.use(express.static(PUBLIC_PATH));
}

export function setupMulter(PUBLIC_PATH) {
    const AVATARS_PATH = path.join(PUBLIC_PATH, 'img', 'avatars');
    const ICONS_PATH = path.join(PUBLIC_PATH, 'img', 'icons');

    if (!fs.existsSync(AVATARS_PATH)) {
        fs.mkdirSync(AVATARS_PATH, { recursive: true });
    }

    const iconStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, ICONS_PATH);
        },
        filename: function (req, file, cb) {
            const fieldName = file.fieldname || 'icon';
            const timestamp = Date.now();
            const ext = path.extname(file.originalname) || '.png';
            const filename = `${fieldName}_${timestamp}${ext}`;
            cb(null, filename);
        }
    });

    const avatarStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, AVATARS_PATH);
        },
        filename: function (req, file, cb) {
            const userId = req.session?.user?.id || 'unknown';
            const timestamp = Date.now();
            const ext = path.extname(file.originalname) || '.png';
            const filename = `avatar_${userId}_${timestamp}${ext}`;
            cb(null, filename);
        }
    });

    const imageFilter = function (req, file, cb) {
        console.log('🔍 Image filter called:', {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            encoding: file.encoding
        });

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

    const upload = multer({
        storage: iconStorage,
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: imageFilter
    });

    const uploadAvatar = multer({
        storage: avatarStorage,
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: imageFilter
    });

    return { upload, uploadAvatar };
}

export function setupMethodOverride(app) {
    app.use(methodOverride('_method'));
}

export function setupSession(app, pool) {
    const PgSession = connectPgSimple(session);
    const sessionStore = new PgSession({
        pool: pool,
        tableName: 'sessions',
        createTableIfMissing: true
    });

    app.use(
        session({
            store: sessionStore,
            secret: process.env.SESSION_SECRET || 'safekeys-secret-please-change',
            resave: true,
            saveUninitialized: true,
            cookie: {
                httpOnly: true,
                maxAge: 1000 * 60 * 60 * 24,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax'
            },
            name: 'safekeys.sid'
        })
    );
}

export function setupPassportSession(app, passport) {
    app.use(passport.initialize());
    app.use(passport.session());
}

export function setupFlash(app) {
    app.use(connectFlash());
}

export function setupCSRF(app) {
    const csrfProtection = csrf({
        cookie: false,
        sessionKey: 'session',
        value: (req) => {
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

    app.use((req, res, next) => {
        const skipPaths = [
            '/api/',
            '/admin/settings/save',
            '/checkout/momo',
            '/profile',
            '/admin/products'
        ];

        const shouldSkip = skipPaths.some(path => req.path.startsWith(path));

        if (shouldSkip) {
            return next();
        }

        csrfProtection(req, res, (err) => {
            if (err) {
                console.error('❌ CSRF Error:', {
                    path: req.path,
                    method: req.method,
                    error: err.message,
                    hasSession: !!req.session,
                    sessionID: req.sessionID,
                    cookies: req.cookies
                });

                if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
                    console.warn('⚠️  CSRF error on safe method, ignoring');
                    return next();
                }

                req.flash('error', 'Phiên làm việc đã hết hạn. Vui lòng thử lại.');
                return res.redirect('back');
            }
            next();
        });
    });

    app.use((err, req, res, next) => {
        if (err.code === 'EBADCSRFTOKEN') {
            console.error('❌ CSRF Token Error:', {
                path: req.path,
                method: req.method,
                hasSession: !!req.session
            });

            if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
                return next();
            }

            req.flash('error', 'Token bảo mật không hợp lệ. Vui lòng thử lại.');
            return res.redirect('back');
        }

        next(err);
    });
}

export function setupLocalsMiddleware(app, pool, getCart, logger) {
    app.use(async (req, res, next) => {
        res.locals.currentUser = null;
        res.locals.csrfToken = '';
        res.locals.flash = { success: [], error: [] };
        res.locals.theme = { primary: '#16a34a' };
        res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
        res.locals.settings = { social_media_list: [] };

        try {
            const sessionUser = req.session?.user;
            const passportUser = req.user;
            let user = sessionUser || passportUser || null;

            if (user && user.id) {
                try {
                    const freshUser = await pool.query('SELECT id, name, email, role, avatar, phone, address FROM users WHERE id = $1', [user.id]);
                    if (freshUser.rows && freshUser.rows.length > 0) {
                        const dbUser = freshUser.rows[0];
                        if (req.session.user) {
                            req.session.user.name = dbUser.name;
                            req.session.user.avatar = dbUser.avatar;
                            req.session.user.phone = dbUser.phone;
                            req.session.user.address = dbUser.address;
                        }
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
                }
            }

            res.locals.currentUser = user || null;
        } catch (e) {
            console.error('Error setting currentUser:', e);
            res.locals.currentUser = null;
        }

        try {
            if (req.csrfToken && typeof req.csrfToken === 'function') {
                try {
                    res.locals.csrfToken = req.csrfToken();
                } catch (csrfError) {
                    console.warn('CSRF token generation failed:', csrfError.message);
                    res.locals.csrfToken = '';
                }
            } else {
                res.locals.csrfToken = '';
            }
        } catch (e) {
            res.locals.csrfToken = '';
        }

        try {
            res.locals.flash = {
                success: req.flash('success') || [],
                error: req.flash('error') || []
            };
        } catch (e) {
            res.locals.flash = { success: [], error: [] };
        }

        try {
            if (!req.session) {
                res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
            } else {
                try {
                    const cart = await getCart(req);
                    res.locals.cart = {
                        totalQty: (cart && typeof cart.totalQty === 'number') ? cart.totalQty : 0,
                        totalCents: (cart && typeof cart.totalCents === 'number') ? cart.totalCents : 0,
                        items: (cart && cart.items && typeof cart.items === 'object') ? cart.items : {}
                    };
                    if (cart && cart.totalQty > 0) {
                        logger.debug('🛒 Cart loaded:', { totalQty: cart.totalQty, itemCount: Object.keys(cart.items || {}).length });
                    }
                } catch (cartError) {
                    console.error('Error loading cart in middleware:', cartError);
                    res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
                }
            }
        } catch (e) {
            console.error('Error setting cart in locals:', e);
            res.locals.cart = { totalQty: 0, totalCents: 0, items: {} };
        }

        try {
            let socialMediaList = [];
            try {
                const socialMediaJson = await getSetting('social_media_list', '');
                if (socialMediaJson && socialMediaJson.trim()) {
                    try {
                        socialMediaList = JSON.parse(socialMediaJson);
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
}

// Helper function (needed by locals middleware)
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
