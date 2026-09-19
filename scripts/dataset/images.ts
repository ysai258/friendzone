import sharp from 'sharp'

/**
 * Image derivation for Blur Battle.
 *
 * The reveal ladder is generated here rather than in the browser, and that is a
 * security decision as much as a performance one: if the client held the sharp
 * image and applied a CSS blur, the answer would be one devtools panel away.
 * Each step is a separate file, and the server only ever hands out the step a
 * round has actually reached.
 *
 * The blur is done by downscaling and scaling back up rather than by a large
 * gaussian. Destroying the pixels is the point — a gaussian is reversible
 * enough to be worth attacking, and pixelation also reads better on a phone,
 * since shape and colour survive while detail genuinely does not.
 */

export const STAGE_WIDTHS = [10, 20, 44, 96, 220] as const
export const OUTPUT_WIDTH = 1024
export const THUMB_WIDTH = 320

export interface DerivedImage {
  stages: Buffer[]
  full: Buffer
  thumb: Buffer
  width: number
  height: number
}

export async function deriveImage(input: Buffer): Promise<DerivedImage> {
  // Normalise first: one orientation, one colour space, one known size, so
  // every stage below is derived from the same picture.
  const base = sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: OUTPUT_WIDTH, height: OUTPUT_WIDTH, fit: 'cover', position: 'attention' })

  const normalised = await base.toColorspace('srgb').webp({ quality: 88 }).toBuffer()
  const meta = await sharp(normalised).metadata()

  const stages = await Promise.all(
    STAGE_WIDTHS.map(async (width) => {
      // Two separate passes, deliberately. Calling .resize() twice on one sharp
      // pipeline does not downscale and then upscale — the second call replaces
      // the first, and the result is the original at full detail. Rendering the
      // small image to a buffer first is what actually destroys the pixels.
      const small = await sharp(normalised)
        .resize({ width, height: width, fit: 'cover', kernel: 'cubic' })
        .png()
        .toBuffer()

      // Blur scaled to the block size, so every step is softened by the same
      // amount relative to how much detail it still has.
      const sigma = Math.min(60, Math.max(0.3, OUTPUT_WIDTH / width / 6))

      return sharp(small)
        .resize({ width: OUTPUT_WIDTH, height: OUTPUT_WIDTH, fit: 'fill', kernel: 'cubic' })
        .blur(sigma)
        .webp({ quality: 70 })
        .toBuffer()
    }),
  )

  const thumb = await sharp(normalised)
    .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: 'cover' })
    .webp({ quality: 80 })
    .toBuffer()

  return { stages, full: normalised, thumb, width: meta.width, height: meta.height }
}

/**
 * Difference hash. Downscale to 9x8 grey and record, for each pair of
 * horizontally adjacent pixels, whether the left is brighter than the right.
 *
 * Chosen over the more obvious average hash after that one produced nonsense
 * here: aHash asks "is this pixel brighter than the image mean", so two
 * photographs that are mostly bright sky over a dark subject score as
 * near-identical whatever the subject is. It confidently called the Statue of
 * Liberty a duplicate of the Eiffel Tower. dHash encodes local gradients
 * instead of global brightness, which is what actually distinguishes one
 * silhouette from another.
 */
export async function differenceHash(input: Buffer): Promise<bigint> {
  const width = 9
  const height = 8
  const raw = await sharp(input).greyscale().resize(width, height, { fit: 'fill' }).raw().toBuffer()

  let hash = 0n
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = raw[y * width + x] as number
      const right = raw[y * width + x + 1] as number
      hash <<= 1n
      if (left > right) hash |= 1n
    }
  }
  return hash
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b
  let count = 0
  while (diff > 0n) {
    count += Number(diff & 1n)
    diff >>= 1n
  }
  return count
}

/** Reject images too small or too lopsided to survive a square crop. */
export async function isUsable(input: Buffer, minWidth = 640): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const meta = await sharp(input).metadata()
    const { width, height } = meta
    if (width < minWidth || height < minWidth) return { ok: false, reason: `too small (${width}x${height})` }
    const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height))
    if (ratio > 2.2) return { ok: false, reason: `too lopsided (${ratio.toFixed(1)}:1)` }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `unreadable (${error instanceof Error ? error.message : 'unknown'})` }
  }
}

/**
 * Offline stand-in. Lets the whole pipeline, the seed and the game run with no
 * network at all — the shapes are nonsense, but the mechanics are identical, so
 * a contributor can play the game before they have fetched a single photo.
 */
export async function placeholderImage(seedText: string): Promise<Buffer> {
  let hash = 0
  for (let i = 0; i < seedText.length; i++) hash = (Math.imul(hash, 31) + seedText.charCodeAt(i)) | 0
  const bits = (shift: number, mod: number): number => Math.abs(hash >> shift) % mod

  const hue = Math.abs(hash) % 360
  const hue2 = (hue + 90 + bits(11, 180)) % 360
  const angle = bits(13, 4)

  // Enough structure that two of these do not look alike to a perceptual hash
  // at 9x8 greyscale: varying gradient direction, a scattered field of shapes,
  // and a band whose position and thickness both come from the seed.
  const shapes: string[] = []
  const count = 4 + bits(3, 5)
  for (let i = 0; i < count; i++) {
    const h = hash + i * 2654435761
    const x = Math.abs(h >> 2) % OUTPUT_WIDTH
    const y = Math.abs(h >> 8) % OUTPUT_WIDTH
    const r = 60 + (Math.abs(h >> 14) % 220)
    const shade = (hue + 40 + (Math.abs(h >> 5) % 280)) % 360
    shapes.push(
      i % 2 === 0
        ? `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${shade},80%,${45 + (Math.abs(h >> 17) % 35)}%)" opacity="0.7"/>`
        : `<rect x="${x}" y="${y}" width="${r * 2}" height="${r}" rx="${r / 4}" fill="hsl(${shade},70%,${35 + (Math.abs(h >> 19) % 40)}%)" opacity="0.6"/>`,
    )
  }

  const bandY = bits(21, OUTPUT_WIDTH - 200)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_WIDTH}" height="${OUTPUT_WIDTH}">
    <defs><linearGradient id="g" x1="${angle % 2}" y1="${angle < 2 ? 0 : 1}" x2="${1 - (angle % 2)}" y2="${angle < 2 ? 1 : 0}">
      <stop offset="0%" stop-color="hsl(${hue},70%,55%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},65%,30%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    ${shapes.join('')}
    <rect x="0" y="${bandY}" width="${OUTPUT_WIDTH}" height="${80 + bits(23, 160)}" fill="hsl(${(hue + 180) % 360},60%,25%)" opacity="0.55"/>
  </svg>`

  return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer()
}
