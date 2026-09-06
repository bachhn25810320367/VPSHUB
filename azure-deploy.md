# Hướng Dẫn Kết Nối VPS Hub với Microsoft Azure (Serverless & Free Tier)

Tài liệu này hướng dẫn từng bước thiết lập tài nguyên trên **Microsoft Azure Portal** để kết nối hoàn chỉnh với **VPS Hub**.

---

## 1. Khởi tạo Azure Cosmos DB NoSQL (Miễn Phí 1,000 RU/s & 25GB)

1. Truy cập [Azure Portal](https://portal.azure.com) -> Tìm **Azure Cosmos DB** -> Nhấn **Create**.
2. Chọn **Azure Cosmos DB for NoSQL**.
3. Điền thông số:
   - **Subscription**: Chọn gói của bạn (Free / Pay-As-You-Go).
   - **Resource Group**: `rg-vps-hub` (hoặc tạo mới).
   - **Account Name**: ví dụ `cosmos-vps-hub-prod`.
   - **Location**: `Southeast Asia` (hoặc `East Asia`).
   - **Capacity mode**: **Serverless** (hoặc chọn **Apply Free Tier Discount** 1,000 RU/s và 25GB dung lượng).
4. Nhấn **Review + create** -> **Create**.
5. Sau khi tạo xong, vào mục **Keys** -> Copy chuỗi **PRIMARY CONNECTION STRING**.

---

## 2. Cấu hình Connection String vào Azure Functions

1. Mở file `api/local.settings.json` và cập nhật chuỗi kết nối:
   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "node",
       "COSMOS_DB_CONNECTION_STRING": "AccountEndpoint=https://<your-account>.documents.azure.com:443/;AccountKey=<your-key>;",
       "AGENT_SECRET_KEY": "secret-token-change-me"
     },
     "Host": {
       "CORS": "*"
     }
   }
   ```
2. Mã nguồn API tự động tạo Database `vps_hub` và 2 Containers khi khởi chạy lần đầu:
   - `vps_metrics`: Partition Key `/vps_id`, TTL `604800` (7 ngày tự động dọn dẹp số liệu cũ để giữ dung lượng 0 đồng).
   - `expenses`: Partition Key `/category`.

---

## 3. Triển khai lên Azure Static Web Apps (Free Tier)

**Azure Static Web Apps** cho phép lưu trữ giao diện frontend HTML/CSS/JS đồng thời tự động tích hợp backend **Azure Functions** (thư mục `api/`) trên cùng 1 tên miền.

### Cách 1: Qua GitHub Actions (Khuyên dùng)
1. Đẩy mã nguồn dự án lên GitHub repository cá nhân (ví dụ: `your-username/vps-hub`).
2. Trên Azure Portal, tìm **Static Web Apps** -> **Create**.
3. Liên kết với tài khoản GitHub và chọn repo `vps-hub`.
4. Trong mục **Build Details**:
   - **App location**: `frontend`
   - **Api location**: `api`
   - **Output location**: để trống (hoặc để mặc định)
5. Nhấn **Create**. GitHub Actions sẽ tự động biên dịch TypeScript trong `api/` và triển khai frontend.
6. Vào mục **Configuration** của Static Web App trên Azure Portal:
   - Thêm Application Setting:
     - Tên: `COSMOS_DB_CONNECTION_STRING`
     - Giá trị: Chuỗi kết nối Cosmos DB lấy từ Bước 1.
     - Tên: `AGENT_SECRET_KEY`
     - Giá trị: Mã token bí mật của bạn (ví dụ: `hoangngocbach-hub-secure-token-2026`).

---

## 4. Tùy chỉnh Tên miền Cá nhân (`hoangngocbach.id.vn`)

1. Trong Azure Static Web Apps, vào mục **Custom domains** -> Thêm tên miền `app.hoangngocbach.id.vn`.
2. Trên Cloudflare DNS Dashboard:
   - Thêm bản ghi CNAME:
     - **Name**: `app`
     - **Target**: `<tên-app>.azurestaticapps.net`
     - **Proxy status**: Proxied (đám mây cam).
3. Cloudflare & Azure sẽ tự động cấp phát chứng chỉ SSL/TLS miễn phí.

---

## 5. Thử nghiệm Nhanh tại Cục bộ (Local Test)

Bạn có thể chạy toàn bộ hệ thống ngay trên máy tính mà chưa cần deploy lên Azure bằng lệnh:
```powershell
node dev-server.js
```
Mở trình duyệt tại địa chỉ: `http://localhost:8080`
- Toàn bộ API `/api/telemetry/latest`, `/api/telemetry/history`, `/api/expenses` đã được giả lập hoàn chỉnh.
- Mọi thao tác thêm/sửa/xóa hợp đồng chi phí hay chuyển đổi biểu đồ sẽ phản hồi lập tức.
