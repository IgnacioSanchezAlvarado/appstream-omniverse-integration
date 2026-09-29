import { useState, useEffect } from 'react'
import Dashboard from './components/Dashboard'
import { parseTokensFromHash, isAuthenticated, redirectToLogin, logout } from './services/auth'
import './App.css'

function App() {
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check for tokens in URL hash (callback from Cognito)
    const hashTokens = parseTokensFromHash()
    if (hashTokens) {
      setAuthenticated(true)
      setLoading(false)
      return
    }

    // Check for existing stored tokens
    if (isAuthenticated()) {
      setAuthenticated(true)
      setLoading(false)
      return
    }

    // No tokens — redirect to Cognito
    redirectToLogin()
  }, [])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        {/* nosemgrep: jsx-not-internationalized */}
        <p>Redirecting to login...</p>
      </div>
    )
  }

  if (!authenticated) return null

  return <Dashboard onLogout={logout} />
}

export default App
