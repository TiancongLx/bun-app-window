/*
 * shell.cc — 最小窗口 ABI（含无边框模式）
 *
 * 设计要点：
 *   1. UI 线程由本文件创建，webview_run 在其上阻塞；JS 侧 shell_start 立即返回。
 *   2. 无边框模式自己建窗口，再把 HWND 交给 webview（webview_create 的嵌入模式），
 *      COM 样板、DPI、WebView2 初始化仍由平台层负责。
 *   3. 宿主 -> 页面的控制命令经队列 + webview_dispatch 投递到 UI 线程，
 *      避免跨线程触碰线程亲和的 WebView2。
 *   4. 页面 -> 宿主走本地 HTTP/WebSocket，不暴露 C -> JS 回调。
 *   5. 不使用 webview_set_size：它会 SetWindowPos 顶层窗口，嵌入模式下会打乱几何。
 *      改为直接 SetWindowPos 子 widget，由其 WM_SIZE 驱动 put_Bounds。
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
// MinGW 的 winuser.h 用 WINVER 门控 DPI 相关 API：
//   AdjustWindowRectExForDpi 需要 >= 0x0605，GetDpiForWindow 需要 >= 0x0A00
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>

#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <atomic>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

#include "webview/webview.h"

// WebView2 的 COM 头。只为了拿 ICoreWebView2Controller2::put_DefaultBackgroundColor：
// WebView2 表面在页面首帧绘制之前显示的是它自己的默认白底，深色应用启动会白闪一下。
// MinGW 下没有 IID 符号库，所以下面的 QueryInterface 一律用本文件内的 GUID 字面量。
#include <WebView2.h>

namespace {

// ---- 对外常量（与 TS 侧保持字面一致） ----
enum ShellFlag : int {
  SHELL_FLAG_FRAMELESS = 1,
  SHELL_FLAG_TOPMOST = 2,
  SHELL_FLAG_CENTER = 4,
  SHELL_FLAG_RESIZABLE = 8,
  // 创建后先不显示，等调用方确认页面就绪再 shell_show()。
  // 用于消除「空窗口先出现、内容后填上」的首帧闪烁。
  SHELL_FLAG_DEFER_SHOW = 16,
  // 接受文件/文件夹拖放，落下的路径以 shell-msg 的 {t:'drop',paths:[...]} 推给页面。
  SHELL_FLAG_ACCEPT_DROP = 32,
  // 首次显示时直接以最大化出现。
  //
  // 为什么不「先 show 再 maximize」：那会有一次「小窗闪一下再撑满」的跳变，
  // 交付观感很差。这里把最大化合成到 show_now() 的那一次 ShowWindow，
  // 窗口从隐藏直接变成最大化，中间没有任何可见帧。
  // 与 FLAG_CENTER 同时给时以本项为准——最大化会覆盖位置。
  SHELL_FLAG_START_MAXIMIZED = 64,
  // 允许页面把顶层框架导航到别的 origin（默认禁止）。
  //
  // 默认行为：任何离开本站 origin 的顶层导航都被取消，改用系统默认浏览器打开；
  // `target=_blank` / `window.open` 触发的新窗口同样被拦下并转交系统浏览器。
  //
  // 为什么默认禁止：页面里一个普通外链就能把整个应用导航走，而且**没有返回路径**
  // ——导航到外部站点后，页面里既没有后退按钮也没有宿主 API 能回来，用户只能
  // 关掉整个窗口。这是默认值应该选安全一侧的典型场景。
  //
  // 需要「应用本身就是浏览器」时再给这个标志。
  SHELL_FLAG_ALLOW_EXTERNAL_NAV = 128,
};

enum ShellState : int {
  SHELL_STATE_MAXIMIZED = 1,
  SHELL_STATE_MINIMIZED = 2,
  SHELL_STATE_FOCUSED = 4,
};

enum ShellEdge : int {
  SHELL_EDGE_LEFT = 0,
  SHELL_EDGE_RIGHT = 1,
  SHELL_EDGE_TOP = 2,
  SHELL_EDGE_BOTTOM = 3,
  SHELL_EDGE_TOPLEFT = 4,
  SHELL_EDGE_TOPRIGHT = 5,
  SHELL_EDGE_BOTTOMLEFT = 6,
  SHELL_EDGE_BOTTOMRIGHT = 7,
};

enum class cmd_kind { eval, title, minimize, maximize_toggle, close, drag, resize, show, zoom, reload, devtools, fullscreen, restore_bounds, browser_ui, app_menu };

struct cmd {
  cmd_kind kind;
  std::string arg;
};

std::atomic<webview_t> g_webview{nullptr};
HWND g_hwnd = nullptr;        // 顶层窗口（自有或 webview 创建）
HWND g_widget = nullptr;      // WebView2 容器子窗口
WNDPROC g_widget_orig = nullptr;
WNDPROC g_toplevel_orig = nullptr;  // 仅带边框模式：webview 自建窗口的子类化
HANDLE g_ready = nullptr;

bool g_frameless = false;
std::atomic<bool> g_shown{false};  // 是否已完成首次显示（忽略创建期 WM_DPICHANGED 建议矩形；跨线程读）
std::atomic<int> g_round_state{-1};  // 圆角状态缓存：-1 未知 / 0 直角 / 1 圆角（跨线程读）
bool g_resizable = true;
bool g_defer_show = false;    // 延迟显示：等 shell_show() 再 ShowWindow
bool g_accept_drop = false;   // 接受文件拖放
bool g_start_maximized = false;  // 首次显示即以最大化出现
std::wstring g_app_id;        // AppUserModelID：决定任务栏分组与图标归属
int g_min_w = 320;
int g_min_h = 200;
int g_start_w = 1200;
int g_start_h = 800;

// ---- 自绘标题栏的 caption button 命中区（逻辑像素，96 DPI 基准）----
//
// 这三个值有**三处**副本，缺一不可：
//
//   src/shell/types.ts        CAPTION_BAR_HEIGHT / CAPTION_BUTTON_WIDTH / CAPTION_BUTTONS
//   src/ui/titlebar.ts 的 CSS  --ws-tb-height: 32px / .ws__tb-btn { width: 46px }
//   这里                        命中区（C++ 无法 import TS）
//
// `tests/types.test.ts` 用判据把三处钉在一起，包括「顺序」。
//
// ## 为什么必须精确一致
//
// `HTMAXBUTTON` 是「鼠标悬停在最大化按钮上时弹 Snap Layouts」的**唯一**触发条件：
// 微软文档（Support snap layouts for desktop apps on Windows 11）明写 Win32 应用
// 要「respond to WM_NCHITTEST with a return value of HTMAXBUTTON for the
// maximize/restore button」。这里算错几个像素，表现为「悬停位置偏了才弹」或
// 「根本不弹」——两种都极难从现象反推回常量，所以宁可用断言锁死。
//
// ## 为什么是「焊死」而不是让页面告诉壳层
//
// Win 11 的 caption button 本来就是固定规格（46×32），焊接不会错；而让页面
// 运行时上报命中区会引入一条新的 IPC 时序（页面还没挂标题栏的那一帧，
// 命中区是空的，此时悬停最大化按钮什么都不发生）。规格固定时，静态常量更可靠。
const int kCaptionBarHeight = 32;
const int kCaptionButtonWidth = 46;
// 顺序必须与 types.ts 的 CAPTION_BUTTONS 一致：从右往左 close → maximize → minimize
// （判定见 caption_button_at，只在这里用一次）

// 全屏状态：进入前保存样式与矩形，退出时原样还原。
//
// 声明放在这里（而不是原先跟着 toggle_fullscreen 走）：hit_test_client 要用它
// 判断「全屏时标题栏不可见，caption button 不参与命中」，而 hit_test_client 在
// 文件里出现得更早。C++ 的名字查找是按声明顺序，放晚了就是编译错误。
bool g_fullscreen = false;
LONG_PTR g_saved_style = 0;
RECT g_saved_rect{};

// 两把锁，锁序固定为 life → queue，避免任何自锁路径：
//   g_life_mu  — 保护 g_webview 的生死：enqueue 的「检查后投递」与 teardown 的「销毁后清空」互斥
//   g_queue_mu — 只保护命令队列本身
// 注意 drain() 只碰 g_queue_mu；teardown 会持 g_life_mu 调 webview_destroy，
// 若两者共用一把锁，销毁过程中若同步派发了 WM_APP 就会死锁。
std::mutex g_life_mu;
std::mutex g_queue_mu;
std::deque<cmd> g_queue;

std::string g_url;
std::string g_title;

// 本站 origin（`scheme://host[:port]`，小写）。外部导航拦截的判据。
// 由 shell_start_ex 从 g_url 算出。空串表示「算不出来」（`file://`、`about:blank`、
// 自定义 scheme 等无 origin 的启动地址），此时判据退化——见 classify_nav。
std::wstring g_origin;
// 启动 URL 去掉 `#fragment` 后的形态。origin 为空时唯一的放行依据：
// 只有同文档导航（即 `g_app_doc` 或它的 `#xxx`）才留在应用内。
std::wstring g_app_doc;
bool g_allow_external_nav = false;
// 导航守卫的 COM 对象与注册令牌。我们各持有一份引用，teardown 时 remove + Release。
ICoreWebView2NavigationStartingEventHandler *g_nav_guard = nullptr;
EventRegistrationToken g_nav_token{};
ICoreWebView2NewWindowRequestedEventHandler *g_new_window_guard = nullptr;
EventRegistrationToken g_new_window_token{};
// 键盘快捷键的事件处理器与注册令牌。与 nav guard 同一套持有方式：
// add_ 之后我们持一份引用，teardown 时 remove_ + Release。
ICoreWebView2AcceleratorKeyPressedEventHandler *g_accel_handler = nullptr;
EventRegistrationToken g_accel_token{};
// 拖放：WebMessageReceived 的处理器与令牌（从 DOM drop 里取真实路径）。
ICoreWebView2WebMessageReceivedEventHandler *g_drop_handler = nullptr;
EventRegistrationToken g_drop_token{};

// 错误槽。跨线程写：启动期由 UI 线程写（CoInitializeEx / webview_create 失败等），
// 运行期任何线程都可能写。放在 mutex 后面，避免两条错误互相覆盖成半截字符串。
// 读侧必须走 shell_error_text() 拿拷贝——shell_error() 返回的是共享缓冲区的指针。
std::mutex g_err_mu;
char g_err[1024] = {0};

void set_err(const char *msg) {
  std::lock_guard<std::mutex> lock(g_err_mu);
  lstrcpynA(g_err, msg ? msg : "", static_cast<int>(sizeof(g_err)));
}

// 启动前清空：让「启动失败」读到的一定是本次启动写下的那条，而不是上一次的残留。
void clear_err() {
  std::lock_guard<std::mutex> lock(g_err_mu);
  g_err[0] = 0;
}

// 把当前错误拷进调用方的缓冲区并返回长度。shell_error() 只保留 ABI 兼容，
// 它返回的指针在解锁后可能被别的线程改写，新代码一律用这个。
int copy_err(char *buf, int cap) {
  if (!buf || cap <= 0) return 0;
  std::lock_guard<std::mutex> lock(g_err_mu);
  const int n = lstrlenA(g_err);
  const int copy = n < cap - 1 ? n : cap - 1;
  if (copy > 0) memcpy(buf, g_err, static_cast<size_t>(copy));
  buf[copy] = 0;
  return copy;
}

// ---- 外观与系统集成辅助 ----

// 从宿主 exe 的资源里取图标。
// Bun 的 --windows-icon 会把 ICO 的每个尺寸各写成一个 RT_GROUP_ICON 条目，
// 编号不保证从 1 开始，因此这里枚举第一个可用的图标组，而不是猜测 ID。
HICON load_exe_icon(int cx, int cy) {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  const int w = cx > 0 ? cx : GetSystemMetrics(SM_CXICON);
  const int h = cy > 0 ? cy : GetSystemMetrics(SM_CYICON);

  HICON icon = static_cast<HICON>(LoadImageW(inst, IDI_APPLICATION, IMAGE_ICON, w, h,
                                             LR_SHARED));

  // 枚举本模块的图标组资源，取第一个能加载成功的
  struct Ctx {
    HINSTANCE inst;
    int w, h;
    HICON out;
  } ctx{inst, w, h, nullptr};

  EnumResourceNamesW(
      inst, RT_GROUP_ICON,
      [](HMODULE, LPCWSTR, LPWSTR name, LONG_PTR lp) -> BOOL {
        auto *c = reinterpret_cast<Ctx *>(lp);
        HICON ic =
            static_cast<HICON>(LoadImageW(c->inst, name, IMAGE_ICON, c->w, c->h, 0));
        if (ic) {
          c->out = ic;
          return FALSE;  // 找到即停
        }
        return TRUE;
      },
      reinterpret_cast<LONG_PTR>(&ctx));

  if (ctx.out) icon = ctx.out;
  return icon;
}

// exe 里嵌了图标，但窗口不会自动继承；不显式设置的话任务栏/Alt-Tab/标题栏
// 全是系统默认图标。大图标给 Alt-Tab 与任务栏，小图标给标题栏与 Alt-Tab 缩略。
void apply_window_icons(HWND hwnd) {
  if (!hwnd) return;
  HICON big = load_exe_icon(GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON));
  HICON small =
      load_exe_icon(GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON));
  if (big) SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(big));
  if (small) SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small));
}

// 任务栏分组按 AppUserModelID 归属。不设的话窗口会被归到承载进程（bun.exe）名下，
// 图标与跳转列表都跟着错。必须在窗口创建前调用。
void apply_app_user_model_id() {
  if (g_app_id.empty()) return;
  using SetFn = HRESULT(WINAPI *)(PCWSTR);
  auto fn = reinterpret_cast<SetFn>(GetProcAddress(
      GetModuleHandleW(L"shell32.dll"), "SetCurrentProcessExplicitAppUserModelID"));
  if (fn) fn(g_app_id.c_str());
}

// AppsUseLightTheme: 0 = 深色，1 = 浅色。缺省按浅色处理。
bool system_uses_dark() {
  DWORD value = 1;
  DWORD size = sizeof(value);
  const LONG rc = RegGetValueW(
      HKEY_CURRENT_USER,
      L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
      L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &value, &size);
  return rc == ERROR_SUCCESS && value == 0;
}

// 标题栏、边框、系统菜单由 DWM 绘制；只有把这个属性设上，它们才跟随系统深色。
// 20 是 1903+ 的属性号，19 对应更早的 1809，两个都试一遍不影响结果。
void apply_dark_mode(HWND hwnd) {
  if (!hwnd) return;
  const BOOL dark = system_uses_dark() ? TRUE : FALSE;
  if (FAILED(DwmSetWindowAttribute(hwnd, 20, &dark, sizeof(dark)))) {
    DwmSetWindowAttribute(hwnd, 19, &dark, sizeof(dark));
  }
}

// 让 WebView2 在页面首帧绘制之前显示与系统主题一致的底色。
//
// 不设的话，未绘制区域是 WebView2 的默认**白底**：深色应用窗口一显示，屏幕会先闪
// 一下白（实测首帧亮度 mean=236/255，约 200 ms），这才是「启动闪屏」的真正来源——
// 光把窗口藏到内容就绪只能减轻一半，因为窗口一显示、页面还没合成，露出的是白底。
//
// 需要 ICoreWebView2Controller2。MinGW 不提供 IID 符号库，所以用 GUID 字面量
// （同仓库既有约定：见 pitfalls 3.2）。失败不影响其余功能。
void apply_default_background(webview_t w, bool dark) {
  if (!w) {
    return;
  }
  auto *ctrl = static_cast<ICoreWebView2Controller *>(
      webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
  if (!ctrl) {
    return;
  }

  // {c979903e-d4ca-4228-92eb-47ee3fa96eab} = ICoreWebView2Controller2
  static const GUID kIIDController2 = {
      0xc979903e, 0xd4ca, 0x4228, {0x92, 0xeb, 0x47, 0xee, 0x3f, 0xa9, 0x6e, 0xab}};

  ICoreWebView2Controller2 *ctrl2 = nullptr;
  if (FAILED(ctrl->QueryInterface(kIIDController2, reinterpret_cast<void **>(&ctrl2))) ||
      !ctrl2) {
    return;
  }

  COREWEBVIEW2_COLOR color{};
  color.A = 255;
  if (dark) {
    // 与常见深色应用底色同量级，差值小到看不出来
    color.R = 32;
    color.G = 32;
    color.B = 32;
  } else {
    color.R = 255;
    color.G = 255;
    color.B = 255;
  }
  ctrl2->put_DefaultBackgroundColor(color);
  ctrl2->Release();
}

// ---- WebView2 的「浏览器 vs 应用」设置 ----

// WebView2 的默认设置是**浏览器**语义：右键是 Edge 菜单、Ctrl+P 打印网页、
// 左下角跳状态栏、触控板横滑会前进后退、表单有自动填充与密码提示。
// 这些在浏览器里都对，在桌面应用里每一条都是「这是个网页」的破绽。
//
// 位定义与 TS 侧 `BROWSER_UI_*` 逐位一致，不要单独改。
enum ShellBrowserUi : int {
  SHELL_BROWSER_MENU = 1,       // 默认右键菜单（重新加载 / 检查 / 另存为 / 翻译…）
  SHELL_BROWSER_KEYS = 2,       // 浏览器快捷键（Ctrl+P 打印、Ctrl+F 查找、Ctrl+S 保存…）
  SHELL_BROWSER_STATUSBAR = 4,  // 悬停时左下角的链接状态栏
  SHELL_BROWSER_SWIPE = 8,      // 触控板横滑导航
  SHELL_BROWSER_AUTOFILL = 16,  // 表单自动填充与密码保存提示
};

// 各 Settings 接口的 IID（MinGW 无 IID 符号库，按本仓约定用字面量）。
// 它们是链式继承（Settings5 : Settings4 : Settings3 : Settings2 : Settings），
// 所以 QueryInterface 到最高版本即可访问全部属性。
static const GUID kIIDSettings = {
    0xe562e4f0, 0xd7fa, 0x43ac, {0x8d, 0x71, 0xc0, 0x51, 0x50, 0x49, 0x9f, 0x00}};
static const GUID kIIDSettings3 = {
    0xfdb5ab74, 0xaf33, 0x4854, {0x84, 0xf0, 0x0a, 0x63, 0x1d, 0xeb, 0x5e, 0xba}};
static const GUID kIIDSettings4 = {
    0xcb56846c, 0x4168, 0x4d53, {0xb0, 0x4f, 0x03, 0xb6, 0xd6, 0x79, 0x6f, 0xf2}};
static const GUID kIIDSettings5 = {
    0x183e7052, 0x1d03, 0x43a0, {0xab, 0x99, 0x98, 0xe0, 0x43, 0xb6, 0x6b, 0x39}};
// IsSwipeNavigationEnabled 在 Settings6（实测：头文件 21168 行），不在 Settings5
static const GUID kIIDSettings6 = {
    0x11cb3acd, 0x9bc8, 0x43b8, {0x83, 0xbf, 0xf4, 0x07, 0x53, 0x71, 0x4f, 0x87}};

// 逐项关闭 mask 里的浏览器行为。
//
// 每一项都单独判 SUCCEEDED：老版本 WebView2 Runtime 可能没有 Settings4/5，
// 那时对应的 IF 会失败，但前面的项已经生效——不能因为一个失败就整体放弃。
void apply_browser_ui(webview_t w, int mask) {
  if (!w || mask == 0) {
    return;
  }
  auto *ctrl = static_cast<ICoreWebView2Controller *>(
      webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
  if (!ctrl) {
    return;
  }
  ICoreWebView2 *core = nullptr;
  if (FAILED(ctrl->get_CoreWebView2(&core)) || !core) {
    return;
  }
  ICoreWebView2Settings *s1 = nullptr;
  if (FAILED(core->get_Settings(&s1)) || !s1) {
    core->Release();
    return;
  }

  // ---- Settings（基线版本）----
  if (mask & (SHELL_BROWSER_MENU | SHELL_BROWSER_STATUSBAR)) {
    if (mask & SHELL_BROWSER_MENU) {
      s1->put_AreDefaultContextMenusEnabled(FALSE);
    }
    if (mask & SHELL_BROWSER_STATUSBAR) {
      s1->put_IsStatusBarEnabled(FALSE);
    }
  }

  // ---- Settings3：浏览器快捷键 ----
  if (mask & SHELL_BROWSER_KEYS) {
    ICoreWebView2Settings3 *s3 = nullptr;
    if (SUCCEEDED(s1->QueryInterface(kIIDSettings3, reinterpret_cast<void **>(&s3))) && s3) {
      s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
      s3->Release();
    }
  }

  // ---- Settings4：自动填充与密码保存 ----
  if (mask & SHELL_BROWSER_AUTOFILL) {
    ICoreWebView2Settings4 *s4 = nullptr;
    if (SUCCEEDED(s1->QueryInterface(kIIDSettings4, reinterpret_cast<void **>(&s4))) && s4) {
      s4->put_IsGeneralAutofillEnabled(FALSE);
      s4->put_IsPasswordAutosaveEnabled(FALSE);
      s4->Release();
    }
  }

  // ---- Settings6：滑动导航 ----
  if (mask & SHELL_BROWSER_SWIPE) {
    ICoreWebView2Settings6 *s6 = nullptr;
    if (SUCCEEDED(s1->QueryInterface(kIIDSettings6, reinterpret_cast<void **>(&s6))) && s6) {
      s6->put_IsSwipeNavigationEnabled(FALSE);
      s6->Release();
    }
  }

  (void)kIIDSettings;   // 基接口走 get_Settings，保留字面量供文档对照
  (void)kIIDSettings5;  // Settings5 无本项目所需属性，保留以便将来扩展
  s1->Release();
  core->Release();
}

// 右键标题栏 / Alt+Space 的系统菜单。原生窗口靠它给出还原、移动、大小、关闭；
// 无边框模式删掉了非客户区，必须自己补回来，否则这几条交互全缺。
void show_system_menu(HWND hwnd, POINT screen_pt) {
  if (!hwnd) return;
  HMENU menu = GetSystemMenu(hwnd, FALSE);
  if (!menu) return;

  const bool maximized = IsZoomed(hwnd) != 0;
  EnableMenuItem(menu, SC_RESTORE, MF_BYCOMMAND | (maximized ? MF_ENABLED : MF_GRAYED));
  EnableMenuItem(menu, SC_MOVE, MF_BYCOMMAND | (maximized ? MF_GRAYED : MF_ENABLED));
  EnableMenuItem(menu, SC_SIZE,
                 MF_BYCOMMAND | (maximized || !g_resizable ? MF_GRAYED : MF_ENABLED));
  SetMenuDefaultItem(menu, SC_CLOSE, FALSE);

  SetForegroundWindow(hwnd);
  const int cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, screen_pt.x,
                                 screen_pt.y, 0, hwnd, nullptr);
  // 交给系统执行，避免自己重复实现最小化/最大化/关闭
  if (cmd) PostMessageW(hwnd, WM_SYSCOMMAND, static_cast<WPARAM>(cmd), 0);
}

// ---- 几何辅助 ----

// DPI 感知开启后，窗口尺寸按物理像素解释；对外仍以 96 DPI 的逻辑像素为准。
UINT current_dpi() {
  return g_hwnd ? GetDpiForWindow(g_hwnd) : GetDpiForSystem();
}

int frame_border_x() {
  const UINT dpi = current_dpi();
  return GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) +
         GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
}

int frame_border_y() {
  const UINT dpi = current_dpi();
  return GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) +
         GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
}

// 自绘 caption button 的命中判定。
//
// 返回 HT* 码（HTCLOSE / HTMAXBUTTON / HTMINBUTTON）；不在按钮上返回 -1。
// **不用 HTNOWHERE 当哨兵**：那是合法的 HT 值（0），拿它做「没命中」会让
// 调用点分不清「不在按钮上」与「命中了位置 0」。
//
// ## 为什么这个判定必须先于缩放边框
//
// 缩放边框判定在 `IsZoomed` 时整体跳过（最大化的窗口本来就不能拖边缘）。
// 而 caption button 在**最大化时同样要能被命中**——用户靠它还原。
// 如果沿用原来的 early-return，最大化后悬停/点击最大化按钮全部失效。
//
// ## 坐标
//
// 入参是**客户区坐标（设备像素）**。逻辑像素常量在这里按 `current_dpi()` 换算，
// 所以 200% 缩放下 46×32 逻辑像素的按钮是 92×64 物理像素。
int caption_button_at(const RECT &client, POINT pt) {
  const UINT dpi = current_dpi();
  const int bw = MulDiv(kCaptionButtonWidth, static_cast<int>(dpi), 96);
  const int bh = MulDiv(kCaptionBarHeight, static_cast<int>(dpi), 96);
  if (bw <= 0 || bh <= 0) {
    return -1;
  }

  // 标题栏带：只在顶部 bh 高之内
  if (pt.y < client.top || pt.y >= client.top + bh) {
    return -1;
  }
  if (pt.x < client.left || pt.x >= client.right) {
    return -1;
  }

  // 从右边缘往左数：0 = close，1 = maximize，2 = minimize。
  // 顺序与 types.ts 的 CAPTION_BUTTONS 一致。
  const int from_right = client.right - pt.x;
  const int idx = from_right / bw;
  if (idx == 0) return HTCLOSE;
  if (idx == 1) return HTMAXBUTTON;
  if (idx == 2) return HTMINBUTTON;
  return -1;
}

// 返回 HT* 代码；HTCLIENT 表示不落在缩放边框或 caption button 上。
// 坐标为顶层窗口客户区坐标（设备像素）。
//
// 前置条件里 **`IsZoomed` 是刻意的**，不是漏判：Windows 里最大化的窗口本来
// 就不能拖边缘缩放（资源管理器自己也一样），必须先还原。所以最大化时跳过缩放
// 边框判定，让点击直接落到页面。
//
// 这一条原本没有注释，2026-10-21 排查时被误判成「缩放边框在最大化下失效」——
// 一处有意的判断如果没写理由，在别人（和下一个 agent）眼里就长得像 bug。
// 判断本身是对的，缺的是理由。
//
// **但 caption button 不在「跳过」之列**：它先判，且不受 resizable / zoomed 影响。
LRESULT hit_test_client(HWND hwnd, POINT pt) {
  if (!g_frameless) {
    return HTCLIENT;
  }
  RECT rc{};
  GetClientRect(hwnd, &rc);

  // 1. caption button（最优先）。全屏时标题栏不可见，不参与命中。
  if (!g_fullscreen) {
    const int cap = caption_button_at(rc, pt);
    if (cap != -1) {
      return static_cast<LRESULT>(cap);
    }
  }

  // 2. 缩放边框。最大化 / 不可缩放时不做。
  if (!g_resizable || IsZoomed(hwnd)) {
    return HTCLIENT;
  }

  const int bx = frame_border_x();
  const int by = frame_border_y();

  const bool left = pt.x < bx;
  const bool right = pt.x >= rc.right - bx;
  const bool top = pt.y < by;
  const bool bottom = pt.y >= rc.bottom - by;

  if (top && left) return HTTOPLEFT;
  if (top && right) return HTTOPRIGHT;
  if (bottom && left) return HTBOTTOMLEFT;
  if (bottom && right) return HTBOTTOMRIGHT;
  if (left) return HTLEFT;
  if (right) return HTRIGHT;
  if (top) return HTTOP;
  if (bottom) return HTBOTTOM;
  return HTCLIENT;
}

LRESULT hit_test(HWND hwnd, POINT screen_pt) {
  POINT pt = screen_pt;
  ScreenToClient(hwnd, &pt);
  return hit_test_client(hwnd, pt);
}

// 把 widget 铺满顶层窗口客户区。widget 的 WM_SIZE 会驱动 put_Bounds。
void fit_widget() {
  if (!g_hwnd || !g_widget) {
    return;
  }
  RECT rc{};
  GetClientRect(g_hwnd, &rc);
  SetWindowPos(g_widget, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void post_json(const std::string &json) {
  if (!g_webview) {
    return;
  }
  std::string expr = "window.__shell && window.__shell.recv(";
  expr += json;
  expr += ")";
  webview_eval(g_webview, expr.c_str());
}

// ---- 窗口生命周期事件：固定容量环形队列 ----
//
// 为什么是队列而不是回调：`webview_run` 会阻塞 UI 线程，而 `bun:ffi` 的 JSCallback
// 依赖空闲的 JS 主线程，二者叠加会跨线程重入死锁（ADR 0002、`AGENTS.md` §5 第 5 条）。
// 唯一可行的形态是「UI 线程往定长环里写，宿主在自己的节奏里批量拉走」。
//
// 为什么不复用 push_state 的两道闸：那两道闸（变化检测 + 16 ms 节流）是为跨进程
// `webview_eval` 服务的。宿主事件是同进程内存写，成本低几个数量级，而且**消费者不同**
// ——共用一份缓存会让页面推送的「跳过」把宿主事件一起吃掉。所以事件侧自持 g_ev_last。
//
// 为什么满时丢最旧：事件是状态迁移，最新的状态才是真相。丢最新会让环冻结在旧状态上，
// 宿主看到的是「窗口一直没变」——比丢历史危险得多。丢失量由 seq 缺口如实上报。

enum ShellEventType : unsigned {
  SHELL_EVENT_STATE = 1,
  SHELL_EVENT_CLOSED = 2,
};

// 与 TS 侧 src/shell/events.ts 的 EV_* 逐位一致
enum ShellEventFlag : unsigned {
  SHELL_EV_MAXIMIZED = 1,
  SHELL_EV_MINIMIZED = 2,
  SHELL_EV_FOCUSED = 4,
  SHELL_EV_DARK = 8,
};

// 32 字节定长，小端直排：FFI 侧不做序列化，宿主拿到 Uint8Array 直接按偏移读。
// 改布局 = 改 ABI，必须同步 events.ts 的 EVENT_RECORD_BYTES 与 decodeEvents。
struct EventRecord {
  unsigned int seq;    // 单调递增，从 1 起；新一次 shell_start_ex 归零
  unsigned int type;   // ShellEventType
  int a;               // STATE: 客户区宽（物理像素）
  int b;               // STATE: 客户区高
  int c;               // STATE: DPI
  int d;               // 保留（0）
  unsigned int flags;  // ShellEventFlag 按位或
  unsigned int reserved;
};
static_assert(sizeof(EventRecord) == 32, "event record must stay 32 bytes");

// 容量必须是 2 的幂（下面用位与取模）。128 × 32 B = 4 KiB：
// 16 ms 节奏下一次拖动约 60 条，留一倍余量；宿主完全不拉时 seq 缺口会如实上报。
const unsigned kEventCapacity = 128;
static_assert((kEventCapacity & (kEventCapacity - 1)) == 0,
              "event capacity must be a power of two");

// 事件环的锁，独立于 g_life_mu / g_queue_mu，从不与它们嵌套——锁序表里它是孤点。
// 写侧只有 UI 线程；读侧是宿主线程的批量拷贝，**也**要独占（它要推进 g_ev_tail）。
// 临界区最长是一次 4 KiB memcpy（微秒级），UI 线程感知不到。
// 不用无锁 SPSC 的理由很具体：溢出时写侧要推进读游标，「丢最旧」让环出现第二个
// 写者，正确性成本远高于一把 SRW。
SRWLOCK g_ev_mu = SRWLOCK_INIT;
EventRecord g_events[kEventCapacity];
unsigned g_ev_head = 0;  // 单调递增的写游标；占有量 = head - tail
unsigned g_ev_tail = 0;  // 单调递增的读游标
unsigned g_ev_seq = 0;
bool g_ev_has_last = false;
EventRecord g_ev_last{};  // 仅 UI 线程读写，用于「同态不入队」

// 入队一条记录（仅 UI 线程调用）。
void emit_event(unsigned type, int a, int b, int c, int d, unsigned flags) {
  AcquireSRWLockExclusive(&g_ev_mu);
  EventRecord rec{};
  rec.seq = ++g_ev_seq;
  rec.type = type;
  rec.a = a;
  rec.b = b;
  rec.c = c;
  rec.d = d;
  rec.flags = flags;
  if (g_ev_head - g_ev_tail >= kEventCapacity) {
    ++g_ev_tail;  // 满：丢最旧，保住最新状态
  }
  g_events[g_ev_head & (kEventCapacity - 1)] = rec;
  ++g_ev_head;
  ReleaseSRWLockExclusive(&g_ev_mu);
}

// 抓一次窗口状态，**状态没变就不入队**。
//
// 无边框模式的 WM_SIZE / WM_ACTIVATE 会经 shell_wnd_proc 走到这里；带边框模式的
// 窗口由 webview 库创建，消息只经过 toplevel_proc——两条路都必须显式调用本函数，
// 否则默认（带边框）配置下宿主永远收不到尺寸与最大化事件，而门禁照样全绿。
void emit_state_event() {
  if (!g_hwnd) {
    return;
  }
  const bool maxed = IsZoomed(g_hwnd) != FALSE;
  const bool minned = IsIconic(g_hwnd) != FALSE;
  const bool focused = GetForegroundWindow() == g_hwnd;
  RECT rc{};
  GetClientRect(g_hwnd, &rc);
  const int px_w = rc.right - rc.left;
  const int px_h = rc.bottom - rc.top;
  const int dpi = static_cast<int>(GetDpiForWindow(g_hwnd));
  const bool dark = system_uses_dark();

  unsigned flags = 0;
  if (maxed) flags |= SHELL_EV_MAXIMIZED;
  if (minned) flags |= SHELL_EV_MINIMIZED;
  if (focused) flags |= SHELL_EV_FOCUSED;
  if (dark) flags |= SHELL_EV_DARK;

  if (g_ev_has_last && g_ev_last.a == px_w && g_ev_last.b == px_h &&
      g_ev_last.c == dpi && g_ev_last.flags == flags) {
    return;
  }
  g_ev_has_last = true;
  g_ev_last = EventRecord{0, SHELL_EVENT_STATE, px_w, px_h, dpi, 0, flags, 0};
  emit_event(SHELL_EVENT_STATE, px_w, px_h, dpi, 0, flags);
}

// 终态事件。必须在 teardown 全部做完、g_webview 已置空**之后**调用：
// 「看到 CLOSED」于是等价于「进程级单例已释放，可以 restart」，宿主不必再轮询
// is_alive()（见 AGENTS.md §7.1）。
void emit_closed_event() {
  g_ev_has_last = false;
  g_ev_last = EventRecord{};
  emit_event(SHELL_EVENT_CLOSED, 0, 0, 0, 0, 0);
}

// 新一轮启动前清空：丢弃上一轮未读的记录（否则宿主可能先拿到上一次的 CLOSED，
// 误判「当前窗口已经关了」），并把序号归零。宿主侧据此判定新一轮——seq 变小即重启。
void reset_events() {
  AcquireSRWLockExclusive(&g_ev_mu);
  g_ev_tail = g_ev_head;
  g_ev_seq = 0;
  ReleaseSRWLockExclusive(&g_ev_mu);
  g_ev_has_last = false;
  g_ev_last = EventRecord{};
}

// 上一次真正推送出去的状态。放在这里而不是函数内，供变化检测比对。
struct PushedState {
  int px_w = -1;
  int px_h = -1;
  unsigned int dpi = 0;
  bool maxed = false;
  bool minned = false;
  bool focused = false;
  bool dark = false;
  ULONGLONG at = 0;
};
PushedState g_pushed;
bool g_push_pending = false;  // 有变化被节流掉了，等定时器补齐

const UINT_PTR kPushTimerId = 1;
const ULONGLONG kPushMinIntervalMs = 16;  // 约一帧

// 推送窗口状态（仅限 UI 线程调用）
// 尺寸对外统一用 96 DPI 逻辑像素（即页面 CSS px），另附物理像素与 dpi，
// 避免前端每次自行按 dpr 折算。
//
// 两道闸，因为 WM_SIZE 在拖动缩放时每帧都触发，而每次推送都是一次跨进程
// webview_eval（宿主侧 39µs，渲染器还要执行一段 JS）：
//   1) 变化检测：状态一模一样就不发。停下来之后不会再有 WM_SIZE，这里直接吸收掉。
//   2) 16ms 节流 + 尾随补齐：拖动过程中尺寸每帧都在变，靠第 1 道拦不住；
//      被节流掉时挂一个 16ms 定时器，到点补发最后一次状态，保证不会丢。
/**
 * 推送的强制级别。
 *
 * 分成三级而不是一个 bool，因为「跳过变化检测」与「跳过节流」是两个不同的意图，
 * 混成一个 `force` 会产生重复消息——尾随补齐（`flush_push_state`）本意只是
 * 「补上被节流掉的那次变化」，却因为复用了 force 而在状态其实没变时补发一条
 * 一模一样的消息。实测启动时页面连续收到两条 `maximized:false`，
 * 原因就是 `show_now()` 的强制推送与随后一次尾随补齐撞在一起。
 *
 * - `None`             常规调用（`WM_SIZE` / `WM_ACTIVATE` / …）：两道闸都过
 * - `BypassThrottle`   尾随补齐、首次显示：**只**跳过节流，仍做变化检测
 * - `BypassAll`        全屏切换 / 恢复矩形：强制发，不管变没变
 *
 * `BypassAll` 只留给「尺寸可能恰好相同、但状态确有外部变化」的场景。
 * 首次显示不属于这类：`ShowWindow` 会同步触发 `WM_SIZE`，那一次已经推过真实状态；
 * 在这里再用 BypassAll 只会推一条一模一样的消息（实测两条相隔 1 ms）。
 */
enum class PushMode { None, BypassThrottle, BypassAll };

void push_state(PushMode mode = PushMode::None) {
  if (!g_hwnd || !g_webview) {
    return;
  }
  const bool maxed = IsZoomed(g_hwnd) != FALSE;
  const bool minned = IsIconic(g_hwnd) != FALSE;
  const bool focused = GetForegroundWindow() == g_hwnd;
  RECT rc{};
  GetClientRect(g_hwnd, &rc);

  const int px_w = rc.right - rc.left;
  const int px_h = rc.bottom - rc.top;
  const UINT dpi = GetDpiForWindow(g_hwnd);
  const bool dark = system_uses_dark();

  // 只有 BypassAll 跳过变化检测。BypassThrottle 仍然要过这一关：
  // 「补发」的前提是确实有变化被节流掉了。
  const bool same = px_w == g_pushed.px_w && px_h == g_pushed.px_h &&
                    dpi == g_pushed.dpi && maxed == g_pushed.maxed &&
                    minned == g_pushed.minned && focused == g_pushed.focused &&
                    dark == g_pushed.dark;
  if (same && mode != PushMode::BypassAll) {
    return;
  }

  const ULONGLONG now = GetTickCount64();
  if (mode == PushMode::None && now - g_pushed.at < kPushMinIntervalMs) {
    if (!g_push_pending) {
      g_push_pending = true;
      SetTimer(g_hwnd, kPushTimerId, static_cast<UINT>(kPushMinIntervalMs), nullptr);
    }
    return;
  }

  if (g_push_pending) {
    g_push_pending = false;
    KillTimer(g_hwnd, kPushTimerId);
  }

  g_pushed = PushedState{px_w, px_h, dpi, maxed, minned, focused, dark, now};

  const int css_w = dpi ? MulDiv(px_w, 96, static_cast<int>(dpi)) : px_w;
  const int css_h = dpi ? MulDiv(px_h, 96, static_cast<int>(dpi)) : px_h;

  char buf[448];
  wsprintfA(buf,
            "{\"t\":\"win\",\"maximized\":%s,\"minimized\":%s,\"focused\":%s,"
            "\"width\":%d,\"height\":%d,\"pixelWidth\":%d,\"pixelHeight\":%d,"
            "\"dpi\":%u,\"frameless\":%s,\"dark\":%s}",
            maxed ? "true" : "false", minned ? "true" : "false",
            focused ? "true" : "false", css_w, css_h, px_w, px_h, dpi,
            g_frameless ? "true" : "false", dark ? "true" : "false");
  post_json(buf);
}

// 节流定时器到点：补上被节流掉的那一次变化。
//
// 只跳过节流，**不**跳过变化检测——后者由 `PushMode::BypassThrottle` 表达。
// 早先这里写的是 `push_state(true)`（当时 force 是个 bool，同时跳过两道闸），
// 于是状态其实没变时也会补发一条一模一样的消息：实测启动时页面连续收到
// 两条 `maximized:false`。
void flush_push_state() {
  if (!g_push_pending) {
    return;
  }
  g_push_pending = false;
  if (g_hwnd) {
    KillTimer(g_hwnd, kPushTimerId);
  }
  push_state(PushMode::BypassThrottle);
}

void apply_round_corners(HWND hwnd, bool round) {
  // DWMWA_WINDOW_CORNER_PREFERENCE = 33；DWMWCP_DONOTROUND = 1, DWMWCP_ROUND = 2
  // 带缓存：拖动缩放时 WM_SIZE 触发极频繁，没必要每次都调 DWM。
  const int key = round ? 1 : 0;
  if (g_round_state == key) {
    return;
  }
  const int pref = round ? 2 : 1;
  if (SUCCEEDED(DwmSetWindowAttribute(hwnd, 33, &pref, sizeof(pref)))) {
    g_round_state = key;
  }
}

// 首次显示。g_shown 必须先置位再 ShowWindow：
// 显示之后的 WM_DPICHANGED 才允许跟随系统建议矩形；同时也让 toplevel_proc 的
// WM_SHOWWINDOW 拦截放行（它只拦 g_shown 为假的显示请求）。
//
// 激活动作是必须的：带边框模式下原本由 webview 的 window_show() 负责 SetFocus，
// 现在我们接管了显示，不补这一步窗口出现时不会成为前台窗口（标题栏呈未激活灰态，
// 用起来像「卡住了」）。SetForegroundWindow 可能因本机策略失败，属尽力而为。
//
// ---- 为什么需要 force_visible() ----
//
// ShowWindow 的**第一次**调用会被启动方的 STARTUPINFO 覆盖：当父进程以
// `STARTF_USESHOWWINDOW` + `SW_HIDE` 创建我们时，Windows 用 STARTUPINFO 里的
// wShowWindow 代替我们传的 nCmdShow。于是这一次 `ShowWindow(SW_SHOW)` 变成
// 「隐藏」，窗口永远不可见。
//
// 这个缺陷极隐蔽：窗口确实被创建了，几何、命中测试、最大化、PrintWindow 截图
// 全部正常，只有 IsWindowVisible 为假。自检读的是 metrics，看不出差别；
// 门禁也照样全绿。2026-10-21 实测：`Start-Process -WindowStyle Hidden` 起的
// 进程永远 WS_VISIBLE=False，去掉该参数后 1 秒内变 True。
//
// 修法不能只写 `ShowWindow` 就完事——第二次调用才不再被覆盖。
void force_visible();

void show_now() {
  if (!g_hwnd) return;
  // 先置 g_shown：之后的 WM_DPICHANGED 才允许跟随建议矩形，
  // 也让 toplevel_proc 的 WM_SHOWWINDOW 拦截放行。
  g_shown = true;
  // 最大化也走这一次 ShowWindow：窗口从隐藏直接变成最大化，
  // 没有「先小窗再撑满」的中间帧。
  ShowWindow(g_hwnd, g_start_maximized ? SW_SHOWMAXIMIZED : SW_SHOW);
  force_visible();
  SetForegroundWindow(g_hwnd);
  SetFocus(g_hwnd);
  UpdateWindow(g_hwnd);
  fit_widget();
  // 用 BypassThrottle 而不是 BypassAll：`ShowWindow` 内部会**同步**触发
  // `WM_SIZE`，那一次已经走 `push_state(None)` 推过显示后的真实状态了。
  // 若这里再用 BypassAll（跳过变化检测），就会把同样的内容再推一遍——
  // 实测两条 `maximized:false` 的时间戳只差 1 ms，且字段完全相同。
  //
  // BypassThrottle 的语义正好：万一上面那次被 16 ms 节流吃掉了，
  // 这一发会补上；若已经推过，变化检测会拦住。
  push_state(PushMode::BypassThrottle);
  // 兜底再发一条**宿主**事件。上面那发推的是页面（shell-msg），事件环是另一条通道。
  //
  // 注意这不是首帧事件的**唯一**来源：带边框模式的 `WM_SIZE` / `WM_ACTIVATE` 经
  // `toplevel_proc` 已经会入队（`probe-window-events.ts` 摘掉本行仍然通过）。
  // 留着是为了覆盖「显示时既没有 WM_SIZE 也没有 WM_ACTIVATE」的窄窗口——事件侧有
  // `g_ev_last` 变化检测，重复调用会被吃掉，成本为零。
  emit_state_event();
}

// 兜住「第一次 ShowWindow 被 STARTUPINFO 覆盖」这一情形。
//
// 已经可见时是 no-op，所以可以在任何显示路径上无脑调用。
// 第二层兜底用 SWP_SHOWWINDOW：它不读 nCmdShow，因此不受 STARTUPINFO 影响。
// 两层都留是有意的——第二次 ShowWindow 在 Windows 文档里「不再被覆盖」，
// 但那依赖系统实现细节；SWP_SHOWWINDOW 是更直接的原语。
void force_visible() {
  if (!g_hwnd) return;
  if (IsWindowVisible(g_hwnd)) return;
  ShowWindow(g_hwnd, g_start_maximized ? SW_SHOWMAXIMIZED : SW_SHOW);
  if (IsWindowVisible(g_hwnd)) return;
  SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                   SWP_SHOWWINDOW);
}

// ---- 原生上下文菜单 ----
//
// 关掉 WebView2 的默认右键菜单之后，右键就成了「点了没反应」——那也不像原生应用。
// 原生桌面应用右键是有菜单的，只是菜单属于应用而非浏览器。
//
// 这里由页面定义菜单项，壳负责用 TrackPopupMenu 弹出系统菜单（真正的 Win32 菜单，
// 跟随系统主题、支持键盘导航、带阴影）。选中结果通过 shell-msg 推回页面：
//   { t: "menu", id: "<选中的 id>" }
//
// 菜单项格式（页面侧构造，壳只做切分，不做 JSON 解析）：
//   "open|打开题库\nrefresh|刷新\n-\nquit|退出"
//   每行 `id|label`，单独的 `-` 表示分隔线。

struct MenuItem {
  std::string id;
  std::wstring label;
  bool separator;
};

std::wstring widen_utf8(const std::string &s) {
  if (s.empty()) return std::wstring();
  const int need = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (need <= 1) return std::wstring();
  std::wstring out(static_cast<size_t>(need - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &out[0], need);
  return out;
}

// 解析菜单描述。空行忽略；`-` 是分隔线。
std::vector<MenuItem> parse_menu(const std::string &spec) {
  std::vector<MenuItem> out;
  size_t start = 0;
  while (start <= spec.size()) {
    const size_t nl = spec.find('\n', start);
    const std::string line =
        spec.substr(start, nl == std::string::npos ? std::string::npos : nl - start);
    if (!line.empty()) {
      if (line == "-") {
        out.push_back(MenuItem{"", L"", true});
      } else {
        const size_t bar = line.find('|');
        if (bar != std::string::npos && bar > 0 && bar + 1 < line.size()) {
          out.push_back(MenuItem{line.substr(0, bar), widen_utf8(line.substr(bar + 1)), false});
        }
      }
    }
    if (nl == std::string::npos) break;
    start = nl + 1;
  }
  return out;
}

// 弹出原生菜单并把选中项推回页面。仅 UI 线程调用。
//
// 为什么不在返回值里给结果：菜单是模态的，选中前拿不到结果；而跨线程同步返回
// 又要多一套等待机制。推回 shell-msg 与既有的消息通道同构，页面侧处理起来更自然。
void show_app_menu(HWND hwnd, POINT screen_pt, const std::string &spec) {
  const std::vector<MenuItem> items = parse_menu(spec);
  if (items.empty() || !hwnd) {
    return;
  }

  HMENU menu = CreatePopupMenu();
  if (!menu) {
    return;
  }

  // 菜单项 id 从 1 开始（0 在 TrackPopupMenu 里表示「没选」）
  std::vector<std::string> ids(items.size());
  int next_id = 1;
  for (size_t i = 0; i < items.size(); ++i) {
    const MenuItem &it = items[i];
    if (it.separator) {
      AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
      continue;
    }
    ids[static_cast<size_t>(next_id - 1)] = it.id;
    AppendMenuW(menu, MF_STRING, static_cast<UINT_PTR>(next_id), it.label.c_str());
    ++next_id;
  }

  SetForegroundWindow(hwnd);
  const UINT cmd = static_cast<UINT>(TrackPopupMenu(
      menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, screen_pt.x, screen_pt.y, 0, hwnd,
      nullptr));
  DestroyMenu(menu);

  // TPM_NONOTIFY 下必须补这一条，否则菜单关掉后窗口收不到激活，
  // 表现为「菜单没了但窗口半死」——点哪都不响应，直到 Alt+Tab 切走再回来。
  PostMessageW(hwnd, WM_NULL, 0, 0);

  if (cmd == 0 || cmd > ids.size()) {
    return;
  }
  const std::string &picked = ids[cmd - 1];
  if (picked.empty()) {
    return;
  }
  std::string json = "{\"t\":\"menu\",\"id\":\"";
  for (char ch : picked) {
    if (ch == '\\' || ch == '"') json.push_back('\\');
    json.push_back(ch);
  }
  json += "\"}";
  post_json(json);
}


// ---- 缩放 / 全屏 / 刷新 / 开发者工具 / 拖放 ----

// 缩放级别阶梯。与 Edge 的量级接近：小端更密，大端更疏，避免高倍率下 ±0.1 看不出变化。
const double kZoomLadder[] = {0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1.0,
                              1.1,  1.25, 1.5, 1.75, 2.0, 2.5, 3.0};
const int kZoomCount = static_cast<int>(sizeof(kZoomLadder) / sizeof(kZoomLadder[0]));
double g_zoom = 1.0;

// 注：`g_fullscreen` / `g_saved_style` / `g_saved_rect` 的声明已上移到
// caption button 常量旁边——`hit_test_client` 需要 g_fullscreen，而它在这里
// 出现得更早。C++ 名字查找按声明顺序，重复定义会直接编译失败。

// 取 CoreWebView2。调用方负责 Release()。失败返回 nullptr（老 runtime 或缺 COM 上下文）。
ICoreWebView2 *core_webview() {
  if (!g_webview) {
    return nullptr;
  }
  auto *ctrl = static_cast<ICoreWebView2Controller *>(
      webview_get_native_handle(g_webview, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
  if (!ctrl) {
    return nullptr;
  }
  ICoreWebView2 *core = nullptr;
  if (FAILED(ctrl->get_CoreWebView2(&core))) {
    return nullptr;
  }
  return core;
}

// 设页面缩放。必须在 UI 线程调用（WebView2 是 STA）。
void apply_zoom(double factor) {
  if (!g_webview) {
    return;
  }
  if (factor < kZoomLadder[0]) factor = kZoomLadder[0];
  if (factor > kZoomLadder[kZoomCount - 1]) factor = kZoomLadder[kZoomCount - 1];

  auto *ctrl = static_cast<ICoreWebView2Controller *>(
      webview_get_native_handle(g_webview, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
  if (!ctrl) {
    return;
  }
  if (SUCCEEDED(ctrl->put_ZoomFactor(factor))) {
    g_zoom = factor;
  }
}

// 往上/下走一档。direction > 0 放大。
void zoom_step(int direction) {
  int nearest = 0;
  for (int i = 0; i < kZoomCount; ++i) {
    if (g_zoom <= kZoomLadder[i] + 1e-9) {
      nearest = i;
      break;
    }
    nearest = i;
  }
  int next = nearest + (direction > 0 ? 1 : -1);
  if (next < 0) next = 0;
  if (next >= kZoomCount) next = kZoomCount - 1;
  apply_zoom(kZoomLadder[next]);
}

void reload_page() {
  ICoreWebView2 *core = core_webview();
  if (!core) {
    return;
  }
  core->Reload();
  core->Release();
}

void open_dev_tools() {
  ICoreWebView2 *core = core_webview();
  if (!core) {
    return;
  }
  core->OpenDevToolsWindow();
  core->Release();
}

// ---- 外部导航拦截 ----
//
// ## 为什么必须有这一层
//
// 默认设置下，页面里一个普通外链（`<a href="https://example.com">`）就能把**顶层
// 框架**导航走。而这是个桌面应用：没有地址栏、没有后退按钮、也没有宿主 API 能把
// 页面拉回来。用户点一下外链，应用就变成了那个网站，只能关窗重开。
//
// 这是默认值应该选安全一侧的典型场景，所以默认拦截；需要「应用本身就是浏览器」
// 时由调用方显式给 `SHELL_FLAG_ALLOW_EXTERNAL_NAV`。
//
// ## 两个入口，缺一不可
//
// `NavigationStarting` 管「当前框架被导航走」，`NewWindowRequested` 管
// `target=_blank` / `window.open` 弹新窗。后者如果不拦，WebView2 会真的开一个
// 没有我们任何配置的新窗口。
//
// ## 为什么只对 http/https 调 ShellExecute
//
// `ShellExecuteW(L"open", url)` 按协议名去找注册的处理程序。对任意 scheme 调用，
// 等于给了页面一个「触发任意协议处理器」的入口（`ms-*:`、自定义 scheme、甚至
// `file:`）。所以只放行 http/https，其它 scheme 一律**静默取消、不外开**。

// 取 `scheme://host[:port]` 并统一小写。非 http/https 或解析不出来时返回空串。
//
// 不用 UrlGetPart / CoInternetParseUrl 之类的现成解析器：它们要额外链接
// urlmon，而这里只需要「够用来比较同源」的判断。
static std::wstring url_origin(const std::wstring &url) {
  const size_t scheme_end = url.find(L"://");
  if (scheme_end == std::wstring::npos || scheme_end == 0) {
    return std::wstring();
  }
  std::wstring scheme = url.substr(0, scheme_end);
  for (auto &ch : scheme) {
    ch = static_cast<wchar_t>(towlower(ch));
  }
  if (scheme != L"http" && scheme != L"https") {
    return std::wstring();
  }
  const size_t host_start = scheme_end + 3;
  size_t host_end = url.find_first_of(L"/?#", host_start);
  if (host_end == std::wstring::npos) {
    host_end = url.size();
  }
  if (host_end == host_start) {
    return std::wstring();
  }
  std::wstring origin = scheme + L"://" + url.substr(host_start, host_end - host_start);
  for (auto &ch : origin) {
    ch = static_cast<wchar_t>(towlower(ch));
  }
  return origin;
}

// 取 URL 里 `#` 之前的部分。只有 fragment 变化的导航不算跨文档。
//
// 这个函数专门服务「启动地址没有 origin」的退化判据：`file:///C:/app/index.html#a`
// 与 `file:///C:/app/index.html#b` 是同一份文档，剥掉 `#` 后是同一个串。
static std::wstring strip_fragment(const std::wstring &url) {
  const size_t hash = url.find(L'#');
  return hash == std::wstring::npos ? url : url.substr(0, hash);
}

// 一条导航该不该留在应用内。
enum class NavVerdict {
  Allow,     // 留在当前 webview 里导航
  External,  // 取消本次导航，改交系统浏览器（非 http/https 时连外开也不做）
};

// 导航裁决——整个外部导航拦截的唯一判据。
//
// 两种形态，取决于启动地址有没有 origin：
//
//   g_origin 非空（http/https 应用）→ 判「同源」。页面内路由、同源跳转都留在应用内，
//     跨源一律外开。这是绝大多数场景。
//
//   g_origin 为空（`file://`、`about:blank`、自定义 scheme）→ 判「同文档」：比较
//     去掉 `#fragment` 之后是否与启动地址逐字相同。UI 常在 `file://` 上跑，
//     此时若不拦，一个 https 外链就能把应用带走；而若拦得太狠，页面自己的
//     `#/route` 跳转又会被踢出去。剥 fragment 正好卡在两者之间。
//
// 历史：这里原本只判同源，且「g_origin 为空 → 一律放行」。那等于给 `file://`
// 应用开了个后门——恰恰是桌面应用最常见的形态。改成两条形态各判各的之后，
// 「解析失败」不再等于「不设防」。
static NavVerdict classify_nav(const std::wstring &url) {
  if (!g_origin.empty()) {
    return url_origin(url) == g_origin ? NavVerdict::Allow : NavVerdict::External;
  }
  if (!g_app_doc.empty() && strip_fragment(url) == g_app_doc) {
    return NavVerdict::Allow;
  }
  return NavVerdict::External;
}

// 交给系统默认浏览器。只放行 http/https，理由见本节开头。
static void open_external(const std::wstring &url) {
  if (url_origin(url).empty()) {
    return;
  }
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// COM 事件处理器的公共部分。WebView2 在 UI 线程同步调用 Invoke，所以这里
// 不需要额外同步；引用计数只用 atomic 保证 Release 不撕裂。
class NavEventBase {
 public:
  virtual ~NavEventBase() = default;
  ULONG add_ref() { return ++m_refs; }
  ULONG release() {
    const ULONG left = --m_refs;
    if (left == 0) {
      delete this;
    }
    return left;
  }

 protected:
  HRESULT query_unknown(REFIID riid, void **out, REFIID self_iid, void *self) {
    if (!out) {
      return E_POINTER;
    }
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, self_iid)) {
      *out = self;
      add_ref();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }

 private:
  std::atomic<ULONG> m_refs{1};
};

// 当前框架被导航走时触发：判定为外部就取消导航，改交系统浏览器。
//
// 继承顺序把 `NavEventBase` 放在前面（引用计数与 QueryInterface 的公共实现），
// COM 接口放在后面。注意 `QueryInterface` 回填的必须是**接口子对象的地址**：
// 多重继承下 `this` 指向 NavEventBase 子对象，与 vtable 起点不同，必须先
// `static_cast` 到接口类型再交出去，否则调用方拿到的是错位的指针。
class NavigationGuard : public NavEventBase,
                        public ICoreWebView2NavigationStartingEventHandler {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
    return query_unknown(riid, out, IID_ICoreWebView2NavigationStartingEventHandler,
                         static_cast<ICoreWebView2NavigationStartingEventHandler *>(this));
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return add_ref(); }
  ULONG STDMETHODCALLTYPE Release() override { return release(); }

  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 * /*sender*/,
                                   ICoreWebView2NavigationStartingEventArgs *args) override {
    if (!args) {
      return S_OK;
    }
    LPWSTR raw = nullptr;
    if (FAILED(args->get_Uri(&raw)) || !raw) {
      // 拿不到 URI 就不拦：拦错的代价（应用白屏）比放过的代价更高
      return S_OK;
    }
    const std::wstring uri(raw);
    CoTaskMemFree(raw);

    if (classify_nav(uri) == NavVerdict::Allow) {
      return S_OK;
    }
    args->put_Cancel(TRUE);
    open_external(uri);
    return S_OK;
  }
};

// target=_blank / window.open 时触发：取消新窗口，改交系统浏览器。
class NewWindowGuard : public NavEventBase,
                       public ICoreWebView2NewWindowRequestedEventHandler {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
    return query_unknown(riid, out, IID_ICoreWebView2NewWindowRequestedEventHandler,
                         static_cast<ICoreWebView2NewWindowRequestedEventHandler *>(this));
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return add_ref(); }
  ULONG STDMETHODCALLTYPE Release() override { return release(); }

  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 * /*sender*/,
                                   ICoreWebView2NewWindowRequestedEventArgs *args) override {
    if (!args) {
      return S_OK;
    }
    LPWSTR raw = nullptr;
    if (FAILED(args->get_Uri(&raw)) || !raw) {
      // 拿不到 URI 时仍然标记 Handled：否则 WebView2 会开一个我们完全没配置的新窗口
      args->put_Handled(TRUE);
      return S_OK;
    }
    const std::wstring uri(raw);
    CoTaskMemFree(raw);

    args->put_Handled(TRUE);
    // 同源的新窗口请求（比如页面里 `window.open('/detail')`）也不在应用内开：
    // 这个壳只支持一个顶层窗口（原生层是进程级单例），开出来也没人能管它。
    open_external(uri);
    return S_OK;
  }
};

// 注册两个守卫。必须在 navigate 之前调用——否则首次导航不会被拦。
//
// 两个守卫的门槛不同，这里刻意不合并成一个条件：
//
//   NavigationGuard — 受 `g_allow_external_nav` 控制。这个 flag 的语义是
//     「本应用就是个浏览器，别管我导航到哪」，跳过它是本意。
//
//   NewWindowGuard — **无条件安装**，哪怕给了 `g_allow_external_nav`。
//     拦住 `window.open` 不是安全策略，是能力边界：这个壳只支持一个顶层窗口
//     （原生层是进程级单例，g_webview 只有一份），开出来的新窗口没有任何宿主
//     API 能管它——关不掉、读不到、也收不到 shell-msg。放它出去等于制造
//     一个没人负责的窗口。
//
// 另外注意这里**不再**因为 `g_origin` 为空就整体跳过：`file://` 应用恰恰是
// 外部导航劫持最常见的形态，判据退化在 classify_nav 里处理，而不是靠「不装守卫」。
void install_nav_guard() {
  ICoreWebView2 *core = core_webview();
  if (!core) {
    return;
  }

  if (!g_allow_external_nav && !g_nav_guard) {
    auto *guard = new NavigationGuard();
    if (SUCCEEDED(core->add_NavigationStarting(guard, &g_nav_token))) {
      g_nav_guard = guard;  // 我们持有一份引用，teardown 时 remove + Release
    } else {
      guard->Release();
    }
  }
  if (!g_new_window_guard) {
    auto *guard = new NewWindowGuard();
    if (SUCCEEDED(core->add_NewWindowRequested(guard, &g_new_window_token))) {
      g_new_window_guard = guard;
    } else {
      guard->Release();
    }
  }

  core->Release();
}

// 反注册并释放。必须在 webview_destroy **之前**调用：destroy 之后
// core_webview() 已经拿不到 core，remove_ 就无从谈起了。
void uninstall_nav_guard() {
  ICoreWebView2 *core = core_webview();
  if (core) {
    if (g_nav_guard) {
      core->remove_NavigationStarting(g_nav_token);
    }
    if (g_new_window_guard) {
      core->remove_NewWindowRequested(g_new_window_token);
    }
    core->Release();
  }
  if (g_nav_guard) {
    g_nav_guard->Release();
    g_nav_guard = nullptr;
  }
  if (g_new_window_guard) {
    g_new_window_guard->Release();
    g_new_window_guard = nullptr;
  }
}

// F11 全屏：去掉窗口样式钉到当前显示器整屏，再按一次还原。
// 与「最大化」不同——最大化仍保留边框与任务栏，全屏两者都不要。
void toggle_fullscreen() {
  if (!g_hwnd) {
    return;
  }
  HWND hwnd = g_hwnd;

  if (!g_fullscreen) {
    GetWindowRect(hwnd, &g_saved_rect);
    g_saved_style = GetWindowLongPtrW(hwnd, GWL_STYLE);

    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
      return;
    }
    const int w = mi.rcMonitor.right - mi.rcMonitor.left;
    const int h = mi.rcMonitor.bottom - mi.rcMonitor.top;

    // 无边框模式本来就是 WS_POPUP 风格，只需铺满；带边框模式要去掉整个非客户区。
    SetWindowLongPtrW(hwnd, GWL_STYLE, WS_POPUP | WS_VISIBLE);
    SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top, w, h,
                 SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
    g_fullscreen = true;
  } else {
    SetWindowLongPtrW(hwnd, GWL_STYLE, g_saved_style);
    SetWindowPos(hwnd, nullptr, g_saved_rect.left, g_saved_rect.top,
                 g_saved_rect.right - g_saved_rect.left,
                 g_saved_rect.bottom - g_saved_rect.top,
                 SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOOWNERZORDER);
    g_fullscreen = false;
  }
  fit_widget();
  push_state(PushMode::BypassAll);
}

// 把宽字符串转成 UTF-8 并写进 JSON 字符串字面量（转义 \ 与 "）。
void append_json_string(std::string &out, const std::wstring &w) {
  out.push_back('"');
  const int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (need > 1) {
    std::string utf8(static_cast<size_t>(need - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, &utf8[0], need, nullptr, nullptr);
    for (char ch : utf8) {
      if (ch == '\\' || ch == '"') {
        out.push_back('\\');
      }
      out.push_back(ch);
    }
  }
  out.push_back('"');
}

// ---- 拖放：从 DOM drop 里取真实路径（AdditionalObjects）----
//
// ## 为什么不是 `AllowExternalDrop(FALSE)`
//
// `0.5.0` 曾用 `ICoreWebView2Controller4::put_AllowExternalDrop(FALSE)`，假设
// 「关掉 WebView2 的 drop target，OLE 链会继续往父窗口找，落到 `DragAcceptFiles`
// 上」。**这个假设是错的**，实测两条：
//
//   1. `AllowExternalDrop` 的语义是「**禁止**外部拖放」，不是「让给父窗口」。
//      关掉之后用户拖文件进来看到的是红色拒绝图标。
//   2. `DragAcceptFiles` 只设 `WS_EX_ACCEPTFILES`，**不注册** `IDropTarget`
//      （查 `OleDropTargetInterface` property：整条窗口链全为 false）。
//      现代 Windows 的 OLE 命中测试不会 fallback 到那条 legacy 路径。
//
// ## 现在的路
//
// 恢复 WebView2 的默认行为（它接管拖放、转成 DOM 事件），然后从 DOM drop 的
// `DataTransfer.files` 里取真实路径——这是微软专门为这个场景提供的上游接口：
//
//   页面 drop  → chrome.webview.postMessage({ files: [...] })
//             → ICoreWebView2WebMessageReceivedEventArgs2::get_AdditionalObjects
//             → 每项 QueryInterface 到 ICoreWebView2File，get_Path 拿绝对路径
//
// 页面侧那一行由 `kInit` 注入（见 ui_thread），所以**页面不需要写任何代码**。
//
// ## 为什么保留 `WM_DROPFILES` 那条老路
//
// 它是兜底：老 runtime 没有 `AdditionalObjects` 时，至少 `DragAcceptFiles` 还在，
// 某些场景（比如未来 WebView2 行为变化）也可能重新用上。两条路互不干扰——
// 只是同一时刻通常只有一条会触发。
//
// ## 与「不造轮子」的关系
//
// 不自己写 `IDropTarget`：那要解析 `IDataObject` 的 `CF_HDROP`，还要与 WebView2
// 的命中测试打架。`AdditionalObjects` 是上游的等价能力，且路径由 WebView2 给出，
// 不依赖我们自己猜文件系统。

// 事件处理器：从 WebMessageReceived 里挑出「带 File 对象」的那些。
//
// 不解析 JSON，也不看消息内容——直接问 `AdditionalObjects` 里有没有文件。
// 这样页面自己的 `postMessage`（如果有）不会被误伤：它们没有 File，集合为空。
class DropMessageHandler final : public ICoreWebView2WebMessageReceivedEventHandler {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
    if (!out) {
      return E_POINTER;
    }
    if (IsEqualIID(riid, IID_IUnknown) ||
        IsEqualIID(riid, IID_ICoreWebView2WebMessageReceivedEventHandler)) {
      *out = static_cast<ICoreWebView2WebMessageReceivedEventHandler *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++m_refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG left = --m_refs;
    if (left == 0) {
      delete this;
    }
    return left;
  }

  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2 * /*sender*/,
                                   ICoreWebView2WebMessageReceivedEventArgs *args) override {
    if (!args) {
      return S_OK;
    }
    // 老 runtime 上没有 EventArgs2：静默放过，不影响其它消息
    ICoreWebView2WebMessageReceivedEventArgs2 *args2 = nullptr;
    if (FAILED(args->QueryInterface(IID_ICoreWebView2WebMessageReceivedEventArgs2,
                                    reinterpret_cast<void **>(&args2))) ||
        !args2) {
      return S_OK;
    }

    ICoreWebView2ObjectCollectionView *objects = nullptr;
    if (SUCCEEDED(args2->get_AdditionalObjects(&objects)) && objects) {
      UINT count = 0;
      if (SUCCEEDED(objects->get_Count(&count)) && count > 0) {
        std::string paths;
        std::string dirs;
        bool anyPath = false;
        bool anyDir = false;
        // 已收路径（去重用）。数量是个位到几十，线性查比建哈希表划算。
        std::vector<std::wstring> seen;
        // 诊断计数。**无论成功与否都要回报**——「取不到路径就什么都不发」是这一族
        // 故障里最贵的一个：页面在等，宿主沉默，两边都没有线索（pitfalls 2.16）。
        UINT nFile = 0;
        UINT nHandle = 0;
        UINT nNoPath = 0;
        for (UINT i = 0; i < count; ++i) {
          IUnknown *item = nullptr;
          if (FAILED(objects->GetValueAtIndex(i, &item)) || !item) {
            ++nNoPath;
            continue;
          }

          // 两条路，缺一条就有一类对象拿不到路径：
          //
          //   `ICoreWebView2File`             —— `dataTransfer.files` 里的 File
          //   `ICoreWebView2FileSystemHandle` —— `getAsFileSystemHandle()` 的产物
          //
          // **目录只能从第二条来**（`FileSystemDirectoryHandle`），而它没有
          // `ICoreWebView2File`；反过来普通文件两条都可能命中，先试 File 更省。
          // `get_Kind` 是唯一可靠的「这是不是目录」判据——`File` 的 `size === 0`
          // 区分不了空文件与目录。
          LPWSTR raw = nullptr;
          bool isDir = false;
          ICoreWebView2File *file = nullptr;
          if (SUCCEEDED(item->QueryInterface(IID_ICoreWebView2File,
                                             reinterpret_cast<void **>(&file))) &&
              file) {
            ++nFile;
            if (FAILED(file->get_Path(&raw))) {
              raw = nullptr;
            }
            file->Release();
          } else {
            ICoreWebView2FileSystemHandle *handle = nullptr;
            if (SUCCEEDED(item->QueryInterface(
                    IID_ICoreWebView2FileSystemHandle,
                    reinterpret_cast<void **>(&handle))) &&
                handle) {
              ++nHandle;
              COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND kind =
                  COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_FILE;
              if (SUCCEEDED(handle->get_Kind(&kind))) {
                isDir = kind == COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_DIRECTORY;
              }
              if (FAILED(handle->get_Path(&raw))) {
                raw = nullptr;
              }
              handle->Release();
            }
          }
          item->Release();

          if (!raw) {
            ++nNoPath;
            continue;
          }
          const std::wstring path(raw);
          CoTaskMemFree(raw);

          // 去重：注入脚本把 handles 与 files 一起传，同一个载体可能给两条相同路径。
          bool dup = false;
          for (size_t d = 0; d < seen.size(); ++d) {
            if (seen[d] == path) {
              dup = true;
              break;
            }
          }
          if (dup) {
            continue;
          }
          seen.push_back(path);

          // `get_Kind` 只对 `ICoreWebView2FileSystemHandle` 有效。实测（2026-10-21）
          // 目录的 handle 到宿主时是 null（集合里数得出 1 项，但两个 QI 都不成立），
          // 于是目录只能以 `dataTransfer.files` 里的 File 身份到达——那条路没有
          // kind。所以文件系统属性是**必须**的第二个判据，不是冗余。
          if (!isDir) {
            const DWORD attrs = GetFileAttributesW(path.c_str());
            if (attrs != INVALID_FILE_ATTRIBUTES &&
                (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) {
              isDir = true;
            }
          }

          if (anyPath) {
            paths.push_back(',');
          }
          append_json_string(paths, path);
          anyPath = true;

          if (isDir) {
            if (anyDir) {
              dirs.push_back(',');
            }
            append_json_string(dirs, path);
            anyDir = true;
          }
        }
        objects->Release();
        // 一次投递要么给出路径，要么给出**为什么没有**。`ok`/`err` 就是那个交代：
        // 页面与探针都靠它判断断在哪一环，而不是盯着空数组猜。
        std::string json = "{\"t\":\"drop\",\"paths\":[";
        json += paths;
        json += "],\"dirs\":[";
        json += dirs;
        json += "],\"nFile\":";
        json += std::to_string(nFile);
        json += ",\"nHandle\":";
        json += std::to_string(nHandle);
        json += ",\"nNoPath\":";
        json += std::to_string(nNoPath);
        json += ",\"ok\":";
        json += anyPath ? "true" : "false";
        if (!anyPath) {
          json += ",\"err\":\"additional objects carried no usable path\"";
        }
        json += "}";
        post_json(json);
      } else {
        objects->Release();
        post_json("{\"t\":\"drop\",\"paths\":[],\"dirs\":[],\"ok\":false,"
                  "\"err\":\"AdditionalObjects is empty\"}");
      }
    }
    args2->Release();
    return S_OK;
  }

 private:
  std::atomic<ULONG> m_refs{1};
};

void install_drop_handler() {
  if (g_drop_handler || !g_webview) {
    return;
  }
  ICoreWebView2 *core = core_webview();
  if (!core) {
    return;
  }
  auto *handler = new DropMessageHandler();
  if (SUCCEEDED(core->add_WebMessageReceived(handler, &g_drop_token))) {
    g_drop_handler = handler;
  } else {
    handler->Release();
  }
  core->Release();
}

void uninstall_drop_handler() {
  if (!g_drop_handler) {
    return;
  }
  ICoreWebView2 *core = core_webview();
  if (core) {
    core->remove_WebMessageReceived(g_drop_token);
    core->Release();
  }
  g_drop_handler->Release();
  g_drop_handler = nullptr;
  g_drop_token = EventRegistrationToken{};
}

// 拖放：`DragAcceptFiles` 那条老路（兜底）。主路见上面的 `DropMessageHandler`。
//
// 注意提权场景：本进程若是 High 完整性，资源管理器（Medium）
// 发来的 WM_DROPFILES 会被 UIPI 拦掉。所以窗口建好后要显式放行这三条消息，
// 否则「拖进来没反应」且完全没有错误提示。
void enable_drop(HWND hwnd) {
  if (!hwnd) {
    return;
  }
  DragAcceptFiles(hwnd, TRUE);
  ChangeWindowMessageFilterEx(hwnd, WM_DROPFILES, MSGFLT_ALLOW, nullptr);
  ChangeWindowMessageFilterEx(hwnd, WM_COPYDATA, MSGFLT_ALLOW, nullptr);
  // 0x0049 = WM_COPYGLOBALDATA，Win7 起改名后未再公开常量
  ChangeWindowMessageFilterEx(hwnd, 0x0049, MSGFLT_ALLOW, nullptr);
  // 主路：订阅 DOM drop 转出来的 WebMessage
  install_drop_handler();
}

void handle_drop(HDROP hd) {
  if (!hd) {
    return;
  }
  const UINT count = DragQueryFileW(hd, 0xFFFFFFFF, nullptr, 0);
  std::string paths;
  std::string dirs;
  bool anyPath = false;
  bool anyDir = false;
  for (UINT i = 0; i < count; ++i) {
    const UINT len = DragQueryFileW(hd, i, nullptr, 0);
    if (len == 0) {
      continue;
    }
    std::wstring path(static_cast<size_t>(len) + 1, L'\0');
    if (DragQueryFileW(hd, i, &path[0], len + 1) == 0) {
      continue;
    }
    path.resize(len);

    if (anyPath) {
      paths.push_back(',');
    }
    append_json_string(paths, path);
    anyPath = true;

    // 兜底路径要靠文件系统属性判目录：`WM_DROPFILES` 只给路径，没有 kind。
    // 主路（`AdditionalObjects`）用的是 `get_Kind`，两者判据不同但**输出形状必须
    // 一致**——否则同一个 `shell-msg` 会因命中哪条路而字段不同，消费者没法写。
    const DWORD attrs = GetFileAttributesW(path.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      if (anyDir) {
        dirs.push_back(',');
      }
      append_json_string(dirs, path);
      anyDir = true;
    }
  }
  DragFinish(hd);
  if (!anyPath) {
    return;
  }
  std::string json = "{\"t\":\"drop\",\"paths\":[";
  json += paths;
  json += "],\"dirs\":[";
  json += dirs;
  json += "]}";
  post_json(json);
}

// ---- 键盘快捷键：订阅 WebView2 的 AcceleratorKeyPressed ----
//
// 为什么不能只靠 WM_KEYDOWN：WM_KEYDOWN 只投递给**焦点窗口**，而焦点在 WebView2
// 的渲染子窗口（`Chrome_RenderWidgetHostHWND`）上。它不把未处理的按键转发给父窗口，
// 于是挂在 shell_wnd_proc / toplevel_proc 上的键盘处理对真实按键永远不触发。
// 实测：直接 PostMessage(hwnd, WM_KEYDOWN, VK_F11) 能正常全屏、再发一次能还原，
// 真实按 F11 毫无反应——判定逻辑完全正确，断的是消息路由。
// WM_MOUSEWHEEL 之所以没事，是因为它会被焦点窗口的 DefWindowProc 转给父窗口。
//
// 上游早有现成接口：ICoreWebView2Controller::add_AcceleratorKeyPressed。它在按键
// 送进页面**之前**回调，不依赖焦点窗口的消息链。本仓 vendor 的 SDK 1.0.4258.31
// 里早有（`WebView2.h` 里 `add_AcceleratorKeyPressed` 与两个 IID 都是 selectany）。

// 快捷键语义的**唯一**判定处。
//
// AcceleratorKeyPressed 与 WM_KEYDOWN 两条路共用它。分两份写必然漂移：
// 改一处忘一处，然后就变成「只有某种窗口模式命中」。
bool handle_accelerator_key(UINT vkey, bool ctrl) {
  switch (vkey) {
  case VK_F11:
    toggle_fullscreen();
    return true;
  case VK_F12:
    open_dev_tools();
    return true;
  case VK_F5:
    reload_page();
    return true;
  case 'R':
    if (ctrl) {
      reload_page();
      return true;
    }
    break;
  case VK_OEM_PLUS:  // 主键盘 =/+（Shift 不改变虚拟键码）
  case VK_ADD:       // 小键盘 +
    if (ctrl) {
      zoom_step(+1);
      return true;
    }
    break;
  case VK_OEM_MINUS:
  case VK_SUBTRACT:
    if (ctrl) {
      zoom_step(-1);
      return true;
    }
    break;
  case '0':
  case VK_NUMPAD0:
    if (ctrl) {
      apply_zoom(1.0);
      return true;
    }
    break;
  default:
    break;
  }
  return false;
}

// 事件处理器。只认按下：KEY_UP 再来一遍会让 F11 的全屏 toggle 走两次，
// 表现恰好是「按了没反应」——一个很容易被当成「没装上」的假象。
class AcceleratorKeyHandler final : public ICoreWebView2AcceleratorKeyPressedEventHandler {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
    if (!out) {
      return E_POINTER;
    }
    if (IsEqualIID(riid, IID_IUnknown) ||
        IsEqualIID(riid, IID_ICoreWebView2AcceleratorKeyPressedEventHandler)) {
      *out = static_cast<ICoreWebView2AcceleratorKeyPressedEventHandler *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++m_refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG left = --m_refs;
    if (left == 0) {
      delete this;
    }
    return left;
  }

  HRESULT STDMETHODCALLTYPE Invoke(
      ICoreWebView2Controller * /*sender*/,
      ICoreWebView2AcceleratorKeyPressedEventArgs *args) override {
    if (!args) {
      return S_OK;
    }
    COREWEBVIEW2_KEY_EVENT_KIND kind{};
    if (FAILED(args->get_KeyEventKind(&kind))) {
      return S_OK;
    }
    if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN &&
        kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) {
      return S_OK;
    }
    UINT vkey = 0;
    if (FAILED(args->get_VirtualKey(&vkey))) {
      return S_OK;
    }
    // 事件参数里没有 Ctrl 位，只有 PhysicalKeyStatus；修饰键状态从 GetKeyState 读，
    // 在 accelerator 回调里它仍然反映真实的按键状态。
    const bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    if (handle_accelerator_key(vkey, ctrl)) {
      // 处理过的要吃掉，否则页面同时也会收到这个按键
      args->put_Handled(TRUE);
    }
    return S_OK;
  }

 private:
  std::atomic<ULONG> m_refs{1};
};

// 必须在 webview_run **之前**订阅：消息循环一旦起来，键盘就已经可能落在页面上。
void install_accelerator_handler() {
  if (g_accel_handler || !g_webview) {
    return;
  }
  auto *ctrl = static_cast<ICoreWebView2Controller *>(
      webview_get_native_handle(g_webview, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
  if (!ctrl) {
    return;
  }
  auto *handler = new AcceleratorKeyHandler();
  if (SUCCEEDED(ctrl->add_AcceleratorKeyPressed(handler, &g_accel_token))) {
    g_accel_handler = handler;  // 我们持一份引用，teardown 时 remove + Release
  } else {
    handler->Release();
  }
}

// 反注册。必须在 webview_destroy **之前**：destroy 之后拿不到 controller。
void uninstall_accelerator_handler() {
  if (!g_accel_handler) {
    return;
  }
  auto *ctrl = g_webview ? static_cast<ICoreWebView2Controller *>(
                               webview_get_native_handle(
                                   g_webview, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER))
                         : nullptr;
  if (ctrl) {
    ctrl->remove_AcceleratorKeyPressed(g_accel_token);
  }
  g_accel_handler->Release();
  g_accel_handler = nullptr;
  g_accel_token = EventRegistrationToken{};
}

// 键盘 / 滚轮 / 拖放的共用前置处理。两种窗口模式都要，抽出来避免两份漂移。
// 返回 true 表示已处理并回填 *out。
bool handle_input_message(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, LRESULT *out) {
  switch (msg) {
  case WM_KEYDOWN: {
    const bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    // 判定与 AcceleratorKeyPressed 共用同一份实现（handle_accelerator_key）：
    // 真实按键走那条路，这条只覆盖「焦点确实落在自有窗口上」的残余场景。
    if (handle_accelerator_key(static_cast<UINT>(wp), ctrl)) {
      *out = 0;
      return true;
    }
    break;
  }

  case WM_MOUSEWHEEL: {
    if ((GET_KEYSTATE_WPARAM(wp) & MK_CONTROL) != 0) {
      const short delta = GET_WHEEL_DELTA_WPARAM(wp);
      zoom_step(delta > 0 ? +1 : -1);
      *out = 0;
      return true;
    }
    break;
  }

  case WM_DROPFILES:
    handle_drop(reinterpret_cast<HDROP>(wp));
    *out = 0;
    return true;

  default:
    break;
  }
  return false;
}

// setMinSize 的入参是逻辑像素（96 DPI），而系统的 track size 要物理像素。
// WM_GETMINMAXINFO 与居中夹取都要这个换算，抽出来避免两处口径分叉
// （此前直接在 native 侧按物理像素用，高 DPI 下最小尺寸只有预期的六成）。
void min_track_size(HWND hwnd, int *out_w, int *out_h) {
  const UINT dpi = hwnd ? GetDpiForWindow(hwnd) : 96;
  RECT rc{0, 0, MulDiv(g_min_w, static_cast<int>(dpi), 96),
          MulDiv(g_min_h, static_cast<int>(dpi), 96)};
  AdjustWindowRectExForDpi(&rc, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
  if (out_w) *out_w = rc.right - rc.left;
  if (out_h) *out_h = rc.bottom - rc.top;
}

// 把窗口居中到它所在显示器的工作区。两种窗口模式（自有窗口 / webview 自建窗口）共用。
//
// 三处容易写错的地方：
//   1) 必须用 rcWork 而不是 rcMonitor——整屏居中会让窗口压到任务栏下面。
//   2) 窗口比工作区大时必须先收缩再居中。高 DPI 下这很常见（900x940 逻辑像素在 200%
//      就是 1800x1880，加边框 1950 > 工作区 1824）。不收缩的话居中算出的 y 为负，
//      夹取后窗口贴顶，看起来「没有垂直居中」；收缩后才是真正的居中。
//   3) 收缩不得低于 setMinSize 给的下限。
void center_on_work_area(HWND hwnd) {
  if (!hwnd) {
    return;
  }
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (!GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
    return;
  }

  RECT rc{};
  if (!GetWindowRect(hwnd, &rc)) {
    return;
  }
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  const int work_w = mi.rcWork.right - mi.rcWork.left;
  const int work_h = mi.rcWork.bottom - mi.rcWork.top;

  // 先收缩到工作区内，但不下探到最小尺寸以下
  if (w > work_w || h > work_h) {
    int min_w = 0;
    int min_h = 0;
    min_track_size(hwnd, &min_w, &min_h);
    const int max_w = work_w > min_w ? work_w : min_w;
    const int max_h = work_h > min_h ? work_h : min_h;
    const int fit_w = w > max_w ? max_w : w;
    const int fit_h = h > max_h ? max_h : h;
    if (fit_w != w || fit_h != h) {
      SetWindowPos(hwnd, nullptr, 0, 0, fit_w, fit_h,
                   SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
      w = fit_w;
      h = fit_h;
    }
  }

  int x = mi.rcWork.left + (work_w - w) / 2;
  int y = mi.rcWork.top + (work_h - h) / 2;

  if (x + w > mi.rcWork.right) x = mi.rcWork.right - w;
  if (y + h > mi.rcWork.bottom) y = mi.rcWork.bottom - h;
  if (x < mi.rcWork.left) x = mi.rcWork.left;
  if (y < mi.rcWork.top) y = mi.rcWork.top;

  SetWindowPos(hwnd, nullptr, x, y, 0, 0,
               SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

// ---- 窗口位置与尺寸的保存/恢复 ----

// 读取当前窗口矩形，写成 "x,y,w,h,max,dpi"。
//
// 最大化时必须取「还原后」的矩形（WINDOWPLACEMENT.rcNormalPosition）：
// 直接 GetWindowRect 拿到的是整屏尺寸，下次启动就会先铺满再最大化，
// 用户点「还原」时看到的仍是全屏——这是同类实现最常见的错。
//
// **最小化时同理，而且更隐蔽**：`IsZoomed` 在最小化时返回 false，早先的写法于是
// 落进 `GetWindowRect` 分支，拿到 Win32 的哨兵坐标（实测 `-32000,-32000` 加图标尺寸，
// 典型 `314x50`）。这对值形状完全合法——整数坐标、正尺寸——下游只判「尺寸 ≤ 0」的
// 形状校验拦不住，会把它当真实位置存进 `window.json`，下次启动恢复成一个畸形小窗。
// 实测现场：无边框窗口变成 666×471，页面被挤到换行并出现滚动条。
//
// 所以判据不是「是否最大化」而是「是否处于有意义的显示状态」：只要最小化或最大化，
// 就用 `rcNormalPosition`（它天然是「还原后该用的矩形」）。
int format_bounds(char *buf, int cap) {
  if (!buf || cap <= 0) return 0;
  buf[0] = 0;
  if (!g_hwnd) return 0;

  WINDOWPLACEMENT wp{};
  wp.length = sizeof(wp);
  const bool haveWp = GetWindowPlacement(g_hwnd, &wp) != 0;
  const bool minned = IsIconic(g_hwnd) != 0;

  // 最大化位：最小化时 `IsZoomed` 恒为 false，得从 `wp.flags` 取
  // 「还原后会不会变成最大化」——否则「最大化 → 最小化 → 关窗」这条路径
  // 会把状态记成「未最大化」，下次启动就丢了最大化。
  bool maxed = IsZoomed(g_hwnd) != 0;
  if (minned && haveWp && (wp.flags & WPF_RESTORETOMAXIMIZED) != 0) {
    maxed = true;
  }

  RECT rc{};
  if ((maxed || minned) && haveWp) {
    rc = wp.rcNormalPosition;
  } else if (!GetWindowRect(g_hwnd, &rc)) {
    return 0;
  }

  const UINT dpi = GetDpiForWindow(g_hwnd);
  char tmp[128];
  // 只用整数格式：wsprintfA 不吃 %f（见 pitfalls 2.4d）
  wsprintfA(tmp, "%d,%d,%d,%d,%d,%u", static_cast<int>(rc.left),
            static_cast<int>(rc.top), static_cast<int>(rc.right - rc.left),
            static_cast<int>(rc.bottom - rc.top), maxed ? 1 : 0, dpi);
  const int n = lstrlenA(tmp);
  if (n >= cap) return 0;
  lstrcpyA(buf, tmp);
  return n;
}

long long intersect_area(const RECT &a, const RECT &b) {
  const int l = a.left > b.left ? a.left : b.left;
  const int t = a.top > b.top ? a.top : b.top;
  const int r = a.right < b.right ? a.right : b.right;
  const int bo = a.bottom < b.bottom ? a.bottom : b.bottom;
  if (r <= l || bo <= t) return 0;
  return static_cast<long long>(r - l) * (bo - t);
}

// 找出与目标矩形交叠最多的那块显示器工作区。
struct MonitorPick {
  HMONITOR mon = nullptr;
  long long area = 0;
  RECT work{};
};

struct PickCtx {
  const RECT *want;
  MonitorPick *out;
};

BOOL CALLBACK pick_monitor_proc(HMONITOR mon, HDC, LPRECT, LPARAM lp) {
  auto *ctx = reinterpret_cast<PickCtx *>(lp);
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (GetMonitorInfoW(mon, &mi)) {
    const long long a = intersect_area(*ctx->want, mi.rcWork);
    if (a > ctx->out->area) {
      ctx->out->area = a;
      ctx->out->mon = mon;
      ctx->out->work = mi.rcWork;
    }
  }
  return TRUE;
}

// 把保存的矩形恢复到窗口上。
//
// 跨会话恢复有三种失败方式，每个都要处理，否则表现为「窗口不知道跑哪去了」：
//   1) 缩放比例变了：保存的是物理像素，要按 DPI 比例换算，否则同一份配置在
//      125% 和 200% 的机器上是两个大小。
//   2) 显示器不在了（拔掉外接屏、换分辨率）：矩形可能整块落在屏幕外。
//      判据取「与某块工作区交叠至少 80×40」——够看见标题栏并抓住窗口。
//   3) 窗口比工作区还大：先收缩，否则标题栏会被推到屏幕外。
// 判据不过时在某块屏上居中，而不是沿用 (0,0)——那会让使用者以为程序没启动。
void restore_bounds(int x, int y, int w, int h, int saved_dpi, bool maximized) {
  if (!g_hwnd) return;

  const UINT dpi = GetDpiForWindow(g_hwnd);
  int tw = w;
  int th = h;
  if (saved_dpi > 0 && dpi > 0 && saved_dpi != static_cast<int>(dpi)) {
    tw = MulDiv(w, static_cast<int>(dpi), saved_dpi);
    th = MulDiv(h, static_cast<int>(dpi), saved_dpi);
  }
  if (tw < g_min_w) tw = g_min_w;
  if (th < g_min_h) th = g_min_h;

  RECT want{x, y, x + tw, y + th};
  MonitorPick pick;
  PickCtx ctx{&want, &pick};
  EnumDisplayMonitors(nullptr, nullptr, pick_monitor_proc,
                      reinterpret_cast<LPARAM>(&ctx));

  const long long kMinVisible = 80LL * 40LL;
  const bool usable = pick.mon != nullptr && pick.area >= kMinVisible;

  RECT work{};
  if (usable) {
    work = pick.work;
  } else {
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTOPRIMARY), &mi)) {
      return;
    }
    work = mi.rcWork;
  }

  const int work_w = work.right - work.left;
  const int work_h = work.bottom - work.top;
  if (tw > work_w) tw = work_w;
  if (th > work_h) th = work_h;

  int nx;
  int ny;
  if (usable) {
    nx = x;
    ny = y;
  } else {
    nx = work.left + (work_w - tw) / 2;
    ny = work.top + (work_h - th) / 2;
  }

  if (nx + tw > work.right) nx = work.right - tw;
  if (ny + th > work.bottom) ny = work.bottom - th;
  if (nx < work.left) nx = work.left;
  if (ny < work.top) ny = work.top;

  // 最大化状态下直接 SetWindowPos 只改「还原位置」，不移动窗口本身；
  // 先还原再定位，最后按需重新最大化。
  if (IsZoomed(g_hwnd)) {
    ShowWindow(g_hwnd, SW_RESTORE);
  }
  SetWindowPos(g_hwnd, nullptr, nx, ny, tw, th,
               SWP_NOZORDER | SWP_NOACTIVATE);
  if (maximized) {
    ShowWindow(g_hwnd, SW_MAXIMIZE);
  }
  fit_widget();
  push_state(PushMode::BypassAll);
}

// ---- 自有窗口的消息处理（仅 frameless 路径使用） ----

LRESULT CALLBACK shell_wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  // 键盘 / Ctrl+滚轮 / 拖放：两种窗口模式共用同一套处理
  LRESULT handled = 0;
  if (handle_input_message(hwnd, msg, wp, lp, &handled)) {
    return handled;
  }
  switch (msg) {
  case WM_NCCALCSIZE:
    if (g_frameless && wp == TRUE) {
      // 客户区占满窗口。最大化时直接钉到工作区：
      // 系统给最大化窗口的矩形会带不可见边框，只做等差回缩依赖 SM_* 猜测；
      // 直接以 rcWork 覆盖更确定，也不受 DWM 边框宽度变化影响。
      if (IsZoomed(hwnd)) {
        auto *params = reinterpret_cast<NCCALCSIZE_PARAMS *>(lp);
        MONITORINFO mi{};
        mi.cbSize = sizeof(mi);
        if (GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
          params->rgrc[0] = mi.rcWork;
        }
      }
      return 0;
    }
    break;

  case WM_NCHITTEST: {
    POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
    const LRESULT code = hit_test(hwnd, pt);
    if (code != HTCLIENT) {
      return code;
    }
    break;
  }

  // 自绘 caption button 的**点击**必须在这里执行。
  //
  // 一旦 `WM_NCHITTEST` 返回 `HTMAXBUTTON` / `HTMINBUTTON` / `HTCLOSE`，系统就把
  // 那个点当成**非客户区**：按下时发 `WM_NCLBUTTONDOWN` 而**不是** `WM_LBUTTONDOWN`
  // ——页面因此收不到任何 pointer/click 事件。
  //
  // 这正是「加了 HTMAXBUTTON 就必须同时加这条」的原因：只改 hit_test 的话，
  // 按钮会变成一个吃掉点击的黑洞，表现是「点最大化没反应」。
  //
  // 只处理这三个码，其余（`HTCAPTION` 拖动、八个边框码缩放）继续 `break` 交给
  // `DefWindowProc` —— 那是系统自己的模态循环，不能抢。
  case WM_NCLBUTTONDOWN: {
    const WPARAM hit = wp;
    if (hit == HTCLOSE) {
      DestroyWindow(hwnd);
      return 0;
    }
    if (hit == HTMINBUTTON) {
      ShowWindow(hwnd, SW_MINIMIZE);
      return 0;
    }
    if (hit == HTMAXBUTTON) {
      // 与 `shell_toggle_maximize()` 同一条语义：最大化时还原，否则最大化。
      ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
      return 0;
    }
    break;
  }

  case WM_GETMINMAXINFO: {
    auto *mmi = reinterpret_cast<MINMAXINFO *>(lp);

    // 最小尺寸：入参是逻辑像素，换算成当前 DPI 的 track size 后回报
    int min_w = 0;
    int min_h = 0;
    min_track_size(hwnd, &min_w, &min_h);
    mmi->ptMinTrackSize.x = min_w;
    mmi->ptMinTrackSize.y = min_h;

    // 最大化区域钉到工作区：否则系统按带边框的窗口外扩，无边框下会溢出屏幕。
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
      mmi->ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
      mmi->ptMaxPosition.y = mi.rcWork.top - mi.rcMonitor.top;
      mmi->ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
      mmi->ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
    }
    break;
  }

  case WM_TIMER:
    // 状态推送被节流时挂的一次性定时器：到点补发最后一次状态
    if (wp == kPushTimerId) {
      flush_push_state();
      return 0;
    }
    break;

  case WM_SIZE:
    // 贴满屏幕时收起圆角：最大化窗口与屏幕边缘应严丝合缝，
    // 保留圆角会在四角露出桌面（尤其任务栏同色时更明显）。
    apply_round_corners(hwnd, !IsZoomed(hwnd));
    fit_widget();
    push_state();
    emit_state_event();
    break;

  case WM_ACTIVATE:
  case WM_SETFOCUS:
    push_state();
    emit_state_event();
    break;

  case WM_SETTINGCHANGE:
  case WM_THEMECHANGED:
    // 系统切换深/浅色时重新应用，并把新状态推给页面
    apply_dark_mode(hwnd);
    push_state();
    emit_state_event();
    break;

  case WM_NCRBUTTONUP:
    // 右键标题栏：系统菜单。无边框模式没有非客户区，命中由 hit_test 给出
    if (static_cast<WPARAM>(wp) == HTCAPTION) {
      POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      show_system_menu(hwnd, pt);
      return 0;
    }
    break;

  case WM_SYSCOMMAND:
    // Alt+Space 走 SC_KEYMENU，低半字节用于携带按键字符
    if ((static_cast<WPARAM>(wp) & 0xFFF0) == SC_KEYMENU) {
      if (static_cast<INT_PTR>(lp) == ' ') {
        RECT rc{};
        GetWindowRect(hwnd, &rc);
        POINT pt{rc.left + 8, rc.top + 8};
        show_system_menu(hwnd, pt);
        return 0;
      }
    }
    break;

  case WM_DPICHANGED: {
    // 只在窗口已显示后跟随建议矩形。创建/首次布局阶段系统给出的建议矩形，
    // 是基于创建时的级联位置算出来的，会覆盖掉调用方的居中/定位意图。
    if (!g_shown) {
      break;
    }
    const auto *suggested = reinterpret_cast<RECT *>(lp);
    SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                 suggested->right - suggested->left,
                 suggested->bottom - suggested->top,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    fit_widget();
    push_state();
    emit_state_event();
    return 0;
  }

  case WM_CLOSE:
    DestroyWindow(hwnd);
    return 0;

  case WM_DESTROY:
    PostQuitMessage(0);
    return 0;

  default:
    break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// ---- widget 子类化：让缩放边框的命中透传给父窗口 ----

LRESULT CALLBACK widget_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_NCHITTEST) {
    POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
    if (hit_test(g_hwnd ? g_hwnd : GetParent(hwnd), pt) != HTCLIENT) {
      // HTTRANSPARENT：本窗口不吃这个点，交给同一线程的父窗口判定。
      return HTTRANSPARENT;
    }
  }
  return CallWindowProcW(g_widget_orig, hwnd, msg, wp, lp);
}

void subclass_widget() {
  if (!g_widget || g_widget_orig) {
    return;
  }
  g_widget_orig = reinterpret_cast<WNDPROC>(
      SetWindowLongPtrW(g_widget, GWLP_WNDPROC,
                        reinterpret_cast<LONG_PTR>(widget_proc)));
}

// 带边框模式：顶层窗口由 webview 创建，要补系统菜单与主题跟随只能子类化。
// 只拦这几类消息，其余原样转发，避免影响 webview 自身的窗口逻辑。
LRESULT CALLBACK toplevel_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  LRESULT handled = 0;
  if (handle_input_message(hwnd, msg, wp, lp, &handled)) {
    return handled;
  }
  switch (msg) {
  case WM_SHOWWINDOW:
    // webview 的 set_size_impl 结尾会 window_show()，而 window_show() 里
    // ShowWindow + UpdateWindow 是**同步绘制**：窗口会先以未加载页面（纯黑）
    // 的姿态真画出一帧，再被调用方藏起来——这就是启动闪屏。
    // 延迟显示期间，任何来自外部的显示请求都在这里压回去：
    // 用 SWP_HIDEWINDOW 清掉 WS_VISIBLE，使随后的 UpdateWindow 无更新区域可画。
    // 我们自己的 shell_show() → show_now() 会先置 g_shown，故不会被拦截。
    if (wp == TRUE && g_defer_show && !g_shown) {
      SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                   SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                       SWP_NOACTIVATE);
      return 0;
    }
    break;
  // 带边框模式的顶层窗口由 webview 库创建，`shell_wnd_proc` 根本不在它的消息链上
  // ——只有这里能看见 WM_SIZE / WM_ACTIVATE。所以宿主事件必须在这里补一遍，
  // 否则默认（带边框）配置下宿主永远收不到尺寸与最大化事件，而门禁全绿。
  //
  // 这里**只**发宿主事件，不调 push_state()：页面推送的 16 ms 节流 + 变化检测是
  // 为跨进程 webview_eval 设计的，给带边框模式新开一条页面推送会改变既有消费者的
  // 可见行为（页面突然开始收到以前没有的 win 消息）。两件事分开。
  case WM_SIZE:
  case WM_ACTIVATE:
  case WM_SETFOCUS:
  case WM_DPICHANGED:
    emit_state_event();
    break;
  case WM_TIMER:
    if (wp == kPushTimerId) {
      flush_push_state();
      return 0;
    }
    break;
  case WM_SETTINGCHANGE:
  case WM_THEMECHANGED:
    apply_dark_mode(hwnd);
    push_state();
    emit_state_event();
    break;
  case WM_NCRBUTTONUP:
    if (static_cast<WPARAM>(wp) == HTCAPTION) {
      POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      show_system_menu(hwnd, pt);
      return 0;
    }
    break;
  default:
    break;
  }
  return CallWindowProcW(g_toplevel_orig, hwnd, msg, wp, lp);
}

void subclass_toplevel() {
  if (!g_hwnd || g_toplevel_orig) {
    return;
  }
  g_toplevel_orig = reinterpret_cast<WNDPROC>(
      SetWindowLongPtrW(g_hwnd, GWLP_WNDPROC,
                        reinterpret_cast<LONG_PTR>(toplevel_proc)));
}

// ---- UI 线程 ----

void drain(webview_t /*w*/, void * /*arg*/) {
  std::deque<cmd> local;
  {
    std::lock_guard<std::mutex> lock(g_queue_mu);
    local.swap(g_queue);
  }
  for (const auto &c : local) {
    if (!g_hwnd) {
      break;
    }
    switch (c.kind) {
    case cmd_kind::eval:
      if (g_webview) webview_eval(g_webview, c.arg.c_str());
      break;
    case cmd_kind::title:
      // 必须做 UTF-8 → UTF-16 解码：std::wstring(arg.begin(), arg.end()) 会把每个
      // UTF-8 字节当成一个 wchar_t，中文标题直接变乱码（实测：「围棋习题册生成器」
      // 被显示成「￥ﾛﾴ￦ﾣﾋ…」）。widen_utf8 见原生上下文菜单那一节。
      SetWindowTextW(g_hwnd, widen_utf8(c.arg).c_str());
      break;
    case cmd_kind::minimize:
      ShowWindow(g_hwnd, SW_MINIMIZE);
      break;
    case cmd_kind::maximize_toggle:
      ShowWindow(g_hwnd, IsZoomed(g_hwnd) ? SW_RESTORE : SW_MAXIMIZE);
      break;
    case cmd_kind::close:
      DestroyWindow(g_hwnd);
      break;
    case cmd_kind::drag:
      ReleaseCapture();
      SendMessageW(g_hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
      break;
    case cmd_kind::resize: {
      const int edge = std::atoi(c.arg.c_str());
      static const WPARAM codes[8] = {HTLEFT,        HTRIGHT,    HTTOP,
                                      HTBOTTOM,      HTTOPLEFT,  HTTOPRIGHT,
                                      HTBOTTOMLEFT,  HTBOTTOMRIGHT};
      if (edge >= 0 && edge <= 7) {
        ReleaseCapture();
        SendMessageW(g_hwnd, WM_NCLBUTTONDOWN, codes[edge], 0);
      }
      break;
    }
    case cmd_kind::show:
      if (!g_shown) show_now();
      break;
    case cmd_kind::zoom:
      // 参数是千分数（见 shell_set_zoom）
      apply_zoom(static_cast<double>(std::atoi(c.arg.c_str())) / 1000.0);
      break;
    case cmd_kind::reload:
      reload_page();
      break;
    case cmd_kind::devtools:
      open_dev_tools();
      break;
    case cmd_kind::fullscreen:
      toggle_fullscreen();
      break;
    case cmd_kind::browser_ui:
      apply_browser_ui(g_webview, std::atoi(c.arg.c_str()));
      break;
    case cmd_kind::app_menu: {
      // 参数格式 "x,y|menu-spec"：屏幕坐标 + 菜单描述
      const size_t bar = c.arg.find('|');
      if (bar != std::string::npos) {
        const std::string coord = c.arg.substr(0, bar);
        const std::string spec = c.arg.substr(bar + 1);
        int mx = 0;
        int my = 0;
        if (sscanf(coord.c_str(), "%d,%d", &mx, &my) == 2) {
          POINT pt{mx, my};
          show_app_menu(g_hwnd, pt, spec);
        }
      }
      break;
    }
    case cmd_kind::restore_bounds: {
      int bx = 0, by = 0, bw = 0, bh = 0, bdpi = 0, bmax = 0;
      // 纯整数解析：与 format_bounds 的输出格式成对
      if (sscanf(c.arg.c_str(), "%d,%d,%d,%d,%d,%d", &bx, &by, &bw, &bh, &bdpi,
                 &bmax) == 6) {
        restore_bounds(bx, by, bw, bh, bdpi, bmax != 0);
      }
      break;
    }
    }
  }
}

// 把命令投给 UI 线程执行。
//
// 生命周期锁 g_life_mu 让「检查 g_webview 非空」与「投递」成为原子对：
// teardown 也必须持它才能销毁并清空，所以中间不会插进一次销毁，
// 不会把 webview_dispatch 打到已释放的对象上。
// webview_dispatch 内部只是 PostMessageW，不同步回调 drain，因此持锁安全。
void enqueue(cmd_kind kind, std::string arg = {}) {
  std::lock_guard<std::mutex> life(g_life_mu);
  if (!g_webview) {
    return;
  }
  {
    std::lock_guard<std::mutex> q(g_queue_mu);
    g_queue.push_back(cmd{kind, std::move(arg)});
  }
  webview_dispatch(g_webview, drain, nullptr);
}

HWND create_own_window(int width, int height, const wchar_t *title) {
  static bool registered = false;
  if (!registered) {
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"webview_shell";
    wc.lpfnWndProc = shell_wnd_proc;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = nullptr;
    // 窗口不会自动继承 exe 图标，必须在类上显式给，否则标题栏/Alt-Tab 是默认图标
    wc.hIcon = load_exe_icon(GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON));
    wc.hIconSm =
        load_exe_icon(GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON));
    // CS_HREDRAW/VREDRAW 会引发重绘闪烁，无边框自绘不需要
    wc.style = 0;
    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
      return nullptr;
    }
    registered = true;
  }

  // 无边框窗口按「客户区尺寸」直接创建：不做 AdjustWindowRectEx，否则会多出边框，
  // 且最大化/还原时系统按带边框的矩形保存还原点，造成还原后尺寸漂移。
  // 尺寸按当前 DPI 换算：对外接口统一用 96 DPI 逻辑像素。
  const int scale_num = static_cast<int>(GetDpiForSystem());
  const int px_w = MulDiv(width, scale_num, 96);
  const int px_h = MulDiv(height, scale_num, 96);

  HWND hwnd = CreateWindowExW(
      0, L"webview_shell", title, WS_OVERLAPPEDWINDOW & ~WS_VISIBLE,
      CW_USEDEFAULT, CW_USEDEFAULT, px_w, px_h, nullptr, nullptr,
      GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    return nullptr;
  }

  // 创建期的 WM_NCCALCSIZE 不会被采纳（系统仍按带边框计算客户区），
  // 必须用 SWP_FRAMECHANGED 强制重算一次，之后 client == window。
  SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                   SWP_FRAMECHANGED);

  apply_round_corners(hwnd, true);
  apply_window_icons(hwnd);
  apply_dark_mode(hwnd);
  return hwnd;
}

DWORD WINAPI ui_thread(LPVOID param) {
  const int flags = static_cast<int>(reinterpret_cast<INT_PTR>(param));

  g_frameless = (flags & SHELL_FLAG_FRAMELESS) != 0;
  g_resizable = (flags & SHELL_FLAG_RESIZABLE) != 0;
  g_defer_show = (flags & SHELL_FLAG_DEFER_SHOW) != 0;
  g_accept_drop = (flags & SHELL_FLAG_ACCEPT_DROP) != 0;
  g_start_maximized = (flags & SHELL_FLAG_START_MAXIMIZED) != 0;

  // 任务栏归属必须在窗口创建前设定
  apply_app_user_model_id();

  // 关键：webview 的 com_init_wrapper 只在「它自己创建窗口」时初始化 COM。
  // 嵌入模式（我们提供 HWND）必须由调用方先 CoInitializeEx，否则
  // CreateCoreWebView2Controller 会失败，最终表现为 webview_create 返回 nullptr。
  if (g_frameless) {
    const HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) {
      set_err("CoInitializeEx failed");
      SetEvent(g_ready);
      return 1;
    }
  }

  // 必须做 UTF-8 → UTF-16 解码（同 drain 里的 title 分支）：
  // 无边框模式用它创建窗口标题，直接窄转宽会把中文变成乱码。
  const std::wstring wtitle = widen_utf8(g_title);

  if (g_frameless) {
    g_hwnd = create_own_window(g_start_w, g_start_h, wtitle.c_str());
    if (!g_hwnd) {
      set_err("CreateWindowEx failed");
      SetEvent(g_ready);
      return 1;
    }
    if (!g_resizable) {
      SetWindowLongPtrW(g_hwnd, GWL_STYLE,
                        GetWindowLongPtrW(g_hwnd, GWL_STYLE) &
                            ~(WS_THICKFRAME | WS_MAXIMIZEBOX));
    }
    if (flags & SHELL_FLAG_TOPMOST) {
      SetWindowPos(g_hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    if (flags & SHELL_FLAG_CENTER) {
      center_on_work_area(g_hwnd);
    }
  }

  g_webview = webview_create(1, g_frameless ? static_cast<void *>(g_hwnd) : nullptr);
  if (!g_webview) {
    set_err("webview_create failed (WebView2 runtime missing?)");
    SetEvent(g_ready);
    return 1;
  }

  // 必须在 navigate 之前：这是「页面还没画出内容时露出的底色」，
  // 设晚了那一帧白底已经闪过去了。
  apply_default_background(g_webview, system_uses_dark());

  if (!g_frameless) {
    g_hwnd = static_cast<HWND>(webview_get_window(g_webview));

    // 子类化必须在 set_size 之前安装：webview 的 set_size_impl 结尾会调
    // window_show()，而我们要在 WM_SHOWWINDOW 里把这次显示压回去。
    subclass_toplevel();

    webview_set_title(g_webview, g_title.c_str());
    // webview 自建的窗口同样不继承 exe 图标，且不会跟随系统深色
    apply_window_icons(g_hwnd);
    apply_dark_mode(g_hwnd);

    // 这个调用不能省，哪怕尺寸我们后面会再改：
    // 它会置位 webview 内部的 m_is_size_set。不置位的话，webview 在消息循环里
    // 会补一个「默认 640x480」的 set_size，把尺寸覆盖掉（实测 client 变 1280x960，
    // 而不是预期的 1800x1640）。它顺带的显示动作由 WM_SHOWWINDOW 拦截。
    webview_set_size(g_webview, g_start_w, g_start_h, WEBVIEW_HINT_NONE);

    // 带边框模式同样支持 FLAG_CENTER。此前只在无边框分支里居中，
    // 带边框窗口于是停在创建时的级联位置（实测 147,147 / 343,343）。
    if (flags & SHELL_FLAG_CENTER) {
      center_on_work_area(g_hwnd);
    }
  }

  g_widget = static_cast<HWND>(
      webview_get_native_handle(g_webview, WEBVIEW_NATIVE_HANDLE_KIND_UI_WIDGET));

  if (g_accept_drop) {
    enable_drop(g_hwnd);
  }

  static const char *kInit =
      "window.__shell = window.__shell || {};"
      "window.__shell.recv = function (o) {"
      "  window.dispatchEvent(new CustomEvent('shell-msg', { detail: o }));"
      "};";

  // `FLAG_ACCEPT_DROP` 时追加：把 DOM drop 里的 File 对象转发给宿主。
  //
  // 为什么必须在**初始化脚本**里做，而不是让页面自己写：`FLAG_ACCEPT_DROP` 的
  // 承诺是「壳层把路径交给你」，页面不该为它写任何代码。这里注入一次，对
  // 所有页面生效，且与 `window.__shell.recv` 同一条注入路径。
  //
  // 四个必须点（前三个是「drop 根本不触发」的直接原因，缺一个就毫无反应）：
  //
  //   1. `dragenter` 与 `dragover` 都要 `preventDefault()`。只挂 `dragover`
  //      在多数浏览器上够用，但 WebView2 里从 `dragenter` 起就必须表态。
  //   2. **`dataTransfer.dropEffect` 必须显式设成 `'copy'`**。这一条最隐蔽：
  //      `preventDefault()` 只表示「这里可能接受」，而 `dropEffect` 才是**给用户
  //      看的那一个结论**。它默认是 `'none'`，于是光标一直是禁止图标、`drop`
  //      一次都不来——而 `dragenter` / `dragover` 照常触发。实测（2026-10-21）：
  //      只有 `preventDefault()` 时 `dragenter=1 dragover=72 drop=0`；补上
  //      `dropEffect` 才有 `drop`。本条与 `pitfalls` 2.15 配套。
  //   3. capture 阶段挂监听（第三个参数 `true`），先于页面自己的处理跑；页面若也
  //      `preventDefault` 不影响我们。
  //   4. `files` 要转成真数组再 `postMessage`——`FileList` 是 live 集合，跨进程
  //      structured clone 未必能带过去。
  //
  // `window.__shellDropReady` / `__shellDropPosted` / `__shellDropError` 是给探针与
  // 消费者自检用的三个标记：
  //
  //   `__shellDropReady`   注入跑没跑
  //   `__shellDropPosted`  `postMessageWithAdditionalObjects` 是否调用成功
  //   `__shellDropError`   抛错时的 message（空串 = 没抛）
  //
  // 没有这三个，「拖放没反应」永远分不清是「脚本没注入」「drop 没触发」
  // 还是「投递时抛错被 catch 吞了」。
  //
  // `chrome.webview` 不存在时（理论上不该发生，我们在 WebView2 里）直接跳过，
  // 不让一段注入脚本的失败影响页面。
  //
  // ## 为什么是 `postMessageWithAdditionalObjects` 而不是 `postMessage`
  //
  // 这一条是**整条主路能否成立的唯一分水岭**，而且失败时完全没有症状：
  // `postMessage` 会对 payload 做 JSON 序列化，`File` 对象被序列化成 `{}`，
  // 投递**成功**、`WebMessageReceived` **照常触发**，但 `get_AdditionalObjects`
  // 返回空集合、`get_Count` 是 0 —— 于是壳层什么都不推，页面永远等不到路径。
  //
  // 微软文档（`ICoreWebView2WebMessageReceivedEventArgs2::get_AdditionalObjects`）：
  // 「To pass additionalObjects via WebMessage to the app, use the
  // `chrome.webview.postMessageWithAdditionalObjects` content API.」两者是配对的，
  // `AdditionalObjects` 只承载第二个参数里的 DOM 对象。
  //
  // 所以第一个参数只放自己的标记，DOM 对象一律走第二个参数。见 `pitfalls` 2.16。
  //
  // ## 目录为什么要走 `getAsFileSystemHandle()`
  //
  // WebView2 支持的 DOM 对象只有两种（`WebMessageObjects.md`）：`File` 与
  // `FileSystemHandle`。**目录不是 `File`**，它只能以
  // `FileSystemDirectoryHandle`（`FileSystemHandle` 的子类）身份过桥，宿主侧
  // 落到 `ICoreWebView2FileSystemHandle`，由 `get_Kind` 区分文件/目录
  // （`FILE = 0` / `DIRECTORY = 1`）。
  //
  // 而 `dataTransfer.files` 对目录**不一定**给 entry，所以：
  //
  //   - `dataTransfer.items[i].getAsFileSystemHandle()` —— 主路，文件和目录都能拿
  //   - `dataTransfer.files` —— 回退，只在 handles 全失败时才用
  //
  // 两者都空时**必须报出来**，不能像上一版那样静默 return（`pitfalls` 2.16 第 4 关）。
  //
  // `getAsFileSystemHandle()` 返回 Promise，必须在 `drop` 处理器里**同步调用**
  // （`dataTransfer` 在事件返回后即失效），拿到 Promise 之后再 await。
  //
  // ## 为什么必须有超时兜底
  //
  // 那个 Promise **可能永远不兑现**（实测 2026-10-21：拖文件进来 `files=1
  // items=1`，两次 drop 都没有任何投递，页面一直停在「等待宿主回报」）。
  // 若直接在 `.then()` 里投递，Promise 不兑现就等于**什么都不发**，表现与「注入
  // 脚本没跑」完全一致——又是同一类静默失效。
  //
  // 现在的写法是「先到先投，之后作废」：`settled` 一置位，晚到的 handles 结果不再
  // 投递。超时那条路只能用 `files`（拿不到目录），但它保证**总有东西发出**；`via`
  // 字段如实记录走了哪条路（`handles` / `files` / `files-timeout` / `files-error`），
  // 诊断不再靠猜。
  //
  // 传不支持的对象给 `postMessageWithAdditionalObjects` 会**抛异常且消息不发出**
  // （spec 明文），所以 `post` 里必须有 try/catch，且失败后要能退回 `files`。
  static const char *kDropInit =
      "(function(){"
      "  if (!window.chrome || !window.chrome.webview) { return; }"
      "  var wv = window.chrome.webview;"
      "  window.__shellDropReady = 1;"
      "  window.__shellDropPosted = 0;"
      "  window.__shellDropVia = '';"
      "  window.__shellDropError = '';"
      "  function allow(e) {"
      "    e.preventDefault();"
      "    if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }"
      "  }"
      "  function post(via, objs) {"
      "    try {"
      "      wv.postMessageWithAdditionalObjects({ __shellDrop: 1, via: via }, objs);"
      "      window.__shellDropPosted = 1;"
      "      window.__shellDropVia = via;"
      "      return true;"
      "    } catch (err) {"
      "      window.__shellDropError = via + ': ' + String(err && err.message ? err.message : err);"
      "      return false;"
      "    }"
      "  }"
      "  window.addEventListener('dragenter', allow, true);"
      "  window.addEventListener('dragover', allow, true);"
      "  window.addEventListener('drop', function (e) {"
      "    var dt = e.dataTransfer;"
      "    if (!dt) { return; }"
      "    e.preventDefault();"
      "    if (!wv.postMessageWithAdditionalObjects) {"
      "      window.__shellDropError = 'postMessageWithAdditionalObjects unavailable';"
      "      return;"
      "    }"
      // 同步抓取：await 之后 dataTransfer 就失效了，所有读取必须在事件里做完
      "    var files = [];"
      "    if (dt.files) {"
      "      for (var i = 0; i < dt.files.length; i++) { files.push(dt.files[i]); }"
      "    }"
      "    var pending = [];"
      "    if (dt.items) {"
      "      for (var j = 0; j < dt.items.length; j++) {"
      "        var it = dt.items[j];"
      "        if (it.kind !== 'file') { continue; }"
      "        if (it.getAsFileSystemHandle) {"
      "          try { pending.push(it.getAsFileSystemHandle()); } catch (_) {}"
      "        }"
      "      }"
      "    }"
      "    var settled = false;"
      "    function settle(via, objs) {"
      "      if (settled) { return false; }"
      "      settled = true;"
      "      return post(via, objs);"
      "    }"
      "    if (!pending.length) {"
      // 没有 handles 这条路（老运行时）：只能用 files
      "      if (files.length) { settle('files', files); }"
      "      else { window.__shellDropError = 'drop had no files and no items'; }"
      "      return;"
      "    }"
      "    setTimeout(function () {"
      "      if (!settled) {"
      "        if (!window.__shellDropError) {"
      "          window.__shellDropError = 'getAsFileSystemHandle did not settle';"
      "        }"
      "        if (files.length) { settle('files-timeout', files); }"
      "      }"
      "    }, 800);"
      "    Promise.all(pending).then(function (list) {"
      "      var handles = [];"
      "      for (var k = 0; k < list.length; k++) { if (list[k]) { handles.push(list[k]); } }"
      // handles 与 files 一起传：目录的 handle 到宿主可能是 null（spec：不支持的
      // DOM 对象以 null 传递），而 `files` 里目录会以一个 File 出现——两条都带上，
      // 宿主按「能取到 path 的那个」用，并对重复路径去重。
      "      var both = handles.concat(files);"
      "      if (both.length) { settle('handles+files', both); }"
      "      else if (!window.__shellDropError) {"
      "        window.__shellDropError = 'no handle and no file could be posted';"
      "      }"
      "    })['catch'](function (err) {"
      "      window.__shellDropError = 'getAsFileSystemHandle: ' +"
      "        String(err && err.message ? err.message : err);"
      "      if (files.length) { settle('files-error', files); }"
      "    });"
      "  }, true);"
      "})();";

  std::string initScript = kInit;
  if (g_accept_drop) {
    initScript += kDropInit;
  }

  if (webview_init(g_webview, initScript.c_str()) != WEBVIEW_ERROR_OK) {
    set_err("webview_init failed");
  }
  // 必须在 navigate **之前**安装：`NavigationStarting` 只对注册之后发起的导航生效，
  // 晚一步的话首次加载（也就是最可能被一个 `file://` 入口带偏的那一次）完全不受保护。
  install_nav_guard();
  // 键盘快捷键的订阅点。必须早于 webview_run（消息循环）——真实按键不走
  // 顶层窗口的 WM_KEYDOWN，只走 WebView2 的 AcceleratorKeyPressed。
  install_accelerator_handler();
  if (webview_navigate(g_webview, g_url.c_str()) != WEBVIEW_ERROR_OK) {
    set_err("webview_navigate failed");
  }

  if (g_frameless) {
    subclass_widget();
    fit_widget();
    if (!g_defer_show) show_now();
  } else {
    // subclass_toplevel() 已在上面（set_size 之前）安装
    if (!g_defer_show) {
      g_shown = true;
      // 带边框模式的显示由 webview 自己的 window_show() 完成，而那同样是
      // 本进程对 ShowWindow 的第一次调用——会被启动方的 STARTUPINFO 覆盖成
      // SW_HIDE，导致窗口永远不可见（与 frameless 分支同一个根因）。
      force_visible();
    }
  }

  SetEvent(g_ready);

  webview_run(g_webview); // 阻塞直到窗口关闭或 shell_stop()

  // 销毁 + 清空必须在生命周期锁内完成：enqueue 在同一把锁下「检查非空并投递」，
  // 中间若插进一次销毁，就会把 webview_dispatch 打到已释放的对象上。
  {
    std::lock_guard<std::mutex> life(g_life_mu);
    // 反注册必须在 destroy **之前**：destroy 之后 core_webview() 返回 nullptr，
    // remove_ 就无从谈起，守卫对象会一直挂在已死的 core 上（释放时崩）。
    uninstall_accelerator_handler();
    uninstall_drop_handler();
    uninstall_nav_guard();
    webview_destroy(g_webview);
    g_webview = nullptr;
    {
      std::lock_guard<std::mutex> q(g_queue_mu);
      g_queue.clear();
    }
  }

  g_widget = nullptr;
  g_widget_orig = nullptr;
  g_toplevel_orig = nullptr;
  g_hwnd = nullptr;
  g_shown = false;
  g_round_state = -1; // 窗口已销毁，缓存失效
  g_push_pending = false;
  g_pushed = PushedState{};

  // 终态事件放在**所有清理之后**：宿主看到它就可以安全 restart，不必再轮询
  // is_alive()——原生层是进程级单例，而此刻 g_webview 已经是 nullptr。
  emit_closed_event();

  if (g_frameless) {
    CoUninitialize();
  }
  return 0;
}

} // namespace

extern "C" {

__declspec(dllexport) int shell_start_ex(const char *url, const char *title,
                                         int width, int height, int flags) {
  if (!url || !*url) {
    set_err("url is required");
    return -1;
  }
  if (g_webview) {
    set_err("shell already started");
    return -1;
  }

  // 尽力开启 Per-Monitor V2 DPI 感知：否则在 150%/200% 缩放下整个窗口会被系统
  // 位图拉伸（WebView2 内容一起变糊）。必须在任何窗口创建前调用，
  // 且宿进程若已设定感知级别则此处会失败（沿用宿主设定）。
  {
    auto setCtx = reinterpret_cast<BOOL(WINAPI *)(DPI_AWARENESS_CONTEXT)>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
    if (!setCtx ||
        !setCtx(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
      // 退一步尝试 system-aware
      auto setAware = reinterpret_cast<BOOL(WINAPI *)(int)>(
          GetProcAddress(GetModuleHandleW(L"shcore.dll"), "SetProcessDpiAwareness"));
      if (setAware) setAware(1 /* PROCESS_SYSTEM_DPI_AWARE */);
    }
  }

  g_url = url;
  g_title = title ? title : "shell";
  g_start_w = width > 0 ? width : 1200;
  g_start_h = height > 0 ? height : 800;
  g_frameless = (flags & SHELL_FLAG_FRAMELESS) != 0;
  g_resizable = (flags & SHELL_FLAG_RESIZABLE) != 0;
  g_accept_drop = (flags & SHELL_FLAG_ACCEPT_DROP) != 0;
  g_start_maximized = (flags & SHELL_FLAG_START_MAXIMIZED) != 0;
  // 外部导航拦截的两个判据基准。在这里算而不是在 ui_thread 里算：
  // 两者都是「启动地址的静态属性」，越早定下来越不会和后续状态混在一起。
  //
  //   g_origin  — http/https 应用的同源基准；`file://` 等无 origin 的地址为空串。
  //   g_app_doc — 启动地址剥掉 `#fragment`，origin 为空时作为「同文档」基准。
  //   g_allow_external_nav — 显式放弃导航拦截（应用本身就是浏览器）。
  {
    const std::wstring wurl = widen_utf8(g_url);
    g_origin = url_origin(wurl);
    g_app_doc = strip_fragment(wurl);
  }
  g_allow_external_nav = (flags & SHELL_FLAG_ALLOW_EXTERNAL_NAV) != 0;
  // 丢弃上一轮未读的事件记录并归零序号：否则宿主可能先拿到上一次的 CLOSED，
  // 误判「当前窗口已经关了」。宿主侧以「seq 变小」判定新一轮。
  reset_events();
  clear_err();

  g_ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_ready) {
    set_err("CreateEvent failed");
    return -1;
  }

  HANDLE thread = CreateThread(nullptr, 0, ui_thread,
                               reinterpret_cast<LPVOID>(static_cast<INT_PTR>(flags)),
                               0, nullptr);
  if (!thread) {
    set_err("CreateThread failed");
    CloseHandle(g_ready);
    g_ready = nullptr;
    return -1;
  }

  const DWORD waited = WaitForSingleObject(g_ready, 20000);
  CloseHandle(g_ready);
  g_ready = nullptr;
  CloseHandle(thread);

  if (waited != WAIT_OBJECT_0) {
    set_err("timeout waiting for webview creation");
    return -1;
  }
  return g_webview ? 0 : -1;
}

__declspec(dllexport) int shell_start(const char *url, const char *title,
                                      int width, int height) {
  return shell_start_ex(url, title, width, height, SHELL_FLAG_RESIZABLE);
}

__declspec(dllexport) int shell_post(const char *json) {
  if (!json || !*json) {
    set_err("payload is required");
    return -1;
  }
  if (!g_webview) {
    set_err("window is not running");
    return -1;
  }
  enqueue(cmd_kind::eval, std::string("window.__shell && window.__shell.recv(") + json + ")");
  return 0;
}

__declspec(dllexport) int shell_title(const char *title) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::title, title ? title : "");
  return 0;
}

__declspec(dllexport) int shell_minimize(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::minimize);
  return 0;
}

__declspec(dllexport) int shell_toggle_maximize(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::maximize_toggle);
  return 0;
}

__declspec(dllexport) int shell_close(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::close);
  return 0;
}

// 由页面在拖拽区 pointerdown 时调用：转成一次原生标题栏拖拽（含贴边分屏）。
__declspec(dllexport) int shell_drag(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::drag);
  return 0;
}

// 自定义缩放手柄用；正常边框命中走 WM_NCHITTEST，不需要调用。
__declspec(dllexport) int shell_begin_resize(int edge) {
  if (!g_webview) return -1;
  if (edge < 0 || edge > 7) return -1;
  enqueue(cmd_kind::resize, std::to_string(edge));
  return 0;
}

__declspec(dllexport) void shell_set_min_size(int width, int height) {
  if (width > 0) g_min_w = width;
  if (height > 0) g_min_h = height;
}

// 延迟显示模式下由调用方在页面就绪后调用（消除首帧闪烁）。
// 未启用 SHELL_FLAG_DEFER_SHOW 时是幂等 no-op。
__declspec(dllexport) int shell_show(void) {
  if (!g_webview) return -1;
  if (g_shown) return 0;
  enqueue(cmd_kind::show);
  return 0;
}

// 在屏幕坐标 (x, y) 弹出原生上下文菜单。items 是页面定义的描述串：
//   "open|打开题库\nrefresh|刷新\n-\nquit|退出"
// 选中后通过 shell-msg 推回 { t: "menu", id: "<id>" }。
__declspec(dllexport) int shell_show_app_menu(int x, int y, const char *items) {
  if (!g_webview || !items || !*items) return -1;
  char head[40];
  wsprintfA(head, "%d,%d|", x, y);
  enqueue(cmd_kind::app_menu, std::string(head) + items);
  return 0;
}

// 关闭 mask 里指定的浏览器行为（右键默认菜单 / 浏览器快捷键 / 状态栏 /
// 滑动导航 / 自动填充）。位定义见 ShellBrowserUi。
// 运行时生效；建议在 start() 之后立即调用。
__declspec(dllexport) int shell_set_browser_ui(int mask) {
  if (!g_webview) return -1;
  char buf[16];
  wsprintfA(buf, "%d", mask);
  enqueue(cmd_kind::browser_ui, std::string(buf));
  return 0;
}

// ---- 窗口位置（供持久化 helper 使用）----

// 读取当前矩形，格式 "x,y,w,h,maximized,dpi"。返回写入长度，0 表示窗口不存在。
__declspec(dllexport) int shell_get_bounds(char *buf, int cap) { return format_bounds(buf, cap); }

// 恢复矩形。坐标与尺寸均为物理像素，saved_dpi 是保存时的缩放 DPI。
// 会按当前 DPI 换算尺寸、校验矩形是否仍在某块屏上、必要时居中。
__declspec(dllexport) int shell_restore_bounds(int x, int y, int w, int h,
                                               int saved_dpi, int maximized) {
  if (!g_webview) return -1;
  char buf[96];
  wsprintfA(buf, "%d,%d,%d,%d,%d,%d", x, y, w, h, saved_dpi, maximized ? 1 : 0);
  enqueue(cmd_kind::restore_bounds, std::string(buf));
  return 0;
}

// ---- 输入与视图能力 ----

// 设页面缩放倍率（0.25 ~ 3.0）。主线程调用，实际 COM 动作投到 UI 线程执行。
__declspec(dllexport) int shell_set_zoom(double factor) {
  if (!g_webview) return -1;
  // 注意：不能在这里用 wsprintfA("...%f", factor)。user32 的 wsprintf 只支持
  // %c/%d/%u/%x/%s，没有浮点，%.4f 会产出空串，atof("")=0 再被钳到下限——
  // 实测表现为「设任何倍率都变成 0.25」。改用整数千分数编码。
  int milli = static_cast<int>(factor * 1000.0 + (factor >= 0 ? 0.5 : -0.5));
  char buf[24];
  wsprintfA(buf, "%d", milli);
  enqueue(cmd_kind::zoom, std::string(buf));
  return 0;
}

// 查询当前缩放。读缓存，无 COM 调用。
__declspec(dllexport) double shell_get_zoom(void) { return g_zoom; }

// 重新加载页面（等同 Ctrl+R / F5）。
__declspec(dllexport) int shell_reload(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::reload);
  return 0;
}

// 打开 WebView2 开发者工具（等同 F12）。
__declspec(dllexport) int shell_devtools(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::devtools);
  return 0;
}

// 切换全屏（等同 F11）。
__declspec(dllexport) int shell_toggle_fullscreen(void) {
  if (!g_webview) return -1;
  enqueue(cmd_kind::fullscreen);
  return 0;
}

// 同步查询系统深浅色。页面侧也会收到 win 推送里的 dark 字段；
// 这个接口供宿主在推送之外按需读取。
__declspec(dllexport) int shell_is_dark(void) { return system_uses_dark() ? 1 : 0; }

// AppUserModelID 决定任务栏分组与图标归属。
// 进程级设定应在 shell_start_ex 之前调用；窗口已建时改写对当前窗口不生效。
__declspec(dllexport) int shell_set_app_id(const char *app_id) {
  if (!app_id || !*app_id) {
    g_app_id.clear();
    return 0;
  }
  const int need = MultiByteToWideChar(CP_UTF8, 0, app_id, -1, nullptr, 0);
  if (need <= 0) {
    set_err("invalid app id (utf-8 decode failed)");
    return -1;
  }
  g_app_id.assign(static_cast<size_t>(need - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, app_id, -1, &g_app_id[0], need);
  apply_app_user_model_id();
  return 0;
}

// 系统文件夹选择框。替代「每次 spawn 一个 powershell.exe 跑 WinForms」的做法：
// 直接调 shell32，无子进程、无脚本落盘、无 STA 依赖外部进程。
// 返回 0 表示用户选中并把路径写入 buf；1 表示取消；-1 表示失败。
__declspec(dllexport) int shell_pick_folder(const char *title, char *buf, int cap) {
  if (!buf || cap <= 0) return -1;
  buf[0] = 0;

  // SHBrowseForFolder 需要 COM 已初始化；重复初始化返回 S_FALSE 也无害
  const HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  wchar_t wtitle[256] = L"选择文件夹";
  if (title && *title) {
    MultiByteToWideChar(CP_UTF8, 0, title, -1, wtitle, 256);
  }

  BROWSEINFOW bi{};
  // hwndOwner 必须给：没有 owner 的对话框不模态于应用窗口，z 序上也压不住
  // 应用窗口——表现为「点了选择，对话框跑到窗口下面去了，看着像没反应」。
  // 给了 owner 之后它是该窗口的模态子级，必然在其之上，且打开期间应用窗口不可操作。
  //
  // 取 hwnd 时短暂持生命周期锁，但**不能**在 SHBrowseForFolder 阻塞期间持锁：
  // 那会挡住 teardown。所以只锁住「读值」这一步，再用 IsWindow 复核一次，
  // 防止读到的窗口在解锁后已被销毁（无效 owner 会退化为无 owner，不会崩）。
  HWND owner = nullptr;
  {
    std::lock_guard<std::mutex> life(g_life_mu);
    owner = g_hwnd;
  }
  if (owner && !IsWindow(owner)) {
    owner = nullptr;
  }
  bi.hwndOwner = owner;
  bi.lpszTitle = wtitle;
  bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_USENEWUI;

  PIDLIST_ABSOLUTE pidl = SHBrowseForFolderW(&bi);
  if (!pidl) {
    if (SUCCEEDED(hr)) CoUninitialize();
    return 1;  // 用户取消
  }

  wchar_t wpath[MAX_PATH] = {0};
  const BOOL ok = SHGetPathFromIDListW(pidl, wpath);
  CoTaskMemFree(pidl);
  if (SUCCEEDED(hr)) CoUninitialize();

  if (!ok) {
    set_err("SHGetPathFromIDList failed");
    return -1;
  }
  const int need = WideCharToMultiByte(CP_UTF8, 0, wpath, -1, buf, cap, nullptr, nullptr);
  if (need <= 0) {
    set_err("folder path too long");
    return -1;
  }
  return 0;
}

__declspec(dllexport) int shell_get_state(void) {
  int state = 0;
  if (!g_hwnd) return 0;
  if (IsZoomed(g_hwnd)) state |= SHELL_STATE_MAXIMIZED;
  if (IsIconic(g_hwnd)) state |= SHELL_STATE_MINIMIZED;
  if (GetForegroundWindow() == g_hwnd) state |= SHELL_STATE_FOCUSED;
  return state;
}

// 窗口是否仍然存在。1 = 存活，0 = 已销毁（用户点 X 或调用过 shell_stop）。
//
// 为什么不复用 shell_get_state：它返回 0 同时表示「未启动」与「已销毁」，
// 调用方无法区分。宿主需要这个信号来回收进程——窗口销毁后 webview_run 会在
// UI 线程返回，但宿主进程（以及它起的本地服务）不会自己退出。
__declspec(dllexport) int shell_is_alive(void) { return g_webview ? 1 : 0; }

// 批量拉取窗口生命周期事件。capacity 是**记录条数**（不是字节数），
// buf 需至少 capacity * 32 字节；返回本次写入的条数。
//
// 与其它导出不同，这里**不**检查 g_webview：CLOSED 恰好在它被置空之后才产生，
// 早退会让宿主永远读不到「窗口已关闭」。未启动时返回 0，与「没有新事件」同义。
//
// 线程契约：约定单读者。多个线程同时拉会各自拿到不同的子集——不会崩，但谁也看不全。
__declspec(dllexport) int shell_poll_events(void *buf, int capacity) {
  if (!buf || capacity <= 0) return 0;
  auto *out = static_cast<EventRecord *>(buf);
  // 读侧也要独占：它要推进 g_ev_tail。临界区最长是一次 4 KiB 拷贝。
  AcquireSRWLockExclusive(&g_ev_mu);
  const unsigned avail = g_ev_head - g_ev_tail;
  const unsigned want = static_cast<unsigned>(capacity);
  const unsigned n = avail < want ? avail : want;
  const unsigned start = g_ev_tail;
  for (unsigned i = 0; i < n; ++i) {
    out[i] = g_events[(start + i) & (kEventCapacity - 1)];
  }
  g_ev_tail = start + n;
  ReleaseSRWLockExclusive(&g_ev_mu);
  return static_cast<int>(n);
}

// 调试用：入参为顶层窗口客户区坐标（设备像素），与页面 CSS 像素按 dpr 换算。
__declspec(dllexport) int shell_debug_hittest(int x, int y) {
  if (!g_hwnd) return -1;
  POINT pt{x, y};
  return static_cast<int>(hit_test_client(g_hwnd, pt));
}

// 调试用：把窗口/客户区/工作区几何写进缓冲区，返回写入长度。
// 格式：pos=X,Y win=WxH client=WxH work=WxH border=XxY
__declspec(dllexport) int shell_debug_metrics(char *buf, int cap) {
  if (!buf || cap <= 0) return 0;
  buf[0] = 0;
  if (!g_hwnd) return 0;

  RECT wr{}, cr{};
  GetWindowRect(g_hwnd, &wr);
  GetClientRect(g_hwnd, &cr);

  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTONEAREST), &mi);

  char tmp[320];
  wsprintfA(tmp,
            "pos=%ld,%ld win=%ldx%ld client=%ldx%ld work=%ldx%ld border=%dx%d round=%d",
            wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top,
            cr.right - cr.left, cr.bottom - cr.top,
            mi.rcWork.right - mi.rcWork.left, mi.rcWork.bottom - mi.rcWork.top,
            frame_border_x(), frame_border_y(), g_round_state.load());

  const int n = lstrlenA(tmp);
  if (n >= cap) return 0;
  lstrcpyA(buf, tmp);
  return n;
}

// 调试用：报告进程 DPI 感知与实际监视器 DPI。
// 格式：awareness=N dpi=N scale=N%
__declspec(dllexport) int shell_debug_dpi(char *buf, int cap) {
  if (!buf || cap <= 0) return 0;
  buf[0] = 0;

  DPI_AWARENESS awareness = DPI_AWARENESS_INVALID;
  auto getAwareness = reinterpret_cast<HRESULT(WINAPI *)(DPI_AWARENESS *)>(
      GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetProcessDpiAwareness"));
  if (getAwareness) {
    // GetProcessDpiAwareness 需要一个 handle；传 nullptr 表示当前进程
    HANDLE proc = GetCurrentProcess();
    auto getFromProc = reinterpret_cast<HRESULT(WINAPI *)(HANDLE, DPI_AWARENESS *)>(
        GetProcAddress(GetModuleHandleW(L"shcore.dll"), "GetProcessDpiAwareness"));
    (void)getAwareness;
    if (getFromProc) {
      getFromProc(proc, &awareness);
    }
  }

  // 监视器原始 DPI（不受进程感知影响）
  const UINT monitorDpi = GetDpiForSystem();
  const int scale = MulDiv(static_cast<int>(monitorDpi), 100, 96);

  char tmp[160];
  wsprintfA(tmp, "awareness=%d dpi=%u scale=%d%%", static_cast<int>(awareness),
            monitorDpi, scale);

  const int n = lstrlenA(tmp);
  if (n >= cap) return 0;
  lstrcpyA(buf, tmp);
  return n;
}

// 调试用：返回本 DLL 自身在内存中的模块基址。
// 用来判断 Bun 的 ffi 是按标准模块加载（出现在 PEB 模块链）还是手动映射。
__declspec(dllexport) unsigned long long shell_self_base(void) {
  HMODULE self = nullptr;
  if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                             GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCWSTR>(&shell_self_base), &self)) {
    return static_cast<unsigned long long>(reinterpret_cast<ULONG_PTR>(self));
  }
  return 0;
}

// 调试用：把本 DLL 的完整文件路径写进缓冲区，返回写入长度。
// 若为空，说明它是内存映射而非磁盘文件。
__declspec(dllexport) int shell_self_path(char *buf, int cap) {
  if (!buf || cap <= 0) return 0;
  buf[0] = 0;

  HMODULE self = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(&shell_self_base), &self)) {
    return 0;
  }

  wchar_t wpath[MAX_PATH] = {0};
  // 0x2 = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS 不适用；用 GetModuleFileNameW
  const DWORD n = GetModuleFileNameW(self, wpath, MAX_PATH);
  if (n == 0) {
    lstrcpynA(buf, "(GetModuleFileNameW failed)", cap);
    return lstrlenA(buf);
  }
  const int need = WideCharToMultiByte(CP_UTF8, 0, wpath, -1, buf, cap, nullptr, nullptr);
  return need > 0 ? need - 1 : 0;
}

// terminate 必须跑在 UI 线程：vendor 侧的实现是 PostQuitMessage(0)，它只把
// WM_QUIT 投给**调用线程**的消息队列。从宿主线程直接调，退出消息就落在一个
// 没有消息循环的线程上，UI 线程的 webview_run 永远收不到——表现为
// shell_stop()「什么都没发生」：窗口还在、is_alive 仍为真、再 start 会报
// 「shell already started」。实测踩过。
void terminate_on_ui(webview_t w, void * /*arg*/) {
  if (w) {
    webview_terminate(w);
  }
}

__declspec(dllexport) void shell_stop(void) {
  // 持生命周期锁：teardown 也用它，所以不会在「检查非空」与「投递」之间
  // 插进一次销毁。
  std::lock_guard<std::mutex> life(g_life_mu);
  if (g_webview) {
    webview_dispatch(g_webview, terminate_on_ui, nullptr);
  }
}

// 错误文本的拷贝式读出。shell_error() 返回的是共享缓冲区的指针，解锁后可能被
// 别的线程改写；需要可靠读取时用这个（返回写入长度）。
__declspec(dllexport) int shell_error_text(char *buf, int cap) { return copy_err(buf, cap); }

__declspec(dllexport) const char *shell_error(void) { return g_err; }

} // extern "C"
