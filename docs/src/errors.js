// Every backend error code (backend/README-backend.md, "Error codes") → friendly
// Traditional Chinese with a next step. Raw errors never reach the UI.

export class AppError extends Error {
  constructor(code, raw) { super(code); this.code = code; this.raw = raw; }
}

const MSG = {
  // --- backend codes ---
  NOT_AUTHENTICATED: '登入狀態失效了。請關掉 App 再打開一次。',
  NOT_IN_ROOM: '你還沒加入房間，請先建立或加入一個房間。',
  ALREADY_IN_ROOM: '這支手機已經在另一個房間裡了。',
  CODE_TOO_SHORT: '配對碼至少要 8 個字元。建議按「產生」取得 12 個隨機字元。',
  CODE_TOO_LONG: '配對碼最多 64 個字元，請縮短一點。',
  CODE_TAKEN: '這個配對碼已經有人用了。請按「產生」換一個新的。',
  BAD_CODE: '配對碼不對，或這個房間已經滿了。請再核對一次；如果你以前就在這個房間，點「我回來了」選回你的位置。',
  BAD_SLOT: '請選擇你之前的位置（1 號或 2 號）。',
  BAD_NAME: '名字要 1–6 個字。',
  RATE_LIMITED: '嘗試太多次了。請等 10 分鐘後再試，並仔細核對配對碼。',
  BAD_TITLE: '任務名稱要 1–40 個字。',
  BAD_VALUE: '金額要在 NT$ 1–50 之間。',
  BAD_DUE: '期限要在 5 分鐘後到 7 天內，請重新選擇。',
  TASK_NOT_FOUND: '找不到這個任務，可能已經被刪除了。',
  NOT_OWNER: '只有任務的主人可以這樣做。',
  TASK_NOT_ACTIVE: '這個任務已經完成或放棄了。',
  TASK_OVERDUE: '太晚了——伺服器時間顯示期限已經過了。',
  PROOF_REQUIRED: '這個任務需要拍照證明，請再按一次並拍照。',
  BAD_PROOF_PATH: '照片存放位置不對，請按「重試」。',
  PROOF_MISSING: '照片還沒上傳成功，請按「重試」。',
  DELETE_WINDOW_PASSED: '建立超過 5 分鐘就不能刪除了；可以改用「放棄」。',
  NOT_ALLOWED: '這個動作要由對方來做。',
  TASK_NOT_DONE: '只有已完成的任務可以質疑。',
  NO_PARTNER: '對方還沒加入房間，先把配對碼傳給對方吧。',
  SETTLEMENT_PENDING: '已經有一個結算請求在等待回應了。',
  NOTHING_TO_SETTLE: '目前平手，不需要結算。',
  SETTLEMENT_NOT_FOUND: '找不到這筆結算，請重新開啟 App。',
  SETTLEMENT_NOT_PENDING: '這筆結算已經回應過或過期了。',
  SETTLEMENT_NOT_CONFIRMED: '這筆結算已經撤銷過了。',
  NOT_LATEST_SETTLEMENT: '只能撤銷最近一次的結算。',
  UNDO_WINDOW_PASSED: '結算已超過 24 小時，無法撤銷。',
  BAD_SUBSCRIPTION: '通知設定失敗，請再按一次「開啟通知」。',
  BAD_INTERVAL: '伺服器設定錯誤。',
  PERMISSION: '沒有權限做這件事。請重新開啟 App；若一直發生，請重新配對。',
  // --- client-side codes ---
  NETWORK: '連不上網路。請檢查 Wi-Fi 或行動網路後再試。',
  CAPTCHA: '人機驗證沒有通過。請重新完成驗證後再試一次。',
  CAPTCHA_NEEDED: '請先完成下方的人機驗證。',
  ANON_DISABLED: 'Supabase 還沒開啟匿名登入。請依 backend README 第 2 步開啟。',
  AUTH_RATE_LIMITED: '登入請求太頻繁了，請等一分鐘再試。',
  QUOTA: '手機儲存空間不足，離線資料存不下了。請清出一些空間後再試。',
  UPLOAD_FAILED: '照片上傳失敗。任務仍保留著，請按「重試」。',
  PROOF_TOO_BIG: '照片太大了（上限 300 KB）。請按「重試」重新拍一張。',
  IMAGE_BAD: '讀不到這張照片，請換一張或重拍。',
  CAMERA: '沒有拿到照片。若相機打不開，請到 iPhone「設定 › 隱私權與安全性 › 相機」允許後再試。',
  NEEDS_ONLINE: '這個動作需要網路，連線後再試一次。',
  UNKNOWN: '發生了預料之外的問題，請稍後再試；若持續發生，請重新開啟 App。',
};

export const msg = (code) => MSG[code] || MSG.UNKNOWN;

export function toAppError(e, fallback = 'UNKNOWN') {
  if (e instanceof AppError) return e;
  const m = String((e && (e.message || e.error_description || e.error)) || e || '');
  if (/^[A-Z][A-Z_]+$/.test(m) && MSG[m]) return new AppError(m, e);
  if (e && e.name === 'QuotaExceededError') return new AppError('QUOTA', e);
  if (/captcha/i.test(m)) return new AppError('CAPTCHA', e);
  if (/anonymous sign-?ins are disabled/i.test(m)) return new AppError('ANON_DISABLED', e);
  if (/rate limit/i.test(m)) return new AppError('AUTH_RATE_LIMITED', e);
  if (/permission denied|row-level security/i.test(m)) return new AppError('PERMISSION', e);
  if (/payload too large|maximum allowed size|too large/i.test(m) || (e && String(e.statusCode) === '413')) return new AppError('PROOF_TOO_BIG', e);
  if (/quota/i.test(m)) return new AppError('QUOTA', e);
  if (/failed to fetch|load failed|networkerror|network request failed|network error|fetch|timed? ?out|offline/i.test(m)
      || (typeof navigator !== 'undefined' && navigator.onLine === false)) return new AppError('NETWORK', e);
  if (/jwt|refresh token|session/i.test(m)) return new AppError('NOT_AUTHENTICATED', e);
  console.warn('[studybet] unmapped error', e);
  return new AppError(fallback, e);
}

export const isNetwork = (e) => toAppError(e).code === 'NETWORK';
export const errText = (e) => msg(toAppError(e).code);
