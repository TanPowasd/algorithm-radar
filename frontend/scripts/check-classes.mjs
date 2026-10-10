/* 类名契约检查：抽出 JSX 里用到的 class，与 styles.css 里定义的对照，找出缺样式的类。
   用法：node scripts/check-classes.mjs  （从 frontend/ 目录运行，或项目根运行 npm --prefix frontend run check-classes） */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')
const css = readdirSync(srcDir).filter((name) => name.endsWith('.css')).map((name) => readFileSync(join(srcDir, name), 'utf8')).join('\n')

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(jsx|js)$/.test(name)) out.push(p)
  }
  return out
}

const used = new Map() // class -> Set(相对文件)
for (const f of walk(srcDir)) {
  const rel = f.slice(srcDir.length + 1).replaceAll('\\', '/')
  if (rel === 'styles.css') continue
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const cls of (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (!cls || !/^[a-zA-Z_][\w-]*$/.test(cls) || cls.endsWith('-')) continue
      if (!used.has(cls)) used.set(cls, new Set())
      used.get(cls).add(rel)
    }
  }
  for (const m of text.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set())
    used.get(m[1]).add(rel)
  }
}

const defined = new Set()
for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1])

const missing = [...used.entries()].filter(([cls]) => !defined.has(cls)).sort((a, b) => a[0].localeCompare(b[0]))
console.log(`JSX 用到 ${used.size} 个类名 · styles.css 定义 ${defined.size} 个`)
if (!missing.length) {
  console.log('✓ 没有缺样式的类名')
} else {
  console.log(`\n缺定义的类名（${missing.length}）：`)
  for (const [cls, where] of missing) console.log(`  .${cls.padEnd(22)} ${[...where].slice(0, 3).join(', ')}`)
  process.exitCode = 1
}
