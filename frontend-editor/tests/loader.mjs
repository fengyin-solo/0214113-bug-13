// 测试用 loader：让 Node 能解析 Vite 风格的无扩展名相对导入
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
    const base = new URL(specifier, context.parentURL)
    for (const ext of ['.js', '.mjs', '.vue']) {
      const candidate = fileURLToPath(base) + ext
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
