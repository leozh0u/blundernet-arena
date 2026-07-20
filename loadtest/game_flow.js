// k6 load test: each virtual user plays a short game against the engine.
// Exercises the whole pipeline: api -> redis -> sqs -> worker -> redis.
//
//   k6 run loadtest/game_flow.js
//   k6 run -e BASE=http://<alb-dns> -e VUS=50 -e DURATION=2m loadtest/game_flow.js

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Trend } from 'k6/metrics'

const BASE = __ENV.BASE || 'http://localhost:8080'

export const options = {
  vus: Number(__ENV.VUS) || 20,
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    engine_reply_ms: ['p(95)<5000'],
  },
}

// Time from posting a player move to the engine's reply being visible —
// the number that actually matters to a human at the board.
const engineReply = new Trend('engine_reply_ms', true)

const OPENING = ['e2e4', 'd2d4', 'g1f3', 'c2c4']

function waitForPly(id, want, deadlineMs) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    const res = http.get(`${BASE}/api/games/${id}`)
    if (res.status === 200 && res.json('moves').length >= want) {
      return true
    }
    sleep(0.3)
  }
  return false
}

export default function () {
  const create = http.post(`${BASE}/api/games`, JSON.stringify({ color: 'white' }), {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!check(create, { 'game created': (r) => r.status === 201 })) return
  const id = create.json('id')

  const move = OPENING[Math.floor(Math.random() * OPENING.length)]
  const t0 = Date.now()
  const res = http.post(`${BASE}/api/games/${id}/moves`, JSON.stringify({ uci: move }), {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!check(res, { 'move accepted': (r) => r.status === 200 })) return

  if (check(waitForPly(id, 2, 15000), { 'engine replied': (ok) => ok })) {
    engineReply.add(Date.now() - t0)
  }

  http.post(`${BASE}/api/games/${id}/resign`)
  sleep(1)
}
