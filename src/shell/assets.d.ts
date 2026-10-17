/**
 * assets.d.ts — 打包器资源导入的模块声明
 *
 * `with { type: "file" }` 的导入在运行期是字符串路径，但 TypeScript 需要知道
 * 这类模块存在，否则 `import dll from "...dll" with { type: "file" }` 会报 TS2307。
 */

declare module "*.dll" {
  const path: string;
  export default path;
}

declare module "*.html" {
  const content: string;
  export default content;
}
