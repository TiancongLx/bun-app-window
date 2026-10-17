/**
 * native-lib.ts — 原生 DLL 的受控加载
 *
 * 背景：`import ... with { type: "file" }` 在打包后指向 Bun 的虚拟路径，
 * 首次 dlopen 时 Bun 会把 DLL 释放到 TMPDIR（Windows 为 %TEMP%），
 * 命名如 `.bun-<uid>-<hash>.dll`。这带来两个问题：
 *   1. %TEMP% 执行常在 AppLocker / WDAC / SRP 环境下被禁；
 *   2. 释放出来的文件不会在退出时清理。
 *
 * 做法：改为从 `Bun.embeddedFiles` 取原始字节，自行释放到
 * %LOCALAPPDATA%\<app>\runtime\ 下，用内容哈希命名，再 dlopen 该副本。
 * 这样既不触碰 %TEMP%，也顺便拿到幂等复用与旧版本清理。
 *
 * 前提：BUN_TMPDIR 只在进程启动时读取（实测运行时设置无效），
 * 所以不能靠改环境变量绕开，必须走这条自管理路径。
 */

import { CString, FFIType, dlopen, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// 保留 import 以确保 DLL 被打进 exe；运行时**不使用**这个路径。
import bundledDllPath from "../build/libshell.dll" with { type: "file" };

export type NativeLibInfo = {
  path: string;
  source: "dev" | "embedded" | "fallback-tmp";
  sha256: string;
  bytes: number;
  reused: boolean;
  pruned: string[];
};

const DLL_PATTERN = /^libshell.*\.dll$/i;

function isPackedRuntime(): boolean {
  // 打包后 import.meta.dir 形如 B:\~BUN\root；开发态是真实目录
  return /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(import.meta.dir) || import.meta.dir.startsWith("/$bunfs/");
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 从 Bun.embeddedFiles 取出内嵌 DLL 的字节；开发态返回 null */
async function readEmbeddedDll(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const files = (Bun as unknown as { embeddedFiles?: ReadonlyArray<Blob & { name: string }> })
    .embeddedFiles;
  if (!files || files.length === 0) return null;

  const hit = files.find((f) => DLL_PATTERN.test(f.name));
  if (!hit) return null;

  const buf = new Uint8Array(await hit.arrayBuffer());
  if (buf.length < 2 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`embedded DLL is not a PE file (${hit.name})`);
  }
  return { name: hit.name, bytes: buf };
}

function runtimeDir(appName: string): string {
  const base =
    process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.length > 0
      ? process.env.LOCALAPPDATA
      : join(homedir(), "AppData", "Local");
  return join(base, appName, "runtime");
}

/**
 * 把字节释放到目标目录，按内容哈希命名，幂等。
 * 先写同目录下的临时名再 rename，避免半截文件被别的实例读到。
 */
function materialize(
  dir: string,
  bytes: Uint8Array,
  sha256: string,
): { path: string; reused: boolean } {
  mkdirSync(dir, { recursive: true });

  const finalName = `libshell-${sha256.slice(0, 16)}.dll`;
  const finalPath = join(dir, finalName);

  if (existsSync(finalPath)) {
    try {
      if (statSync(finalPath).size === bytes.length) {
        return { path: finalPath, reused: true };
      }
    } catch {
      // 读不到就重写
    }
  }

  const tmpName = `.tmp-${process.pid}-${Date.now().toString(36)}.dll`;
  const tmpPath = join(dir, tmpName);
  writeFileSync(tmpPath, bytes);

  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Windows 上目标已存在时 rename 会失败：另一个实例可能刚好抢先写入
    rmSync(tmpPath, { force: true });
    if (!existsSync(finalPath)) throw err;
  }

  return { path: finalPath, reused: false };
}

/** 删掉与当前哈希不符的旧版本；被占用的删除失败则忽略 */
function pruneOldVersions(dir: string, keepName: string): string[] {
  const pruned: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return pruned;
  }

  for (const name of entries) {
    if (!DLL_PATTERN.test(name)) continue;
    if (name === keepName) continue;
    try {
      rmSync(join(dir, name), { force: true });
      pruned.push(name);
    } catch {
      // 正被其它实例加载，跳过
    }
  }
  return pruned;
}

export async function resolveNativeLib(appName = "WebViewShell"): Promise<NativeLibInfo> {
  // 开发态：直接用仓库里的真实文件
  if (!isPackedRuntime()) {
    const p = resolve(bundledDllPath);
    const bytes = statSync(p).size;
    return {
      path: p,
      source: "dev",
      sha256: "",
      bytes,
      reused: false,
      pruned: [],
    };
  }

  const embedded = await readEmbeddedDll();
  if (!embedded) {
    // 没有内嵌资源（例如用 --asset 之外的构建方式）：退回 Bun 的默认释放
    return {
      path: resolve(bundledDllPath),
      source: "fallback-tmp",
      sha256: "",
      bytes: 0,
      reused: false,
      pruned: [],
    };
  }

  const sha256 = sha256Hex(embedded.bytes);
  const dir = runtimeDir(appName);

  try {
    const { path, reused } = materialize(dir, embedded.bytes, sha256);
    const pruned = pruneOldVersions(dir, basename(path));
    return {
      path,
      source: "embedded",
      sha256,
      bytes: embedded.bytes.length,
      reused,
      pruned,
    };
  } catch {
    // %LOCALAPPDATA% 不可写（受限环境）：退回默认释放路径，保证还能跑
    return {
      path: resolve(bundledDllPath),
      source: "fallback-tmp",
      sha256,
      bytes: embedded.bytes.length,
      reused: false,
      pruned: [],
    };
  }
}

// ---- FFI 声明（与原实现一致） ----

export function openNativeLib(path: string) {
  return dlopen(path, {
    shell_start_ex: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    shell_post: { args: [FFIType.ptr], returns: FFIType.i32 },
    shell_title: { args: [FFIType.ptr], returns: FFIType.i32 },
    shell_minimize: { args: [], returns: FFIType.i32 },
    shell_toggle_maximize: { args: [], returns: FFIType.i32 },
    shell_close: { args: [], returns: FFIType.i32 },
    shell_drag: { args: [], returns: FFIType.i32 },
    shell_begin_resize: { args: [FFIType.i32], returns: FFIType.i32 },
    shell_set_min_size: { args: [FFIType.i32, FFIType.i32], returns: FFIType.void },
    shell_get_state: { args: [], returns: FFIType.i32 },
    shell_debug_hittest: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    shell_debug_metrics: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_debug_dpi: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_self_base: { args: [], returns: FFIType.u64 },
    shell_self_path: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_stop: { args: [], returns: FFIType.void },
    shell_error: { args: [], returns: FFIType.ptr },
  });
}

export type NativeLib = ReturnType<typeof openNativeLib>;
export type NativeSymbols = NativeLib["symbols"];

export { ptr } from "bun:ffi";

export const cstr = (s: string) => ptr(new TextEncoder().encode(`${s}\0`));

export function readCStr(p: unknown): string {
  if (!p) return "";
  try {
    return new CString(p as never).toString();
  } catch {
    return "";
  }
}
