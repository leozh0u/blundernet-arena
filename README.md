# BlunderNet Arena

A scalable, cloud-native platform for playing chess against [BlunderNet](https://github.com/leozh0u) — my self-trained AlphaZero-style engine.

**Stack (target):** Go · AWS (ECS Fargate, ALB, SQS, ElastiCache, RDS) · Terraform · React

## Why this exists

BlunderNet proves I can train an engine. This project proves I can *serve* it at scale:
a stateless Go API fleet behind a load balancer, CPU-heavy inference decoupled onto an
autoscaling worker fleet via a queue, live game state in Redis, durable state in Postgres,
and the whole stack defined in Terraform.

## Status

🚧 Early scaffolding. Build log and architecture notes to come.
