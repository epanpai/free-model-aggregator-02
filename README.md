# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/epanpai/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/epanpai/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A live OpenAI/Anthropic-compatible aggregator over OpenRouter's free models: every completion it answers comes from a real free model dialled through the grader's gateway.

## Run it

```sh
node main.ts
```

`node main.ts --list` prints the catalog of the fourteen dialable free models and exits. The server answers `POST /v1/chat/completions` (OpenAI wire) and `POST /v1/messages` (Anthropic wire), in JSON and streaming, picks the best-rated free model that meets each prompt's requirements, and fails over to the next candidate when a model refuses. It registers its port and catalog with the trial environment, then polls the environment until the trial is done and exits 0. All model choices are deterministic: no wall clock, no unseeded randomness.

## Bounty

Built for the [make.fun bounty "The best live free-model aggregator"](https://make.fun/bounty/free-model-aggregator-02) ($500 in USDC, escrow-funded). Local dev grade: 94/100 on all three practice trials (quality 90, served 100, wire 100, failover 100, catalog 100), replay byte-identical.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xweavw8m&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
