/**
 * embedded.ts — 可选入口：让 `bun build --compile` 把原生库打进 exe
 *
 * 用法（编译型消费者）：
 *   import { createShell } from "webview-shell";
 *   import { embeddedDll } from "webview-shell/embedded";
 *   const shell = await createShell({ url, embedded: embeddedDll });
 *
 * 也可以只写 `import "webview-shell/embedded";` —— resolve 会自动从
 * `Bun.embeddedFiles` 里找到它，不需要显式传参。
 *
 * 非编译型消费者**不要**导入本文件：它带来的静态 `type: "file"` 依赖
 * 会在没有 dist/libshell.dll 的场景下让打包失败。
 */

// 消费方的 tsconfig 不 include node_modules，因此包内的 assets.d.ts 不会被自动纳入。
// 用三斜线引用把 *.dll 的模块声明钉在本文件上，否则消费者 `bun check` 会报 TS2307。
/// <reference path="./assets.d.ts" />

// 这条 import 的唯一作用是让打包器把 DLL 记为「需要内嵌」
import dllPath from "../../dist/libshell.dll" with { type: "file" };

const DLL_PATTERN = /^libshell.*\.dll$/i;

/** 返回内嵌 DLL 的字节；不在编译产物内或未内嵌时返回 null */
export async function embeddedDll(): Promise<Uint8Array | null> {
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

/** 打包器记录的 DLL 路径（仅排障时有用，运行期不要用它读文件） */
export const embeddedDllPath: string = dllPath;
