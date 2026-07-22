import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'

const api = {
  async createGame(color) {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    })
    if (!res.ok) throw new Error('could not start a game')
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

const other = (c) => (c === 'white' ? 'black' : 'white')

// Group the flat UCI list into numbered pairs for the move panel, and
// convert to algebraic (Nf3) which is what chess players actually read.
function movePairs(moves) {
  const board = new Chess()
  const san = moves.map((uci) => {
    const mv = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined,
    })
    return mv ? mv.san : uci
  })
  const pairs = []
  for (let i = 0; i < san.length; i += 2) {
    pairs.push({ n: i / 2 + 1, white: san[i], black: san[i + 1] })
  }
  return pairs
}

function outcome(state) {
  if (state.status !== 'finished') return null
  if (state.result === '1/2-1/2') return { kind: 'draw', title: 'Draw' }
  const playerWon =
    (state.result === '1-0' && state.player_color === 'white') ||
    (state.result === '0-1' && state.player_color === 'black')
  return {
    kind: playerWon ? 'win' : 'loss',
    title: playerWon ? 'You win' : 'BlunderNet wins',
  }
}

export default function App() {
  const [state, setState] = useState(null)
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const wsRef = useRef(null)

  useEffect(() => {
    api.stats().then(setStats).catch(() => {})
  }, [state?.status])

  useEffect(() => () => wsRef.current?.close(), [])

  const connect = useCallback((id) => {
    wsRef.current?.close()
    const ws = new WebSocket(wsURL(id))
    ws.onmessage = (ev) => setState(JSON.parse(ev.data))
    ws.onerror = () => setError('Connection lost. Refresh to resume.')
    wsRef.current = ws
  }, [])

  const newGame = async (color) => {
    setError('')
    setSelected(null)
    try {
      const st = await api.createGame(color)
      setState(st)
      connect(st.id)
    } catch (e) {
      setError(e.message)
    }
  }

  const myTurn = state && state.status === 'ongoing' && state.turn === state.player_color

  const tryMove = (from, to) => {
    if (!myTurn) return false
    // The server is the authority; chess.js here only detects promotions
    // and rejects obviously illegal drops without a round trip.
    const probe = new Chess(state.fen)
    let mv
    try {
      mv = probe.move({ from, to, promotion: 'q' })
    } catch {
      return false
    }
    if (!mv) return false
    setSelected(null)
    setState({ ...state, fen: probe.fen(), turn: other(state.turn) })
    api.move(state.id, from + to + (mv.promotion ? 'q' : '')).then(({ ok, body }) => {
      if (!ok) {
        setError(body.error || 'That move was rejected.')
        setState((s) => ({ ...s }))
      }
    })
    return true
  }

  // Click a piece, then click its destination. Drag works too, but taps
  // are how most people play on a phone.
  const onSquareClick = (square) => {
    if (!myTurn) return
    if (selected === square) return setSelected(null)
    if (selected && tryMove(selected, square)) return
    const piece = new Chess(state.fen).get(square)
    const mine = piece && piece.color === (state.player_color === 'white' ? 'w' : 'b')
    setSelected(mine ? square : null)
  }

  const legalTargets = useMemo(() => {
    if (!selected || !state) return []
    return new Chess(state.fen)
      .moves({ square: selected, verbose: true })
      .map((m) => m.to)
  }, [selected, state])

  const squareStyles = useMemo(() => {
    const styles = {}
    if (selected) {
      styles[selected] = { background: 'rgba(212, 162, 76, 0.45)' }
    }
    for (const sq of legalTargets) {
      styles[sq] = {
        background:
          'radial-gradient(circle, rgba(212,162,76,0.55) 22%, transparent 24%)',
      }
    }
    // Highlight the last move so you can see what the engine just played.
    const last = state?.moves?.[state.moves.length - 1]
    if (last) {
      for (const sq of [last.slice(0, 2), last.slice(2, 4)]) {
        styles[sq] = { ...styles[sq], boxShadow: 'inset 0 0 0 3px rgba(125,211,252,0.5)' }
      }
    }
    return styles
  }, [selected, legalTargets, state])

  const result = state ? outcome(state) : null
  const pairs = state ? movePairs(state.moves) : []

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <span className="mark">♞</span>
          <div>
            <h1>BlunderNet Arena</h1>
            <p>A neural network trained from scratch. Come beat it.</p>
          </div>
        </div>
        {stats && stats.total > 0 && (
          <dl className="scoreboard">
            <div><dt>Games</dt><dd>{stats.total}</dd></div>
            <div><dt>Engine</dt><dd>{stats.engine_wins}</dd></div>
            <div><dt>Humans</dt><dd>{stats.player_wins}</dd></div>
            <div><dt>Draws</dt><dd>{stats.draws}</dd></div>
          </dl>
        )}
      </header>

      {!state ? (
        <section className="lobby">
          <h2>Pick a side</h2>
          <p>
            Every reply comes from BlunderNet running a tree search over its own
            policy and value network. It is not a grandmaster. That is the fun.
          </p>
          <div className="choices">
            <button className="choice" onClick={() => newGame('white')}>
              <span className="pieces">♔</span>
              <span className="label">Play as White</span>
              <span className="sub">You move first</span>
            </button>
            <button className="choice dark" onClick={() => newGame('black')}>
              <span className="pieces">♚</span>
              <span className="label">Play as Black</span>
              <span className="sub">Engine opens</span>
            </button>
          </div>
        </section>
      ) : (
        <main className="game">
          <div className="board-wrap">
            <div className="board">
              <Chessboard
                position={state.fen}
                onPieceDrop={(f, t) => tryMove(f, t)}
                onSquareClick={onSquareClick}
                boardOrientation={state.player_color}
                arePiecesDraggable={state.status === 'ongoing'}
                customBoardStyle={{ borderRadius: '10px' }}
                customDarkSquareStyle={{ backgroundColor: '#8a6a48' }}
                customLightSquareStyle={{ backgroundColor: '#eddab9' }}
                customSquareStyles={squareStyles}
              />
              {result && (
                <div className={`overlay ${result.kind}`}>
                  <div className="verdict">
                    <h2>{result.title}</h2>
                    <p>by {state.termination}</p>
                    <div className="again">
                      <button onClick={() => newGame('white')}>Play White</button>
                      <button className="ghost" onClick={() => newGame('black')}>
                        Play Black
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="panel">
            <div className={`turn ${myTurn ? 'you' : 'engine'}`}>
              {state.status === 'finished' ? (
                <span>Game over</span>
              ) : myTurn ? (
                <span>Your move</span>
              ) : (
                <span className="thinking">
                  BlunderNet is thinking<i /><i /><i />
                </span>
              )}
            </div>

            <div className="moves">
              {pairs.length === 0 ? (
                <p className="empty">No moves yet.</p>
              ) : (
                <ol>
                  {pairs.map((p) => (
                    <li key={p.n}>
                      <span className="num">{p.n}.</span>
                      <span className="san">{p.white}</span>
                      <span className="san">{p.black || ''}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {state.status === 'ongoing' && (
              <button className="ghost wide" onClick={() => api.resign(state.id)}>
                Resign
              </button>
            )}
          </aside>
        </main>
      )}

      {error && <div className="error">{error}</div>}

      <footer className="foot">
        <a href="https://github.com/leozh0u/blundernet-arena">Source</a>
        <span>·</span>
        <a href="https://github.com/leozh0u/blundernet">The engine</a>
      </footer>
    </div>
  )
}
