# VPS HUB - Hệ Thống Quản Lý 2 VPS Azure & Chi Tiêu (0đ Duy Trì, Siêu Nhẹ RAM)

Hệ thống quản lý 2 node VPS chuyên biệt:
- **VPS 1 (Kuala Lumpur - 85.211.193.75):** Windows Server 2022 (WindowVM) (1 Core / 2 Threads EPYC 7763, 1GB RAM)
- **VPS 2 (Seoul - 20.196.198.124):** Debian 12 (bookworm) (Chạy Beszel Hub cổng :8080)
- **VPS 3:** đã gộp vào VPS 2 (09/2026)

---

## 🏗 Kiến Trúc Tổng Thể

```text
                     [ hoangngocbach.id.vn ]
                               │
                               ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                 AZURE STATIC WEB APPS (SWA)                 │
    │  • Frontend: Single Page Dashboard (Vue 3 / Tailwind)       │
    │  • Backend API: /api/* (Azure Functions Serverless Node.js) │
    │                                                             │
    │  Database: Azure Cosmos DB (Free Tier 1000 RU/s + 25GB SSD) │
    │  ├── /expenses     (Lưu chi tiêu, hóa đơn định kỳ)          │
    │  └── /vps_metrics  (Lưu CPU/RAM/Băng thông, TTL 7 ngày)     │
    └──────────────────────────┬──────────────────────────────────┘
                               ▲
                 (Metric HTTPS POST 30s/lần)
                               │
      ┌────────────────────────┼────────────────────────┐
      │ (Cloudflare Tunnel)    │ (Cloudflare Tunnel)    │ (Cloudflare Tunnel)
      ▼                        ▼                        ▼
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│    VPS 1     │         │    VPS 2     │         │    VPS 3     │
│ (Win2022)    │         │ (Debian 12)  │         │ (Debian 12)  │
├──────────────┤         ├──────────────┤         ├──────────────┤
│ Go Agent     │         │ Go Agent     │         │ Go Agent     │
│ Port: 8085   │         │ Port: 8085   │         │ Port: 8085   │
│ Win32 API    │         │ /proc sysinfo│         │ /proc sysinfo│
│ RAM: ~6MB    │         │ RAM: ~6MB    │         │ RAM: ~6MB    │
└──────────────┘         └──────────────┘         └──────────────┘
```

---

## 🚀 Hướng Dẫn Triển Khai Nhanh

### BƯỚC 1: Biên dịch và chạy Go Agent trên 3 VPS

#### 1. Biên dịch Agent (Cross-compile cho cả Linux & Windows):
Trên máy có cài Go (hoặc compile trực tiếp trên VPS Debian):

```bash
cd agent

# Biên dịch cho Linux (Ubuntu, Debian):
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o vps-agent-linux .

# Biên dịch cho Windows Server 2022:
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o vps-agent-windows.exe .
```
*(Cờ `-ldflags="-s -w"` sẽ xóa toàn bộ debug symbol thừa, giúp file binary siêu nhỏ chỉ ~7MB và khởi động trong 2ms).*

#### 2. Cài đặt trên VPS 2 (Debian):
Copy file `vps-agent-linux` lên thư mục `/opt/vps-agent/` và tạo service:

```bash
sudo mkdir -p /opt/vps-agent
sudo mv vps-agent-linux /opt/vps-agent/vps-agent
sudo chmod +x /opt/vps-agent/vps-agent

# Tạo systemd service
sudo nano /etc/systemd/system/vps-agent.service
```

Dán nội dung sau vào file service:
```ini
[Unit]
Description=VPS Telemetry & Storage Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vps-agent
ExecStart=/opt/vps-agent/vps-agent -port 8085 -vps-id vps2 -vps-name "VPS 2 (Debian)" -hub-url https://hoangngocbach.id.vn/api/telemetry -secret secret-token-change-me
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Kích hoạt và khởi động service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-agent
# Kiểm tra log và RAM tiêu thụ (chỉ ~5MB - 6MB):
sudo systemctl status vps-agent
```

#### 3. Cài đặt trên VPS 1 (Windows Server 2022 - Kuala Lumpur):
Tạo thư mục `C:\vps-agent`, copy file `vps-agent-windows.exe` vào đó.
Mở PowerShell (Run as Administrator):

```powershell
# Chạy thử nghiệm:
cd C:\vps-agent
.\vps-agent-windows.exe -port 8085 -vps-id vps1 -vps-name "VPS 1 (Kuala Lumpur)" -hub-url https://hoangngocbach.id.vn/api/telemetry -secret secret-token-change-me
```

Để chạy ngầm vĩnh viễn cùng Windows:
Tạo một Task trong **Task Scheduler** chạy khi hệ thống khởi động (At startup) với user `SYSTEM`.

---

### BƯỚC 2: Cấu hình Cloudflare Tunnel trên 3 VPS

Mỗi VPS chỉ cần map subdomain vào cổng `8085`:

* **Trên VPS 1 (Windows):**
  Thêm Ingress rule vào file config Cloudflare Tunnel:
  ```yaml
  ingress:
    - hostname: vps1.hoangngocbach.id.vn
      service: http://localhost:8085
  ```

* **Trên VPS 2 (Debian):**
  ```yaml
  ingress:
    - hostname: vps2.hoangngocbach.id.vn
      service: http://localhost:8085
    - hostname: beszel.hoangngocbach.id.vn
      service: http://localhost:8080
  ```

* **Trên VPS 3 (Debian):**
  ```yaml
  ingress:
    - hostname: vps3.hoangngocbach.id.vn
      service: http://localhost:8085
  ```

---

### BƯỚC 3: Thiết lập Azure Cosmos DB (Free Tier 1000 RU/s + 25GB)

1. Đăng nhập [Azure Portal](https://portal.azure.com).
2. Tạo resource **Azure Cosmos DB** (chọn **Azure Cosmos DB for NoSQL**).
3. **Quan trọng:** Tại mục **Capacity Mode**, chọn **Provisioned throughput** và **TÍCH CHỌN "Apply Free Tier Discount"**.
4. Vào mục **Data Explorer**:
   * Tạo Database: `vps_hub`
   * Tạo Container 1: `vps_metrics`
     - Partition Key: `/vps_id`
     - Throughput: `400 RU/s` (Autoscale hoặc Manual)
     - Cài đặt **Settings -> Time to Live (TTL)**: Bật **On**, đặt `604800` giây (7 ngày).
   * Tạo Container 2: `expenses`
     - Partition Key: `/category`
     - Throughput: `400 RU/s`
5. Lấy chuỗi kết nối tại mục **Keys -> Primary Connection String**.

---

### BƯỚC 4: Deploy lên Azure Static Web Apps

1. Đẩy mã nguồn thư mục này lên GitHub repository của bạn.
2. Lên Azure Portal, tạo **Static Web Apps**:
   * Plan type: **Free**
   * Source: **GitHub** (chọn repo vừa đẩy)
   * Build Presets: **Custom**
     - App location: `frontend`
     - Api location: `api`
     - Output location: `""` (để trống vì frontend dùng file tĩnh trực tiếp)
3. Sau khi tạo xong, vào mục **Configuration -> Application Settings** trên Azure Static Web Apps và thêm:
   * `COSMOS_DB_CONNECTION_STRING`: `<Chuỗi kết nối Cosmos DB>`
   * `AGENT_SECRET_KEY`: `secret-token-change-me`
4. Vào mục **Custom domains**, thêm domain `hoangngocbach.id.vn`. Azure sẽ cung cấp bản ghi CNAME/TXT để bạn thêm vào Cloudflare DNS.

---

## 🛡 Các Điểm Đột Phá Kỹ Thuật Được Tối Ưu

1. **Không dính bẫy vCPU-seconds của ACA:** Sử dụng Azure Functions thuần túy theo request, 3 VPS ping 30s/lần chỉ tiêu thụ ~3.750 GB-seconds / 400.000 GB-seconds miễn phí mỗi tháng (< 1% hạn mức).
2. **Vượt giới hạn 100MB Cloudflare Tunnel:** Trình duyệt tự động cắt nhỏ file thành các chunk **20MB** (`file.slice()`), Go Agent nhận và stream thẳng xuống đĩa cứng bằng buffer 64KB (không load vào RAM).
3. **Tương thích hoàn hảo Windows Server 2022 & Linux:** Agent sử dụng Win32 API (`kernel32.dll`, `iphlpapi.dll`) trên Windows và `/proc` trên Linux.
4. **Tránh xung đột cổng 8080 của Beszel Hub:** Đổi cổng lắng nghe của Agent sang `8085`.
5. **CORS Preflight:** Xử lý chuẩn `OPTIONS 204` cho cross-domain upload từ `hoangngocbach.id.vn` sang các subdomain VPS.
6. **Smart Polling:** Tự động ngắt request khi ẩn tab trình duyệt để tiết kiệm 100% request không cần thiết.
