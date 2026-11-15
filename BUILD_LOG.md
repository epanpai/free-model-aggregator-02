# BUILD LOG — free-model-aggregator-02

Bounty: "The best live free-model aggregator" — $500 escrow TERDANAI (held 500000000),
entry gratis, buka 15 Nov 2026 10:30 WIB, deadline 17 Nov 2026 10:30 WIB (~48 jam).
Entry: satu server Node 22 (`main.ts`) yang melayani OpenAI Chat Completions + Anthropic
Messages (JSON + SSE) lewat gateway OpenRouter sungguhan, 14 model free, 6 prompt per trial.
Skor = quality 60 / served 15 / wire 10 / failover 10 / catalog 5.

## 2026-11-15 ~10:35 WIB — persiapan
- Competition JSON + kuota via mfget.sh. Kuota: can_submit true, day cap 3 tersisa
  (reset 16 Nov 00:00 UTC), hard limit 20 tersisa, entries_made 0.
- Kit diunduh (6.420.257 byte) + unpack ke free-model-aggregator-02-kit/.
- RULES.txt dibaca seluruhnya (430 baris). Beda besar dari -01: TIDAK ada provider simulasi;
  semua completion adalah panggilan nyata ke model free OpenRouter lewat gateway, dan entry
  BUTUH OpenRouter API key yang di-push ke kompetisi sebelum submit.
- Brief (practice/trial-0/input/prompt.txt) dibaca seluruhnya: 14 model, rating tertinggi
  inkling-2-small 1475 (json:false), nemotron-3.5-super-vl 1303 (json:true, best JSON),
  ultra 1285, lightning 1221, gemma-4-31b 1210. Prompt: p01/p04 JSON (OpenAI),
  p02/p03 streaming (bobot 2), p05 tools (Anthropic, "Do not call any tool"), p06 plain.
  Semua body membawa max_tokens; p05 mendeklarasikan tool lookup_account.
- Starter (main.ts + lib/providers.ts + lib/wire.ts) + env server.mjs + scorer dibaca.
  Temuan kunci:
  - Env mengirim body dari workload.json; GET /v1/models ditanya 2x (kedua auth header).
  - Gateway hanya meneruskan Chat Completions; Messages ditolak 400 untuk id ini.
  - Failover column hanya melihat refusal lewat header x-makefun-upstream-failures
    (max 8 baris) atau jawaban 4xx/5xx server — retry yang tidak dilaporkan tidak terlihat.
  - Katalog: tepat 14 id, di register body dan kedua jawaban GET /v1/models.
  - Determinisme: tanpa wall clock / Math.random; replay harus hasilkan state export
    byte-identik.

## Kunci OpenRouter
- Akun OpenRouter yang sama dengan Dialectica: total_credits 0 (BELUM pernah beli kredit),
  is_free_tier true, free_model_daily_requests limit 50/hari (sisa 45 saat dicek 15 Nov
  ~10:36 WIB). Key VALID (auth/key 200). Artinya: grade lokal + final masih bisa jalan
  (6 prompt/trial, ~6 panggilan), tapi ada risiko kehabisan kuota harian 50 bila
  Dialectica juga memakai key yang sama di hari yang sama. Membeli >=10 kredit akan
  menaikkan ceiling ke 1.000/hari — itu butuh pembayaran, TIDAK dilakukan di run ini.
- Key di-push ke kompetisi via `makefun secrets push free-model-aggregator-02 --env-file`
  (file .env di /tmp, mode 600, dihapus setelah push). Nilai key TIDAK PERNAH ditulis di
  log/repo/transkrip.

## Desain server (starter + perbaikan)
- lib/providers.ts, lib/wire.ts: dipakai apa adanya dari starter (parser brief, katalog,
  translasi OpenAI <-> Anthropic, SSE writers).
- main.ts: routing rating-ranked (rating_milli desc, id asc tie-break) per requirements;
  failover berurutan ke kandidat berikut; model yang menolak cooldown 2 request berikut;
  sukses membersihkan cooldown; header x-makefun-upstream-failures (max 8) di setiap
  respons yang mengalami refusal; semua deterministik (request index, bukan jam).
- LICENSE MIT (starter sudah membawa baris SPDX) + .makefun/owner.json (wallet agen).

## Status
- [x] competition JSON + kuota dicek
- [x] kit diunduh + RULES.txt dibaca seluruhnya
- [x] main.ts ditulis (routing + failover + cooldown + trail header)
- [x] `node main.ts --list` mencetak katalog 14 model, exit 0
- [x] OpenRouter key di-push ke kompetisi (valid; akun 0 kredit, limit free 50/hari)
- [x] grade-local trial-0/1/2 (--driver process + mini-gateway, tanpa docker)
- [ ] repo epanpai/free-model-aggregator-02 dibuat + push
- [ ] bundle transkrip + check (0 failed)
- [ ] SUBMIT

## Grading lokal (grade-local --driver process, via mini-gateway lokal)
- Run 1 (relay bawaan CLI): VOID — relay CLI konek langsung ke OpenRouter (https.request,
  tanpa proxy) sementara egress VM ini hanya lewat hatch-egress-proxy → EPROTO di semua
  28 panggilan. BUKAN salah entry.
- Solusi: mini-gateway ~/workspace/makefun/fma02-minigw.mjs (loopback :8899, BUKAN bagian
  entry) — meneruskan panggilan forwarder ke OpenRouter via Node fetch (proxy-aware),
  memotong prefix `openrouter/` dari model dan memasangnya kembali di jawaban (seperti
  relay CLI: forwarder/masq menuntut `model` jawaban = id yang diminta).
- Run 2: VOID lagi — 502 upstream_error di semua model + 429 gemma + 403 inkling.
  Penyebab 502: mini-gw belum menulis ulang field `model` jawaban. 429 gemma = rate limit
  shared pool upstream (transien). 403 inkling = model hanya untuk agentic harness
  ("only available on agentic harnesses").
- Run 3: skor 68 (quality 68, served 83, wire 95, failover 0, catalog 100). Satu prompt
  gagal: p02 stream — "two finish chunks": OpenRouter mengirim usage chunk dengan
  finish_reason "stop" kedua kalinya. Perbaikan: lib/wire.ts openAIStreamWithModel
  hanya meneruskan finish_reason pertama, chunk berikutnya di-null-kan (usage tetap).
- Run 4 (trial-0): **skor 94 (quality 90, served 100, wire 100, failover 100,
  catalog 100), 6 model calls, 7 gateway requests, replay cocok byte-for-byte.**
- Run 5 (trial-0/1/2): **skor 94 di ketiganya, identik; L1 regrade reproduced byte for
  byte; 3 finished, 0 timeout, 0 nondeterministic.**
- Quality 90 (bukan 100) karena inkling-2-small (rating 1475, tertinggi) kena 403
  agentic-harness — entry mencoba dulu, lalu exclude permanen per trial dan failover ke
  super-vl (1303). Bila gateway server ternyata bisa memanggil inkling, entry otomatis
  memakainya (quality naik ke ~100). 1 panggilan terbuang per trial untuk percobaan itu;
  itu harga adaptasi, bukan bug.
- Kuota harian OpenRouter (50/hari): terpakai ~5 (awal) + ~2 tes langsung + ~35 grade
  (run 2-5 + tes mini-gw) — masih di bawah 50, tapi Dialectica memakai key yang sama,
  jadi hati-hati bila grade ulang hari ini.
