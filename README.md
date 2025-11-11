# SafeKeyS - Hệ thống bán Key phần mềm và Game

Hệ thống bán key phần mềm và game với đầy đủ tính năng quản lý, thanh toán MoMo, và quản lý dữ liệu.

## 🚀 Tính năng chính

- ✅ **Quản lý sản phẩm**: Thêm, sửa, xóa sản phẩm với danh mục
- ✅ **Quản lý đơn hàng**: Xem lịch sử đơn hàng, quản lý trạng thái
- ✅ **Thanh toán MoMo**: Tích hợp cổng thanh toán MoMo
- ✅ **Giỏ hàng**: Lưu giỏ hàng vào database, không mất khi đăng xuất
- ✅ **Quản lý người dùng**: Đăng ký, đăng nhập, hồ sơ cá nhân
- ✅ **Yêu thích**: Danh sách sản phẩm yêu thích
- ✅ **Tin tức**: Quản lý tin tức, bài viết
- ✅ **Admin Panel**: Dashboard quản lý toàn diện
- ✅ **Lưu trữ dữ liệu**: Dữ liệu được lưu vào file JSON trong `data/` và PostgreSQL

## 📋 Yêu cầu hệ thống

- Node.js >= 18.x
- PostgreSQL >= 12.x
- npm hoặc yarn

## 🔧 Cài đặt

### 1. Clone repository

```bash
git clone <repository-url>
cd SafeKeyS
```

### 2. Cài đặt dependencies

```bash
npm install
```

### 3. Cấu hình môi trường

Tạo file `.env` trong thư mục gốc:

```env
# PostgreSQL
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=safekeys
PG_USER=postgres
PG_PASSWORD=your_password

# Session
SESSION_SECRET=your-secret-key-change-this

# MoMo Payment (optional)
MOMO_ACCESS_KEY=your_momo_access_key
MOMO_SECRET_KEY=your_momo_secret_key

# Google OAuth (optional)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Server
PORT=3000
NODE_ENV=development
```

### 4. Tạo database

```bash
npm run create-db
```

Hoặc tạo thủ công:

```sql
CREATE DATABASE safekeys;
```

Sau đó import schema từ `data/safekeys-database.sql` (nếu có).

### 5. Tạo bảng user_carts (cho tính năng lưu giỏ hàng)

```bash
npm run create-user-carts-table
```

### 6. Khởi động server

**Development mode (với nodemon):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

Server sẽ chạy tại: `http://localhost:3000`

## 📁 Cấu trúc dữ liệu

Dữ liệu được lưu trữ ở 2 nơi:

### 1. PostgreSQL Database
- Tất cả dữ liệu chính (users, products, orders, etc.)
- Session data (giỏ hàng, đăng nhập)
- User carts (giỏ hàng theo user_id)

### 2. File JSON trong `data/`
- `users.json` - Người dùng
- `products.json` - Sản phẩm
- `orders.json` - Đơn hàng
- `order_items.json` - Chi tiết đơn hàng
- `order_keys.json` - Keys của đơn hàng
- `categories.json` - Danh mục
- `wishlist.json` - Yêu thích
- `news.json` - Tin tức
- `settings.json` - Cài đặt

**Lưu ý:** Dữ liệu được lưu tự động vào file JSON mỗi khi có thao tác. Bạn có thể mở file JSON để xem và quản lý dữ liệu trực tiếp.

## 🔄 Scripts có sẵn

### Quản lý database
```bash
# Tạo database và import schema
npm run create-db

# Tạo bảng user_carts (cho tính năng lưu giỏ hàng)
npm run create-user-carts-table
```

### Đồng bộ dữ liệu
```bash
# Đồng bộ từ PostgreSQL → File JSON
npm run sync-to-files

# Đồng bộ từ File JSON → PostgreSQL
npm run sync-to-postgresql
```

### Chạy server
```bash
# Development mode (tự động restart khi có thay đổi)
npm run dev

# Production mode
npm start
```

## 🎯 Tính năng chi tiết

### Giỏ hàng
- Giỏ hàng được lưu vào PostgreSQL session store
- Giỏ hàng được lưu vào database theo `user_id` khi logout
- Giỏ hàng được restore khi login lại
- Không mất giỏ hàng khi reload trang hoặc đăng xuất/đăng nhập

### Thanh toán
- **MoMo Payment**: Tích hợp cổng thanh toán MoMo
- **Mock Payment**: Thanh toán thử nghiệm (không cần tiền thật)
- Keys được lưu vào `order_keys` sau khi thanh toán thành công

### Quản lý Keys
- Admin có thể quản lý keys cho từng sản phẩm
- Keys được tự động gán cho đơn hàng sau khi thanh toán
- Mỗi sản phẩm có thể có nhiều keys (theo số lượng)

### Admin Panel
- Dashboard với thống kê
- Quản lý sản phẩm, danh mục, tin tức
- Quản lý đơn hàng và người dùng
- Xem lịch sử giao dịch của người dùng

## 🔐 Đăng nhập Admin

- **URL**: `http://localhost:3000/admin`
- **Mật khẩu dự phòng**: `141514` (cho tài khoản admin bị khóa)

## 📝 API Endpoints

### Cart
- `POST /api/cart/add/:productId` - Thêm vào giỏ hàng (AJAX)
- `POST /cart/add/:productId` - Thêm vào giỏ hàng
- `POST /cart/remove/:productId` - Xóa khỏi giỏ hàng
- `POST /cart/update/:productId` - Cập nhật số lượng

### Checkout
- `GET /checkout` - Trang xác nhận thanh toán
- `POST /checkout` - Xử lý thanh toán
- `POST /checkout/momo` - Thanh toán MoMo
- `POST /api/momo-callback` - Callback từ MoMo

### Orders
- `GET /orders` - Lịch sử đơn hàng
- `GET /orders/:id/keys` - Xem keys của đơn hàng

## 🗄️ Database Schema

### Bảng chính
- `users` - Người dùng
- `products` - Sản phẩm
- `categories` - Danh mục
- `orders` - Đơn hàng
- `order_items` - Chi tiết đơn hàng
- `order_keys` - Keys của đơn hàng
- `wishlist` - Yêu thích
- `news` - Tin tức
- `settings` - Cài đặt
- `sessions` - Session data (PostgreSQL session store)
- `user_carts` - Giỏ hàng theo user_id

## 🛠️ Troubleshooting

### Lỗi kết nối PostgreSQL
- Kiểm tra PostgreSQL service có đang chạy không
- Kiểm tra thông tin trong file `.env`
- Kiểm tra database `safekeys` đã được tạo chưa

### Giỏ hàng bị mất
- Đảm bảo đã chạy `npm run create-user-carts-table`
- Kiểm tra session store có hoạt động không
- Xem log trong console để debug

### Dữ liệu không đồng bộ
- Chạy `npm run sync-to-files` để đồng bộ từ PostgreSQL → File
- Chạy `npm run sync-to-postgresql` để đồng bộ từ File → PostgreSQL

## 📄 License

ISC

## 👥 Tác giả

SafeKeyS Team
