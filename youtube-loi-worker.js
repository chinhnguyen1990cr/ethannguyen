/**
 * ════════════════════════════════════════════════════════════════════════════
 *  LẤY LỜI THOẠI YOUTUBE KÈM MỐC TỪNG CHỮ  —  Cloudflare Worker
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  VÌ SAO CẦN TỆP NÀY
 *  YouTube có sẵn mốc thời gian cho TỪNG CHỮ ở phụ đề tự động — không phải ước
 *  lượng, mà là mốc máy nhận dạng giọng nói ghi ra lúc nghe. Đó là thứ chính xác
 *  nhất có thể có. Nhưng địa chỉ lấy nó không cho phép trang web khác gọi thẳng
 *  (trình duyệt chặn vì lý do bảo mật, gọi là CORS). Worker này đứng giữa: nó gọi
 *  YouTube giúp bạn rồi trả kết quả về cho app.
 *
 *  CÁCH ĐƯA LÊN (làm một lần, khoảng 5 phút, miễn phí)
 *   1. Vào  https://dash.cloudflare.com  → đăng nhập (đăng ký miễn phí nếu chưa có).
 *   2. Menu trái: "Compute (Workers)" → "Create" → "Start with Hello World!" → Deploy.
 *   3. Bấm "Edit code" (hoặc "</> Edit Code").
 *   4. Xoá sạch phần mã mẫu, dán TOÀN BỘ tệp này vào, bấm "Deploy".
 *   5. Sao chép địa chỉ worker, dạng:  https://ten-cua-ban.tai-khoan.workers.dev
 *   6. Mở app → Cài đặt → "Lời thoại chuẩn từ YouTube" → dán địa chỉ đó vào → Lưu.
 *
 *  Xong. Từ đó mỗi lần mở một video, app sẽ tự lấy lời thoại thật kèm mốc từng chữ.
 *
 *  RIÊNG TƯ: worker chỉ nhận mã video (ví dụ "dQw4w9WgXcQ") và gọi YouTube. Nó
 *  không thấy, không lưu, không gửi đi bất cứ thứ gì khác của bạn.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=86400'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const videoId = (url.searchParams.get('v') || '').trim();
    const lang = (url.searchParams.get('lang') || 'en').trim();

    if (!videoId) return traLoi({ ok: false, loi: 'Thiếu mã video. Gọi dạng: ?v=MA_VIDEO' }, 400);
    // Mã video YouTube luôn 11 ký tự trong bảng chữ an toàn. Chặn ở đây để worker
    // không trở thành cái cổng cho người khác gọi đi đâu tuỳ ý.
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return traLoi({ ok: false, loi: 'Mã video không hợp lệ.' }, 400);
    }

    try {
      const track = await timDuongPhuDe(videoId, lang);
      if (!track) {
        return traLoi({ ok: false, loi: 'Video này không có phụ đề tiếng Anh (kể cả phụ đề tự động).' }, 404);
      }
      const json3 = await layJson3(track.baseUrl);
      const lines = docJson3(json3);
      if (!lines.length) {
        return traLoi({ ok: false, loi: 'Lấy được đường phụ đề nhưng nội dung rỗng.' }, 502);
      }
      return traLoi({
        ok: true,
        videoId,
        lang: track.lang || lang,
        tuDong: !!track.tuDong,      // phụ đề tự động mới có mốc từng chữ
        coMocChu: lines.some(d => d.w && d.w.length),
        soDong: lines.length,
        lines
      });
    } catch (e) {
      return traLoi({ ok: false, loi: String((e && e.message) || e) }, 502);
    }
  }
};

function traLoi(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/**
 * Tìm đường dẫn tới tệp phụ đề. Thử hai lối, vì YouTube hay đổi:
 *  1. Hỏi thẳng API nội bộ của trình phát (ổn định hơn, không phải đọc HTML).
 *  2. Nếu hỏng thì đọc trang xem video và bóc dữ liệu nhúng trong đó.
 */
async function timDuongPhuDe(videoId, lang) {
  let tracks = await thuInnertube(videoId);
  if (!tracks || !tracks.length) tracks = await thuTrangXem(videoId);
  if (!tracks || !tracks.length) return null;
  return chonDuong(tracks, lang);
}

async function thuInnertube(videoId) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Giả làm ứng dụng Android: lối này ít bị chặn nhất và không cần cookie.
      'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip'
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          androidSdkVersion: 34,
          hl: 'en',
          gl: 'US'
        }
      }
    })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const ds = j && j.captions
    && j.captions.playerCaptionsTracklistRenderer
    && j.captions.playerCaptionsTracklistRenderer.captionTracks;
  return Array.isArray(ds) ? ds : null;
}

async function thuTrangXem(videoId) {
  const r = await fetch('https://www.youtube.com/watch?v=' + videoId + '&hl=en', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      // Bỏ qua trang hỏi đồng ý cookie ở châu Âu, nếu không thì nhận về trang đó thay vì video.
      'Cookie': 'CONSENT=YES+1'
    }
  });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\u0026/g, '&')); } catch (_) { return null; }
}

/**
 * Chọn đường nào. Ưu tiên PHỤ ĐỀ TỰ ĐỘNG (kind === 'asr') vì chỉ nó mới kèm mốc
 * từng chữ — phụ đề người ta gõ tay chỉ có mốc theo câu, tức là quay lại đúng chỗ
 * phải ước lượng. Không có bản tự động thì lấy bản tay, vẫn hơn không có gì.
 */
function chonDuong(tracks, lang) {
  const hop = (t) => String((t.languageCode || '')).toLowerCase().startsWith(String(lang).toLowerCase());
  const asr = (t) => t.kind === 'asr';
  const thu = [
    tracks.find(t => hop(t) && asr(t)),
    tracks.find(t => hop(t)),
    tracks.find(asr),
    tracks[0]
  ].filter(Boolean);
  const t = thu[0];
  if (!t || !t.baseUrl) return null;
  return { baseUrl: t.baseUrl, lang: t.languageCode, tuDong: t.kind === 'asr' };
}

async function layJson3(baseUrl) {
  // fmt=json3 là định dạng DUY NHẤT kèm tOffsetMs — tức mốc của từng chữ bên trong
  // một dòng. Các định dạng khác (vtt, srv1…) chỉ cho mốc cả dòng.
  const u = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
  const r = await fetch(u, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('YouTube trả mã ' + r.status + ' khi lấy nội dung phụ đề.');
  return await r.json();
}

/**
 * Chuyển json3 về đúng dạng app đang dùng:
 *   { t: giây bắt đầu, e: giây kết thúc, en: cả câu, w: [{t, w}] mốc từng chữ }
 */
function docJson3(j) {
  const ev = (j && j.events) || [];
  const lines = [];
  for (const e of ev) {
    if (!e.segs) continue;
    const batDau = (e.tStartMs || 0) / 1000;
    // Mỗi mẩu (seg) THƯỜNG là một chữ, nhưng không phải lúc nào cũng vậy — YouTube hay gộp
    // "of the", "I'm gonna" vào một mẩu. Gộp thì số mốc ít hơn số chữ, mà app tô sáng theo chỉ
    // số nên lệch một là sai cả câu. Tách ra, chia thời gian trong mẩu theo độ dài từng chữ.
    // Sai số ở đây chỉ nằm trong vài trăm mili-giây của MỘT mẩu, không tích luỹ ra cả câu.
    const mau = [];
    let cau = '';
    for (const s of e.segs) {
      const t = String(s.utf8 == null ? '' : s.utf8);
      if (!t.trim()) { cau += t; continue; }
      mau.push({ t0: batDau + (s.tOffsetMs || 0) / 1000, chu: t.trim().split(/\s+/) });
      cau += t;
    }
    const hetDong = ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000;
    const chu = [];
    for (let i = 0; i < mau.length; i++) {
      const m = mau[i];
      if (m.chu.length === 1) { chu.push({ t: +m.t0.toFixed(3), w: m.chu[0] }); continue; }
      const het = (i + 1 < mau.length) ? mau[i + 1].t0 : hetDong;
      const rong = Math.max(0.05, het - m.t0);
      const nang = m.chu.map(w => 0.45 + w.length * 0.55);
      const tong = nang.reduce((a, b) => a + b, 0) || 1;
      let don = 0;
      for (let k = 0; k < m.chu.length; k++) {
        chu.push({ t: +(m.t0 + (don / tong) * rong).toFixed(3), w: m.chu[k] });
        don += nang[k];
      }
    }
    // Dựng câu TỪ CHÍNH những chữ đã có mốc. Nếu ghép từ văn bản thô rồi tách lại bằng khoảng
    // trắng, số chữ có thể lệch với số mốc — và app tô sáng theo chỉ số, lệch một là sai cả câu.
    cau = (chu.length ? chu.map(c => c.w).join(' ') : cau).replace(/\s+/g, ' ').trim();
    if (!cau) continue;
    lines.push({
      t: +batDau.toFixed(3),
      e: +((e.tStartMs || 0) + (e.dDurationMs || 0)).toFixed(0) / 1000,
      en: cau,
      w: chu
    });
  }
  // Phụ đề tự động của YouTube chạy kiểu "cuộn": dòng sau lặp lại phần đuôi của dòng
  // trước để chữ trôi lên. Giữ nguyên là đọc thấy câu nào cũng lặp. Bỏ những dòng bị
  // dòng sau nuốt trọn.
  const sach = [];
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i], ke = lines[i + 1];
    if (ke && ke.en.startsWith(d.en) && ke.en.length > d.en.length) continue;
    sach.push(d);
  }
  // Mốc kết thúc không bao giờ được lấn sang câu sau.
  for (let i = 0; i < sach.length - 1; i++) {
    if (sach[i].e > sach[i + 1].t) sach[i].e = sach[i + 1].t;
  }
  return sach;
}
