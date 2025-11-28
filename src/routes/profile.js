import express from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';

const router = express.Router();

/**
 * Profile routes - user profile view & edit, password change
 */

export function setupProfileRoutes(app, {
    pool, db, requireAuth, logger, uploadAvatar, PUBLIC_PATH, getUser, getUserId, dataManager
}) {
    // GET /profile - View profile
    app.get('/profile', requireAuth, async (req, res) => {
        try {
            const userId = getUserId(req);
            const stmt1 = db.prepare('SELECT * FROM users WHERE id = ?');
            const user = await stmt1.get(userId);
            if (!user) {
                req.flash('error', 'Không tìm thấy thông tin người dùng');
                return res.redirect('/');
            }

            if (user.avatar && !user.avatar.startsWith('http') && !user.avatar.startsWith('https')) {
                const avatarFilePath = path.join(PUBLIC_PATH, user.avatar.replace(/^\//, ''));
                if (!fs.existsSync(avatarFilePath)) {
                    console.warn('⚠️ Avatar file not found:', avatarFilePath);
                    console.warn('⚠️ Avatar path in database:', user.avatar);
                } else {
                    console.log('✅ Avatar file exists:', avatarFilePath);
                }
            }

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

    // POST /profile - Update profile (with avatar upload)
    app.post('/profile', requireAuth,
        (req, res, next) => {
            next();
        },
        (req, res, next) => {
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

                logger.debug('🔍 Multer processing complete:', {
                    hasFile: !!req.file,
                    sessionUserId: req.session?.user?.id,
                    contentType: req.headers['content-type']
                });

                if (!req.file && req.headers['content-type']?.includes('multipart/form-data')) {
                    console.warn('⚠️ WARNING: Form has multipart content-type but no file received!');
                }

                const token = req.body._csrf || req.headers['x-csrf-token'] || req.query._csrf;
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

            const { name, phone, address } = req.body;
            const userId = getUserId(req);

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
                const stmt1 = db.prepare('SELECT * FROM users WHERE id = ?');
                const user = await stmt1.get(userId);
                if (!user) {
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

                let avatarPath = null;

                if (req.file) {
                    console.log('📸 Avatar upload detected:', {
                        filename: req.file.filename,
                        size: req.file.size,
                        mimetype: req.file.mimetype
                    });

                    if (!fs.existsSync(req.file.path)) {
                        console.error('❌ Uploaded file does not exist at path:', req.file.path);
                        req.flash('error', 'Có lỗi xảy ra khi lưu ảnh. Vui lòng thử lại.');
                        return res.redirect('/profile');
                    }

                    console.log('✅ File exists at path:', req.file.path);

                    if (user.avatar && !user.avatar.startsWith('http') && !user.avatar.startsWith('https')) {
                        const oldAvatarPath = path.join(PUBLIC_PATH, user.avatar.replace(/^\//, ''));
                        console.log('🗑️ Checking old avatar path:', oldAvatarPath);
                        if (fs.existsSync(oldAvatarPath)) {
                            try {
                                fs.unlinkSync(oldAvatarPath);
                                console.log('✅ Deleted old avatar:', oldAvatarPath);
                            } catch (err) {
                                console.error('⚠️ Error deleting old avatar (non-critical):', err.message);
                            }
                        }
                    }

                    avatarPath = `/img/avatars/${req.file.filename}`;
                    console.log('💾 New avatar path to save:', avatarPath);
                } else {
                    avatarPath = user.avatar || null;
                    console.log('ℹ️ No avatar file uploaded, keeping existing avatar:', avatarPath);
                }

                const updateName = (name && name.trim()) ? name.trim() : user.name;
                const updatePhone = (phone && phone.trim()) ? phone.trim() : null;
                const updateAddress = (address && address.trim()) ? address.trim() : null;

                console.log('Updating user profile:', {
                    userId,
                    updateName,
                    updatePhone: updatePhone ? '***' : null,
                    updateAddress: updateAddress ? '***' : null,
                    avatarPath
                });

                const updateResult = await pool.query(
                    `UPDATE users 
           SET name = $1, phone = $2, address = $3, avatar = $4, updated_at = CURRENT_TIMESTAMP 
           WHERE id = $5`,
                    [updateName, updatePhone || null, updateAddress || null, avatarPath, userId]
                );

                dataManager.updateItem('users', userId, {
                    name: updateName,
                    phone: updatePhone || null,
                    address: updateAddress || null,
                    avatar: avatarPath,
                    updated_at: new Date().toISOString()
                });

                if (req.session.user) {
                    req.session.user.name = updateName;
                    req.session.user.avatar = avatarPath;
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

                const stmt3 = db.prepare('SELECT * FROM users WHERE id = ?');
                const updatedUser = await stmt3.get(userId);

                if (!updatedUser) {
                    console.error('❌ User not found after update');
                    throw new Error('User not found after update');
                }

                console.log('✅ Updated user from database:', {
                    id: updatedUser.id,
                    name: updatedUser.name,
                    avatar: updatedUser.avatar
                });

                req.session.user = {
                    id: updatedUser.id,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    role: updatedUser.role,
                    avatar: updatedUser.avatar || null
                };

                if (req.file) {
                    req.flash('success', 'Đã cập nhật thông tin và avatar thành công');
                } else {
                    req.flash('success', 'Đã cập nhật thông tin thành công');
                }

                res.redirect('/profile?t=' + Date.now());
            } catch (err) {
                console.error('Profile update error:', err);
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

    // POST /profile/change-password
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
                const stmt1 = db.prepare('SELECT * FROM users WHERE id = ?');
                const user = await stmt1.get(userId);
                if (!user) {
                    req.flash('error', 'Không tìm thấy người dùng');
                    return res.redirect('/profile');
                }

                if (user.google_id) {
                    req.flash('error', 'Tài khoản đăng nhập bằng Google không thể đổi mật khẩu');
                    return res.redirect('/profile');
                }

                if (!bcrypt.compareSync(current_password, user.password_hash)) {
                    req.flash('error', 'Mật khẩu hiện tại không đúng');
                    return res.redirect('/profile');
                }

                const newPasswordHash = bcrypt.hashSync(new_password, 10);
                await pool.query(
                    'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [newPasswordHash, userId]
                );

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
}

export default router;
