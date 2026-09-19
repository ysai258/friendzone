import { Link } from 'react-router-dom'
import { Button, Logo, Screen } from '../components/ui.tsx'

export function NotFound() {
  return (
    <Screen className="items-center pt-20 text-center">
      <Logo />
      <p className="text-lg text-muted">There is nothing here.</p>
      <Link to="/">
        <Button size="lg">Back to the games</Button>
      </Link>
    </Screen>
  )
}
