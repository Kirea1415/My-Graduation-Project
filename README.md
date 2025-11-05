SafeKeyS - Tài liệu dự án (Website hoàn chỉnh)

## 1) Tính năng tổng quan
- Sản phẩm, danh mục, giỏ hàng, thanh toán giả lập, wishlist.
- Lọc sản phẩm không tải lại trang (AJAX): sắp xếp, danh mục, khoảng giá, tìm kiếm, cập nhật URL không reload.
- Trang Cài đặt Admin:
  - Lưu từng phần (section) qua AJAX: `social`, `homepage`, `pages`.
  - Quản lý nội dung trang chủ (hero title/subtitle/features, carousel title/subtitle).
  - Mạng xã hội động: thêm/sửa/xóa, tên tuỳ ý, upload icon hình ảnh; không còn nhập URL icon.
  - Footer đọc dữ liệu từ `social_media_list` (JSON) có fallback định dạng cũ nếu còn.
- Xác thực: tài khoản thường + (tuỳ chọn) Google OAuth, bcrypt, session.
- Upload file icon bằng multer, lưu tại `public/img/icons/` với kiểm tra loại/kích thước file.

## 2) Công nghệ sử dụng
- Node.js, Express, EJS.
- SQLite (mặc định). Hỗ trợ xuất/đồng bộ sang PostgreSQL.
- Passport (local, Google OAuth tuỳ chọn), bcrypt, express-session.
- Multer (upload), CSRF, flash messages.
- Frontend: EJS + CSS thuần, fetch API (AJAX).

## 3) Cài đặt & chạy
```bash
npm install
npm start
# hoặc
node server.js
```
Mặc định ứng dụng chạy tại: http://localhost:3000

### Environment variables (tuỳ chọn)
- PORT: cổng chạy server (mặc định 3000)
- NODE_ENV: `development` | `production`
- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (nếu bật Google OAuth)
- SESSION_SECRET (khuyến nghị đặt riêng khi triển khai)

## 4) Cấu trúc thư mục (rút gọn)
- `server.js`: Routing, middleware, DB, auth, API AJAX, admin settings.
- `views/`: Giao diện EJS
  - `home.ejs`: Trang chủ, filter AJAX.
  - `admin/settings.ejs`: Cài đặt admin, lưu từng phần, upload icon.
- `public/`: Tài nguyên tĩnh
  - `img/icons/`: Nơi lưu icon mạng xã hội upload.

## 5) Cơ sở dữ liệu
- Mặc định dùng SQLite (file `.db`).
- File `.db` là cơ sở dữ liệu SQLite (toàn bộ bảng/dữ liệu). Mở bằng DBeaver, Beekeeper Studio, TablePlus, hoặc `sqlite3`.

### Truy vấn nhanh (sqlite3)
```bash
# Liệt kê bảng
sqlite3 safekeys.db ".tables"

# Truy vấn tất cả dữ liệu một bảng
sqlite3 safekeys.db "SELECT * FROM products LIMIT 50;"
```

## 6) Bộ lọc sản phẩm (AJAX)
- UI gọi `GET /api/products/filter` với các params: `q`, `sort`, `category`, `price`.
- Server trả JSON `{ success, html, count }`, client cập nhật grid sản phẩm trực tiếp.
- URL được cập nhật bằng `history.pushState` để hỗ trợ Back/Forward (có lắng nghe `popstate`).

## 7) Cài đặt Admin (Admin Settings)
- Endpoint lưu AJAX: `POST /admin/settings/save` với `section` thuộc một trong: `social`, `homepage`, `pages`.
- Mạng xã hội:
  - Dữ liệu lưu trong `social_media_list` (JSON array), mỗi item: `{ name, url, iconPath }`.
  - Icon chỉ dùng upload file (bỏ trường URL icon). Tệp lưu `public/img/icons/`.
- Trang chủ: các key `homepage_hero_title`, `homepage_hero_subtitle`, `homepage_hero_features`, `homepage_carousel_title`, `homepage_carousel_subtitle`.

## 8) Xuất dữ liệu & chuyển đổi sang PostgreSQL
- Dùng Node.js + `pg` để:
  1) Tạo lược đồ (schema) tương đương trên PostgreSQL.
  2) Đọc tất cả dữ liệu từ SQLite và insert sang PostgreSQL.
  3) Tạo index/constraint; reset sequence nếu có.
- Gợi ý kiểm tra khác biệt cú pháp giữa SQLite và PostgreSQL: AUTOINCREMENT ↔ SEQUENCE, datetime, upsert.
- Sau khi import, có thể quản lý/quer y bằng pgAdmin.

### Truy vấn tất cả dữ liệu (PostgreSQL, psql)
```bash
# Ví dụ: liệt kê sản phẩm trên Postgres
psql "$DATABASE_URL" -c "SELECT id, title, price_cents FROM products LIMIT 50;"
```

## 9) Bảo mật & xác thực
- Session + CSRF được bật cho form POST (các API GET phục vụ AJAX filter không yêu cầu CSRF).
- Mật khẩu băm bằng bcrypt.
- (Tuỳ chọn) Google OAuth qua Passport (cần cấu hình client id/secret).

## 10) Khắc phục sự cố
- Không lưu được Cài đặt Admin: kiểm tra quyền ghi thư mục `public/img/icons/` và kích thước/định dạng ảnh.
- Lọc không hoạt động: kiểm tra `GET /api/products/filter` trả về `200`; xem console trình duyệt và logs server.
- Dropdown trống: kiểm tra bảng `categories` có dữ liệu; truy vấn danh mục nằm trong `server.js` (route `/`).
- Upload icon thất bại: kiểm tra `multer` filter (định dạng) và limit kích thước.

## 11) Câu hỏi thường gặp (FAQ)
- `.db` là gì và mở thế nào?
  - Là file cơ sở dữ liệu SQLite. Mở bằng DBeaver, Beekeeper Studio, TablePlus, hoặc `sqlite3 safekeys.db`.
- Có bắt buộc sửa tất cả cảnh báo linter không?
  - Nên sửa để code rõ ràng, tránh lỗi tiềm ẩn. Dự án đã được tinh chỉnh để không còn báo lỗi nghiêm trọng ở phần Admin Settings.
- Có thể triển khai production thế nào?
  - Dùng `NODE_ENV=production`, reverse proxy (Nginx), và trình quản lý process như PM2. Đặt `SESSION_SECRET` riêng.

## 12) Thư mục quan trọng
- `server.js`: Routing, filter API, cài đặt, auth, giỏ hàng, wishlist, middleware.
- `views/home.ejs`: Trang chủ + JS filter AJAX.
- `views/admin/settings.ejs`: Giao diện cài đặt admin (lưu từng phần, upload icon).
- `public/img/icons/`: Lưu icon mạng xã hội đã upload.

## 13) Giấy phép
Sử dụng nội bộ cho dự án SafeKeyS.

## Thư mục quan trọng
- `server.js`: routing, filter API, cài đặt, auth, giỏ hàng, wishlist.
- `views/home.ejs`: giao diện trang chủ, filters AJAX.
- `views/admin/settings.ejs`: giao diện cài đặt admin, lưu từng phần qua AJAX, upload icon.

## Giấy phép
Sử dụng nội bộ cho dự án SafeKeyS.


