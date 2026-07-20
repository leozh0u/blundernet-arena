# BlunderNet Arena

Play chess against [BlunderNet](https://github.com/leozh0u/blundernet), a neural network I trained from scratch, at a site built to hold up when many people play at once.

The engine repo answers "can I train a model?" This repo answers a different question: can I serve one? The answer here is a Go service fleet behind a load balancer, with game state in Redis, engine inference decoupled onto queue-fed workers, finished games archived in Postgres, and the whole thing defined in Terraform.

**Stack:** Go, React, PostgreSQL, Redis, SQS, ONNX Runtime, Docker, Terraform, AWS (ALB, ECS Fargate, ElastiCache, RDS)

## Architecture

```
 Browser (React) ──HTTP/WebSocket──▶ ALB ──▶ api fleet (ECS Fargate, autoscaled on CPU)
                                              │        │
                                    live game state,   │ move jobs
                                    pub/sub fanout     ▼
                                              │      SQS ──▶ worker fleet (autoscaled on
                                              ▼                queue depth, ONNX Runtime)
                                            Redis              │
                                              ▲────────────────┘
                                            engine reply, pub/sub
                                              │
                                              ▼
                                          Postgres (finished games, stats)
```

A move makes the following trip. The api validates it against the chess rules, writes the new state to Redis with a compare-and-set, publishes the update, and enqueues a job. A worker picks the job up, runs the position through the network, plays the reply through the same compare-and-set path, and publishes again. Every browser watching the game gets both updates pushed over its WebSocket, whichever api instance it happens to be connected to.

## Design notes

**The api servers hold no state.** Live games exist in Redis with a 24-hour TTL, finished games in Postgres, and the servers themselves only hold WebSocket connections. Any instance can serve any request, which is what lets the fleet scale horizontally and lets a task die mid-game without the player noticing. Cross-instance WebSocket delivery works because every instance subscribes to game events over Redis pub/sub rather than keeping per-game connection registries.

**Inference runs behind a queue on purpose.** An engine move costs real CPU while an HTTP request costs almost none, and the two should not compete for the same cores or scale on the same signal. The api fleet scales on CPU, the worker fleet scales on queue backlog, and a burst of new games turns into queue depth instead of timeouts.

**SQS delivers at least once, so the worker is idempotent.** Each job carries the ply it was created for. A worker that receives a stale or duplicated job (the game moved on, the game ended, a second delivery of the same ply) drops it without side effects. The Redis write is a Lua compare-and-set on the ply, so even two workers racing on the same job cannot both win. There is a test that proves a double delivery moves the engine exactly once.

**Underpromotions are folded into queen promotions.** The policy head indexes moves as from-square times 64 plus to-square, which cannot distinguish promotion pieces. The training pipeline made that tradeoff (it costs well under 1% of moves), so the serving path mirrors it exactly. The board encoding in Go reproduces the Python training encoder plane for plane, and the parity is pinned by tests on both sides of the export.

**No NAT gateway.** The VPC has public subnets only, with isolation done by security groups. Fargate tasks get public IPs so they can pull images, and a NAT gateway would add about $32 a month to serve no traffic. The stack is built to be stood up for a demo and torn down after: `make deploy`, play, `make destroy`.

## Running it locally

Requires Docker. The model artifact is optional; without it the worker uses a small material searcher instead of the network.

```
docker compose up -d --build     # postgres, redis, elasticmq, api, worker
open http://localhost:8080
./scripts/e2e.sh                 # scripted game against the engine
```

To regenerate the model from the engine repo:

```
python scripts/export_onnx.py --repo ../blundernet --out models/blundernet.onnx
```

The export script checks that ONNX Runtime and PyTorch produce identical outputs before it succeeds. On this laptop a single position evaluates in 0.64 ms on CPU, which is why the workers do not need GPUs.

## Load test

`loadtest/game_flow.js` has each virtual user create a game, play an opening move, wait for the engine's reply, and resign. Ten users for 30 seconds on a MacBook against the local compose stack:

```
http_reqs        1165 (37.2/s)     0 failed
http_req_duration            p95 = 14.7 ms
engine_reply_ms              p95 = 326 ms
games completed  237, one worker process
```

The engine reply number is bounded by the test's own 300 ms polling interval; the inference itself is under a millisecond. The same script points at the ALB with `-e BASE=http://<alb-dns>`.

## Deploying

```
cd deploy/terraform
export TF_VAR_db_password=...
make -C ../.. deploy    # terraform apply, build and push images, roll services
make -C ../.. destroy   # tear it all down
```

Terraform creates the VPC, ALB, ECS cluster and services, ElastiCache, RDS, the SQS queue with a dead-letter queue, ECR repositories, IAM roles scoped so the api can only send to the queue and the worker can only consume from it, and CloudWatch log groups. CI validates the configuration on every push.

## Layout

```
cmd/api, cmd/worker      the two binaries
internal/game            chess domain: move lists, legality, outcomes
internal/engine          board encoding, ONNX inference, fallback searcher
internal/store           Redis (live state, CAS, pub/sub) and Postgres (archive)
internal/queue           SQS client, ElasticMQ-compatible for local dev
internal/httpapi         REST + WebSocket handlers, embedded frontend
web/                     React frontend, built into the api binary
deploy/terraform         the AWS stack
loadtest/                k6 scenario
```
