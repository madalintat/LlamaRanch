# LlamaRanch

> A quiet ranch for your local models.

This is the one place that says what LlamaRanch is, why it exists, what it feels
like, and what we will and will not build. If a decision does not serve the one
sentence below, it does not belong here.

## The one sentence

**LlamaRanch lets you run local AI models that actually fit your machine, work
reliably, and can be used from anywhere, without the struggle.**

"Does it fit," "make it fit," "use it anywhere," "doesn't break" are not separate
features. They are that one sentence said from a few angles, the way a car
starts, steers, stops, and stays safe. One machine doing its job.

## Why it exists

Running local AI on your own hardware has two options today, and both are bad:

- **Ollama** hides the herd and dumbs it down. Easy, but you lose control, you
  cannot tune, you cannot see, and it is built for the simple case.
- **Raw llama.cpp** is a stablehand's nightmare. All the power, but you are
  hand-feeding cryptic flags, guessing at GPU layers, and getting crashes with no
  explanation.

Nothing sits in between: a tool that makes local models work well on a normal
machine, keeps you in control, and plugs into everything else. Meanwhile the
reasons to run local keep growing: cost, privacy, and open models getting good.
That gap is the entire reason LlamaRanch exists.

## The magic

The magic is not one clever trick. **The magic is judgment.**

Running a model well takes a thousand small expert decisions: which quant, how
many layers on the GPU, how much context, what cache type, which model for this
task, how to read this model's tool calls. Today you either make those yourself
(hard, expert-only) or a tool makes them badly and hides them from you.

LlamaRanch makes those decisions **for you, correctly, on your machine, and stays
open to everything.** It is the difference between a pile of parts and a machine
that runs. Said shortest: **expert decisions, made for you, kept local, open to
anything.**

## The ranch is the architecture

The metaphor is not decoration. It maps one to one onto the engineering, which is
why the brand is already right.

| The ranch story | The real engineering |
|---|---|
| A ranch of llamas, each one different | Many models, each a different size, quant, and strength |
| Getting them ready, fed, healthy | Loading, fitting, warming, managing memory |
| Knowing which llama is right for the job | Routing the right model to the task |
| Always ready for action, no fuss | Warm pool, fast first token, no flag-wrangling |
| Nothing leaves the valley | Local-first, verifiable privacy |
| You run the ranch, you do not shovel the stalls | You use models, the ranch does the dirty work |

You are the owner, not the laborer. Every llama is fit and ready.

## The three pillars

We do not reinvent the engine. llama.cpp is the engine and it is excellent. We
build the **judgment layer** on top of it, and it comes down to three things.

1. **Power, kept quiet.** All of llama.cpp's depth surfaced and the expert calls
   made for you: the right model fit to your machine and saddled before you ask,
   warm pools and hot-swap, one open OpenAI-compatible address anything can ride,
   and the hard things (guaranteed-valid structured output, speculative decoding)
   set up so they just work.
2. **Privacy you can watch.** Local-first is only worth something if you can
   trust it, so we show it: a LOCAL / ONLINE / OFF tag on every model, tool, and
   connector, a square LED that proves home, a live Ledger, and one switch that
   closes every gate. Nothing leaves the valley, and you can see it.
3. **The truth about your models.** A local model is a shrunk model, and almost
   nothing tells you how much sharpness it lost. Quant Truth measures it on your
   own machine, names the sweet spot for your hardware, and is honest about its
   own limits.

Build on llama.cpp, add judgment, stay open, stay local, show the work. That is
the how.

## What we are NOT

- **Not an agent harness.** Cursor, Cline, Zed, and the rest already ride well.
  We are the ranch they come to, not another rider. Our own chat is the showroom
  that proves the ground is good, not the product.
- **Not a companion.** An assistant that grows with you is someone else's job. We
  are the ground it stands on, and it should run better pointed at LlamaRanch
  than at anything else. We make the endpoint, not the companion.
- **Not a throughput engine.** Multi-tenant serving solves a problem single-user
  local use does not have. Our edge is latency and "it just works," not requests
  per second.
- **Not a pretty wrapper.** Convenience is table stakes. We win on control,
  correctness, and honesty for people who want the herd managed well. The
  interface is calm; the engineering underneath is the point.

## The vibe and the brand

Warm, quiet, legible, local. The aesthetic is the best thing we have, and it
stays.

**Keep, always:**
- The name, the llamas, the ranch, the quiet valley, "nothing leaves the valley."
- Warm paper and ink. A live dither texture used as material, never as
  decoration.
- **Square** status LEDs (never rounded). Part-numbers in mono on list rows.
- Light and dark that follow the system.
- Three bundled, offline typefaces: **Newsreader** (one serif headline per
  surface), **Instrument Sans** (interface), **JetBrains Mono** (labels,
  endpoints, data).
- **Legible privacy everywhere**: every tool and connector wears a LOCAL /
  ONLINE / OFF tag. This is part of the product, not a footnote.

**Voice:**
- Plain and human. Say the true thing simply.
- No em-dashes. No bland AI-cliche copy. Write with a little flavour.
- Show the work. We are the opposite of a black box: the ranch tells you what it
  decided and why, and lets you override.

The story we tell has shifted from "an agent on a ranch" toward what the product
actually is: **the ranch that keeps your models fit, ready, and rideable from
anywhere.** The valley stays quiet. The llamas just got a real ranch hand.

## Where it is going

Same purpose getting deeper over time, not a pile of unrelated features.

- **Now:** the three pillars made real. Power surfaced (structured output,
  speculative decoding, warm swap), privacy you can watch (the live Ledger), and
  Quant Truth measured on your own machine.
- **Soon:** a local RAG stack (embeddings and reranking) wired for you,
  fill-in-the-middle for code, and more dialects so any agent plugs in.
- **Later:** become the substrate every local-AI app rides into (expose the ranch
  over MCP too), auto-pick the fast engine on Mac, and the shared ranch (one
  machine in a home or studio, everyone's apps plug in).

The far star: **the standard way a person runs private AI on hardware they
already own.** When someone says "I run my models locally and it just works,"
they mean they have a ranch.
