/*
 * session-bridge-test.cc — 验证「服务进程派生子进程到交互式会话」的可行性
 *
 * 目标场景：OTT 以 LocalSystem 运行在 Session 0，需要把 GUI 任务派生到
 * 用户已登录的 Session 1（有交互式桌面，WebView2 才能创建 controller）。
 *
 * 关键 API：
 *   WTSGetActiveConsoleSessionId  取当前活动的物理控制台会话
 *   WTSQueryUserToken             取该会话登录用户的 token（需 SeTcbPrivilege，仅 LocalSystem）
 *   DuplicateTokenEx              转成主 token
 *   CreateProcessAsUser           以该 token 派生进程，并指定 winsta0\default 桌面
 *
 * 三种模式：
 *   --probe              只报告自身身份与 session
 *   --report <file>      子进程模式：把自身 session/身份写入文件
 *   --spawn <exe> [...]  父进程模式：派生子进程到活动控制台会话
 *
 * 编译：
 *   clang++ -std=c++17 -O2 session-bridge-test.cc -o session-bridge-test.exe \
 *     -lwtsapi32 -luserenv -ladvapi32 -luser32
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <wtsapi32.h>
#include <userenv.h>
#include <sddl.h>

#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

// 取当前进程所在的 session
DWORD self_session() {
  DWORD sid = 0xFFFFFFFF;
  ProcessIdToSessionId(GetCurrentProcessId(), &sid);
  return sid;
}

// 当前进程的账户名（DOMAIN\User）
std::wstring self_user() {
  wchar_t buf[256] = {0};
  DWORD len = 256;
  if (!GetUserNameW(buf, &len)) return L"(unknown)";
  return buf;
}

// 当前进程是否具备某特权（用于判断是不是真的 SYSTEM）
bool has_privilege(const wchar_t *name) {
  HANDLE tok = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return false;
  LUID luid{};
  bool found = false;
  if (LookupPrivilegeValueW(nullptr, name, &luid)) {
    DWORD len = 0;
    GetTokenInformation(tok, TokenPrivileges, nullptr, 0, &len);
    if (len) {
      auto *tp = static_cast<PTOKEN_PRIVILEGES>(std::malloc(len));
      if (tp && GetTokenInformation(tok, TokenPrivileges, tp, len, &len)) {
        for (DWORD i = 0; i < tp->PrivilegeCount; i++) {
          if (tp->Privileges[i].Luid.LowPart == luid.LowPart &&
              tp->Privileges[i].Luid.HighPart == luid.HighPart) {
            found = true;
            break;
          }
        }
      }
      std::free(tp);
    }
  }
  CloseHandle(tok);
  return found;
}

// 确保特权已启用（LocalSystem 默认持有但可能未 enabled）
bool enable_privilege(const wchar_t *name) {
  HANDLE tok = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &tok)) {
    return false;
  }
  TOKEN_PRIVILEGES tp{};
  tp.PrivilegeCount = 1;
  if (!LookupPrivilegeValueW(nullptr, name, &tp.Privileges[0].Luid)) {
    CloseHandle(tok);
    return false;
  }
  tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  const BOOL ok = AdjustTokenPrivileges(tok, FALSE, &tp, sizeof(tp), nullptr, nullptr);
  const DWORD err = GetLastError();  // ERROR_NOT_ALL_ASSIGNED 表示不持有
  CloseHandle(tok);
  return ok && err == ERROR_SUCCESS;
}

void print_identity() {
  std::printf("self.pid        = %lu\n", GetCurrentProcessId());
  std::printf("self.session    = %lu\n", self_session());
  std::wprintf(L"self.user       = %s\n", self_user().c_str());
  std::printf("priv.SeTcb      = %s\n", has_privilege(L"SeTcbPrivilege") ? "present" : "absent");
  std::printf("priv.SeAssign   = %s",
              has_privilege(L"SeAssignPrimaryTokenPrivilege") ? "present" : "absent");
  std::printf("\n");
  std::printf("priv.SeIncrease = %s",
              has_privilege(L"SeIncreaseQuotaPrivilege") ? "present" : "absent");
  std::printf("\n");
}

// 子进程模式：把自身信息写到文件，供父进程核对
int run_report(const wchar_t *path) {
  wchar_t line[512];
  swprintf_s(line, L"child.pid=%lu\r\nchild.session=%lu\r\nchild.user=%s\r\n",
             GetCurrentProcessId(), self_session(), self_user().c_str());

  // 用 UTF-8 写，便于外部读取
  char utf8[2048] = {0};
  WideCharToMultiByte(CP_UTF8, 0, line, -1, utf8, sizeof(utf8), nullptr, nullptr);
  FILE *f = nullptr;
  if (_wfopen_s(&f, path, L"wb") != 0 || !f) {
    std::printf("child: cannot write %ls (err=%lu)\n", path, GetLastError());
    return 3;
  }
  fwrite(utf8, 1, strlen(utf8), f);
  fclose(f);
  std::printf("child: wrote %ls\n", path);
  return 0;
}

// 父进程模式：派生子进程到活动控制台会话
int run_spawn(int argc, wchar_t **argv) {
  if (argc < 3) {
    std::printf("usage: --spawn <exe> [args...]\n");
    return 2;
  }

  print_identity();

  const DWORD consoleSession = WTSGetActiveConsoleSessionId();
  std::printf("console.session = %lu%s\n", consoleSession,
              consoleSession == 0xFFFFFFFF ? " (none)" : "");
  if (consoleSession == 0xFFFFFFFF || consoleSession == 0) {
    std::printf("RESULT: no interactive console session\n");
    return 4;
  }

  // 特权未启用时 WTSQueryUserToken 会返回 ERROR_PRIVILEGE_NOT_HELD
  enable_privilege(L"SeTcbPrivilege");
  enable_privilege(L"SeAssignPrimaryTokenPrivilege");
  enable_privilege(L"SeIncreaseQuotaPrivilege");

  HANDLE userTok = nullptr;
  if (!WTSQueryUserToken(consoleSession, &userTok)) {
    const DWORD err = GetLastError();
    std::printf("WTSQueryUserToken FAILED err=%lu%s\n", err,
                err == ERROR_PRIVILEGE_NOT_HELD ? " (needs SeTcbPrivilege -> run as LocalSystem)" : "");
    std::printf("RESULT: fail\n");
    return 5;
  }
  std::printf("WTSQueryUserToken  ok\n");

  HANDLE primaryTok = nullptr;
  if (!DuplicateTokenEx(userTok, MAXIMUM_ALLOWED, nullptr, SecurityImpersonation,
                        TokenPrimary, &primaryTok)) {
    std::printf("DuplicateTokenEx FAILED err=%lu\n", GetLastError());
    CloseHandle(userTok);
    std::printf("RESULT: fail\n");
    return 6;
  }
  std::printf("DuplicateTokenEx   ok\n");

  // 显式把 token 的 session 设为控制台会话（若 WTSQueryUserToken 给的已正确，
  // 这一步是幂等的；保留它是为了应对某些环境返回租户 session 的情况）
  DWORD tokSession = 0;
  DWORD retLen = 0;
  if (GetTokenInformation(primaryTok, TokenSessionId, &tokSession, sizeof(tokSession), &retLen)) {
    std::printf("token.session   = %lu\n", tokSession);
    if (tokSession != consoleSession) {
      DWORD target = consoleSession;
      if (SetTokenInformation(primaryTok, TokenSessionId, &target, sizeof(target))) {
        std::printf("token.session    -> %lu (remapped)\n", consoleSession);
      } else {
        std::printf("SetTokenInformation FAILED err=%lu\n", GetLastError());
      }
    }
  }

  // 用目标用户的 profile 构造环境块，否则子进程的 HOME/USERPROFILE 会是 SYSTEM 的
  LPVOID envBlock = nullptr;
  if (!CreateEnvironmentBlock(&envBlock, primaryTok, FALSE)) {
    std::printf("CreateEnvironmentBlock FAILED err=%lu (continuing without env)\n", GetLastError());
    envBlock = nullptr;
  } else {
    std::printf("CreateEnvironmentBlock ok\n");
  }

  // 拼接命令行
  std::wstring cmdline;
  for (int i = 2; i < argc; i++) {
    if (i > 2) cmdline += L' ';
    cmdline += argv[i];
  }

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  // 关键：指定交互式桌面，否则子进程进不来 winsta0\default
  si.lpDesktop = const_cast<LPWSTR>(L"winsta0\\default");
  PROCESS_INFORMATION pi{};

  const DWORD flags = CREATE_UNICODE_ENVIRONMENT;
  const BOOL ok = CreateProcessAsUserW(
      primaryTok, nullptr, cmdline.data(), nullptr, nullptr, FALSE, flags,
      envBlock, nullptr, &si, &pi);

  if (!ok) {
    const DWORD err = GetLastError();
    std::printf("CreateProcessAsUser FAILED err=%lu\n", err);
    if (err == ERROR_PRIVILEGE_NOT_HELD) {
      std::printf("  -> caller lacks SeAssignPrimaryToken / SeIncreaseQuota\n");
    }
    if (envBlock) DestroyEnvironmentBlock(envBlock);
    CloseHandle(primaryTok);
    CloseHandle(userTok);
    std::printf("RESULT: fail\n");
    return 7;
  }

  std::printf("CreateProcessAsUser ok  child.pid=%lu\n", pi.dwProcessId);

  // 默认不等待：GUI 进程需要长期存活，父进程等它会阻塞。
  // 需要同步结果时由子进程自己写文件，父进程读文件即可。
  DWORD childSession = 0xFFFFFFFF;
  for (int i = 0; i < 50; i++) {
    if (ProcessIdToSessionId(pi.dwProcessId, &childSession)) break;
    Sleep(20);
  }
  std::printf("child.session   = %lu %s\n", childSession,
              childSession == consoleSession ? "(matches console)" : "(MISMATCH)");

  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  if (envBlock) DestroyEnvironmentBlock(envBlock);
  CloseHandle(primaryTok);
  CloseHandle(userTok);

  std::printf("RESULT: %s\n", childSession == consoleSession ? "ok" : "session-mismatch");
  return childSession == consoleSession ? 0 : 8;
}

} // namespace

int wmain(int argc, wchar_t **argv) {
  SetConsoleOutputCP(CP_UTF8);

  if (argc < 2) {
    std::printf("usage:\n"
                "  --probe\n"
                "  --report <file>\n"
                "  --spawn <exe> [args...]\n");
    return 2;
  }

  const std::wstring mode = argv[1];
  if (mode == L"--probe") {
    print_identity();
    const DWORD cs = WTSGetActiveConsoleSessionId();
    std::printf("console.session = %lu\n", cs);
    return 0;
  }
  if (mode == L"--report") {
    if (argc < 3) return 2;
    return run_report(argv[2]);
  }
  if (mode == L"--spawn") {
    return run_spawn(argc, argv);
  }

  std::printf("unknown mode\n");
  return 2;
}

