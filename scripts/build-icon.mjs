// Renders brand-logo/v5/final SVGs to PNGs and packs a multi-size Windows .ico.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(repository, 'brand-logo', 'v5', 'final')
const output = path.join(repository, 'windows', 'assets')
const SIZES = [
  ['icon.svg', [256, 128, 64, 48]],
  ['icon-small.svg', [40, 32, 24, 20, 16]],
]

function packIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(image => image.png)])
}

await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge' })
try {
  const images = []
  for (const [file, sizes] of SIZES) {
    const url = pathToFileURL(path.join(source, file)).href
    for (const size of sizes) {
      const page = await browser.newPage({ viewport: { width: size, height: size } })
      await page.goto(url)
      const png = await page.screenshot({ omitBackground: true })
      await page.close()
      await fs.writeFile(path.join(output, `icon-${size}.png`), png)
      images.push({ size, png })
    }
  }
  images.sort((a, b) => b.size - a.size)
  await fs.writeFile(path.join(output, 'yisama.ico'), packIco(images))
  console.log(`Wrote ${path.join(output, 'yisama.ico')} (${images.map(image => image.size).join(', ')})`)
} finally {
  await browser.close()
}
