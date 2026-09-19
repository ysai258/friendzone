import { Route, Routes } from 'react-router-dom'
import { Landing } from './screens/Landing.tsx'
import { RoomPage } from './screens/RoomPage.tsx'
import { NotFound } from './screens/NotFound.tsx'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/r/:code" element={<RoomPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
