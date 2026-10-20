/**
 * resolve.ts — 定位可加载的 libshell.dll
 *
 * 与旧实现的差别（这是「可作依赖包」的关键）：
 * 旧实现把 `import dll from "../build/libshell.dll" with { type: "file" }` 写死，
 * 路径相对仓库结构；装进 node_modules 后会指向 `node_modules/build/`，必崩。
 * 现在改为按「包自身根目录」解析，仓库结构与安装位置都不影响。
 *
 * 解析优先级：
 *   1. options.nativeLibPath          显式指定，跳过一切推断
 *   2. 编译产物 + 内嵌字节            释放到 %LOCALAPPDATA%\<appName>\runtime，内容哈希命名
 *   3. 编译产物 + 可执行文件同级       exe 旁放 libshell.dll（无需内嵌）
 *   4. 开发态                         包根 build/libshell.dll → dist/libshell.dll
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { NativeLibInfo } from "./types";

const DLL_PATTERN = /^libshell.*\.dll$/i;

/** 包根目录：src/shell → 上两级。打包态下该值不可用于文件系统访问。 */
const PKG_ROOT = resolve(import.meta.dir, "..", "..");

/** 从 node_modules 里被引用时，来源应报 package 而不是 dev */
const INSTALLED = /[\\/]node_modules[\\/]/i.test(PKG_ROOT);

/** 是否运行在 `bun build --compile` 产物内 */
export function isPackedRuntime(): boolean {
  return (
    /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(import.meta.dir) ||
    import.meta.dir.startsWith("/$bunfs/")
  );
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function runtimeDir(appName: string): string {
  const base =
    process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.length > 0
      ? process.env.LOCALAPPDATA
      : join(homedir(), "AppData", "Local");
  return join(base, appName, "runtime");
}

function fromPath(path: string, source: NativeLibInfo["source"]): NativeLibInfo {
  return {
    path,
    source,
    sha256: "",
    bytes: statSync(path).size,
    reused: false,
    pruned: [],
  };
}

/** 写入目标目录；同名同大小视为可复用，写入走临时文件 + rename 保证原子性 */
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

  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}.dll`);
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

/** 删掉与当前哈希不符的旧副本；正被其它实例占用的删除失败则忽略 */
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

/** 从 Bun.embeddedFiles 找内嵌 DLL；没有则返回 null */
async function readBunEmbedded(): Promise<Uint8Array | null> {
  const files = (Bun as unknown as { embeddedFiles?: ReadonlyArray<Blob & { name: string }> })
    .embeddedFiles;
  if (!files || files.length === 0) return null;

  const hit = files.find((f) => DLL_PATTERN.test(f.name));
  if (!hit) return null;

  const buf = new Uint8Array(await hit.arrayBuffer());
  if (buf.length < 2 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`embedded native library is not a PE file (${hit.name})`);
  }
  return buf;
}

export type ResolveOptions = {
  nativeLibPath?: string;
  appName?: string;
  embedded?: () => Promise<Uint8Array | null>;
};

export async function resolveNativeLib(opts: ResolveOptions = {}): Promise<NativeLibInfo> {
  const appName = opts.appName ?? "BunFrame";

  // 1. 显式指定
  if (opts.nativeLibPath) {
    if (!existsSync(opts.nativeLibPath)) {
      throw new Error(`nativeLibPath does not exist: ${opts.nativeLibPath}`);
    }
    return fromPath(opts.nativeLibPath, "explicit");
  }

  if (isPackedRuntime()) {
    // 2. 内嵌字节 → 释放到用户目录
    const bytes = opts.embedded ? await opts.embedded() : await readBunEmbedded();
    if (bytes) {
      const sha256 = sha256Hex(bytes);
      try {
        const { path, reused } = materialize(runtimeDir(appName), bytes, sha256);
        return {
          path,
          source: "embedded",
          sha256,
          bytes: bytes.length,
          reused,
          pruned: pruneOldVersions(dirname(path), basename(path)),
        };
      } catch {
        // %LOCALAPPDATA% 不可写（受限环境）：继续尝试同级文件
      }
    }

    // 3. 可执行文件同级
    for (const candidate of [
      join(dirname(process.execPath), "libshell.dll"),
      join(dirname(process.execPath), "dist", "libshell.dll"),
    ]) {
      if (existsSync(candidate)) return fromPath(candidate, "package");
    }

    throw new Error(
      "cannot locate libshell.dll in a compiled executable. " +
        "Either place libshell.dll next to the executable, or import " +
        "`bunframe/embedded` so it gets bundled. " +
        `Searched: ${dirname(process.execPath)}`,
    );
  }

  // 4. 开发态 / 包安装态：包根下的 build/ 再 dist/
  const source: NativeLibInfo["source"] = INSTALLED ? "package" : "dev";
  for (const candidate of [
    join(PKG_ROOT, "build", "libshell.dll"),
    join(PKG_ROOT, "dist", "libshell.dll"),
  ]) {
    if (existsSync(candidate)) return fromPath(candidate, source);
  }

  throw new Error(
    "libshell.dll not found. Build the native layer first: " +
      "`pwsh -File native/build.ps1`. " +
      `Searched under ${PKG_ROOT}`,
  );
}
