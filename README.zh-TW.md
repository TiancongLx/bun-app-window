# bun-app-window

[![npm version](https://img.shields.io/npm/v/bun-app-window?color=cb3837&logo=npm)](https://www.npmjs.com/package/bun-app-window)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.4.3-f472b6?logo=bun&logoColor=white)](https://bun.sh)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows&logoColor=white)](#系統需求與設計邊界)
[![WebView2](https://img.shields.io/badge/WebView2-System%20Runtime-008080)](#系統需求與設計邊界)
[![License](https://img.shields.io/badge/License-MIT-2ea44f)](./LICENSE)

正體中文 | [English](./README.md) | [简体中文](./README.zh-CN.md)

專為 Bun 應用程式設計的 Windows 原生視窗外殼，基於系統內建的 WebView2 執行環境（Runtime）承載前端介面。

本專案遵循極簡職責邊界：僅負責視窗生命週期、幾何尺寸、DPI 縮放適配、無邊框視窗自訂及底層訊息通道；商業邏輯與 UI 渲染完全解耦於外殼層之外。

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS } from "bun-app-window";

const server = serveOnSafePort({ fetch: () => new Response("<h1>Hello</h1>") });
await openShell({ url: `http://127.0.0.1:${server.port}`, flags: FLAG_FRAMELESS });
```

---

## 系統需求與設計邊界

在導入本專案前，請確認以下技術前提與架構取捨是否符合你的應用場景：

| 維度 | 限制與說明 |
| --- | --- |
| 僅支援 Windows x64 | `package.json` 中的 `os` 與 `cpu` 欄位已做強制限制，拒絕在其他平台安裝（套件名稱保持平台中立僅為預留命名空間）。預編譯動態連結程式庫 `libshell.dll` 隨套件發佈，無需在安裝期編譯 |
| 僅支援 Bun 執行環境 | 套件內直接發佈 TypeScript 原始碼，要求 Bun ≥ 1.4.3。Node.js 環境雖可完成套件安裝，但無法直接執行 |
| 基於 `bun:ffi` 建構 | `bun:ffi` 在 Bun 中仍標記為實驗性功能（Experimental）。官方建議正式環境優先採用 Node-API，本專案選擇 `bun:ffi` 是為了換取零第三方相依性的輕量架構 |

執行環境與能力邊界：

- 依賴系統 WebView2 Runtime：目標機器需已安裝 WebView2 執行環境（Windows 11 預設內建）。
- 要求互動式桌面工作階段：受 Windows 工作階段隔離（Session 0 Isolation）機制限制，WebView2 無法在 Session 0（如系統背景服務）中啟動；但實測在 High 完整性層級的管理員提權行程（Process）中可正常執行。
- 明確不包含的功能：系統匣常駐圖示（System Tray）、原生頂部功能表列、自動更新、多視窗管理、跨平台支援。

## 安裝

```bash
bun add bun-app-window
```

## 快速開始

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS, FLAG_CENTER } from "bun-app-window";

const server = serveOnSafePort({
  fetch: () => new Response("<h1>Hello</h1>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  }),
});

const shell = await openShell({
  url: `http://127.0.0.1:${server.port}`,
  title: "My App",
  width: 1000,
  height: 680,
  flags: FLAG_FRAMELESS | FLAG_CENTER,
  minWidth: 480,
  minHeight: 320,
});

shell.post(JSON.stringify({ t: "ready" }));   // 宿主 → 頁面單向訊息
shell.setTitle("Doing work…");
```

說明：`createShell(opts)` 僅解析並載入原生動態連結程式庫，不建立視窗；`openShell(opts)` 則一步完成實例建立與視窗啟動，若啟動失敗將直接拋出例外錯誤。

## 核心 API

### 實例方法與屬性

| 成員 | 說明 |
| --- | --- |
| `start()` | 建立並啟動視窗，回傳 `{ rc, error }`。呼叫後立即回傳，UI 訊息迴圈執行於獨立原生執行緒 |
| `stop()` | 銷毀視窗並釋放底層資源，支援冪等重複呼叫 |
| `show()` | 顯示視窗。常搭配 `FLAG_DEFER_SHOW` 使用，實現在頁面渲染就緒後再展現視窗 |
| `isAlive()` | 檢測視窗是否存活（註：`state()` 無法區分「尚未啟動」與「已銷毀」狀態） |
| `state()` | 取得目前視窗狀態：`{ maximized, minimized, focused, dark, raw }` |
| `lastError()` | 取得最近一次操作失敗的錯誤訊息，無錯誤時回傳空字串 |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | 基礎視窗控制操作，回傳狀態碼 `rc` |
| `setMinSize(w, h)` | 設定視窗最小尺寸（單位：邏輯像素） |
| `drag()` | 觸發原生視窗拖曳（於頁面 `pointerdown` 事件中呼叫，完整保留 Windows 貼齊版面配置特性） |
| `beginResize(edge)` | 觸發原生邊框縮放（於頁面 `pointermove` 事件中呼叫，`edge` 取值見 `RESIZE_EDGE.*`） |
| `post(json)` | 宿主向頁面單向投遞 JSON 訊息，非同步發送且不等待回傳結果 |
| `setZoom(f)` / `getZoom()` | 設定或取得頁面縮放比例（有效範圍 `0.25`–`3.0`，越界值自動鉗制） |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | 頁面重新載入、開啟開發人員工具、切換全螢幕（分別對應 `Ctrl+R` / `F12` / `F11`） |
| `setBrowserUi(mask)` | 停用指定的瀏覽器預設行為，傳入 `BROWSER_UI_*` 旗標的按位元 OR 組合 |
| `showContextMenu(x, y, items)` | 於指定螢幕座標彈出 Win32 原生右鍵快顯功能表（詳見下文用法） |
| `pickFolder(title?)` | 呼叫原生資料夾選擇對話方塊（同步阻塞目前呼叫執行緒） |
| `libInfo` | 原生動態連結程式庫解析中繼資料（包含實際路徑、載入來源、SHA-256 雜湊值） |
| `symbols` | 底層直通介面：直接存取透過 `dlopen` 匯出的底層 C 符號 |

### 視窗旗標（Flags）

透過按位元 OR（`|`）組合傳入 `opts.flags`：

| 旗標 | 作用說明 |
| --- | --- |
| `FLAG_FRAMELESS` | 無邊框視窗模式，移除系統預設標題列，交由前端頁面自行繪製 |
| `FLAG_RESIZABLE` | 允許使用者調整視窗大小 |
| `FLAG_CENTER` | 啟動時於目前顯示器工作區置中顯示（有邊框與無邊框模式均生效） |
| `FLAG_TOPMOST` | 視窗保持最上層顯示 |
| `FLAG_DEFER_SHOW` | 建立視窗後保持隱藏狀態，等待明確呼叫 `show()` |
| `FLAG_ACCEPT_DROP` | 允許視窗接收外部檔案或資料夾拖放事件 |
| `FLAG_START_MAXIMIZED` | 視窗首次顯示即處於最大化狀態，避免從一般尺寸跳變至最大化的中間閃爍畫格 |

## 子路徑模組

核心視窗控制之外的擴充能力均拆分於獨立子路徑下，可依需求匯入。

### `bun-app-window/ipc` — 型別化雙向通訊與事件匯流排

宿主與前端頁面共用同一份 TypeScript 型別宣告，用戶端透過泛型在編譯期完成方法簽章與事件負載驗證：

```ts
// api.ts —— 宿主與頁面共同匯入的型別契約
export type Api = { greet(name: string): string };
export type Events = { windowState: { maximized: boolean } };
```

```ts
// 宿主端
import { createIpcServer } from "bun-app-window/ipc";

const ipc = createIpcServer({
  service: { greet: (name: string) => `Hello ${name}` },
});

serveOnSafePort({
  fetch(req) { /* 處理靜態頁面與驗證 */ },
  websocket: {
    open: (ws) => ipc.attach(ws),
    message: (ws, raw) => ipc.handle(ws, raw),
    close: (ws) => ipc.detach(ws),
  },
});

ipc.emit("windowState", { maximized: false });   // 向頁面主動推播事件
```

```ts
// 頁面端
import { connect } from "bun-app-window/ipc";
import type { Api, Events } from "./api";

const api = await connect<Api, Events>();
await api.greet("Ada");                        // 回傳型別自動推導為 string
api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

預設情況下，`connect` 會從目前頁面 URL 的查詢參數 `?t=` 中讀取驗證 Token 並連線至 `/ws`。若需自訂連線方式，可明確傳入 `url` 或自訂 `channel` 實例。

### `bun-app-window/titlebar` — Windows 11 風格標題列

用於在無邊框模式下快速掛載符合 Windows 11 視覺規範的自訂標題列：

```ts
// 頁面端
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
  title: "我的應用程式",
  icon: "/icon.svg",
  bridge: bridgeFromWindowService(api.window),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

宿主端需在 IPC 服務中公開對應的四個視窗控制方法：

```ts
// 宿主端
createIpcServer({
  service: {
    window: {
      minimize: () => shell.minimize(),
      toggleMaximize: () => shell.toggleMaximize(),
      close: () => shell.close(),
      drag: () => shell.drag(),
    },
  },
});
```

實作細節：

- 原生拖曳體驗：拖曳操作透過呼叫 `shell.drag()` 交由底層發送 `WM_NCLBUTTONDOWN`（`HTCAPTION`）訊息處理，完整保留 Windows 11 貼齊版面配置（Snap Layouts）與連按兩下最大化等系統級行為。
- 樣式自訂與圖示方案：色彩與尺寸均透過 CSS 變數（`--ws-tb-*`）控制，覆寫變數即可實作佈景主題切換。按鈕圖示預設採用相容性較佳的幾何向量符號；若設定 `icons: "fluent"` 則切換為 `Segoe Fluent Icons` 字型渲染（注意：若目標系統缺少該字型，按鈕將退回顯示為缺字方框）。

### `bun-app-window/state` — 視窗位置與尺寸持久化

用於自動記錄並在下次啟動時還原視窗的座標、尺寸及最大化狀態：

```ts
import { attachPlacementStore, loadPlacement, restorePlacement } from "bun-app-window/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, flags: FLAG_DEFER_SHOW });

const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

const store = attachPlacementStore(shell, FILE);   // 定時輪詢狀態，視窗靜止時不觸發寫入磁碟
process.on("beforeExit", () => store.flush());
```

底層原生實作已妥善處理以下邊界場景：

- 最大化狀態下儲存的是視窗「還原後的正常矩形（Restore Rect）」而非全螢幕尺寸。
- 跨顯示器不同縮放比例下的 DPI 座標換算。
- 螢幕拓撲變化（如拔除外接螢幕）後的螢幕外座標越界驗證與修正。

若無需背景輪詢，亦可直接呼叫 `capturePlacement` 與 `savePlacement` 執行單次手動讀寫。

### `bun-app-window/debug` — 診斷與除錯介面

提供底層視窗度量與命中測試（Hit-Test）資訊。注意：診斷介面不屬於穩定 API 契約，後續版本可能隨時調整。

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics();   // 取得 pos / win / client / work / border / round 等幾何度量
d.dpi();       // 取得目前 DPI 感知層級與縮放係數
d.hittest(x, y);
```

## 常見場景與最佳實踐

### 1. 停用瀏覽器預設行為

WebView2 預設保留了完整的瀏覽器互動語意。建構桌面應用程式時，通常建議將其全部停用：

```ts
import { BROWSER_UI_ALL } from "bun-app-window";

const shell = await openShell({ url, browserUi: BROWSER_UI_ALL });
```

亦可依需求組合以下旗標：

| 旗標 | 停用的瀏覽器行為 |
| --- | --- |
| `BROWSER_UI_MENU` | 預設網頁右鍵選單（Edge 快顯功能表） |
| `BROWSER_UI_KEYS` | 瀏覽器內建快速鍵（如 `Ctrl+P` / `Ctrl+F` / `Ctrl+S`） |
| `BROWSER_UI_STATUSBAR` | 左下角連結懸停狀態列 |
| `BROWSER_UI_SWIPE` | 觸控板雙指橫滑上一頁 / 下一頁手勢 |
| `BROWSER_UI_AUTOFILL` | 表單自動填入提示 |

註：`F11`、`F12` 及 `Ctrl±` 縮放由視窗外殼層直接接管，不受上述旗標影響。

### 2. 原生右鍵快顯功能表

停用預設瀏覽器選單後，可透過 `showContextMenu` 喚起基於 Win32 `TrackPopupMenu` 繪製的原生選單。頁面無法直接呼叫它——需先在 IPC 服務上暴露：

```ts
// 宿主端：將選單能力掛載到 window 服務
createIpcServer({
  service: {
    window: {
      showContextMenu: (x: number, y: number, items: string) =>
        shell.showContextMenu(x, y, items),
    },
  },
});
```

```ts
// 頁面端觸發選單
document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  await api.window.showContextMenu(
    Math.round(e.screenX),
    Math.round(e.screenY),
    "open|開啟\nrefresh|重新整理\n-\nquit|結束"
  );
});

// 頁面端監聽選單點擊結果
window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "menu") console.log("選取選單項目 ID:", e.detail.id);
});
```

選單項目定義採用換行符號分隔的字串格式：每行格式為 `id|顯示文字`，單獨一行 `-` 表示分隔線。

### 3. 接收外部檔案拖放

啟用 `FLAG_ACCEPT_DROP` 後，視窗即可接收來自檔案總管（Windows Explorer）的檔案或資料夾拖放：

```ts
// 宿主端
const shell = await openShell({ url, flags: FLAG_ACCEPT_DROP });
```

```js
// 頁面端接收路徑清單
window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "drop") console.log("拖入檔案路徑:", e.detail.paths);
});
```

針對管理員提權場景（High 完整性層級行程接收來自 Medium 層級檔案總管的訊息），底層已透過 `ChangeWindowMessageFilterEx` 自動放行 UIPI 訊息過濾。

### 4. 前端頁面桌面化樣式建議

視窗外殼層不會向頁面隱式注入任何 DOM 或全域樣式。為消除「網頁感」，建議應用程式於前端自行補充以下基礎規則：

```css
html, body { cursor: default; }
body { user-select: none; }
input, textarea, .log { user-select: text; cursor: auto; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off">
```

尤其建議為輸入框設定 `spellcheck="false"`，否則瀏覽器拼字檢查極易在檔案路徑或專業數值下方繪製紅色波浪底線，破壞桌面應用程式的原生觀感。

### 5. 編譯為單一可執行檔（.exe）

使用 `bun build --compile` 封裝時，可透過匯入 `bun-app-window/embedded` 將原生 DLL 一併內嵌至產物中：

```ts
import { createShell } from "bun-app-window";
import { embeddedDll } from "bun-app-window/embedded";   // 將 DLL 位元組內嵌至封裝產物

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

提示：

- 僅透過副作用匯入 `import "bun-app-window/embedded";` 同樣生效。
- 封裝桌面端應用程式時請務必加上 `--windows-hide-console` 參數，否則啟動時將伴隨彈出黑色主控台（Console）視窗。

## 底層機制與互動參考

### 原生動態連結程式庫載入順序

執行階段依以下優先順序尋找並載入 `libshell.dll`：

1. 明確路徑：若傳入 `opts.nativeLibPath`，則直接載入該路徑並略過後續推斷。
2. 內嵌位元組釋放：若包含編譯期內嵌位元組，將其釋放至 `%LOCALAPPDATA%\<appName>\runtime` 目錄下（採用內容雜湊值命名，自動清理歷史舊版本）。
3. 可執行檔同級目錄：尋找目前 `.exe` 所在目錄下的 `libshell.dll`。
4. 開發態路徑：依序尋找套件根目錄下的 `.build/libshell.dll` 與 `dist/libshell.dll`。

### 內建快速鍵與滑鼠行為

| 觸發方式 | 預設行為 |
| --- | --- |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | 頁面縮放：放大一階 / 縮小一階 / 重設為 100% |
| `Ctrl + 滑鼠滾輪` | 頁面縮放：放大 / 縮小 |
| `F11` | 切換全螢幕模式（隱藏視窗邊框並覆蓋系統工作列） |
| `F5` / `Ctrl + R` | 重新載入目前頁面 |
| `F12` | 開啟 WebView2 開發人員工具 |
| `Alt + Space` / 標題列右鍵 | 彈出 Windows 系統視窗選單 |

## 開發與驗證

本專案工具鏈基於 Bun 1.4.3 與 TypeScript 7.0.2 建構，`tsconfig.json` 開啟全量嚴格模式檢查。

**本專案不使用遠端 CI。** 該帳戶的 GitHub Actions 因 billing lock 無法分配 runner；而專案本身是單平台、單人開發、零外部服務相依的相依套件，遠端 CI 的邊際價值低於其維護成本，因此品質把關改為本機執行。建議入口：

```powershell
pwsh -File scripts/gate.ps1          # 對目前工作區執行 bun check + bun test
pwsh -File scripts/gate.ps1 -Clean   # 同上，但在 HEAD 的乾淨副本內執行
```

`-Clean` 重現了託管 runner 的條件：將 `HEAD` clone 到 `%TEMP%`，依 lockfile 安裝相依套件，再於其中執行把關。如此一來，本機產物（`.build/`、`node_modules/`、`vendor/webview2/`）便無法掩蓋缺少的檔案。耗時約兩秒。未提交的變更會被提示並排除於乾淨副本之外——如需驗證工作區現況，請移除 `-Clean`。

底層指令仍可直接呼叫：

```bash
bun check          # 執行 TypeScript 型別檢查
bun test           # 執行自動化測試套件（位於 tests/，共 108 個測試案例）
bun run demo       # 啟動互動式自我檢測範例程式（需於桌面工作階段下執行）
```

需注意：`bun run demo` 與 `AGENTS.md` 中描述的「外部消費方驗收」皆需要互動式桌面，本就不具備 CI 可行性，屬於構造上的本機專屬項目。

注意：每當修改 `src/shell/` 或 `package.json` 後，除執行上述測試外，還需執行一次「作為外部專案相依套件安裝」的整合冒煙測試（Smoke Test），具體流程詳見 `AGENTS.md` 中的「依賴套件驗收」章節。

自動化測試或截圖腳本若需透過 Win32 `EnumWindows` 過濾視窗控制代碼（HWND），請依據視窗模式比對對應的視窗類別名稱（Window Class）：

| 視窗模式 | 對應視窗類別名稱 |
| --- | --- |
| 標準有邊框模式（未傳 `FLAG_FRAMELESS`） | `webview` |
| 無邊框模式（傳入 `FLAG_FRAMELESS`） | `webview_shell` |

## 致謝

- 底層跨平台視窗抽象源自 [webview/webview](https://github.com/webview/webview) `0.12.0`（MIT 授權，作者 Serge Zaitsev · Steffen André Langnes）。儲存庫內 `vendor/webview/` 目錄為其原始碼原樣拷貝，未作任何侵入式修改。
- WebView2 C/C++ SDK 源自 [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.1150.38`（NuGet 套件隨儲存庫發佈以支援離線建構），執行環境由作業系統提供。
- Co-authored-by DeepSeek

## 授權條款

本專案基於 [MIT License](./LICENSE) 開源發佈。`vendor/webview/` 目錄同樣遵循 MIT 授權條款，其原始著作權聲明完整保留於對應原始碼檔案中。
