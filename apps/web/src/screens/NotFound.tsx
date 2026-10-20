import { Link } from 'react-router-dom'
import { Button, Card, Logo, Screen } from '../components/ui.tsx'

export function NotFound() {
  return (
    <Screen className="items-center pt-12 text-center">
      <Logo />
      <Card color="sky" soft tilt="right" padding="lg" className="mt-4 flex flex-col items-center gap-2">
        <div className="animate-float text-6xl" aria-hidden>🕳️</div>
        <p className="font-display text-2xl font-extrabold">There is nothing here.</p>
      </Card>
      <Link to="/">
        <Button size="lg" icon="🏠">Back to the games</Button>
      </Link>
    </Screen>
  )
}
