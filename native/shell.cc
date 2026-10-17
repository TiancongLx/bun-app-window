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
#include <atomic>
#include <deque>
#include <mutex>
#include <string>

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

enum class cmd_kind { eval, title, minimize, maximize_toggle, close, drag, resize, show, zoom, reload, devtools, fullscreen, restore_bounds };

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
std::wstring g_app_id;        // AppUserModelID：决定任务栏分组与图标归属
int g_min_w = 320;
int g_min_h = 200;
int g_start_w = 1200;
int g_start_h = 800;

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

// 返回 HT* 代码；HTCLIENT 表示不落在缩放边框上。坐标为顶层窗口客户区坐标（设备像素）。
LRESULT hit_test_client(HWND hwnd, POINT pt) {
  if (!g_frameless || !g_resizable || IsZoomed(hwnd)) {
    return HTCLIENT;
  }
  RECT rc{};
  GetClientRect(hwnd, &rc);

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
void push_state(bool force = false) {
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

  const bool same = px_w == g_pushed.px_w && px_h == g_pushed.px_h &&
                    dpi == g_pushed.dpi && maxed == g_pushed.maxed &&
                    minned == g_pushed.minned && focused == g_pushed.focused &&
                    dark == g_pushed.dark;
  if (same && !force) {
    return;
  }

  const ULONGLONG now = GetTickCount64();
  if (!force && now - g_pushed.at < kPushMinIntervalMs) {
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

// 节流定时器到点：补发一次（force，因为此时往往与上次推送的状态已经不同了）。
void flush_push_state() {
  if (!g_push_pending) {
    return;
  }
  g_push_pending = false;
  if (g_hwnd) {
    KillTimer(g_hwnd, kPushTimerId);
  }
  push_state(true);
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
void show_now() {
  if (!g_hwnd) return;
  g_shown = true;
  ShowWindow(g_hwnd, SW_SHOW);
  SetForegroundWindow(g_hwnd);
  SetFocus(g_hwnd);
  UpdateWindow(g_hwnd);
  push_state();
}

// ---- 缩放 / 全屏 / 刷新 / 开发者工具 / 拖放 ----

// 缩放级别阶梯。与 Edge 的量级接近：小端更密，大端更疏，避免高倍率下 ±0.1 看不出变化。
const double kZoomLadder[] = {0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1.0,
                              1.1,  1.25, 1.5, 1.75, 2.0, 2.5, 3.0};
const int kZoomCount = static_cast<int>(sizeof(kZoomLadder) / sizeof(kZoomLadder[0]));
double g_zoom = 1.0;

// 全屏状态：进入前保存样式与矩形，退出时原样还原。
bool g_fullscreen = false;
LONG_PTR g_saved_style = 0;
RECT g_saved_rect{};

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
  push_state(true);
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

// 拖放：把落进来的路径推给页面。
//
// 注意提权场景：本进程若是 High 完整性（例如由 OTT 派生），资源管理器（Medium）
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
}

void handle_drop(HDROP hd) {
  if (!hd) {
    return;
  }
  const UINT count = DragQueryFileW(hd, 0xFFFFFFFF, nullptr, 0);
  std::string json = "{\"t\":\"drop\",\"paths\":[";
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
    if (json[json.size() - 1] != '[') {
      json.push_back(',');
    }
    append_json_string(json, path);
  }
  json += "]}";
  DragFinish(hd);
  if (count > 0) {
    post_json(json);
  }
}

// 键盘 / 滚轮 / 拖放的共用前置处理。两种窗口模式都要，抽出来避免两份漂移。
// 返回 true 表示已处理并回填 *out。
bool handle_input_message(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, LRESULT *out) {
  switch (msg) {
  case WM_KEYDOWN: {
    const bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    switch (wp) {
    case VK_F11:
      toggle_fullscreen();
      *out = 0;
      return true;
    case VK_F12:
      open_dev_tools();
      *out = 0;
      return true;
    case VK_F5:
      reload_page();
      *out = 0;
      return true;
    case 'R':
      if (ctrl) {
        reload_page();
        *out = 0;
        return true;
      }
      break;
    case VK_OEM_PLUS:   // 主键盘 =/+（Shift 不改变虚拟键码）
    case VK_ADD:        // 小键盘 +
      if (ctrl) {
        zoom_step(+1);
        *out = 0;
        return true;
      }
      break;
    case VK_OEM_MINUS:
    case VK_SUBTRACT:
      if (ctrl) {
        zoom_step(-1);
        *out = 0;
        return true;
      }
      break;
    case '0':
    case VK_NUMPAD0:
      if (ctrl) {
        apply_zoom(1.0);
        *out = 0;
        return true;
      }
      break;
    default:
      break;
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
int format_bounds(char *buf, int cap) {
  if (!buf || cap <= 0) return 0;
  buf[0] = 0;
  if (!g_hwnd) return 0;

  const bool maxed = IsZoomed(g_hwnd) != 0;
  RECT rc{};
  WINDOWPLACEMENT wp{};
  wp.length = sizeof(wp);
  if (maxed && GetWindowPlacement(g_hwnd, &wp)) {
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
  push_state(true);
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
    break;

  case WM_ACTIVATE:
  case WM_SETFOCUS:
    push_state();
    break;

  case WM_SETTINGCHANGE:
  case WM_THEMECHANGED:
    // 系统切换深/浅色时重新应用，并把新状态推给页面
    apply_dark_mode(hwnd);
    push_state();
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
      SetWindowTextW(g_hwnd, std::wstring(c.arg.begin(), c.arg.end()).c_str());
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

  const std::wstring wtitle(g_title.begin(), g_title.end());

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

  if (webview_init(g_webview, kInit) != WEBVIEW_ERROR_OK) {
    set_err("webview_init failed");
  }
  if (webview_navigate(g_webview, g_url.c_str()) != WEBVIEW_ERROR_OK) {
    set_err("webview_navigate failed");
  }

  if (g_frameless) {
    subclass_widget();
    fit_widget();
    if (!g_defer_show) show_now();
  } else {
    // subclass_toplevel() 已在上面（set_size 之前）安装
    if (!g_defer_show) g_shown = true;
  }

  SetEvent(g_ready);

  webview_run(g_webview); // 阻塞直到窗口关闭或 shell_stop()

  // 销毁 + 清空必须在生命周期锁内完成：enqueue 在同一把锁下「检查非空并投递」，
  // 中间若插进一次销毁，就会把 webview_dispatch 打到已释放的对象上。
  {
    std::lock_guard<std::mutex> life(g_life_mu);
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
