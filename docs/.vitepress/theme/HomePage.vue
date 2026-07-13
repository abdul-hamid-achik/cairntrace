<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

const installCommand =
  'git clone https://github.com/abdul-hamid-achik/cairntrace && cd cairntrace && bun install'

const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

async function copyInstallCommand() {
  try {
    await navigator.clipboard.writeText(installCommand)
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch {
    copied.value = false
  }
}

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer)
})
</script>

<template>
  <main class="ct-home" aria-labelledby="ct-home-title">
    <section class="ct-hero">
      <div class="ct-shell ct-hero-grid">
        <div class="ct-hero-copy">
          <p class="ct-eyebrow ct-reveal">Behavioral browser specs for coding agents</p>
          <h1 id="ct-home-title" class="ct-reveal ct-delay-1">
            Your coding agent said it’s done.
            <span>Make the browser prove it.</span>
          </h1>
          <p class="ct-hero-lede ct-reveal ct-delay-2">
            Cairntrace is a local-first browser testing layer for AI coding agents. Define the
            user outcome once, replay it through a real browser, and return failures with the
            evidence needed to fix them.
          </p>

          <div class="ct-hero-actions ct-reveal ct-delay-3">
            <a class="ct-button ct-button-primary" href="/quickstart">
              Run your first spec
              <span aria-hidden="true">→</span>
            </a>
            <a class="ct-button ct-button-secondary" href="https://github.com/abdul-hamid-achik/cairntrace">View on GitHub</a>
          </div>

          <div class="ct-install ct-reveal ct-delay-4" aria-label="Install Cairntrace from source">
            <span class="ct-install-prompt" aria-hidden="true">$</span>
            <code>{{ installCommand }}</code>
            <button type="button" :aria-label="copied ? 'Install command copied' : 'Copy install command'" @click="copyInstallCommand">
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
            <span class="visually-hidden" aria-live="polite">{{ copied ? 'Install command copied to clipboard.' : '' }}</span>
          </div>

          <p class="ct-install-note ct-reveal ct-delay-4">
            Open source. MIT licensed. Runs from source with Bun.
          </p>
        </div>

        <div class="ct-terminal-wrap ct-reveal ct-delay-2" aria-label="Example Cairntrace browser spec and passing run">
          <div class="ct-terminal">
            <div class="ct-terminal-bar">
              <div class="ct-terminal-dots" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
              <span>flows/orders.yml</span>
              <span class="ct-terminal-status">contract locked</span>
            </div>
            <pre class="ct-code" aria-label="Cairntrace YAML example"><code><span class="ct-code-key">version:</span> <span class="ct-code-number">1</span>
<span class="ct-code-key">name:</span> orders_filter
<span class="ct-code-key">intent:</span> an admin can find failed orders

<span class="ct-code-key">session:</span>
  <span class="ct-code-key">resume:</span> admin

<span class="ct-code-key">outcomes:</span>
  - <span class="ct-code-key">id:</span> failed_orders_visible
    <span class="ct-code-key">description:</span> only failed orders remain
    <span class="ct-code-key">verify:</span>
      <span class="ct-code-key">text:</span> { <span class="ct-code-key">contains:</span> <span class="ct-code-string">"Payment failed"</span> }

<span class="ct-code-key">steps:</span>
  - <span class="ct-code-key">open:</span> { <span class="ct-code-key">path:</span> /orders, <span class="ct-code-key">waitUntil:</span> networkidle }
  - <span class="ct-code-key">click:</span> { <span class="ct-code-key">by:</span> role, <span class="ct-code-key">role:</span> button, <span class="ct-code-key">name:</span> <span class="ct-code-string">"Failed"</span> }</code></pre>
            <div class="ct-run-result">
              <div class="ct-run-command"><span aria-hidden="true">$</span> cairn run flows/orders.yml --cold-start --json</div>
              <div class="ct-result-row">
                <span class="ct-result-check" aria-hidden="true">✓</span>
                <strong>passed</strong>
                <span>1 outcome · 2 steps · 3.8s</span>
              </div>
              <div class="ct-result-artifact">report.html · agent_context.md · outcomes/</div>
            </div>
          </div>
          <div class="ct-terminal-caption">
            <span>Intent stays fixed</span>
            <span>Steps can be repaired</span>
            <span>Evidence stays local</span>
          </div>
        </div>
      </div>
    </section>

    <section class="ct-proof" aria-label="Cairntrace product facts">
      <div class="ct-shell ct-proof-grid">
        <div>
          <span>Local-first</span>
          <strong>Your browser state and run evidence stay on your machine.</strong>
        </div>
        <div>
          <span>Agent-neutral</span>
          <strong>One CLI, MCP surface, and artifact shape for every harness.</strong>
        </div>
        <div>
          <span>Real browsers</span>
          <strong>Use agent-browser by default or switch to Playwright.</strong>
        </div>
        <div>
          <span>Typed outcomes</span>
          <strong>Assert UI, URL, network, console, files, JSON, and more.</strong>
        </div>
      </div>
    </section>

    <section class="ct-section ct-problem-section">
      <div class="ct-shell ct-problem-grid">
        <div class="ct-section-heading">
          <p class="ct-kicker">The missing acceptance layer</p>
          <h2>A green build is not proof the user journey works.</h2>
          <p>
            Coding agents can change the code, run unit tests, and still miss a broken checkout,
            an empty dashboard, or a button that no longer responds. Cairntrace moves the final
            check into the browser and makes its result legible to the next agent.
          </p>
          <a class="ct-text-link" href="/authoring">Read the contract-first authoring guide <span aria-hidden="true">→</span></a>
        </div>

        <figure class="ct-contract-figure">
          <div class="ct-contract-row ct-contract-fixed">
            <span class="ct-contract-index">01</span>
            <div>
              <strong>Behavior contract</strong>
              <p><code>intent + outcomes</code> define what success means.</p>
            </div>
            <span class="ct-contract-tag">fixed</span>
          </div>
          <div class="ct-contract-connector" aria-hidden="true"><span></span></div>
          <div class="ct-contract-row">
            <span class="ct-contract-index">02</span>
            <div>
              <strong>Repairable path</strong>
              <p><code>steps</code> are executable hints, not the contract itself.</p>
            </div>
            <span class="ct-contract-tag">editable</span>
          </div>
          <div class="ct-contract-connector" aria-hidden="true"><span></span></div>
          <div class="ct-contract-row">
            <span class="ct-contract-index">03</span>
            <div>
              <strong>Evidence pack</strong>
              <p>Reports, snapshots, console, network, and outcome files.</p>
            </div>
            <span class="ct-contract-tag">portable</span>
          </div>
          <figcaption>One behavioral promise, replayed and explained end to end.</figcaption>
        </figure>
      </div>
    </section>

    <section class="ct-workflow-section">
      <div class="ct-shell">
        <div class="ct-workflow-heading">
          <div>
            <p class="ct-kicker ct-kicker-light">A tighter agent loop</p>
            <h2>Specify. Replay. Repair.</h2>
          </div>
          <p>
            Cairntrace gives the agent a deterministic route from product intent to browser
            evidence without coupling the spec to one model or one test runner.
          </p>
        </div>

        <ol class="ct-timeline">
          <li>
            <span class="ct-timeline-number">01</span>
            <div>
              <h3>Declare the outcome</h3>
              <p>Write the intent and typed observables before scripting the clicks.</p>
              <code>cairn spec verify flows/checkout.yml --stamp</code>
            </div>
          </li>
          <li>
            <span class="ct-timeline-number">02</span>
            <div>
              <h3>Replay from a clean browser</h3>
              <p>Use a login action, checkpoint, or deterministic precondition for cold-start replay.</p>
              <code>cairn run flows/checkout.yml --cold-start --json</code>
            </div>
          </li>
          <li>
            <span class="ct-timeline-number">03</span>
            <div>
              <h3>Hand the failure back</h3>
              <p>Read the focused agent context, inspect the evidence, and repair only the path.</p>
              <code>cairn context latest</code>
            </div>
          </li>
        </ol>
      </div>
    </section>

    <section class="ct-section ct-capabilities-section">
      <div class="ct-shell">
        <div class="ct-capabilities-heading">
          <div>
            <p class="ct-kicker">Built for work that survives the demo</p>
            <h2>A browser spec your whole toolchain can understand.</h2>
          </div>
          <p>
            Human-readable contracts at authoring time. Stable machine-readable output at run
            time. Rich evidence when the browser disagrees.
          </p>
        </div>

        <div class="ct-mosaic">
          <article class="ct-mosaic-item ct-mosaic-contract">
            <span class="ct-mosaic-label">Contract safety</span>
            <h3>Change the route without moving the finish line.</h3>
            <p>
              A contract hash covers <code>intent + outcomes</code>. Healing can rewrite drifted
              steps, but it cannot silently weaken what the spec promises.
            </p>
            <div class="ct-hash" aria-label="Example contract hash">
              <span>contractHash</span>
              <code>sha256:98b7…4a21</code>
              <strong>verified</strong>
            </div>
          </article>

          <article class="ct-mosaic-item ct-mosaic-backends">
            <span class="ct-mosaic-label">Backend choice</span>
            <h3>Agent workflow now. Playwright when you need it.</h3>
            <ul>
              <li><span>agent-browser</span><strong>default</strong></li>
              <li><span>Playwright</span><strong>traces · video · CI</strong></li>
              <li><span>Mock</span><strong>fast offline tests</strong></li>
            </ul>
          </article>

          <article class="ct-mosaic-item ct-mosaic-evidence">
            <span class="ct-mosaic-label">Repair-ready evidence</span>
            <h3>Start with the answer, then drill into the trace.</h3>
            <div class="ct-evidence-tree" aria-label="Run artifact structure">
              <span>run/checkout-2026…</span>
              <span>├─ <strong>agent_context.md</strong></span>
              <span>├─ <strong>report.html</strong></span>
              <span>├─ outcomes/</span>
              <span>├─ snapshots/</span>
              <span>└─ network/ + console/</span>
            </div>
          </article>

          <article class="ct-mosaic-item ct-mosaic-interface">
            <span class="ct-mosaic-label">Stable agent interface</span>
            <h3>No Claude branch. No Codex shim. No vendor lock-in.</h3>
            <p>
              CLI commands support JSON, YAML, and Markdown. MCP tools mirror the same surface,
              so any capable coding agent can author, run, and read the same spec.
            </p>
            <div class="ct-interface-row" aria-label="Supported interfaces">
              <span>CLI</span><span>MCP</span><span>JSON</span><span>YAML</span><span>MD</span>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="ct-section ct-audience-section">
      <div class="ct-shell ct-audience-grid">
        <div class="ct-section-heading">
          <p class="ct-kicker">Use it where confidence is expensive</p>
          <h2>Give every feature task a real browser definition of done.</h2>
          <p>
            Cairntrace fits the moment between “the code compiles” and “ship it.” Keep the spec
            beside the feature, let the agent run it while working, and preserve the evidence for
            review or CI.
          </p>
        </div>
        <ul class="ct-use-cases">
          <li>
            <span>01</span>
            <div><strong>Agent-built features</strong><p>Verify the user-visible outcome before the task is called complete.</p></div>
          </li>
          <li>
            <span>02</span>
            <div><strong>High-value workflows</strong><p>Cover login, checkout, imports, dashboards, and multi-step operations.</p></div>
          </li>
          <li>
            <span>03</span>
            <div><strong>Regression repair</strong><p>Compare the browser state and patch locator drift without rewriting intent.</p></div>
          </li>
          <li>
            <span>04</span>
            <div><strong>Human review</strong><p>Open a self-contained report instead of reconstructing the run from raw logs.</p></div>
          </li>
        </ul>
      </div>
    </section>

    <section class="ct-section ct-faq-section">
      <div class="ct-shell ct-faq-grid">
        <div class="ct-section-heading ct-faq-heading">
          <p class="ct-kicker">Questions, answered</p>
          <h2>What teams ask before the first run.</h2>
          <p>Still evaluating the fit? The docs stay concrete and the repository is public.</p>
          <a class="ct-text-link" href="https://github.com/abdul-hamid-achik/cairntrace">Inspect the source on GitHub <span aria-hidden="true">→</span></a>
        </div>

        <div class="ct-faq-list">
          <details open>
            <summary>What is Cairntrace?</summary>
            <p>
              Cairntrace is a local-first behavioral browser-spec layer for coding agents. A YAML
              spec defines the product intent, the observable outcomes, and a repairable sequence
              of browser steps.
            </p>
          </details>
          <details>
            <summary>Is Cairntrace a replacement for Playwright?</summary>
            <p>
              No. Cairntrace adds a contract and agent-readable evidence layer. It can use
              Playwright as a backend and export stable specs to Playwright when conventional CI
              tests are the better destination.
            </p>
          </details>
          <details>
            <summary>Which coding agents can use it?</summary>
            <p>
              Any agent that can call a CLI or MCP server can use the same Cairntrace surface.
              There are no product-specific branches for Codex, Claude Code, Cursor, or OpenCode.
            </p>
          </details>
          <details>
            <summary>Does run data leave my machine?</summary>
            <p>
              Normal runs are local-first. Browser state and artifact packs are written locally.
              Optional integrations only run when you configure or invoke them.
            </p>
          </details>
          <details>
            <summary>How does it handle UI drift?</summary>
            <p>
              Semantic locators fail with diagnostics, and the healer can propose step changes
              from fresh browser snapshots. The contract hash prevents those repairs from silently
              changing the intended outcome.
            </p>
          </details>
        </div>
      </div>
    </section>

    <section class="ct-final-section">
      <div class="ct-shell ct-final-card">
        <div>
          <p class="ct-kicker ct-kicker-light">The browser gets the final word</p>
          <h2>Turn “looks done” into evidence.</h2>
          <p>Clone Cairntrace, run the demo flow, and give your next coding task a browser contract.</p>
        </div>
        <div class="ct-final-actions">
          <a class="ct-button ct-button-light" href="/quickstart">Start the quickstart <span aria-hidden="true">→</span></a>
          <a class="ct-button ct-button-ghost" href="/agents">Connect an agent</a>
        </div>
      </div>
    </section>
  </main>
</template>
