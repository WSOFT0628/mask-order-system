# 口罩訂購助手 v2.0.0 安裝說明

## 1. 初始化資料庫

1. 登入 Supabase Dashboard。
2. 開啟專案 `jhyxaalondrfcybpsgdk`。
3. 前往 **SQL Editor**。
4. 建立 **New query**。
5. 在 GitHub 儲存庫開啟 `supabase/初始化.sql`，複製全部內容。
6. 貼到 SQL Editor，按下 **Run**。
7. 確認沒有紅色錯誤訊息。

## 2. 設定登入網址

Magic Link 必須回到實際發布的網站，不能以本機 `file://` 作為正式同步網址。

1. 在 GitHub 儲存庫開啟 **Settings → Pages**。
2. Source 選擇 **Deploy from a branch**。
3. Branch 選擇 **main**、資料夾選擇 **/(root)**，再按 **Save**。
4. 等待網站發布完成，正式網址為 `https://wsoft0628.github.io/mask-order-system/`。
5. 在 Supabase 前往 **Authentication → URL Configuration**。
6. 將正式網址設為 **Site URL**。
7. 將同一網址加入 **Redirect URLs**。

## 3. 建立第一位管理員

1. 用正式網址開啟系統。
2. 輸入管理員 Email，按下「寄送登入連結」。
3. 到信箱開啟 Magic Link。
4. 第一位完成登入的人會自動成為管理員。
5. 系統會把目前本機商品、訂單、設定與價目表上傳成第一份雲端資料。

## 4. 新增家人

1. 家人在手機或電腦開啟同一網址。
2. 輸入自己的 Email 並開啟登入連結。
3. 新帳號會顯示「等待管理員核准」。
4. 管理員前往「設定 → 雲端同步與成員」核准帳號並指定權限。

## 5. 同步狀態

- **已同步**：雲端與目前裝置一致。
- **同步中**：正在上傳或下載。
- **等待同步**：本機有新變更等待上傳。
- **離線使用**：只保存於目前裝置。
- **同步失敗／同步衝突**：系統保留本機資料並嘗試重新載入雲端版本。

## 安全注意事項

- 不要把 Database password、Secret key 或 `service_role` key 放入 HTML。
- 目前 HTML 只包含可公開使用的 Publishable key，資料存取仍由 Supabase 登入與資料庫函式限制。
- 不要關閉初始化 SQL 建立的權限檢查。
- 正式使用前，請先使用兩個測試帳號驗證管理員核准流程。

## v2.1.0 帳號與密碼管理升級

1. 在 Supabase **SQL Editor** 執行 `supabase/v2.1.0-upgrade.sql`。
2. 在 Supabase **Edge Functions** 建立函式 `mask-user-admin`。
3. 將 `supabase/functions/mask-user-admin/index.ts` 全文貼入函式並部署。
4. Edge Function 必須保持 JWT 驗證開啟。
5. 回到網站按 `Ctrl + F5`，確認版本顯示 `v2.1.0`。
6. 管理員可在「設定 → 帳號管理中心」建立 Email、臨時密碼與權限。
7. 新使用者使用 Email＋臨時密碼登入，第一次登入必須設定自己的密碼。

`SUPABASE_SERVICE_ROLE_KEY` 只能由 Edge Function 在後端讀取，禁止貼到 HTML、GitHub 或瀏覽器程式碼。
