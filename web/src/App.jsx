import { useCallback, useEffect, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'

const api = {
  async createGame(color) {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    })
    if (!res.ok) throw new Error('failed to create game')
    return res.json()
  },
  async move(id, uci) {
    const res = await fetch(`/api/games/${id}/moves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uci }),
    })
    return { ok: res.ok, body: await res.json() }
  },
  async resign(id) {
    await fetch(`/api/games/${id}/resign`, { method: 'POST' })
  },
  async stats() {
    const res = await fetch('/api/stats')
    return res.ok ? res.json() : null
  },
}

function wsURL(id) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/games/${id}/ws`
}

function statusLine(state) {
  if (!state) return ''
  if (state.status === 'finished') {
    const won =
      (state.result === '1-0' && state.player_color === 'white') ||
      (state.result === '0-1' && state.player_color === 'black')
    if (state.result === '1/2-1/2') return `Draw — ${state.termination}`
    return won
      ? `You win — ${state.termination}`
      : `BlunderNet wins — ${state.termination}`
  }
  return state.turn === state.player_color ? 'Your move' : 'BlunderNet is thinking…'
}

export default function App() {
  const [state, setState] = useState(null)
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const wsRef = useRef(null)

  useEffect(() => {
    api.stats().then(setStats).catch(() => {})
  }, [state?.status])

  const connect = useCallback((id) => {
    wsRef.current?.close()
    const ws = new WebSocket(wsURL(id))
    ws.onmessage = (ev) => setState(JSON.parse(ev.data))
    ws.onerror = () => setError('connection lost — refresh to resume')
    wsRef.current = ws
  }, [])

  const newGame = async (color) => {
    setError('')
    try {
      const st = await api.createGame(color)
      setState(st)
      connect(st.id)
    } catch (e) {
      setError(e.message)
    }
  }

  const onDrop = (from, to, piece) => {
    if (!state || state.status !== 'ongoing' || state.turn !== state.player_color) {
      return false
    }
    // Server validates for real; chess.js just supplies promotion detection
    // and instant local rejection of obvious illegal drops.
    const probe = new Chess(state.fen)
    let mv
    try {
      mv = probe.move({ from, to, promotion: 'q' })
    } catch {
      return false
    }
    if (!mv) return false
    const uci = from + to + (mv.promotion ? 'q' : '')
    setState({ ...state, fen: probe.fen(), turn: opposite(state.turn) })
    api.move(state.id, uci).then(({ ok, body }) => {
      if (!ok) {
        setError(body.error || 'move rejected')
        setState((s) => ({ ...s }))
      }
    })
    return true
  }

  const opposite = (c) => (c === 'white' ? 'black' : 'white')

  return (
    <div className="app">
      <header>
        <h1>BlunderNet Arena</h1>
        <p className="tagline">Play against a self-trained neural network</p>
      </header>

      {!state && (
        <div className="lobby">
          <p>Choose your side. BlunderNet answers every move from its own training run.</p>
          <div className="buttons">
            <button onClick={() => newGame('white')}>Play White</button>
            <button onClick={() => newGame('black')}>Play Black</button>
          </div>
        </div>
      )}

      {state && (
        <div className="game">
          <div className="status">{statusLine(state)}</div>
          <div className="board">
            <Chessboard
              position={state.fen}
              onPieceDrop={onDrop}
              boardOrientation={state.player_color}
              arePiecesDraggable={state.status === 'ongoing'}
              customDarkSquareStyle={{ backgroundColor: '#4a5568' }}
              customLightSquareStyle={{ backgroundColor: '#cbd5e0' }}
            />
          </div>
          <div className="controls">
            {state.status === 'ongoing' ? (
              <button className="secondary" onClick={() => api.resign(state.id)}>
                Resign
              </button>
            ) : (
              <>
                <button onClick={() => newGame('white')}>Rematch as White</button>
                <button onClick={() => newGame('black')}>Rematch as Black</button>
              </>
            )}
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {stats && stats.total > 0 && (
        <footer>
          {stats.total} games played · engine {stats.engine_wins} · humans{' '}
          {stats.player_wins} · draws {stats.draws}
        </footer>
      )}
    </div>
  )
}
