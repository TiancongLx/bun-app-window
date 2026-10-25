# bun-app-window

[![npm version](https://img.shields.io/npm/v/bun-app-window?color=cb3837&logo=npm)](https://www.npmjs.com/package/bun-app-window)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.4.4-f472b6?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-%3E%3D7.0.2-3178C6?logo=typescript&logoColor=white)](#系統需求與設計邊界)
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

| 維度                            | 限制與說明                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 僅支援 Windows x64              | `package.json` 中的 `os` 與 `cpu` 欄位已做強制限制，拒絕在其他平台安裝（套件名稱保持平台中立僅為預留命名空間）。預編譯動態連結程式庫 `libshell.dll` 隨套件發佈，無需在安裝期編譯                                                 |
| 僅支援 Bun 執行環境             | 套件內直接發佈 TypeScript 原始碼，要求 Bun ≥ 1.4.4。Node.js 環境雖可完成套件安裝，但無法直接執行                                                                                                                                 |
| 型別檢查要求 TypeScript ≥ 7.0.2 | API 在 TypeScript 7.0.2 下設計與檢查，`devDependencies` 中精確鎖版；不為更舊的編譯器做相容。高於 7.0.2 的結果未作斷言——`bun-types` 只在那一側才開啟 `typesVersions: ">= 7.1"` 閘控，`with { type: "text" }` 的解析結果會隨之改變 |
| 型別檢查需自備 `@types/bun`     | 套件內是 `.ts` 原始碼，消費方的 `bun check` 會一併編譯它們。需執行 `bun add -d @types/bun`，否則型別檢查會在 `node_modules` 內回報 `TS2868: Cannot find name 'Bun'`                                                              |
| 基於 `bun:ffi` 建構             | `bun:ffi` 在 Bun 中仍標記為實驗性功能（Experimental）。官方建議正式環境優先採用 Node-API，本專案選擇 `bun:ffi` 是為了換取零第三方相依性的輕量架構                                                                                |

執行環境與能力邊界：

- 依賴系統 WebView2 Runtime：目標機器需已安裝 WebView2 執行環境（Windows 11 預設內建）。
- 要求互動式桌面工作階段：受 Windows 工作階段隔離（Session 0 Isolation）機制限制，WebView2 無法在 Session 0（如系統背景服務）中啟動；但實測在 High 完整性層級的管理員提權行程（Process）中可正常執行。
- 明確不包含的功能：系統匣常駐圖示（System Tray）、原生頂部功能表列、自動更新、多視窗管理、跨平台支援。

## 安裝

```bash
bun add bun-app-window
```

### 套件內容包含什麼

發佈的 tarball 只有預先編譯的 `dist/libshell.dll` 與 TypeScript 原始碼，共 22 個檔案（0.50 MB，解包後 1.47 MB）。原生 C++ 層（`native/`）與上游 vendored 標頭檔（`vendor/`）**不隨套件散布**：它們只在重新編譯 `libshell.dll` 時需要，而重新編譯必須 clone 儲存庫。因此 `bun run build:native` 與 `build:exe` 是本儲存庫專用指令碼，安裝進 `node_modules` 後執行沒有意義。

## 快速開始

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS, FLAG_CENTER } from "bun-app-window";

const server = serveOnSafePort({
    fetch: () =>
        new Response("<h1>Hello</h1>", {
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

shell.post(JSON.stringify({ t: "ready" })); // 宿主 → 頁面單向訊息
shell.setTitle("Doing work…");
```

說明：`createShell(opts)` 僅解析並載入原生動態連結程式庫，不建立視窗；`openShell(opts)` 則一步完成實例建立與視窗啟動，若啟動失敗將直接拋出例外錯誤。

## 核心 API

`ackOf(shell, rc)` 把裸狀態碼轉成 `{ rc, err }`，並且**只在失敗時才讀 `lastError()`**——原生錯誤槽不會被成功呼叫清空，成功之後再讀會拿到上一條殘留，看起來像新的失敗。

### 實例方法與屬性

| 成員                                                 | 說明                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start()`                                            | 建立並啟動視窗，回傳 `{ rc, error }`。呼叫後立即回傳，UI 訊息迴圈執行於獨立原生執行緒                                                                        |
| `stop()`                                             | 銷毀視窗並釋放底層資源，支援冪等重複呼叫                                                                                                                     |
| `show()`                                             | 顯示視窗。常搭配 `FLAG_DEFER_SHOW` 使用，實現在頁面渲染就緒後再展現視窗                                                                                      |
| `isAlive()`                                          | 檢測視窗是否存活（註：`state()` 無法區分「尚未啟動」與「已銷毀」狀態）。等視窗關閉請用 `pollEvents()` 的 `CLOSED`，別輪詢它                                  |
| `pollEvents(max?)`                                   | 批次拉取視窗生命週期事件（`STATE` / `CLOSED`），同步、消費式。詳見下文「視窗事件」                                                                           |
| `state()`                                            | 取得目前視窗狀態：`{ maximized, minimized, focused, dark, raw }`                                                                                             |
| `lastError()`                                        | 取得最近一次操作失敗的錯誤訊息，無錯誤時回傳空字串                                                                                                           |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | 基礎視窗控制操作，回傳狀態碼 `rc`                                                                                                                            |
| `setMinSize(w, h)`                                   | 設定視窗最小尺寸（單位：邏輯像素）                                                                                                                           |
| `drag()`                                             | 觸發原生視窗拖曳（於頁面 `pointerdown` 事件中呼叫，完整保留 Windows 貼齊版面配置特性）                                                                       |
| `beginResize(edge)`                                  | 觸發原生邊框縮放（於頁面 `pointermove` 事件中呼叫，`edge` 取值見 `RESIZE_EDGE.*`）                                                                           |
| `post(json)`                                         | 宿主向頁面單向投遞 JSON 訊息，非同步發送且不等待回傳結果                                                                                                     |
| `setZoom(f)` / `getZoom()`                           | 設定或取得頁面縮放比例（有效範圍 `0.25`–`3.0`，越界值自動鉗制）                                                                                              |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | 頁面重新載入、開啟開發人員工具、切換全螢幕（分別對應 `Ctrl+R` / `F12` / `F11`）                                                                              |
| `setFrameless(frameless)` / `isFrameless()`          | 執行時期切換視窗形態並讀取目前形態。只有**建立時**給了 `FLAG_FRAMELESS` 的視窗能切；帶邊框起點的視窗回傳 `rc=-1`，理由在 `lastError()`。詳見下文「視窗旗標」 |
| `setBrowserUi(mask)`                                 | 停用指定的瀏覽器預設行為，傳入 `BROWSER_UI_*` 旗標的按位元 OR 組合                                                                                           |
| `showContextMenu(x, y, items)`                       | 於指定螢幕座標彈出 Win32 原生右鍵快顯功能表（詳見下文用法）                                                                                                  |
| `pickFolder(title?)`                                 | 呼叫原生資料夾選擇對話方塊（同步阻塞目前呼叫執行緒；**經 IPC 暴露時務必搭配 `timeoutMs: 0`**，見下文）                                                       |
| `libInfo`                                            | 原生動態連結程式庫解析中繼資料（包含實際路徑、載入來源、SHA-256 雜湊值）                                                                                     |
| `symbols`                                            | 底層直通介面：直接存取透過 `dlopen` 匯出的底層 C 符號                                                                                                        |

### 視窗旗標（Flags）

透過按位元 OR（`|`）組合傳入 `opts.flags`：

| 旗標                      | 作用說明                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLAG_FRAMELESS`          | 無邊框視窗模式，移除系統預設標題列，交由前端頁面自行繪製。以這種方式建立的視窗可在執行時期用 `setFrameless(false)` 切回帶邊框                                                                                                                                                     |
| `FLAG_RESIZABLE`          | 允許使用者調整視窗大小                                                                                                                                                                                                                                                            |
| `FLAG_CENTER`             | 啟動時於目前顯示器工作區置中顯示（有邊框與無邊框模式均生效）                                                                                                                                                                                                                      |
| `FLAG_TOPMOST`            | 視窗保持最上層顯示                                                                                                                                                                                                                                                                |
| `FLAG_DEFER_SHOW`         | 建立視窗後保持隱藏狀態，等待明確呼叫 `show()`                                                                                                                                                                                                                                     |
| `FLAG_ACCEPT_DROP`        | 允許視窗接收外部檔案或資料夾拖放事件                                                                                                                                                                                                                                              |
| `FLAG_START_MAXIMIZED`    | 視窗首次顯示即處於最大化狀態，避免從一般尺寸跳變至最大化的中間閃爍畫格                                                                                                                                                                                                            |
| `FLAG_ALLOW_EXTERNAL_NAV` | 放棄外部導覽攔截——用於本身就是瀏覽器的應用程式                                                                                                                                                                                                                                    |
| `FLAG_TITLEBAR_RESERVE`   | 無邊框模式下把網頁內容整體下移一個標題列高度，讓頂端那一條歸原生視窗。**已被 `FLAG_NATIVE_CAPTIONS` 取代**：caption 命中區固定在客戶區 `y ∈ [0, 32)`，這條路會把頁面自繪的標題列放到與點擊真正落點相差 32 px 的位置                                                               |
| `FLAG_NATIVE_CAPTIONS`    | 無邊框模式下，由殼層自己的 layered 子視窗繪製三個 caption 按鈕並在那裡應答 `HTMAXBUTTON`。這是 Snap Layouts 唯一能觸發的途徑：WebView2 的渲染子視窗在另一個處理序裡，恆回 `HTCLIENT`。必須與 `mountTitleBar({ captions: "native" })` 搭配，頁面才會留出 `46 × 3` 而不是自己畫一套 |

### 外部導覽預設被攔截

未提供 `FLAG_ALLOW_EXTERNAL_NAV` 時，一個跨來源連結再也無法把應用程式導覽走。殼層會取消該次導覽，
把位址交給系統預設瀏覽器：

- **同來源**（啟動位址是 `file://` 等無 origin 的形態時，改為判斷「同文件」，即剝除
  `#fragment` 後與啟動位址逐字相同）留在視窗內導覽，應用程式自身的路由不受影響。
- **跨來源**會取消導覽並交給系統瀏覽器——但僅限 `http:` / `https:`。`file:`、
  `javascript:`、`ms-*:` 以及自訂 scheme 一律靜默取消，絕不觸及協定處理常式；
  `mailto:` / `tel:` 也**不在**放行清單內。
- **`window.open` / `target=_blank`** 一律被攔下並外開，即使提供了
  `FLAG_ALLOW_EXTERNAL_NAV` 亦然。那是能力邊界而非策略：殼層僅持有一個頂層視窗
  （原生層是處理序級單例），多開出來的視窗沒有任何宿主 API 能管理它。

桌面殼層沒有網址列、沒有上一頁按鈕，也沒有任何宿主 API 能把頁面導覽回來——所以一次誤點
外部連結就等於應用程式被換成了那個網站。這就是預設值選擇安全一側的原因。

## 子路徑模組

核心視窗控制之外的擴充能力均拆分於獨立子路徑下，可依需求匯入。

### `bun-app-window/app` — 應用程式骨架

用這個套件寫第一個應用程式時，業務程式碼可能只有 30 行，但**宿主樣板是 180 行**：挑安全埠、
產生驗證 token、處理 WebSocket 升級、把 HTML 當字串吐出去、把 `createIpcServer`
接到 Bun 的 websocket 回呼上、拼視窗旗標、處理 `openShell` 失敗、等視窗關閉
（`EVENT_CLOSED`）、依序 `stop()` 兩個東西。每一段單看都不難，但它們**只在特定順序下正確**
（`stop()` 不先等視窗真的銷毀就關服務，下次啟動會撞上 "already started"）。
`app` 把這些收成一次呼叫：

```ts
// main.ts
import { createApp } from "bun-app-window/app";
import { BROWSER_UI_ALL, FLAG_FRAMELESS } from "bun-app-window";
import htmlText from "./index.html" with { type: "text" };

// `with { type: "text" }` 讓 Bun 在封裝期把檔案內嵌進去，所以 `bun build --compile` 後仍然成立。
// TS 7.0.2 看不到這條宣告——bun-types 把它 gate 在 `typesVersions >= 7.1` 之後，
// 於是這個 import 被解析成 `HTMLBundle` 而不是 `string`。橋樑就落在這裡。
const html = htmlText as unknown as string;

const app = await createApp({
    html,
    title: "我的應用程式",
    flags: FLAG_FRAMELESS, // 想要自繪標題列就明確加上
    browserUi: BROWSER_UI_ALL,
    service: {
        greet: (name: string) => `hi ${name}`,
        pickFolder: () => app.shell.pickFolder(),
    },
});

await app.wait(); // 視窗關閉時 resolve
await app.stop(); // 釋放事件泵與服務；冪等，已關閉時立即回傳
```

傳 `page` 就能把打包好的頁面指令碼交給骨架，不必自己寫那條路由。`createApp` 會應答
`PAGE_JS_PATH`（`/page.js`）並帶上正確的 `content-type`——而這裡正是靜默出錯的地方：
模組指令碼以 `text/plain` 送出時會被拒絕執行且不報語法錯，頁面照常渲染、指令碼一行不跑。

```ts
import { bundlePage } from "bun-app-window/pack";

// 建置期，不是啟動時——見下文 pack 一節
const { code } = await bundlePage({ entry: "src/ui/page.ts" });

const app = await createApp({ html, page: code, service });
```

`App` 上另有兩個成員，各能省掉一次呼叫和一條子路徑匯入：

- `app.debug` —— 與 `debugOf(app.shell)` 回傳同一個物件。同樣不在穩定性承諾範圍內。
- `app.attachPlacement(file)` —— 把位置持久化接到骨架的**唯一**事件泵上。自己呼叫
  `attachPlacementStore` 而忘了傳 `{ events: app.events }`，它會起第二個泵；而
  `shell.pollEvents()` 是消費式的，兩個泵各拿一半事件，視窗位置隨機遺失，兩端都不報錯。
  這個方法讓那個錯誤無法表達。

```ts
// page.ts —— index.html 的 bundle 內
import { connect } from "bun-app-window/ipc";
const api = await connect(); // token 從頁面 URL 的 ?t= 取得
await api.greet("Ada");
```

它替你做的事：

- 綁定瀏覽器安全的埠（絕不會是 `ERR_UNSAFE_PORT` 那幾個），並把 HTML 服務出去。
- 每次執行產生一個 token，並在**升級之前**用它校驗 `/ws` —— 升級之後就沒有機會拒絕了。
  `ipc` 未開啟時 `/ws` 是 `404` 而不是 `403`：403 等於告訴對方「這裡有通道」。
- 把 `createIpcServer` 接到 websocket 的 `open` / `message` / `close` 上，`ipc.emit()` 才能到頁面。
- `stop()` 有序且冪等：`shell.stop()` → 等 `EVENT_CLOSED`（帶 5 秒上限）→ `server.stop()`。
- 起一個視窗事件泵並且只起一個：`app.events`。它同時承擔「等視窗關閉」，
  所以是唯一的事件消費者；`attachPlacementStore` 要用它時傳 `{ events: app.events }`。
- 把頁面端的例外回傳給宿主。未捕捉例外與未處理的 Promise 拒絕由注入的監聽腳本捕捉，
  經 HTTP 上報——不走 WebSocket：頁面腳本在求值階段崩潰時通道尚未建立，而那正是最需要
  觀測的情形。傳 `onPageError` 接收；不傳時輸出到宿主的 stderr，而不是丟棄。
- 啟動前校驗 `html` 與 `page` 的一致性。只給其中一個屬於設定錯誤，唯一症狀是視窗正常繪製
  但任何互動都無回應，因此直接拋錯。引用存在但缺少 `type="module"` 時只警告：`<script>`
  的合法寫法不只一種，字串比對的置信度不足以阻斷啟動。
- 用 `assets` 服務額外的靜態檔案。編譯型框架通常產出不止一個產物（典型是腳本 + 樣式表），
  `assets` 是一張「路徑 → 文字」的映射，`content-type` 由副檔名推斷。此前每個消費者都要
  手寫一段 `routes` 回呼來服務樣式表，而最常見的錯法（MIME 型別寫錯）會讓瀏覽器靜默丟棄
  樣式。未辨識的副檔名回退到 `application/octet-stream` 而不是猜測。呼叫方的 `routes`
  仍然優先，未登記的路徑回傳 404。
- 啟動失敗不留半啟動狀態：`openShell` 拋錯時，已綁定的埠會被釋放。

注意事項：

- **預設不帶 `FLAG_FRAMELESS`。** 無邊框視窗沒有系統標題列就拖不動，必須由頁面先掛上
  `mountTitleBar`。預設值選的是「頁面什麼都不做也能用」的那一側。
- **`wait()` 只負責等。** 它在 `EVENT_CLOSED` 上 resolve，但不會停事件泵、也不會關服務——而
  事件泵的計時器是 ref 的（`keepAlive: true`），所以停在這一行的行程會在視窗消失後繼續掛著。
  必須跟一句 `stop()`：它冪等，且關閉已被觀察到時會立即回傳。
- **靜態資源只吃內嵌字串。** `with { type: "text" }` 得到的是編譯期常數：不碰檔案系統、
  不產生暫存檔、`bun build --compile` 後仍然成立。TS 7.0.2 會把這條 import 解析成
  `HTMLBundle` 而不是 `string`（`bun-types` 把正確的宣告 gate 在 `typesVersions >= 7.1`
  之後），範例裡的 `as unknown as string` 就是為此而寫。別用 `Bun.file().text()` 去「修」它：
  那是執行期讀磁碟，HTML 就不在編譯產物裡了。要從磁碟讀東西就寫個 `routes` 函式 —— 五行，
  而且路徑解析的問題留在你這邊，不會滲進骨架。
- **不從主入口匯出。** 它和 `./state`、`./ipc` 一樣是子路徑。它從 `./index` 匯入
  `openShell`；若 `index.ts` 反過來匯出它，就成了循環。

**這不是 `Bun.WebView` 的替代品。** 那個是 headless 瀏覽器，做自動化 / 測試 / 擷取 ——
沒有視窗，而且只能截自己的頁面。本專案畫的是真實桌面視窗：系統標題列、DPI 感知、
貼齊版面配置、工作列歸屬。兩者不在同一條賽道上。

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
    fetch(req) {
        /* 處理靜態頁面與驗證 */
    },
    websocket: {
        open: (ws) => ipc.attach(ws),
        message: (ws, raw) => ipc.handle(ws, raw),
        close: (ws) => ipc.detach(ws),
    },
});

ipc.emit("windowState", { maximized: false }); // 向頁面主動推播事件
```

#### 遲連線的狀態投遞

頁面在視窗建立**之後**才載入。宿主從 `createApp` 回傳、到頁面的 WebSocket 建立之間發出的
任何事件，都投遞給零個連線，也不會被重播——只從事件讀取初始狀態的頁面會一直是空值，
而兩端都不會報錯。

把「狀態類」事件標為黏性，服務端就會在每次連線建立時重播最後一份酬載：

```ts
ipc.emit("windowState", { maximized: false }, { sticky: true }); // attach() 時重播
```

黏性是**明確開啟**的，且每個事件名稱只保留一份酬載，不是歷史佇列。語意上是「通知」而非
「狀態」的事件不應開啟：遲到的連線會額外收到一條讀起來像新訊息的舊訊息。

```ts
// 頁面端
import { connect } from "bun-app-window/ipc";
import type { Api, Events } from "./api";

const api = await connect<Api, Events>();
await api.greet("Ada"); // 回傳型別自動推導為 string
api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

預設情況下，`connect` 會從目前頁面 URL 的查詢參數 `?t=` 中讀取驗證 Token 並連線至 `/ws`。若需自訂連線方式，可明確傳入 `url` 或自訂 `channel` 實例。

#### `timeoutMs` —— 長時人機互動必須明確關閉

單次呼叫預設 **30 秒**逾時。這對一般方法合理，對**人機互動**卻是致命的：

```ts
// 服務端：pickFolder 內部是 SHBrowseForFolder，同步阻塞、耗時完全由使用者決定
const service = { pickFolder: () => shell.pickFolder() };

// 頁面端：必須關閉逾時，否則使用者挑久一點，用戶端先 reject，而服務端還在正常阻塞
const api = await connect<Api, Events>({ timeoutMs: 0 });
```

`0` 表示**不逾時**（不是「0 毫秒逾時」）。踩坑的形態有兩種，都不會讓門禁變紅：

- 頁面沒接 `.catch` → 拒絕完全靜默，表現為「選完了介面毫無反應」。
- 使用者按了「取消」很快返回，所以只有**挑久了**才重現，容易被判成偶發。

還有一層要知道：`shell.pickFolder()` **阻塞的是 Bun 主執行緒**。對話方塊開啟期間，
同一行程裡的計時器不會觸發，其他 IPC 呼叫也會排隊（不是 reject，是沒有回應）。
用戶端那 30 秒計時器跑在瀏覽器渲染行程裡，不受影響——所以調短逾時並不能解決阻塞，
只能讓症狀更早暴露。需要併發就得把 `pickFolder` 放進 Worker 裡呼叫。

#### 用戶端保留名稱

用戶端是一個 `Proxy`：有幾個名稱會解析到用戶端自己身上，永遠到不了遠端方法。服務表裡若有
同名方法，**那個服務端方法就永遠呼叫不到**——頁面呼叫的是用戶端自己的成員，兩端都不會報錯。

| 名稱         | 頁面實際拿到的東西                                                  |
| ------------ | ------------------------------------------------------------------- |
| `on` / `off` | 事件訂閱輔助函式                                                    |
| `close()`    | 關閉 WebSocket 通道——之後所有呼叫都會被 reject                      |
| `connected`  | `boolean`，通道目前是否可用                                         |
| `pending`    | `number`，尚未收到回覆的呼叫數                                      |
| `then`       | `undefined`，否則 `await client` 會把這個永不兌現的 thenable 等下去 |

Symbol 鍵同樣保留。給服務方法換個名稱（`winClose` 而不是 `close`），在頁面端映射回去 ——
見下方的標題列一節。

上述失效在執行期完全不可觀測，因此 `createIpcServer` 在**建立時就會拋錯**：服務表裡出現這些
名稱即終止，錯誤訊息指出衝突的鍵並給出替代命名。只有當服務表由外部輸入產生、且已用其他手段
驗證過時，才應傳 `{ rejectReservedNames: false }` 關閉本檢查。

### `bun-app-window/titlebar` — Windows 11 風格標題列

用於在無邊框模式下快速掛載符合 Windows 11 視覺規範的自訂標題列。IPC 服務是**扁平的**——
沒有 `window` 這一層命名空間——而且四個最自然的名稱裡有一個被用戶端自己佔了，所以宿主端
公開 `winClose`，頁面端再映射回去：

```ts
// 宿主端 —— 扁平服務；`close` 是 IPC 用戶端的保留名稱
createIpcServer({
    service: {
        minimize: () => shell.minimize(),
        toggleMaximize: () => shell.toggleMaximize(),
        winClose: () => shell.close(),
        drag: () => shell.drag(),
    },
});
```

```ts
// 頁面端 —— 明確拼出 bridge
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
    title: "我的應用程式",
    icon: "/icon.svg",
    bridge: bridgeFromWindowService({
        minimize: () => api.minimize(),
        toggleMaximize: () => api.toggleMaximize(),
        close: () => api.winClose(), // 橋接時再映射回 close
        drag: () => api.drag(),
    }),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

實作細節：

- 原生拖曳體驗：拖曳操作透過呼叫 `shell.drag()` 交由底層發送 `WM_NCLBUTTONDOWN`（`HTCAPTION`）訊息處理，完整保留 Windows 11 貼齊版面配置（Snap Layouts）與連按兩下最大化等系統級行為。
- 樣式自訂：色彩與尺寸均透過 CSS 變數（`--ws-tb-*`）控制，覆寫變數即可實作佈景主題切換。若需自行注入樣式表而不是讓 `mountTitleBar` 注入一次，可單獨呼叫匯出的 `titleBarCss()`。
- 字形選擇：預設走 `detectIconSet()`，它向 `document.fonts` 詢問 `Segoe Fluent Icons`（Win 11）或 `Segoe MDL2 Assets`（Win 10），有一個在就用 `fluent`——兩套字型的碼位相同，一張表涵蓋兩代系統。只有兩個字型都探測不到時才退回 `unicode` 幾何符號（`─ □ ❐ ✕`）。要覆寫探測結果就明確傳 `icons: "unicode" | "fluent"`。
- 交給殼層繪製按鈕：傳 `captions: "native"`，元件**一個按鈕都不渲染**，只在右側留出 `46 × 3` 給殼層的 layered 子視窗。必須與 `FLAG_NATIVE_CAPTIONS` 搭配——只開一半的結果是兩套按鈕疊在一起，或者一條點不到的空白區。注意這三個按鈕上的滑鼠點擊走**非客戶區**訊息，所以 `bridge.minimize` / `toggleMaximize` / `close` 在滑鼠這條路上不會被呼叫，動作由殼層自己執行；鍵盤 Tab + Enter 仍然經過 bridge。

### `bun-app-window/state` — 視窗位置與尺寸持久化

用於自動記錄並在下次啟動時還原視窗的座標、尺寸及最大化狀態：

```ts
import { attachPlacementStore, loadPlacement, restorePlacement } from "bun-app-window/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, flags: FLAG_DEFER_SHOW });

const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

const store = attachPlacementStore(shell, FILE); // 訂閱視窗事件，拖曳停下後寫入一次
process.on("beforeExit", () => store.flush());
```

底層原生實作已妥善處理以下邊界場景：

- 最大化狀態下儲存的是視窗「還原後的正常矩形（Restore Rect）」而非全螢幕尺寸。
- 跨顯示器不同縮放比例下的 DPI 座標換算。
- 螢幕拓撲變化（如拔除外接螢幕）後的螢幕外座標越界驗證與修正。

寫入是事件驅動的：收到狀態變化**立刻**取得快照（微秒級），寫入磁碟則攢到停下 300 ms 後
做一次。視窗靜止時既沒有原生呼叫也沒有磁碟寫入。用 `debounceMs` 調整寫入延遲；用
`pumpMs` 調整內部事件泵的拉取節奏。

若已有事件泵（例如用了 `createApp`），把它傳進來，避免兩個消費者爭搶同一批事件：

```ts
import { createApp } from "bun-app-window/app";
import { attachPlacementStore } from "bun-app-window/state";

const app = await createApp({ html });
const store = attachPlacementStore(app.shell, FILE, { events: app.events });
```

若無需背景訂閱，亦可直接呼叫 `capturePlacement` 與 `savePlacement` 執行單次手動讀寫。

### 視窗事件

宿主想知道「視窗狀態變了」，不必輪詢——`pollEvents()` 直接給出事件串流：

```ts
import { EVENT_CLOSED, EVENT_STATE } from "bun-app-window/events";

for (const e of shell.pollEvents()) {
    if (e.type === EVENT_CLOSED) break; // 視窗已銷毀，原生單例已釋放
    if (e.type === EVENT_STATE && e.maximized) {
        /* ... */
    }
}
```

`pollEvents()` 是**消費式**的：讀走的記錄不會再來，所以一個行程只應有一個消費者。
想要固定節奏與多路訂閱時，用 `./events` 的 `attachEventPump()`：

```ts
import { EVENT_CLOSED, attachEventPump } from "bun-app-window/events";

const pump = attachEventPump(shell, { intervalMs: 16 });
pump.on((e) => {
    if (e.type === EVENT_CLOSED) pump.stop();
});
pump.onGap((missing) => console.warn(`漏了 ${missing} 條事件`));
```

- `STATE` 酬載是**快照**：`width` / `height` / `dpi` 與四位狀態
  （`maximized` / `minimized` / `focused` / `dark`）。
- `CLOSED` 是終態。它由原生側在 teardown 全部做完、視窗代碼已置空之後寫出，所以
  「看到 `CLOSED`」等價於「可以安全重啟視窗」——這是它優於 `isAlive()` 的地方。
- 原生側環形佇列容量 128 條，滿時丟最舊。遺失量透過 `seq` 缺口如實上報（`onGap`），
  不會偽裝成「什麼都沒發生」。
- 事件泵的計時器預設 `unref`（不阻止行程退出）。若靠它等視窗關閉，傳 `keepAlive: true`。

### `bun-app-window/debug` — 診斷與除錯介面

提供底層視窗度量與命中測試（Hit-Test）資訊。注意：診斷介面不屬於穩定 API 契約，後續版本可能隨時調整。

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics(); // → "pos=196,196 win=1960x1400 client=1960x1400 work=3072x1824 border=13x13 round=1"
d.dpi(); // → "awareness=-1 dpi=192 scale=200%"
d.hittest(x, y);
```

`metrics()` 與 `dpi()` 回傳的是**格式化文字**，不是物件。真要解析就寫進一次性指令碼裡，別把
解析器塞進正式程式碼——這個格式不屬於任何契約。

### `bun-app-window/types` — 常數面，瀏覽器安全

一個零依賴模組，承載全部常數：`FLAG_*`（十個全在，含 `FLAG_TITLEBAR_RESERVE` 與 `FLAG_NATIVE_CAPTIONS`）、`BROWSER_UI_*`、`RESIZE_EDGE`、`RESIZE_INDEX`、`resizeIndex`、`ZOOM_LADDER`、`ZOOM_MIN`、`ZOOM_MAX`、`STATE_MAXIMIZED` / `STATE_MINIMIZED` / `STATE_FOCUSED`，以及 caption 幾何三件套 `CAPTION_BAR_HEIGHT`（32）/ `CAPTION_BUTTON_WIDTH`（46）/ `CAPTION_BUTTONS`——最後這個的順序是「從右往左 close、maximize、minimize」，而這個順序是有承重的：頁面畫的按鈕順序若與 `caption_button_at()` 的回報順序不一致，點「關閉」會變成最大化。

**頁面側請用這個子路徑。** 主入口經 `./native` 引入 `bun:ffi`，瀏覽器打包器解析不了它——
所以在頁面程式碼裡寫 `import { BROWSER_UI_ALL } from "bun-app-window"` 會在打包期失敗。
開這個子路徑就是為了讓同一份常數被共用，而不是各自手抄：

```ts
import { BROWSER_UI_ALL, ZOOM_LADDER, RESIZE_EDGE, resizeIndex } from "bun-app-window/types";
```

它只有一個不變量：`src/shell/types.ts` 必須保持零 import。有靜態斷言守著。

### `bun-app-window/pack` — 打包頁面指令碼

頁面指令碼必須先打包瀏覽器才載入得了：它會 import `bun-app-window/ipc` 這類裸模組名，
瀏覽器解析不了。打包要放在**建置期**，不是啟動時——`bun build --compile` 之後
`import.meta.dir` 指向封存內部（`B:\~BUN\root`），`.ts` 原始碼已經不在那裡了。

```ts
import { bundlePage, writePageBundle } from "bun-app-window/pack";

// 只在記憶體裡：把字串交給 createApp({ page })
const { code, bytes } = await bundlePage({ entry: "src/ui/page.ts" });

// 或者寫入磁碟，例如從一個 bundle:page 的 npm script 裡呼叫
await writePageBundle({ entry: "src/ui/page.ts", out: "src/ui/page.bundle.txt" });
```

`target: "browser"` 與 `format: "esm"` 是固定的，不可配置——頁面指令碼就是這兩者。
`bytes` 是 UTF-8 位元組數，不是 `string.length`；原始碼裡只要有非 ASCII 文字兩者就不同，
而一個「看起來對」的體積讀數比沒有讀數更糟。

#### 編譯型框架：`plugins`、`define`、`loader`

這三個欄位原樣交給 `Bun.build`，與任何具體框架無關，本套件不自帶任何外掛。

```ts
const built = await bundlePage({
    entry: "src/main.ts",
    plugins: [myFrameworkPlugin()], // .vue / .svelte / .tsx —— 外掛能編譯什麼就傳什麼
    define: { __VUE_OPTIONS_API__: "false" }, // 編譯期常數
    loader: { ".thing": "ts" }, // 自訂副檔名
});
```

#### `alias` 由本套件實作，因為 Bun 沒有這個選項

Bun 1.4.4 的 `BuildConfig` 沒有 `alias` 屬性，而且傳進去不會報錯——它被靜默忽略。
四種寫法都試過，全部解析失敗。因此本套件用自帶的 `onResolve` 外掛支撐 `alias`：

```ts
await bundlePage({ entry, alias: { "@": "./src", lib: "./src/lib" } });
```

| 模組指定符                      | 是否重寫 |
| ------------------------------- | -------- |
| 與某個鍵相等，或以 `鍵/` 為前綴 | 是       |
| 以 `.` 或 `/` 開頭              | 否       |
| 帶 `scheme:` 前綴               | 否       |

**預設是空的。** `$lib` 是 SvelteKit 的約定，`@/` 是某些專案自己的 `tsconfig` 別名，
兩者都不屬於本套件。別名與呼叫方的外掛是合併關係而非取代，且只在傳入 `alias` 時才註冊該外掛。

#### 多產物

編譯型框架經常產出不止一個產物——指令碼加樣式表是常見形態。`outputs` 列出全部，每項帶
`path` / `kind` / `code` / `bytes`，而 `code` 與 `bytes` 特指 `entry-point` 那一個
（不是 `outputs[0]`，輸出順序不構成契約）。

`writePageBundle` 寫出每一個產物：入口寫到 `out`，其餘寫到同目錄並替換副檔名。
所以 `page.bundle.txt` 會得到 `page.bundle.css`，**不是** `main.css`——入口的檔名不該
滲進一個 HTML 與 `assets` 會引用的路徑。它回傳 `written: Array<{ path, bytes }>`，
便於清理時刪掉自己產生的每一個檔案。

```text
$ bun run bundle:page
109,888 B  dist/page.bundle.txt     ← 入口產物
    133 B  dist/page.bundle.css     ← 附帶產物
```

其餘檔案用 `createApp({ assets })` 服務——見上文的 `app` 小節。

失敗時拋錯並帶上 Bun 的完整診斷。兩種形態都覆蓋了：編譯期問題以
`{ success: false, logs }` 回傳，而入口本身不可達時**拋 `AggregateError`**，
它的 `message` 只有一句 `Bundle failed`，細節在 `.errors` 上。

### `bun-app-window/native` — 預編譯動態連結程式庫本體

該子路徑解析到 `dist/libshell.dll` 本身，`import.meta.resolve()` 拿到的是可直接複製到 exe 旁邊的真實路徑：

```ts
import nativeLibPath from "bun-app-window/native" with { type: "file" };

await Bun.write(join(dirname(process.execPath), "libshell.dll"), Bun.file(nativeLibPath));
```

`with { type: "file" }` 不能省略，否則封裝器會把 DLL 當模組解析。此入口用於自行封裝的場景；走 `bun build --compile` 請直接用 `bun-app-window/embedded`，它不必碰檔案系統。

## 常見場景與最佳實踐

### 1. 停用瀏覽器預設行為

WebView2 預設保留了完整的瀏覽器互動語意。建構桌面應用程式時，通常建議將其全部停用：

```ts
import { BROWSER_UI_ALL } from "bun-app-window";

const shell = await openShell({ url, browserUi: BROWSER_UI_ALL });
```

亦可依需求組合以下旗標：

| 旗標                   | 停用的瀏覽器行為                                      |
| ---------------------- | ----------------------------------------------------- |
| `BROWSER_UI_MENU`      | 預設網頁右鍵選單（Edge 快顯功能表）                   |
| `BROWSER_UI_KEYS`      | 瀏覽器內建快速鍵（如 `Ctrl+P` / `Ctrl+F` / `Ctrl+S`） |
| `BROWSER_UI_STATUSBAR` | 左下角連結懸停狀態列                                  |
| `BROWSER_UI_SWIPE`     | 觸控板雙指橫滑上一頁 / 下一頁手勢                     |
| `BROWSER_UI_AUTOFILL`  | 表單自動填入提示                                      |

註：`F11`、`F12` 及 `Ctrl±` 縮放由視窗外殼層直接接管，不受上述旗標影響。

### 2. 原生右鍵快顯功能表

停用預設瀏覽器選單後，可透過 `showContextMenu` 喚起基於 Win32 `TrackPopupMenu` 繪製的原生選單。頁面無法直接呼叫它——需先在 IPC 服務上暴露：

```ts
// 宿主端：將選單能力掛載到扁平服務上
createIpcServer({
    service: {
        showContextMenu: (x: number, y: number, items: string) => shell.showContextMenu(x, y, items),
    },
});
```

```ts
// 頁面端觸發選單
document.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    await api.showContextMenu(
        Math.round(e.screenX),
        Math.round(e.screenY),
        "open|開啟\nrefresh|重新整理\n-\nquit|結束",
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

落進視窗的**檔案與資料夾**都由殼層注入的腳本自動轉發，頁面**不需要**自己監聽 `drop`。每條都是**絕對路徑**（來源 `ICoreWebView2File::get_Path`），而 `dirs` 告訴你其中哪些是資料夾：

```js
window.addEventListener("shell-msg", (e) => {
    if (e.detail.t !== "drop") return;
    for (const p of e.detail.paths) {
        console.log(e.detail.dirs.includes(p) ? "資料夾" : "檔案", p);
    }
});
```

針對管理員提權場景（High 完整性層級行程接收來自 Medium 層級檔案總管的訊息），底層已透過 `ChangeWindowMessageFilterEx` 自動放行 UIPI 訊息過濾。

### 4. 前端頁面桌面化樣式建議

視窗外殼層不會向頁面隱式注入任何 DOM 或全域樣式。為消除「網頁感」，建議應用程式於前端自行補充以下基礎規則：

```css
html,
body {
    cursor: default;
}
body {
    user-select: none;
}
input,
textarea,
.log {
    user-select: text;
    cursor: auto;
}
button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
```

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" />
```

尤其建議為輸入框設定 `spellcheck="false"`，否則瀏覽器拼字檢查極易在檔案路徑或專業數值下方繪製紅色波浪底線，破壞桌面應用程式的原生觀感。

### 5. 編譯為單一可執行檔（.exe）

使用 `bun build --compile` 封裝時，可透過匯入 `bun-app-window/embedded` 將原生 DLL 一併內嵌至產物中：

```ts
import { createShell } from "bun-app-window";
import { embeddedDll } from "bun-app-window/embedded"; // 將 DLL 位元組內嵌至封裝產物

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

提示：

- 僅透過副作用匯入 `import "bun-app-window/embedded";` 同樣生效。
- 封裝桌面端應用程式時請務必加上 `--windows-hide-console` 參數，否則啟動時將伴隨彈出黑色主控台（Console）視窗。

### 6. 兩個型別檢查抓不到的坑

這兩條都不會讓 `bun check` 變紅，但都會得到一個「渲染正常、什麼也不做」的視窗。

- **頁面 bundle 是 ES 模組，`<script>` 標籤必須寫 `type="module"`。** 帶頂層 `await` 的封裝
  產物塞進傳統 `<script>` 就是語法錯誤，**整個指令碼一行都不執行**——而頁面照樣渲染，因為
  HTML 是靜態的。螢幕上沒有任何東西指向這個原因。
- **自己的 `data-*` 選擇器要給命名空間。** 標題列的按鈕用
  `data-act="minimize|maximize|close"`，並在 `document` 上掛 click 監聽。宿主如果也綁
  `button[data-act]`，同一次點擊會被接兩遍，然後打出自己那句「未知動作：maximize」。給自己的
  屬性加前綴（`data-mvp-act`）——泛化屬性名稱是共享命名空間，不是你的地盤。

## 底層機制與互動參考

### 原生動態連結程式庫載入順序

執行階段依以下優先順序尋找並載入 `libshell.dll`：

1. 明確路徑：若傳入 `opts.nativeLibPath`，則直接載入該路徑並略過後續推斷。
2. 內嵌位元組釋放：若包含編譯期內嵌位元組，將其釋放至 `%LOCALAPPDATA%\<appName>\runtime` 目錄下（採用內容雜湊值命名，自動清理歷史舊版本）。
3. 可執行檔同級目錄：尋找目前 `.exe` 所在目錄下的 `libshell.dll`。
4. 開發態路徑：依序尋找套件根目錄下的 `.build/libshell.dll` 與 `dist/libshell.dll`。

### 內建快速鍵與滑鼠行為

| 觸發方式                       | 預設行為                                       |
| ------------------------------ | ---------------------------------------------- |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | 頁面縮放：放大一階 / 縮小一階 / 重設為 100%    |
| `Ctrl + 滑鼠滾輪`              | 頁面縮放：放大 / 縮小                          |
| `F11`                          | 切換全螢幕模式（隱藏視窗邊框並覆蓋系統工作列） |
| `F5` / `Ctrl + R`              | 重新載入目前頁面                               |
| `F12`                          | 開啟 WebView2 開發人員工具                     |
| `Alt + Space` / 標題列右鍵     | 彈出 Windows 系統視窗選單                      |

## 開發與驗證

本專案工具鏈基於 Bun 1.4.4 與 TypeScript 7.0.2 建構，`tsconfig.json` 開啟全量嚴格模式檢查。

**本專案不使用遠端 CI。** 該帳戶的 GitHub Actions 因 billing lock 無法分配 runner；而專案本身是單平台、單人開發、零外部服務相依的相依套件，遠端 CI 的邊際價值低於其維護成本，因此品質把關改為本機執行。建議入口：

```powershell
bun run scripts/gate.ts              # 對目前工作區執行三段把關
bun run scripts/gate.ts --clean      # 同上，但在 HEAD 的乾淨副本內執行
```

`-Clean` 重現了託管 runner 的條件：將 `HEAD` clone 到 `%TEMP%`，依 lockfile 安裝相依套件，再於其中執行把關。如此一來，本機產物（`.build/`、`node_modules/`、`vendor/webview2/`）便無法掩蓋缺少的檔案。未提交的變更會被提示並排除於乾淨副本之外——如需驗證工作區現況，請移除 `-Clean`。

品質把關分三段：`bun check`、`bun test`，以及消費方驗收（`scripts/verify-pack.ts`）。第三段會把 tarball 打包到 `%TEMP%`，安裝進一個臨時專案，對該專案執行型別檢查，再執行 `scripts/consumer-probe.ts`——斷言涵蓋全部子路徑、DLL 是否真的從 `node_modules` 被 `dlopen`、以及 `libInfo.source` 是否為 `package`（條數由探針自報）。可離線執行，且預設拒絕：任何未在允許清單登記的檔案被打進套件，把關就會失敗。只有在改動把關腳本本身時才用 `-SkipPack`。

底層指令仍可直接呼叫：

```bash
bun check          # 執行 TypeScript 型別檢查
bun test           # 執行自動化測試套件（位於 tests/）
bun run demo       # 啟動互動式自我檢測範例程式（需於桌面工作階段下執行）
```

需注意：`bun run demo` 與單一 `.exe` 的驗收都需要互動式桌面，因此兩者都不具備 CI 可行性，屬於構造上的本機專屬項目。`.exe` 那條的完整判據是：編譯 → 把產物複製進一個空目錄 → 啟動 → 確認視窗起得來，且 `libInfo.source` 回報 `embedded`。

每當修改 `src/shell/` 或 `package.json` 後，「作為外部專案相依套件安裝」這條鏈路已由消費方驗收階段自動涵蓋——它隨品質把關一起執行，不需要額外記得。只剩 `.exe` 建置仍需於桌面工作階段手動執行一次。

自動化測試或截圖腳本若需透過 Win32 `EnumWindows` 過濾視窗控制代碼（HWND），請依據視窗模式比對對應的視窗類別名稱（Window Class）：

| 視窗模式                                | 對應視窗類別名稱 |
| --------------------------------------- | ---------------- |
| 標準有邊框模式（未傳 `FLAG_FRAMELESS`） | `webview`        |
| 無邊框模式（傳入 `FLAG_FRAMELESS`）     | `webview_shell`  |

## 致謝

- 底層跨平台視窗抽象源自 [webview/webview](https://github.com/webview/webview) `0.12.0`（MIT 授權，作者 Serge Zaitsev · Steffen André Langnes）。儲存庫內 `vendor/webview/` 目錄為其原始碼原樣拷貝，未作任何侵入式修改。
- WebView2 C/C++ SDK 源自 [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.4258.31`（NuGet 套件隨儲存庫發佈以支援離線建構），執行環境由作業系統提供。
- Co-authored-by DeepSeek

## 授權條款

本專案基於 [MIT License](./LICENSE) 開源發佈。`vendor/webview/` 目錄同樣遵循 MIT 授權條款，其原始著作權聲明完整保留於對應原始碼檔案中。
