# Daily Reading Practice — cách dựng Worker

## ✅ Tình trạng hiện tại (23/09/2026)

App đang ở **v256** (Module 1 + 2 + 3 đã xong):

1. Rollback worker `ethannguyen` từ bản `e173a2e8` về `c761528f` — app trở lại ngay.
2. Xoá `wrangler.toml` khỏi repo GitHub (commit `db9da57`) — bản build sau đó tự nhận
   `Framework: Static` trở lại và phục vụ `index.html` v252 như cũ.

Worker Daily Reading cũng đã dựng xong:

| Việc | Tình trạng |
|------|-----------|
| Worker `daily-reading` | ✅ đã tạo, địa chỉ `https://daily-reading.chinhnguyen1990cr.workers.dev` |
| Mã `daily-reading-worker.js` | ✅ đã dán và Deploy (version `3620805a`) |
| Biến `ALLOW_ORIGIN` (Text) | ✅ đã khai |
| Biến `GEMINI_API_KEY` (Secret) | ✅ đã khai |
| Module 3 — chấm phát âm (`/score`) | ✅ đã dựng, hai lối Azure + Gemini |
| Biến `AZURE_SPEECH_KEY` + `AZURE_REGION` | ⬜ **tuỳ chọn** — chưa khai thì dùng lối Gemini |
| Dán địa chỉ worker vào app | ⬜ bạn dán vào ô "Địa chỉ Cloudflare Worker" |
| Nút "Đọc câu này" / "Mẫu" / "Chấm" | ✅ sửa ở v256 — trước đó bấm không ăn gì (xem dưới) |

## 🔧 v256 — vì sao "Đọc câu này" và "Mẫu" bấm không ăn gì

Hai lỗi chồng lên nhau, cả hai đều của tôi:

1. **Gọi một biến không tồn tại.** Khối điều phối cú bấm khai biến tên `drpEl`, nhưng năm
   nhánh mới tôi viết lại gọi `el.getAttribute('data-i')`. Không có biến nào tên `el`, nên
   mỗi cú bấm ném `ReferenceError` rồi im lặng — bấm vào như bấm vào tường.
2. **Trùng tên hành động.** Nút chấm điểm mang `data-action="drp-cham"`, trùng đúng tên với
   công tắc chọn Azure/Gemini. Nhánh công tắc đứng trước nên nó nuốt hết cú bấm: bấm "Chấm"
   hoá ra đi đổi cài đặt. Nay nút chấm mang tên riêng `drp-cham-cau`.

**Vì sao 93 bộ kiểm tra vẫn xanh?** Vì phép đo cũ chỉ hỏi "dòng điều phối có tồn tại không"
— nó khớp đúng cái chuỗi tôi viết ra, kể cả khi chuỗi ấy sai. Đo hình dạng dây nối chứ không
đo dây có nối tới đâu không. Nay có thêm `ktDieuPhoi.js` soi trên TOÀN app: mọi `data-action`
trong HTML phải có người nhận, không tên nào được xử lý hai lần, và mọi biến dùng trong khối
điều phối phải được khai báo ở đó.

## ⚠️ VỊ TRÍ WORKER — chỗ này đã làm hỏng ba lần, đọc kỹ

Google **không phục vụ Gemini API từ mọi nơi**. Cloudflare Workers chạy ở điểm mạng gần người
gọi nhất, nên nếu rơi vào vùng Google không phục vụ thì mọi lời gọi đều trả về:

```
"User location is not supported for the API use."  (mã 400, FAILED_PRECONDITION)
```

Lời báo lỗi ấy **không nói gì về vị trí** nếu nhìn qua app — bản cũ chỉ hiện "Gemini trả lỗi
400.", và có lần còn bị nhầm thành "hết hạn mức". Worker nay dịch nó ra thành lời nhắc đúng
việc phải làm.

**Cách chữa:** ghim worker vào một vùng Google có phục vụ.

Trên giao diện: Worker → **Settings** → **Runtime** → **Placement** → **Region** →
**Google Cloud Platform (GCP)** → **us-central1** → **Deploy**.

**Nhưng mỗi lần đẩy mã mới lên bằng API, Cloudflare XOÁ MẤT cài đặt ấy.** Nên khi triển khai
bằng API, phải gắn `placement` vào ngay trong metadata. Định dạng đúng — tìm ra sau khi thử
bảy dạng khác nhau:

```json
{
  "main_module": "worker.js",
  "compatibility_date": "2026-09-22",
  "keep_bindings": ["secret_text", "plain_text"],
  "placement": { "mode": "targeted", "target": [{ "region": "gcp:us-central1" }] }
}
```

Hai chỗ dễ sai:
- `target` phải là mảng **đối tượng**, không phải mảng số — dù khi ĐỌC ra Cloudflare lại trả
  về `[122]` (số). Đọc một kiểu, ghi một kiểu.
- Vùng phải viết **`provider:region`** (`gcp:us-central1`), không phải `us-central1` trần.
- `keep_bindings` giữ lại `GEMINI_API_KEY`. Thiếu nó là mất khoá, phải khai lại.

**`placement: {mode:'smart'}` KHÔNG dùng được ở đây** — đã đo: nó đẩy worker đi mỗi lần một
nơi, lúc chạy được lúc báo lỗi vị trí.

## Chấm phát âm — chọn lối nào?

| | Azure Speech | Gemini |
|---|---|---|
| Điểm từng từ | Đo thật từng âm vị | Model tự ước lượng |
| Bốn điểm thành phần | Có, đáng tin | Có, nhưng mềm hơn |
| Cần khai thêm | `AZURE_SPEECH_KEY`, `AZURE_REGION` | Không — dùng chung khoá Gemini |
| Gói miễn phí | 5 giờ âm thanh/tháng | Chung hạn mức Gemini |

**Một điều đã đo được và bạn nên biết:** tôi gửi thử một đoạn **sóng sin 1,5 giây** (không
phải tiếng người) kèm câu gốc, và Gemini chấm **96/100**, "nghe thấy" đúng nguyên câu nằm
trong lời nhắc — tức là nó đọc lại câu gốc chứ không thật sự nghe. Worker nay hỏi thẳng nó
*"có nghe ra tiếng người không"* và tin câu trả lời ấy trước khi tin điểm; gửi lại đúng đoạn
sóng sin ấy thì nó báo **"Không nghe ra tiếng nói nào"**. Nhưng đây vẫn là **giới hạn thật**
của lối chấm bằng Gemini: nó có thể rộng rãi hơn thực tế. Muốn điểm chắc tay thì khai khoá
Azure.

Khoá Azure lấy ở https://portal.azure.com → tạo tài nguyên **Speech Services** (gói F0 miễn
phí) → Keys and Endpoint. `AZURE_REGION` là mã vùng, ví dụ `southeastasia`.

`/health` hiện trả về `{"ok":true,"module1":true,"hasGeminiKey":false,...}` — đúng như mong đợi
khi chưa khai khoá.

Phần dưới giữ lại để hiểu gốc sự cố và để tra cứu về sau.

---

## ⚠️ Vì sao app đã biến mất

Tôi đã đặt `wrangler.toml` vào **đúng thư mục repo của app**. Thư mục này được đẩy lên
GitHub và Cloudflare đang theo dõi nó. Trước đây không có `wrangler.toml` nào, nên Cloudflare
tự hiểu "đây là trang tĩnh" và phục vụ `index.html`. Khi thấy một `wrangler.toml` có dòng:

```
main = "daily-reading-worker.js"
```

…Cloudflare hiểu ngược lại: "đây là một Worker, điểm vào là tệp kia". Thế là nó triển khai
worker daily-reading **đè lên chính worker đang phục vụ app**. Địa chỉ
`ethannguyen.chinhnguyen1990cr.workers.dev` từ đó trả về JSON của worker thay vì app.

Tệp `wrangler.toml` đã được **gỡ khỏi thư mục này**. Nội dung của nó nằm ở cuối trang này —
chỉ dùng khi bạn tạo một thư mục RIÊNG cho worker, tuyệt đối không để chung với app.

---

## Bước 1 — Lấy lại app (làm trước, mất khoảng 1 phút)

**Cách nhanh nhất — quay về bản trước:**

1. https://dash.cloudflare.com → **Compute (Workers)** → chọn worker **ethannguyen**
2. Thẻ **Deployments**
3. Tìm bản triển khai **ngay trước** lần vừa rồi → **⋯** → **Rollback**

App trở lại ngay, không cần đụng tới GitHub.

**Rồi đẩy bản đã gỡ `wrangler.toml` lên GitHub**, nếu không lần build kế tiếp lại đè tiếp:

1. Xoá `wrangler.toml` khỏi repo (tệp trong thư mục này đã gỡ sẵn — chỉ cần đẩy lên)
2. Commit và push

---

## Bước 2 — Tạo worker RIÊNG cho Daily Reading

Worker này phải có **tên khác** và **địa chỉ khác** với worker phục vụ app.

1. https://dash.cloudflare.com → **Compute (Workers)** → **Create**
2. **Start with Hello World!** → đặt tên `daily-reading` → **Deploy**
3. **Edit code** → xoá sạch mã mẫu → dán **toàn bộ** `daily-reading-worker.js` → **Deploy**
4. **Settings → Variables and Secrets → Add**:

| Tên biến           | Kiểu    | Giá trị                                                      | Dùng cho |
|--------------------|---------|--------------------------------------------------------------|----------|
| `GEMINI_API_KEY`   | Secret  | lấy miễn phí ở https://aistudio.google.com/apikey            | Module 1 + Module 3 (Gemini) |
| `ALLOW_ORIGIN`     | Text    | `https://ethannguyen.chinhnguyen1990cr.workers.dev`          | Chặn nguồn gọi |
| `AZURE_SPEECH_KEY` | Secret  | *(chưa cần — Module 3)*                                      | Module 3 (Azure) |
| `AZURE_REGION`     | Text    | *(chưa cần — Module 3)* ví dụ `southeastasia`                 | Module 3 (Azure) |

**`GEMINI_API_KEY` và `AZURE_SPEECH_KEY` phải chọn kiểu Secret, không phải Text.** Chọn nhầm
Text thì khoá hiện nguyên văn trên dashboard và lọt vào log build.

5. Copy địa chỉ worker (dạng `https://daily-reading.chinhnguyen1990cr.workers.dev`)
6. Mở app → **Daily Reading Practice** → dán vào ô **Địa chỉ Cloudflare Worker** → bấm
   **🔌 Kiểm tra kết nối**

Nếu mọi thứ đúng, dòng xanh hiện ra: `✅ Worker chạy · gemini-3.6-flash · đã có khoá`.

---

## Kiểm tra nhanh bằng trình duyệt

Mở thẳng địa chỉ này trên tab mới:

```
https://daily-reading.<tài-khoản>.workers.dev/health
```

Kết quả mong đợi:

```json
{"ok":true,"module1":true,"hasGeminiKey":true,"model":"gemini-3.6-flash"}
```

`hasGeminiKey:false` nghĩa là worker chạy nhưng chưa khai khoá — quay lại bước 4.
Đường `/health` **không bao giờ trả về chính khoá**, chỉ báo có hay không.

---

## Triển khai bằng dòng lệnh (không bắt buộc)

Chỉ làm nếu bạn muốn dùng `wrangler`. Tạo một thư mục **RIÊNG**, chép
`daily-reading-worker.js` vào đó, rồi tạo `wrangler.toml` với nội dung dưới đây.

> **Không bao giờ** đặt tệp `wrangler.toml` này vào thư mục chứa `index.html` của app.
> Đó chính là lỗi đã làm app biến mất.

```toml
name = "daily-reading"
main = "daily-reading-worker.js"
compatibility_date = "2026-09-01"

# Biến THƯỜNG (không bí mật) — ghi thẳng vào đây được.
[vars]
ALLOW_ORIGIN = "https://ethannguyen.chinhnguyen1990cr.workers.dev"
# AZURE_REGION = "southeastasia"   # Module 3

# Biến BÍ MẬT — TUYỆT ĐỐI không viết vào tệp này (tệp này thường lên Git).
# Khai bằng dòng lệnh, giá trị không hiện lên màn hình:
#   npx wrangler secret put GEMINI_API_KEY
#   npx wrangler secret put AZURE_SPEECH_KEY     # Module 3
```

Rồi:

```bash
npx wrangler deploy
```
