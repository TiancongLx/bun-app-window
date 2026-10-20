/**
 * native-asset.d.ts — `bun-app-window/native` 子路径的类型声明
 *
 * 该子路径的运行时目标是真实的 `dist/libshell.dll`，不是 JavaScript 模块，
 * TypeScript 无从推导它的形状，消费方会得到 `TS2307: Cannot find module`。
 * `package.json` 的 `exports["./native"]` 用 `types` 条件把类型指到本文件，
 * 运行时的 `default` 条件仍指向 DLL 本体——两件事互不干扰。
 *
 * 为什么不做成 `.ts` 包装模块：那会让 `import.meta.resolve("bun-app-window/native")`
 * 返回一个 `.ts` 路径。把 DLL 拷到 exe 旁边是真实用法，解析结果必须仍是 DLL 本身。
 *
 * 消费方用法（`with { type: "file" }` 不能省，否则打包器会试着把 DLL 当模块解析）：
 *
 *     import nativeLibPath from "bun-app-window/native" with { type: "file" };
 */

declare const nativeLibPath: string;
export default nativeLibPath;
