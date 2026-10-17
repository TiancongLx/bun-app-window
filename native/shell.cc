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

#include <cstdlib>
#include <deque>
#include <mutex>
#include <string>

#include "webview/webview.h"

namespace {

// ---- 对外常量（与 TS 侧保持字面一致） ----
enum ShellFlag : int {
  SHELL_FLAG_FRAMELESS = 1,
  SHELL_FLAG_TOPMOST = 2,
  SHELL_FLAG_CENTER = 4,
  SHELL_FLAG_RESIZABLE = 8,
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

enum class cmd_kind { eval, title, minimize, maximize_toggle, close, drag, resize };

struct cmd {
  cmd_kind kind;
  std::string arg;
};

webview_t g_webview = nullptr;
HWND g_hwnd = nullptr;        // 顶层窗口（自有或 webview 创建）
HWND g_widget = nullptr;      // WebView2 容器子窗口
WNDPROC g_widget_orig = nullptr;
HANDLE g_ready = nullptr;

bool g_frameless = false;
bool g_shown = false;         // 是否已完成首次显示（用于忽略创建期的 WM_DPICHANGED 建议矩形）
int g_round_state = -1;       // 圆角状态缓存：-1 未知 / 0 直角 / 1 圆角
bool g_resizable = true;
int g_min_w = 320;
int g_min_h = 200;
int g_start_w = 1200;
int g_start_h = 800;

std::mutex g_mu;
std::deque<cmd> g_queue;

std::string g_url;
std::string g_title;
char g_err[1024] = {0};

void set_err(const char *msg) {
  lstrcpynA(g_err, msg ? msg : "", static_cast<int>(sizeof(g_err)));
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

// 推送窗口状态（仅限 UI 线程调用）
// 尺寸对外统一用 96 DPI 逻辑像素（即页面 CSS px），另附物理像素与 dpi，
// 避免前端每次自行按 dpr 折算。
void push_state() {
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
  const int css_w = dpi ? MulDiv(px_w, 96, static_cast<int>(dpi)) : px_w;
  const int css_h = dpi ? MulDiv(px_h, 96, static_cast<int>(dpi)) : px_h;

  char buf[384];
  wsprintfA(buf,
            "{\"t\":\"win\",\"maximized\":%s,\"minimized\":%s,\"focused\":%s,"
            "\"width\":%d,\"height\":%d,\"pixelWidth\":%d,\"pixelHeight\":%d,"
            "\"dpi\":%u,\"frameless\":%s}",
            maxed ? "true" : "false", minned ? "true" : "false",
            focused ? "true" : "false", css_w, css_h, px_w, px_h, dpi,
            g_frameless ? "true" : "false");
  post_json(buf);
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

// ---- 自有窗口的消息处理（仅 frameless 路径使用） ----

LRESULT CALLBACK shell_wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
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

    // 最小尺寸：按窗口样式换算后回报
    RECT minrc{0, 0, g_min_w, g_min_h};
    AdjustWindowRectExForDpi(&minrc, WS_OVERLAPPEDWINDOW, FALSE, 0,
                             GetDpiForWindow(hwnd));
    mmi->ptMinTrackSize.x = minrc.right - minrc.left;
    mmi->ptMinTrackSize.y = minrc.bottom - minrc.top;

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

// ---- UI 线程 ----

void drain(webview_t /*w*/, void * /*arg*/) {
  std::deque<cmd> local;
  {
    std::lock_guard<std::mutex> lock(g_mu);
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
    }
  }
}

void enqueue(cmd_kind kind, std::string arg = {}) {
  if (!g_webview) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_mu);
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
  return hwnd;
}

DWORD WINAPI ui_thread(LPVOID param) {
  const int flags = static_cast<int>(reinterpret_cast<INT_PTR>(param));

  g_frameless = (flags & SHELL_FLAG_FRAMELESS) != 0;
  g_resizable = (flags & SHELL_FLAG_RESIZABLE) != 0;

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
      // 用工作区而非整屏：否则窗口会压到任务栏下方
      MONITORINFO mi{};
      mi.cbSize = sizeof(mi);
      GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTONEAREST), &mi);

      RECT rc{};
      GetWindowRect(g_hwnd, &rc);
      const int w = rc.right - rc.left;
      const int h = rc.bottom - rc.top;
      const int x = mi.rcWork.left + ((mi.rcWork.right - mi.rcWork.left) - w) / 2;
      const int y = mi.rcWork.top + ((mi.rcWork.bottom - mi.rcWork.top) - h) / 2;
      SetWindowPos(g_hwnd, nullptr, x, y, 0, 0,
                   SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
  }

  g_webview = webview_create(1, g_frameless ? static_cast<void *>(g_hwnd) : nullptr);
  if (!g_webview) {
    set_err("webview_create failed (WebView2 runtime missing?)");
    SetEvent(g_ready);
    return 1;
  }

  if (!g_frameless) {
    g_hwnd = static_cast<HWND>(webview_get_window(g_webview));
    webview_set_title(g_webview, g_title.c_str());
    webview_set_size(g_webview, g_start_w, g_start_h, WEBVIEW_HINT_NONE);
  }

  g_widget = static_cast<HWND>(
      webview_get_native_handle(g_webview, WEBVIEW_NATIVE_HANDLE_KIND_UI_WIDGET));

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
    g_shown = true; // 先置位再 ShowWindow：显示后的 WM_DPICHANGED 才允许跟随建议矩形
    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);
    push_state();
  }

  SetEvent(g_ready);

  webview_run(g_webview); // 阻塞直到窗口关闭或 shell_stop()

  webview_destroy(g_webview);
  g_webview = nullptr;
  g_widget = nullptr;
  g_widget_orig = nullptr;
  g_hwnd = nullptr;
  g_shown = false;
  g_round_state = -1; // 窗口已销毁，缓存失效

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
  g_err[0] = 0;

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

__declspec(dllexport) int shell_get_state(void) {
  int state = 0;
  if (!g_hwnd) return 0;
  if (IsZoomed(g_hwnd)) state |= SHELL_STATE_MAXIMIZED;
  if (IsIconic(g_hwnd)) state |= SHELL_STATE_MINIMIZED;
  if (GetForegroundWindow() == g_hwnd) state |= SHELL_STATE_FOCUSED;
  return state;
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
            frame_border_x(), frame_border_y(), g_round_state);

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

__declspec(dllexport) void shell_stop(void) {
  if (g_webview) {
    webview_terminate(g_webview);
  }
}

__declspec(dllexport) const char *shell_error(void) { return g_err; }

} // extern "C"
