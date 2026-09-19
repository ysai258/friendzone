import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pLimit from 'p-limit'
import { editDistance, normalizeAnswer, typoAllowance } from '@friendzone/shared'
import type { ImageQuestion } from '@friendzone/game-engine'
import { CommonsClient, type CommonsFile } from './commons.ts'
import { deriveImage, differenceHash, hammingDistance, isUsable, placeholderImage, STAGE_WIDTHS } from './images.ts'

/**
 * The Blur Battle content pipeline.
 *
 *   fetch -> validate -> deduplicate -> derive -> emit
 *
 * Run it with `--source=wikimedia` to build from Commons, or `--source=sample`
 * to generate stand-in art offline. Both produce exactly the same output
 * shape, so everything downstream — the seed, the server, the game — cannot
 * tell which one ran.
 *
 * Nothing here scrapes. It uses the documented Commons API, identifies itself,
 * limits concurrency, and keeps only files under a licence that permits the
 * derivatives this project makes.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const SUBJECTS = join(ROOT, 'data/seed/image-subjects.json')
const OUT_DIR = join(ROOT, 'data/out')
/** Downloaded originals, kept so re-deriving costs Commons nothing. Gitignored. */
const CACHE_DIR = join(ROOT, 'data/cache')
const IMAGE_DIR = join(ROOT, 'apps/web/public/content/blur')
const PUBLIC_PREFIX = '/content/blur'

interface Subject {
  id: string
  title: string
  aliases: string[]
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
  search: string
}

interface Rejection {
  id: string
  stage: string
  reason: string
}

async function main(): Promise<void> {
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, '').split('=')
      return [key ?? '', value ?? 'true'] as const
    }),
  )
  const source = args.get('source') ?? 'wikimedia'
  const limitCount = Number(args.get('limit') ?? '0')

  const raw = JSON.parse(await readFile(SUBJECTS, 'utf8')) as { items: Subject[] }
  let subjects = raw.items
  if (limitCount > 0) subjects = subjects.slice(0, limitCount)

  console.log(`\nFriendZone content pipeline`)
  console.log(`  source   ${source}`)
  console.log(`  subjects ${subjects.length}\n`)

  const rejections: Rejection[] = []

  // --- Stage 1: answers must be distinguishable from one another ------------
  //
  // This is the check that a purely visual pipeline would miss. The game
  // forgives typos, so two subjects whose titles are within that allowance of
  // each other are effectively the same answer, and a player guessing one
  // would be credited for the other. Caught here rather than in production.
  const usable = rejectConfusableTitles(subjects, rejections)

  // --- Stage 2: fetch -------------------------------------------------------
  const client =
    source === 'wikimedia'
      ? new CommonsClient({ userAgent: process.env['WIKIMEDIA_USER_AGENT'] ?? '' })
      : null

  await mkdir(IMAGE_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })

  // Commons is a shared resource; four at a time is polite and plenty fast.
  const limit = pLimit(source === 'wikimedia' ? 4 : 8)
  const seenHashes: { id: string; hash: bigint }[] = []
  const questions: ImageQuestion[] = []

  const results = await Promise.all(
    usable.map((subject) =>
      limit(async (): Promise<{ subject: Subject; bytes: Buffer; file: CommonsFile | null } | null> => {
        try {
          if (client === null) {
            return { subject, bytes: await placeholderImage(subject.id), file: null }
          }

          // Re-running to change how images are derived should not re-download
          // 78 files from a donation-funded service.
          const cached = await readCache(subject.id)
          if (cached !== null) return { subject, bytes: cached.bytes, file: cached.file }

          const candidates = await client.search(subject.search)
          if (candidates.length === 0) {
            rejections.push({ id: subject.id, stage: 'fetch', reason: 'no freely licensed match' })
            return null
          }

          // Walk candidates until one is actually usable. A single bad file —
          // a 403, an unreadable format, a panorama — costs us that candidate,
          // not the whole subject.
          let lastReason = 'no candidate passed size checks'
          for (const candidate of candidates) {
            try {
              const bytes = await client.download(candidate.imageUrl)
              const check = await isUsable(bytes)
              if (!check.ok) {
                lastReason = check.reason
                continue
              }
              await writeCache(subject.id, bytes, candidate)
              return { subject, bytes, file: candidate }
            } catch (error) {
              lastReason = error instanceof Error ? error.message : 'download failed'
            }
          }
          rejections.push({ id: subject.id, stage: 'validate', reason: lastReason })
          return null
        } catch (error) {
          rejections.push({
            id: subject.id,
            stage: 'fetch',
            reason: error instanceof Error ? error.message : 'unknown',
          })
          return null
        }
      }),
    ),
  )

  // --- Stage 3: deduplicate, derive, emit -----------------------------------
  // Sequential on purpose: duplicate detection compares against everything
  // already accepted, and sharp is CPU-bound anyway.
  for (const result of results) {
    if (result === null) continue
    const { subject, bytes, file } = result

    // Deduplication catches two *fetched* files that are the same photograph —
    // Commons has plenty. Generated placeholders are unique by construction, so
    // hashing them checks something that cannot be wrong and only produces
    // false positives, which silently drop subjects from the offline dataset.
    if (client !== null) {
      // Five bits of 64 differing is a genuinely different picture. Tighter
      // than the textbook threshold for "same image, different compression",
      // because wrongly dropping a subject costs more here than keeping two
      // similar ones.
      const hash = await differenceHash(bytes)
      const clash = seenHashes.find((seen) => hammingDistance(seen.hash, hash) <= 5)
      if (clash !== undefined) {
        rejections.push({ id: subject.id, stage: 'dedupe', reason: `near-identical to ${clash.id}` })
        continue
      }
      seenHashes.push({ id: subject.id, hash })
    }

    const derived = await deriveImage(bytes)

    const stageUrls: string[] = []
    for (let i = 0; i < derived.stages.length; i++) {
      const name = `${subject.id}-s${i + 1}.webp`
      await writeFile(join(IMAGE_DIR, name), derived.stages[i] as Buffer)
      stageUrls.push(`${PUBLIC_PREFIX}/${name}`)
    }
    await writeFile(join(IMAGE_DIR, `${subject.id}-full.webp`), derived.full)
    await writeFile(join(IMAGE_DIR, `${subject.id}-thumb.webp`), derived.thumb)

    questions.push({
      kind: 'image',
      id: subject.id,
      title: subject.title,
      aliases: subject.aliases,
      category: subject.category,
      difficulty: subject.difficulty,
      stageUrls,
      fullUrl: `${PUBLIC_PREFIX}/${subject.id}-full.webp`,
      attribution:
        file === null
          ? {
              source: 'Generated placeholder',
              sourceUrl: 'https://github.com/',
              license: 'CC0',
              licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
              author: null,
            }
          : {
              source: 'Wikimedia Commons',
              sourceUrl: file.descriptionUrl,
              license: file.license,
              licenseUrl: file.licenseUrl,
              author: file.artist,
            },
    })

    process.stdout.write(`  ok  ${subject.title}\n`)
  }

  const outPath = join(OUT_DIR, 'image.json')
  await writeFile(
    outPath,
    `${JSON.stringify(
      {
        kind: 'image',
        version: new Date().toISOString().slice(0, 10),
        source: source === 'wikimedia' ? 'Wikimedia Commons' : 'generated',
        stageWidths: STAGE_WIDTHS,
        items: questions,
      },
      null,
      2,
    )}\n`,
  )

  report(questions.length, subjects.length, rejections, outPath)
  if (questions.length === 0) process.exitCode = 1
}

async function readCache(id: string): Promise<{ bytes: Buffer; file: CommonsFile } | null> {
  try {
    const [bytes, meta] = await Promise.all([
      readFile(join(CACHE_DIR, `${id}.bin`)),
      readFile(join(CACHE_DIR, `${id}.json`), 'utf8'),
    ])
    return { bytes, file: JSON.parse(meta) as CommonsFile }
  } catch {
    return null
  }
}

async function writeCache(id: string, bytes: Buffer, file: CommonsFile): Promise<void> {
  await Promise.all([
    writeFile(join(CACHE_DIR, `${id}.bin`), bytes),
    writeFile(join(CACHE_DIR, `${id}.json`), JSON.stringify(file)),
  ])
}

/**
 * Drop any subject whose answer is close enough to another's that the game's
 * typo forgiveness would accept one for the other.
 */
function rejectConfusableTitles(subjects: Subject[], rejections: Rejection[]): Subject[] {
  const kept: { subject: Subject; forms: string[] }[] = []

  for (const subject of subjects) {
    const forms = [subject.title, ...subject.aliases].map(normalizeAnswer).filter((f) => f.length > 0)
    const clash = kept.find((other) =>
      other.forms.some((a) => forms.some((b) => editDistance(a, b, typoAllowance(a.length)) <= typoAllowance(a.length))),
    )
    if (clash !== undefined) {
      rejections.push({
        id: subject.id,
        stage: 'answers',
        reason: `"${subject.title}" is indistinguishable from "${clash.subject.title}" under the typo allowance`,
      })
      continue
    }
    kept.push({ subject, forms })
  }

  return kept.map((k) => k.subject)
}

function report(accepted: number, total: number, rejections: Rejection[], outPath: string): void {
  console.log(`\n${'-'.repeat(60)}`)
  console.log(`accepted  ${accepted} / ${total}`)
  console.log(`written   ${outPath}`)

  if (rejections.length > 0) {
    console.log(`\nrejected ${rejections.length}:`)
    const byStage = new Map<string, Rejection[]>()
    for (const r of rejections) {
      const list = byStage.get(r.stage) ?? []
      list.push(r)
      byStage.set(r.stage, list)
    }
    for (const [stage, list] of byStage) {
      console.log(`  ${stage} (${list.length})`)
      for (const r of list.slice(0, 8)) console.log(`    ${r.id}: ${r.reason}`)
      if (list.length > 8) console.log(`    ... and ${list.length - 8} more`)
    }
  }
  console.log(`${'-'.repeat(60)}\n`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
