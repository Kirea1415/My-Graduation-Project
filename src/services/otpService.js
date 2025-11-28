import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const OTP_EXPIRE_MS = (Number(process.env.OTP_EXPIRE_SECONDS) || 120) * 1000;

const otpStore = new Map(); // email -> { otp, expireAt }

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

export async function sendOtp(email, subject = 'Mã kích hoạt tài khoản', htmlTemplate) {
    const otp = generateOtp();
    const expireAt = Date.now() + OTP_EXPIRE_MS;
    otpStore.set(email, { otp, expireAt });

    const transporter = getTransporter();
    const html = htmlTemplate || `<h2>Mã kích hoạt của bạn: <b>${otp}</b></h2><p>Mã có hiệu lực trong ${Math.round(OTP_EXPIRE_MS / 1000)} giây.</p>`;

    await transporter.sendMail({
        from: `SafeKeyS <${process.env.SMTP_USER}>`,
        to: email,
        subject,
        html
    });

    return { success: true };
}

export function verifyOtp(email, otp) {
    const record = otpStore.get(email);
    if (!record) return { success: false, message: 'Email chưa gửi OTP.' };
    if (Date.now() > record.expireAt) {
        otpStore.delete(email);
        return { success: false, message: 'OTP đã hết hạn.' };
    }
    if (record.otp !== String(otp)) return { success: false, message: 'OTP không đúng.' };
    otpStore.delete(email);
    return { success: true };
}

export { OTP_EXPIRE_MS };
