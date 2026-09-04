import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, maxWidth: 640, margin: '80px auto', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', color: 'var(--text)' }}>
          <h2 style={{ color: 'var(--red)', marginTop: 0 }}>页面加载异常</h2>
          <p style={{ color: 'var(--text-2)' }}>该页面在渲染时发生错误，请尝试刷新重试。</p>
          <pre style={{ background: 'var(--surface-3)', padding: 12, borderRadius: 'var(--r-sm)', fontSize: 12, overflowX: 'auto', color: 'var(--red)' }}>
            {this.state.error?.toString()}
          </pre>
          <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
            <button className="btn primary" onClick={() => window.location.reload()}>刷新重试</button>
            <a href="/" className="btn ghost">返回首页</a>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
