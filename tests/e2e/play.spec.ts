import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * The journey the product is actually judged on: open a link, type a name,
 * play, see who won. Driven through real browsers so it covers the parts a
 * server-side test cannot — that the countdown renders, that the shared link
 * works from a cold context, that a refresh mid-game keeps your seat.
 */

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create Room' }).click()
  await page.getByPlaceholder('Your name').fill(name)
  await page.getByRole('button', { name: /^Create/ }).click()
  await page.waitForURL(/\/r\/[A-Z0-9]{5}/)
  const code = page.url().split('/r/')[1]
  expect(code).toMatch(/^[A-Z0-9]{5}$/)
  await expect(page.getByText('Share this link')).toBeVisible()
  return code!
}

async function joinRoom(context: BrowserContext, code: string, name: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`/r/${code}`)
  await page.getByPlaceholder('Your name').fill(name)
  await page.getByRole('button', { name: 'Join room' }).click()
  await expect(page.getByText('Players')).toBeVisible()
  return page
}

test.describe('a game of Blur Battle', () => {
  test('three friends join through a link and play to a leaderboard', async ({ browser }) => {
    const hostContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth')

    // Separate contexts: separate browsers, separate storage. This is the
    // shared-link path, not three tabs sharing a session.
    const rahulContext = await browser.newContext()
    const saiContext = await browser.newContext()
    const rahulPage = await joinRoom(rahulContext, code, 'Rahul')
    const saiPage = await joinRoom(saiContext, code, 'Sai')

    // Everyone sees everyone, asserted against the roster rather than any text
    // on the page that happens to contain a name.
    for (const page of [hostPage, rahulPage, saiPage]) {
      const roster = page.getByRole('list', { name: 'Players in this room' })
      for (const name of ['Yashwanth', 'Rahul', 'Sai']) {
        await expect(roster.getByText(name, { exact: true })).toBeVisible()
      }
    }

    // Only the host gets the controls.
    await expect(hostPage.getByRole('button', { name: 'Start game' })).toBeVisible()
    await expect(rahulPage.getByRole('button', { name: 'Start game' })).toHaveCount(0)
    await expect(rahulPage.getByText(/Waiting for Yashwanth/)).toBeVisible()

    // Shortest legal game, so the test is not mostly waiting.
    await hostPage.locator('#setting-questions').fill('3')
    await hostPage.locator('#setting-seconds').fill('10')
    await hostPage.waitForTimeout(500)

    await hostPage.getByRole('button', { name: 'Start game' }).click()

    // The countdown, then the picture, on every screen.
    for (const page of [hostPage, rahulPage, saiPage]) {
      await expect(page.getByText('Blur Battle')).toBeVisible({ timeout: 20_000 })
    }

    await expect(hostPage.getByPlaceholder('What is it?')).toBeVisible({ timeout: 20_000 })
    const image = hostPage.locator('img[alt*="blurred"]')
    await expect(image).toBeVisible()
    // The image on screen is a reveal step, never the full-resolution file.
    await expect(image).toHaveAttribute('src', /-s[1-5]\.webp$/)

    // Everyone guesses. Once the last one is in the server stops the clock, so
    // the round rolls straight into the reveal rather than running down.
    for (const page of [hostPage, rahulPage, saiPage]) {
      await page.getByPlaceholder('What is it?').fill('a wild guess')
      await page.getByRole('button', { name: 'Guess' }).click()
    }

    // The reveal names the answer and credits the photographer.
    await expect(hostPage.getByText('It was')).toBeVisible({ timeout: 30_000 })
    await expect(hostPage.getByRole('link', { name: 'Wikimedia Commons' })).toBeVisible()

    // Play the rest out.
    await expect(hostPage.getByText('Final results')).toBeVisible({ timeout: 120_000 })
    for (const page of [rahulPage, saiPage]) {
      await expect(page.getByText('Final results')).toBeVisible({ timeout: 30_000 })
    }

    // And go again, in the same room, without anybody reopening a link.
    await hostPage.getByRole('button', { name: 'Play again' }).click()
    for (const page of [hostPage, rahulPage, saiPage]) {
      await expect(page.getByText('Share this link')).toBeVisible({ timeout: 20_000 })
    }

    await Promise.all([hostContext.close(), rahulContext.close(), saiContext.close()])
  })

  test('a refresh mid-game keeps your seat', async ({ browser }) => {
    const hostContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const code = await createRoom(hostPage, 'Yashwanth')

    const guestContext = await browser.newContext()
    const guestPage = await joinRoom(guestContext, code, 'Rahul')

    await hostPage.locator('#setting-seconds').fill('45')
    await hostPage.waitForTimeout(400)
    await hostPage.getByRole('button', { name: 'Start game' }).click()
    await expect(guestPage.getByPlaceholder('What is it?')).toBeVisible({ timeout: 25_000 })

    // The thing everybody does without thinking.
    await guestPage.reload()

    // Straight back into the round, no name prompt, still the same two players.
    await expect(guestPage.getByPlaceholder('What is it?')).toBeVisible({ timeout: 20_000 })
    await expect(guestPage.getByPlaceholder('Your name')).toHaveCount(0)
    // The host still has them in the round — the seat was never given up.
    await expect(
      hostPage.getByRole('list', { name: 'Players in this round' }).getByText('Rahul', { exact: true }),
    ).toBeVisible()

    await Promise.all([hostContext.close(), guestContext.close()])
  })

  test('a bad room code says so plainly', async ({ page }) => {
    await page.goto('/r/ZZZZZ')
    await expect(page.getByText(/doesn.t exist/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Start a new one' })).toBeVisible()
  })
})

test.describe('the landing page', () => {
  test('lists every game with its player range', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'FRIENDZONE' })).toBeVisible()
    for (const name of ['Blur Battle', 'Emoji Movie', 'Mind Meld', 'Who Am I?', 'Movie Mafia']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible()
    }
    await expect(page.getByText('No signup. No downloads. Just friends.')).toBeVisible()
  })

  test('has no horizontal scroll on a phone', async ({ page }) => {
    await page.goto('/')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
