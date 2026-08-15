# 口罩訂購助手 v3.3.5

「口罩訂購助手」是一套適合公司、團體與親友團購使用的口罩訂單管理系統，包含商品挑選、買家下單、訂單查詢、活動管理、狀態批次作業與廠商匯出。

## 正式網址

- [管理端](https://wsoft0628.github.io/mask-order-system/)
- [買家訂購頁](https://wsoft0628.github.io/mask-order-system/order.html)
- [買家訂單查詢](https://wsoft0628.github.io/mask-order-system/my-orders.html)

## 主要功能

### 管理端

- 商品、分類、價格與價目表管理
- 賣家代填訂單與訂單紀錄
- 建立多個團購活動，保留已結束與已停用活動歷史
- 依活動查看當時的所有買家訂單
- 訂單全選、多選與批次更新狀態
- 訂單狀態顏色識別：待確認、已確認、需聯絡、已彙整、已取消、已完成
- 單筆或批次列印買家分裝單
- 匯出買家明細 CSV 與廠商 Excel
- 管理員可二次確認後永久刪除訂單
- Supabase 雲端同步、成員、帳號與權限管理

### 買家端

- 透過專屬活動網址挑選商品並下單
- 確認區直接使用 `− / 數量 / ＋` 修改盒數
- 即時顯示商品名稱、款式、數量與應付總額
- 訂單送出後可保留訂單編號與專屬連結
- 獨立訂單中心不依附特定月份活動
- 可用「訂單編號＋完整電話」查單筆訂單
- 可用「訂購人姓名＋完整電話」查本人歷史訂單
- 依活動狀態與訂單進度提供查看、修改或取消
- 所有主要頁面的應用圖案都可返回主頁

## 版本重點

### v3.3.5

- 移除通知確認卡左側的警示色邊條
- 確認訊息改為右上角緊湊單列，不遮住主要內容
- 確認卡、通知面板與页面層級互不覆蓋

### v3.3.0–v3.3.1

- 姓名＋完整電話歷史查詢
- 批次訂單狀態、狀態顏色與分裝單列印
- 統一管理端、訂購頁與查詢頁的主頁返回邏輯

### v3.2.0

- 獨立買家訂單查詢頁
- 活動歷史、訂單快照與管理員永久刪除
- 修正商品明細、總盒數與總金額不一致

## 建置與升級

### 1. GitHub Pages

1. 在儲存庫開啟 **Settings → Pages**。
2. Source 選擇 **Deploy from a branch**。
3. Branch 選擇 **main**，資料夾選擇 **/(root)**。
4. 正式網站會由 `index.html` 發布。

### 2. Supabase SQL

新環境先執行初始化 SQL，再依版本順序執行升級檔。已經執行成功的升級檔不需重複執行。

v3.3.x 所需的最新升級檔：

1. `supabase-v3.2.0-upgrade.sql`
2. `supabase-v3.3.0-upgrade.sql`

### 3. Edge Functions

- `mask-public-order`：買家下單、查詢、修改與取消；`Verify JWT` 維持關閉。
- `mask-user-admin`：帳號與權限管理；JWT 驗證維持開啟。

只有 Edge Function 原始碼變更時才需要重新部署。單純修改 `index.html`、`order.html` 或 `my-orders.html` 不需要重新執行 SQL。

## 安全注意事項

- 不要將 Database password、Secret key 或 `service_role` key 放入 HTML、GitHub 或瀏覽器程式碼。
- HTML 只能使用可公開的 Supabase Publishable key。
- `SUPABASE_SERVICE_ROLE_KEY` 只能在 Edge Function 後端讀取。
- 買家歷史訂單不允許只用姓名或只用電話查詢，避免誤查他人資料。
- 永久刪除訂單無法復原，一般業務紀錄建議優先使用取消或封存。

## 技術架構

- 前端：HTML、CSS、JavaScript
- 網站托管：GitHub Pages
- 後端與資料庫：Supabase
- 匯出：CSV、Excel 與列印用分裝單
