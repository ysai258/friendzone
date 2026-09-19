/**
 * A very small Wikimedia Commons client.
 *
 * Two things matter here beyond fetching bytes. Commons asks that automated
 * clients identify themselves with a contact address, so the User-Agent is
 * configurable and the pipeline refuses to run anonymously. And every file
 * carries licence metadata that has to travel with the image all the way to the
 * reveal screen — an image whose licence we cannot read is dropped rather than
 * guessed at.
 */

export interface CommonsFile {
  pageId: number
  title: string
  descriptionUrl: string
  imageUrl: string
  width: number
  height: number
  mime: string
  license: string
  licenseUrl: string
  artist: string | null
}

const API = 'https://commons.wikimedia.org/w/api.php'

/**
 * Licences we will ship. Free for any use with attribution, which is what a
 * game showing the image to strangers needs.
 *
 * NonCommercial and NoDerivatives are deliberately absent: this project
 * generates blurred derivatives, and "non-commercial" is a promise we cannot
 * make on behalf of whoever deploys it.
 */
const ALLOWED_LICENCE = /^(cc0|cc[- ]by(?![- ]?(nc|nd))|public domain|pd|no restrictions)/i

export interface CommonsOptions {
  userAgent: string
  fetchImpl?: typeof fetch
}

export class CommonsClient {
  private readonly fetch: typeof fetch

  constructor(private readonly options: CommonsOptions) {
    if (!/\S+@\S+|https?:\/\//.test(options.userAgent)) {
      throw new Error(
        'WIKIMEDIA_USER_AGENT must include a contact URL or email. Wikimedia asks automated clients to identify themselves.',
      )
    }
    this.fetch = options.fetchImpl ?? fetch
  }

  /** Best candidates for a search term, already filtered to usable licences. */
  async search(term: string, limit = 8, thumbWidth = 1280): Promise<CommonsFile[]> {
    const url = new URL(API)
    url.searchParams.set('action', 'query')
    url.searchParams.set('format', 'json')
    url.searchParams.set('formatversion', '2')
    url.searchParams.set('generator', 'search')
    url.searchParams.set('gsrsearch', `${term} filetype:bitmap`)
    url.searchParams.set('gsrnamespace', '6')
    url.searchParams.set('gsrlimit', String(limit))
    url.searchParams.set('prop', 'imageinfo')
    url.searchParams.set('iiprop', 'url|extmetadata|size|mime')
    url.searchParams.set('iiurlwidth', String(thumbWidth))

    const response = await this.fetch(url, { headers: { 'user-agent': this.options.userAgent } })
    if (!response.ok) throw new Error(`commons search failed: ${response.status} ${response.statusText}`)

    const body = (await response.json()) as CommonsSearchResponse
    const pages = body.query?.pages ?? []

    const files: CommonsFile[] = []
    for (const page of pages) {
      const info = page.imageinfo?.[0]
      if (info === undefined) continue

      const meta = info.extmetadata ?? {}
      const license = text(meta['LicenseShortName']) ?? text(meta['License']) ?? ''
      if (!ALLOWED_LICENCE.test(license)) continue
      if (!info.mime.startsWith('image/')) continue

      files.push({
        pageId: page.pageid,
        title: page.title,
        descriptionUrl: info.descriptionurl,
        // The scaled render, not the original: originals on Commons run to tens
        // of megabytes and we immediately downscale anyway. The API appends
        // its own analytics parameters, which the upload host rejects.
        imageUrl: stripQuery(info.thumburl ?? info.url),
        width: info.thumbwidth ?? info.width,
        height: info.thumbheight ?? info.height,
        mime: info.mime,
        license,
        licenseUrl: text(meta['LicenseUrl']) ?? 'https://commons.wikimedia.org/wiki/Commons:Licensing',
        artist: stripHtml(text(meta['Artist'])),
      })
    }
    return files
  }

  async download(url: string): Promise<Buffer> {
    const response = await this.fetch(url, { headers: { 'user-agent': this.options.userAgent } })
    if (!response.ok) throw new Error(`download failed: ${response.status} for ${url}`)
    return Buffer.from(await response.arrayBuffer())
  }
}

interface CommonsSearchResponse {
  query?: {
    pages?: {
      pageid: number
      title: string
      imageinfo?: {
        url: string
        descriptionurl: string
        thumburl?: string
        thumbwidth?: number
        thumbheight?: number
        width: number
        height: number
        mime: string
        extmetadata?: Record<string, { value?: unknown }>
      }[]
    }[]
  }
}

/** Commons hands back URLs carrying utm_* parameters that upload.wikimedia.org
 *  answers with a 403. The bare URL is the one that serves. */
function stripQuery(url: string): string {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

function text(field: { value?: unknown } | undefined): string | null {
  if (field === undefined || typeof field.value !== 'string') return null
  return field.value
}

/** Commons attribution fields are HTML fragments; we want a plain credit line. */
function stripHtml(value: string | null): string | null {
  if (value === null) return null
  const plain = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length === 0 ? null : plain.slice(0, 120)
}
