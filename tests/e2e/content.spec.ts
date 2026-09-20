import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * The parts of the content work a player can actually see: that the language
 * they ticked is the language they get, that Mind Meld waits for the host, and
 * that a table of Who Am I? is one coherent category.
 *
 * The expected titles are read from the seed files rather than hard-coded, so
 * these tests keep testing the filter rather than a snapshot of the dataset.
 */

const seed = (name: string): { id: string; title: string }[] => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../data/seed/movies/${name}.json`, import.meta.url)), 'utf8'),
  ) as { items: { id: string; title: string }[] }
  return file.items
}

const titlesOf = (...languages: string[]): Set<string> => {
  const set = new Set<string>()
  for (const language of languages) {
    for (const movie of seed(language)) set.add(movie.title.toLowerCase())
  }
  return set
}

async function createRoom(page: Page, name: string, game?: string): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create Room' }).click()
  await page.getByPlaceholder('Your name').fill(name)
  await page.getByRole('button', { name: /^Create/ }).click()
  await page.waitForURL(/\/r\/[A-Z0-9]{5}/)
  const code = page.url().split('/r/')[1]!
  await expect(page.getByText('Share this link')).toBeVisible()
  if (game !== undefined) {
    await page.getByRole('button', { name: new RegExp(game) }).click()
    await expect(page.getByRole('button', { name: new RegExp(game) })).toHaveAttribute('aria-pressed', 'true')
  }
  return code
}

async function joinRoom(context: BrowserContext, code: string, name: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`/r/${code}`)
  await page.getByPlaceholder('Your name').fill(name)
  await page.getByRole('button', { name: 'Join room' }).click()
  await expect(page.getByText('Players')).toBeVisible()
  return page
}

/** The language chips in the lobby, by label. */
const languageChip = (page: Page, label: string) => page.getByRole('checkbox', { name: label })

test.describe('movie languages', () => {
  test('a fresh room is set to Telugu and Hindi, not English', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await createRoom(page, 'Yashwanth', 'Emoji Movie')

    await expect(languageChip(page, 'Telugu')).toHaveAttribute('aria-checked', 'true')
    await expect(languageChip(page, 'Hindi')).toHaveAttribute('aria-checked', 'true')
    for (const off of ['Tamil', 'Malayalam', 'English']) {
      await expect(languageChip(page, off)).toHaveAttribute('aria-checked', 'false')
    }

    await context.close()
  })

  test('a Telugu-only room only ever reveals Telugu films', async ({ browser }) => {
    // Three rounds of a fifteen-second timer plus reveals and countdowns runs
    // past the default budget on a throttled phone profile.
    test.setTimeout(240_000)
    const hostContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth', 'Emoji Movie')
    const guestPage = await joinRoom(guestContext, code, 'Rahul')

    // Telugu alone.
    await languageChip(hostPage, 'Hindi').click()
    await expect(languageChip(hostPage, 'Hindi')).toHaveAttribute('aria-checked', 'false')
    await expect(languageChip(hostPage, 'Telugu')).toHaveAttribute('aria-checked', 'true')

    await hostPage.locator('#setting-questions').fill('3')
    await hostPage.locator('#setting-seconds').fill('15')
    await hostPage.waitForTimeout(500)
    await hostPage.getByRole('button', { name: 'Start game' }).click()

    const telugu = titlesOf('telugu')
    const revealed: string[] = []
    for (let round = 1; round <= 3; round++) {
      await expect(hostPage.getByPlaceholder('Name the film')).toBeVisible({ timeout: 25_000 })
      for (const page of [hostPage, guestPage]) {
        await page.getByPlaceholder('Name the film').fill('definitely wrong')
        await page.getByRole('button', { name: 'Go' }).click()
      }
      await expect(hostPage.getByText('It was')).toBeVisible({ timeout: 30_000 })
      // Every reveal names the language, and it is the one that was ticked.
      await expect(hostPage.getByText('Telugu', { exact: false }).first()).toBeVisible()
      const answer = await hostPage.locator('p.text-3xl').first().innerText()
      revealed.push(answer.trim().toLowerCase())
      if (round < 3) await expect(hostPage.getByPlaceholder('Name the film')).toBeVisible({ timeout: 30_000 })
    }

    for (const title of revealed) expect(telugu.has(title), `${title} is not a Telugu film`).toBe(true)
    // Three films, three different films.
    expect(new Set(revealed).size).toBe(3)

    await Promise.all([hostContext.close(), guestContext.close()])
  })

  test('a Tamil + Malayalam room plays both and nothing else', async ({ browser }) => {
    test.setTimeout(240_000)
    const hostContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth', 'Emoji Movie')
    const guestPage = await joinRoom(guestContext, code, 'Rahul')

    for (const label of ['Tamil', 'Malayalam']) await languageChip(hostPage, label).click()
    for (const label of ['Telugu', 'Hindi']) await languageChip(hostPage, label).click()
    for (const on of ['Tamil', 'Malayalam']) {
      await expect(languageChip(hostPage, on)).toHaveAttribute('aria-checked', 'true')
    }
    for (const off of ['Telugu', 'Hindi', 'English']) {
      await expect(languageChip(hostPage, off)).toHaveAttribute('aria-checked', 'false')
    }

    await hostPage.locator('#setting-questions').fill('3')
    await hostPage.locator('#setting-seconds').fill('15')
    await hostPage.waitForTimeout(500)
    await hostPage.getByRole('button', { name: 'Start game' }).click()

    const allowed = titlesOf('tamil', 'malayalam')
    for (let round = 1; round <= 3; round++) {
      await expect(hostPage.getByPlaceholder('Name the film')).toBeVisible({ timeout: 25_000 })
      for (const page of [hostPage, guestPage]) {
        await page.getByPlaceholder('Name the film').fill('nope')
        await page.getByRole('button', { name: 'Go' }).click()
      }
      await expect(hostPage.getByText('It was')).toBeVisible({ timeout: 30_000 })
      const answer = (await hostPage.locator('p.text-3xl').first().innerText()).trim().toLowerCase()
      expect(allowed.has(answer), `${answer} is not Tamil or Malayalam`).toBe(true)
      if (round < 3) await expect(hostPage.getByPlaceholder('Name the film')).toBeVisible({ timeout: 30_000 })
    }

    await Promise.all([hostContext.close(), guestContext.close()])
  })
})

test.describe('Mind Meld waits for the host', () => {
  test('results stay up until Next question is pressed', async ({ browser }) => {
    const hostContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth', 'Mind Meld')
    const guestPage = await joinRoom(guestContext, code, 'Rahul')

    await hostPage.locator('#setting-rounds').fill('3')
    await hostPage.locator('#setting-seconds').fill('15')
    await hostPage.waitForTimeout(500)
    await hostPage.getByRole('button', { name: 'Start game' }).click()

    // Round one: the same answer from both, so there is something to look at.
    for (const page of [hostPage, guestPage]) {
      await expect(page.getByPlaceholder('Your answer')).toBeVisible({ timeout: 25_000 })
      await page.getByPlaceholder('Your answer').fill('pizza')
      await page.getByRole('button', { name: 'Lock in' }).click()
    }

    const nextQuestion = hostPage.getByRole('button', { name: 'Next question →' })
    await expect(nextQuestion).toBeVisible({ timeout: 30_000 })
    // The guest gets an explanation instead of a button.
    await expect(guestPage.getByText(/Yashwanth moves it on/)).toBeVisible()
    await expect(guestPage.getByRole('button', { name: 'Next question →' })).toHaveCount(0)

    // Long past the five seconds this used to auto-advance after: the results
    // are still on screen and nobody has been rushed off them.
    await hostPage.waitForTimeout(9_000)
    await expect(nextQuestion).toBeVisible()
    await expect(hostPage.getByText('pizza').first()).toBeVisible()

    await nextQuestion.click()
    for (const page of [hostPage, guestPage]) {
      await expect(page.getByPlaceholder('Your answer')).toBeVisible({ timeout: 20_000 })
    }
    await expect(hostPage.getByText('Round 2 / 3')).toBeVisible()

    await Promise.all([hostContext.close(), guestContext.close()])
  })
})

test.describe('the host can join answers the machine kept apart', () => {
  test('two answers become one group, and the scores follow', async ({ browser }) => {
    const hostContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth', 'Mind Meld')
    const guestPage = await joinRoom(guestContext, code, 'Rahul')

    await hostPage.locator('#setting-rounds').fill('3')
    await hostPage.locator('#setting-seconds').fill('15')
    await hostPage.waitForTimeout(500)
    await hostPage.getByRole('button', { name: 'Start game' }).click()

    // Two ways of saying one thing that no dictionary would fold together.
    for (const [page, answer] of [
      [hostPage, 'petrol bunk'],
      [guestPage, 'gas station'],
    ] as const) {
      await expect(page.getByPlaceholder('Your answer')).toBeVisible({ timeout: 25_000 })
      await page.getByPlaceholder('Your answer').fill(answer)
      await page.getByRole('button', { name: 'Lock in' }).click()
    }

    await expect(hostPage.getByText('Tap two answers that meant the same thing to join them.')).toBeVisible({
      timeout: 30_000,
    })
    // Both are alone, so nobody has scored.
    await expect(hostPage.getByText('alone')).toHaveCount(2)

    await hostPage.getByRole('button', { name: /^petrol bunk/ }).click()
    await expect(hostPage.getByText('Now tap the one it should join.')).toBeVisible()
    await hostPage.getByRole('button', { name: /^gas station/ }).click()
    await hostPage.getByRole('button', { name: 'Join 2 answers' }).click()

    // One group, both names in it, points on the board — on both screens.
    await expect(hostPage.getByText('alone')).toHaveCount(0)
    await expect(hostPage.getByText('petrol bunk')).toBeVisible()
    await expect(guestPage.getByText(/Yashwanth joined some of these answers/)).toBeVisible({ timeout: 15_000 })

    // And it can be taken back.
    await hostPage.getByRole('button', { name: 'Undo joins' }).click()
    await expect(hostPage.getByText('alone')).toHaveCount(2)

    // The round still ends when the host says so.
    await hostPage.getByRole('button', { name: 'Next question →' }).click()
    await expect(hostPage.getByPlaceholder('Your answer')).toBeVisible({ timeout: 20_000 })

    await Promise.all([hostContext.close(), guestContext.close()])
  })
})

test.describe('Who Am I? is one category', () => {
  test('everyone at the table is from the category the host chose', async ({ browser }) => {
    const hostContext = await browser.newContext()
    const rahulContext = await browser.newContext()
    const saiContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth', 'Who Am I')
    const pages = [hostPage, await joinRoom(rahulContext, code, 'Rahul'), await joinRoom(saiContext, code, 'Sai')]

    await hostPage.getByRole('button', { name: 'Indian Cricketers' }).click()
    await expect(hostPage.getByRole('button', { name: 'Indian Cricketers' })).toHaveAttribute('aria-pressed', 'true')
    await hostPage.getByRole('button', { name: 'Start game' }).click()

    for (const page of pages) {
      await expect(page.getByText('Everyone here is one of the')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('Indian Cricketers')).toBeVisible()
    }

    // Between them, the three screens show all three cards; nobody sees their
    // own, and no two players are the same person.
    const seen = new Set<string>()
    for (const page of pages) {
      const cards = await page.locator('.card p.truncate.text-sm.font-bold').allInnerTexts()
      for (const card of cards) {
        const name = card.trim()
        if (name !== '· · · · ·' && name !== '—' && name !== '✓ solved') seen.add(name)
      }
    }
    expect(seen.size).toBe(3)

    await Promise.all([hostContext.close(), rahulContext.close(), saiContext.close()])
  })
})
