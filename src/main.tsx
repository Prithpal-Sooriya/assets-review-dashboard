import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/** Last-resort net: any render-time crash shows an explicit card, not a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="state-card notice notice--error" role="alert" style={{ display: 'block', margin: '2rem auto', maxWidth: '48rem' }}>
          <h2>The dashboard failed to render</h2>
          <p>
            Something went wrong while drawing the dashboard. The embedded data may be malformed —
            rebuild with a freshly generated <code>data/dashboard.json</code> (details are in the
            browser console).
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
