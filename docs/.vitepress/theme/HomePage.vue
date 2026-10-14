<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { track } from '@vercel/analytics'

type InstallTab = 'brew' | 'npm' | 'bun' | 'curl'
type InstallBox = 'hero' | 'final'
type AgentTab = 'claude' | 'cursor' | 'codex'

const installOptions: { id: InstallTab; label: string; command: string }[] = [
  {
    id: 'brew',
    label: 'Homebrew',
    command: 'brew install abdul-hamid-achik/tap/cairntrace',
  },
  {
    id: 'npm',
    label: 'npm',
    command: 'npm install -g @thelacanians/cairntrace',
  },
  {
    id: 'bun',
    label: 'bun',
    command: 'bun add -g @thelacanians/cairntrace',
  },
  {
    id: 'curl',
    label: 'curl',
    command:
      'curl -fsSL https://raw.githubusercontent.com/abdul-hamid-achik/cairntrace/main/install.sh | bash',
  },
]

const agentOptions: { id: AgentTab; label: string; file: string; code: string }[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    file: 'run in your terminal',
    code: 'claude mcp add cairntrace -- cairn mcp',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: '.cursor/mcp.json',
    code: `{
  "mcpServers": {
    "cairntrace": {
      "command": "cairn",
      "args": ["mcp"]
    }
  }
}`,
  },
  {
    id: 'codex',
    label: 'Codex',
    file: '~/.codex/config.toml',
    code: `[mcp_servers.cairntrace]
command = "cairn"
args = ["mcp"]`,
  },
]

const installBoxes: InstallBox[] = ['hero', 'final']
const activeInstall = reactive<Record<InstallBox, InstallTab>>({ hero: 'brew', final: 'brew' })
const copied = reactive<Record<InstallBox, boolean>>({ hero: false, final: false })
const resetTimers: Partial<Record<InstallBox, ReturnType<typeof setTimeout>>> = {}
const activeAgent = ref<AgentTab>('claude')
const activeAgentOption = computed(
  () => agentOptions.find((option) => option.id === activeAgent.value) ?? agentOptions[0],
)

function installFor(box: InstallBox) {
  return installOptions.find((option) => option.id === activeInstall[box]) ?? installOptions[0]
}

async function copyInstall(box: InstallBox) {
  const option = installFor(box)
  try {
    await navigator.clipboard.writeText(option.command)
    copied[box] = true
    track('install_copy', { location: box, method: option.id })
    clearTimeout(resetTimers[box])
    resetTimers[box] = setTimeout(() => {
      copied[box] = false
    }, 1800)
  } catch {
    copied[box] = false
  }
}

// Roving-tabindex keyboard support for the tablists (WAI-ARIA tabs pattern).
function moveTabFocus(
  event: KeyboardEvent,
  ids: string[],
  current: string,
  prefix: string,
  select: (id: string) => void,
) {
  const index = ids.indexOf(current)
  let next = -1
  if (event.key === 'ArrowRight') next = (index + 1) % ids.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + ids.length) % ids.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = ids.length - 1
  if (next < 0) return
  event.preventDefault()
  const id = ids[next]
  select(id)
  document.getElementById(`${prefix}-${id}`)?.focus()
}

function onInstallKeydown(event: KeyboardEvent, box: InstallBox) {
  moveTabFocus(
    event,
    installOptions.map((option) => option.id),
    activeInstall[box],
    `ct-install-${box}-tab`,
    (id) => {
      activeInstall[box] = id as InstallTab
    },
  )
}

function onAgentKeydown(event: KeyboardEvent) {
  moveTabFocus(
    event,
    agentOptions.map((option) => option.id),
    activeAgent.value,
    'ct-agent-tab',
    (id) => {
      activeAgent.value = id as AgentTab
    },
  )
}

onBeforeUnmount(() => {
  for (const timer of Object.values(resetTimers)) {
    if (timer) clearTimeout(timer)
  }
})
</script>

<template>
  <main class="ct-home" aria-labelledby="ct-home-title">
    <section class="ct-hero">
      <div class="ct-shell ct-hero-grid">
        <div class="ct-hero-copy">
          <p class="ct-eyebrow ct-reveal">Browser acceptance tests for AI coding agents</p>
          <h1 id="ct-home-title" class="ct-reveal ct-delay-1">
            Your coding agent said it’s done.
            <span>Make the browser prove it.</span>
          </h1>
          <p class="ct-hero-lede ct-reveal ct-delay-2">
            Cairntrace turns what a feature should do into a YAML spec, replays it in a real
            browser, and hands your agent a failure report it can fix. Heal the path, never the
            promise.
          </p>

          <div class="ct-hero-actions ct-reveal ct-delay-3">
            <a
              class="ct-button ct-button-primary"
              href="/quickstart"
              @click="track('cta_click', { cta: 'quickstart', location: 'hero' })"
            >
              Run your first spec
              <span aria-hidden="true">→</span>
            </a>
            <a
              class="ct-button ct-button-secondary"
              href="/examples"
              @click="track('cta_click', { cta: 'examples', location: 'hero' })"
            >See a real failing run</a>
          </div>

          <p class="ct-compat-row ct-reveal ct-delay-3">
            <span>Works with</span> Claude Code · Cursor · Codex · OpenCode
          </p>
          <ul class="ct-trust-row ct-reveal ct-delay-3" aria-label="Trust signals">
            <li>Free</li>
            <li>MIT</li>
            <li>No account</li>
            <li>Runs locally</li>
          </ul>

          <div class="ct-install-stack ct-reveal ct-delay-4" role="group" aria-label="Install Cairntrace">
            <p class="ct-install-label"><span class="ct-install-step-number" aria-hidden="true">1</span> Install</p>
            <div class="ct-install-tabs" role="tablist" aria-label="Install method">
              <button
                v-for="option in installOptions"
                :id="`ct-install-hero-tab-${option.id}`"
                :key="option.id"
                type="button"
                role="tab"
                class="ct-install-tab"
                :aria-selected="activeInstall.hero === option.id ? 'true' : 'false'"
                :aria-controls="'ct-install-hero-panel'"
                :tabindex="activeInstall.hero === option.id ? 0 : -1"
                @click="activeInstall.hero = option.id"
                @keydown="onInstallKeydown($event, 'hero')"
              >
                {{ option.label }}
              </button>
            </div>
            <div
              id="ct-install-hero-panel"
              class="ct-install"
              role="tabpanel"
              :aria-labelledby="`ct-install-hero-tab-${activeInstall.hero}`"
            >
              <span class="ct-install-prompt" aria-hidden="true">$</span>
              <code>{{ installFor('hero').command }}</code>
              <button
                type="button"
                :aria-label="copied.hero ? 'Install command copied' : 'Copy install command'"
                @click="copyInstall('hero')"
              >
                {{ copied.hero ? 'Copied' : 'Copy' }}
              </button>
              <span class="visually-hidden" aria-live="polite">{{ copied.hero ? 'Install command copied to clipboard.' : '' }}</span>
            </div>
            <div class="ct-install-step">
              <span class="ct-install-step-number" aria-hidden="true">2</span>
              <span>Check the environment</span>
              <code>cairn doctor</code>
            </div>
          </div>

          <p class="ct-install-note ct-reveal ct-delay-4">
            Needs Bun 1.3+ (Homebrew installs it) · browser: agent-browser or Playwright
          </p>
          <p class="ct-install-note ct-install-note-muted ct-reveal ct-delay-4">
            Open source · MIT licensed ·
            <a class="ct-inline-link" href="https://github.com/abdul-hamid-achik/cairntrace">View on GitHub</a> ·
            <a class="ct-inline-link" href="/distribution">Build from source</a>
          </p>
        </div>

        <div class="ct-terminal-wrap ct-reveal ct-delay-2" aria-label="Example Cairntrace browser spec and passing run">
          <div class="ct-terminal">
            <div class="ct-terminal-bar">
              <div class="ct-terminal-dots" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
              <span>examples/flows/01-dashboard-nav.yml</span>
              <span class="ct-terminal-status">example spec</span>
            </div>
            <pre class="ct-code" aria-label="Cairntrace YAML example, excerpt from examples/flows/01-dashboard-nav.yml"><code><span class="ct-code-key">version:</span> <span class="ct-code-number">1</span>
<span class="ct-code-key">name:</span> dashboard_nav
<span class="ct-code-key">intent:</span> from the home page, follow "Open dashboard" and land on a working dashboard

<span class="ct-code-key">outcomes:</span>
  - <span class="ct-code-key">id:</span> url_is_dashboard
    <span class="ct-code-key">verify:</span>
      <span class="ct-code-key">url:</span> { <span class="ct-code-key">endsWith:</span> /dashboard.html }
  - <span class="ct-code-key">id:</span> dashboard_heading_visible
    <span class="ct-code-key">verify:</span>
      <span class="ct-code-key">text:</span> { <span class="ct-code-key">contains:</span> <span class="ct-code-string">Dashboard</span> }
  - <span class="ct-code-key">id:</span> no_console_errors
    <span class="ct-code-key">verify:</span>
      <span class="ct-code-key">console:</span> { <span class="ct-code-key">errorsMax:</span> <span class="ct-code-number">0</span> }

<span class="ct-code-key">steps:</span>
  - <span class="ct-code-key">id:</span> open_home
    <span class="ct-code-key">open:</span> http://localhost:8787/
  - <span class="ct-code-key">id:</span> click_open_dashboard
    <span class="ct-code-key">click:</span> { <span class="ct-code-key">by:</span> role, <span class="ct-code-key">role:</span> link, <span class="ct-code-key">name:</span> <span class="ct-code-string">Open dashboard</span> }
  - <span class="ct-code-key">id:</span> wait_for_dashboard
    <span class="ct-code-key">wait:</span> { <span class="ct-code-key">text:</span> Dashboard, <span class="ct-code-key">timeoutMs:</span> <span class="ct-code-number">5000</span> }</code></pre>
            <div class="ct-run-result">
              <div class="ct-run-command"><span aria-hidden="true">$</span> cairn run examples/flows/01-dashboard-nav.yml --cold-start</div>
              <div class="ct-result-row">
                <span class="ct-result-check" aria-hidden="true">✓</span>
                <strong>passed</strong>
                <span>3 outcomes · 3 steps</span>
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

    <section class="ct-section ct-connect-section" aria-labelledby="ct-connect-title">
      <div class="ct-shell ct-problem-grid ct-connect-grid">
        <div class="ct-section-heading">
          <p class="ct-kicker">Connect your agent</p>
          <h2 id="ct-connect-title">Register one MCP server and your agent gets the browser as a tool.</h2>
          <p>
            Cairntrace runs as a stdio MCP server started with <code>cairn mcp</code>. Register it
            once in your harness, then have the agent call <code>cairn_doctor</code> to verify the
            setup, then <code>cairn_explain</code> once to read the tool surface.
          </p>
          <a
            class="ct-text-link"
            href="/mcp"
            @click="track('cta_click', { cta: 'mcp_reference', location: 'connect' })"
          >Full MCP reference <span aria-hidden="true">→</span></a>
        </div>

        <div class="ct-agent-tabs">
          <div class="ct-agent-tablist" role="tablist" aria-label="Agent harness">
            <button
              v-for="option in agentOptions"
              :id="`ct-agent-tab-${option.id}`"
              :key="option.id"
              type="button"
              role="tab"
              class="ct-agent-tab"
              :aria-selected="activeAgent === option.id ? 'true' : 'false'"
              aria-controls="ct-agent-panel"
              :tabindex="activeAgent === option.id ? 0 : -1"
              @click="activeAgent = option.id"
              @keydown="onAgentKeydown"
            >
              {{ option.label }}
            </button>
          </div>
          <div
            id="ct-agent-panel"
            class="ct-agent-panel"
            role="tabpanel"
            :aria-labelledby="`ct-agent-tab-${activeAgent}`"
            tabindex="0"
          >
            <p class="ct-agent-file">
              <span>{{ activeAgentOption.file }}</span>
            </p>
            <pre class="ct-code ct-agent-code"><code>{{ activeAgentOption.code }}</code></pre>
          </div>
        </div>
      </div>
    </section>

    <section class="ct-section ct-author-section" aria-labelledby="ct-author-title">
      <div class="ct-shell ct-problem-grid">
        <div class="ct-section-heading">
          <p class="ct-kicker">Let the agent write the spec</p>
          <h2 id="ct-author-title">Record the journey once, then promote the draft.</h2>
          <p>
            An agent can open the page, record each step, and export a draft spec. The draft
            is linted and run from a cold browser. It is promoted only after it passes.
          </p>
          <a class="ct-text-link" href="/author-flow">Read the author-flow guide <span aria-hidden="true">→</span></a>
          <a class="ct-text-link ct-text-link-second" href="/discover">Discovery sessions <span aria-hidden="true">→</span></a>
        </div>

        <ul class="ct-use-cases">
          <li>
            <span>01</span>
            <div><strong>Discover</strong><p><code>cairn_discover_open</code> opens the page and returns a snapshot and locator inventory.</p></div>
          </li>
          <li>
            <span>02</span>
            <div><strong>Interact</strong><p><code>cairn_discover_interact</code> records each click, fill, or assert as a step.</p></div>
          </li>
          <li>
            <span>03</span>
            <div><strong>Export</strong><p><code>cairn_discover_export</code> writes the draft from the session journal, even after the browser closed.</p></div>
          </li>
          <li>
            <span>04</span>
            <div><strong>Finish</strong><p><code>cairn spec finish</code> lints the draft, runs it cold, and stamps the contract when green.</p></div>
          </li>
          <li>
            <span>05</span>
            <div><strong>Promote</strong><p><code>cairn spec promote</code> moves it into the suite, rebases its paths, and stamps the contract.</p></div>
          </li>
        </ul>
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

    <section class="ct-section ct-beyond-section" aria-labelledby="ct-beyond-title">
      <div class="ct-shell">
        <div class="ct-capabilities-heading">
          <div>
            <p class="ct-kicker">Beyond the click</p>
            <h2 id="ct-beyond-title">Check the data, the setup, and the suite too.</h2>
          </div>
          <p>
            Outcomes can read the backend, not only the page. Fixtures, services, suites, and
            runners are declared in cairntrace.config.yml, next to your specs.
          </p>
        </div>

        <ul class="ct-beyond-grid">
          <li>
            <a class="ct-beyond-card" href="/verifiers" @click="track('cta_click', { cta: 'verifiers', location: 'beyond' })">
              <span class="ct-mosaic-label">Backend verifiers</span>
              <h3>Assert the record, not just the screen.</h3>
              <p><code>mongo</code>, <code>temporal</code>, <code>http</code>, and <code>xlsx</code> outcomes check the data behind the UI.</p>
              <span class="ct-beyond-link">Verifiers <span aria-hidden="true">→</span></span>
            </a>
          </li>
          <li>
            <a class="ct-beyond-card" href="/fixtures" @click="track('cta_click', { cta: 'fixtures', location: 'beyond' })">
              <span class="ct-mosaic-label">Fixtures</span>
              <h3>Seed the data before the run starts.</h3>
              <p>Fixtures create test data before a run and tear it down after.</p>
              <span class="ct-beyond-link">Fixtures <span aria-hidden="true">→</span></span>
            </a>
          </li>
          <li>
            <a class="ct-beyond-card" href="/services" @click="track('cta_click', { cta: 'services', location: 'beyond' })">
              <span class="ct-mosaic-label">Suites and run policy</span>
              <h3>Run named suites with a defined policy.</h3>
              <p>Pick a suite with <code>--suite</code>, set bail and preflight rules, and hold the run on readiness gates while services start and tear down with it.</p>
              <span class="ct-beyond-link">Services and suites <span aria-hidden="true">→</span></span>
            </a>
          </li>
          <li>
            <a class="ct-beyond-card" href="/delegate" @click="track('cta_click', { cta: 'delegate', location: 'beyond' })">
              <span class="ct-mosaic-label">Delegated runners</span>
              <h3>Run where your app lives.</h3>
              <p>Hand <code>cairn run</code> to a command you provide. The local process keeps the journal, run directories, and exit code.</p>
              <span class="ct-beyond-link">Delegated runners <span aria-hidden="true">→</span></span>
            </a>
          </li>
          <li>
            <a class="ct-beyond-card" href="/export" @click="track('cta_click', { cta: 'export', location: 'beyond' })">
              <span class="ct-mosaic-label">Export to Playwright</span>
              <h3>Keep the spec. Export the test.</h3>
              <p>Emit <code>@playwright/test</code> files from a spec. <code>--verify</code> checks the export before you rely on it.</p>
              <span class="ct-beyond-link">Export and verify <span aria-hidden="true">→</span></span>
            </a>
          </li>
        </ul>
      </div>
    </section>

    <section class="ct-section ct-differs-section" aria-labelledby="ct-differs-title">
      <div class="ct-shell">
        <div class="ct-capabilities-heading">
          <div>
            <p class="ct-kicker">How it differs</p>
            <h2 id="ct-differs-title">Three ways to check a browser feature.</h2>
          </div>
          <p>
            Ad-hoc agent browsing is fast to start. Hand-written Playwright is mature. Cairntrace
            keeps the check as a spec the agent can run and repair.
          </p>
        </div>

        <div class="ct-table-wrap" tabindex="0" role="region" aria-label="Comparison table, scrollable on small screens">
          <table class="ct-compare-table">
            <thead>
              <tr>
                <th scope="col"><span class="visually-hidden">Criterion</span></th>
                <th scope="col">Ad-hoc agent + browser MCP</th>
                <th scope="col">Hand-written Playwright</th>
                <th scope="col" class="ct-compare-us">Cairntrace</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Survives the session</th>
                <td>No. Steps live in the chat.</td>
                <td>Yes. Test files in the repo.</td>
                <td class="ct-compare-us">Yes. YAML spec in the repo.</td>
              </tr>
              <tr>
                <th scope="row">Fixed definition of done</th>
                <td>Whatever the agent decides it is.</td>
                <td>Yes. The assertions you wrote.</td>
                <td class="ct-compare-us">Yes. Intent and outcomes, covered by a contract hash.</td>
              </tr>
              <tr>
                <th scope="row">Agent-readable failure evidence</th>
                <td>Screenshots and logs the agent has to interpret.</td>
                <td>Traces and reports built for people.</td>
                <td class="ct-compare-us">Start with <code>agent_context.md</code>, then outcomes, snapshots, and console.</td>
              </tr>
              <tr>
                <th scope="row">Drift repair</th>
                <td>Re-explore the page each time.</td>
                <td>Edit the test by hand.</td>
                <td class="ct-compare-us">Heal proposes step changes. The contract hash blocks changes to outcomes.</td>
              </tr>
              <tr>
                <th scope="row">Exports to Playwright</th>
                <td>No.</td>
                <td>Native.</td>
                <td class="ct-compare-us"><code>cairn export playwright</code>, with <code>--verify</code>.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="ct-differs-note">
          Playwright wins on ecosystem, maturity, and CI adoption. Cairntrace can
          use Playwright as its browser backend, and it can export to Playwright when a
          conventional test is the better home.
          <a class="ct-text-link" href="/compare">Full comparison <span aria-hidden="true">→</span></a>
        </p>
      </div>
    </section>

    <section class="ct-section ct-ci-section" aria-labelledby="ct-ci-title">
      <div class="ct-shell ct-problem-grid">
        <div class="ct-section-heading">
          <p class="ct-kicker">From agent loop to CI</p>
          <h2 id="ct-ci-title">The same suite the agent ran, in CI.</h2>
          <p>
            <code>--cold-start</code> clears the browser profile first, so a pass does not depend
            on leftover state. <code>--junit</code> writes a report your CI can read. Exit codes
            tell the job what happened.
          </p>
          <a class="ct-text-link" href="/ci">CI recipe <span aria-hidden="true">→</span></a>
          <a class="ct-text-link ct-text-link-second" href="/exit-codes">Exit codes <span aria-hidden="true">→</span></a>
        </div>

        <pre class="ct-code ct-ci-code" aria-label="GitHub Actions step that runs a Cairntrace suite"><code># cairn is installed earlier in the job (see /ci)
- name: Browser acceptance
  run: cairn run --suite &lt;name&gt; --cold-start --junit cairn-junit.xml</code></pre>
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
            <summary>Does it need Bun?</summary>
            <p>
              Yes, Bun 1.3.0 or newer (<code>engines.bun</code> in package.json). Homebrew installs
              it as a dependency. npm and bun installs need Bun on your PATH.
            </p>
          </details>
          <details>
            <summary>Does it run in CI?</summary>
            <p>
              Yes. <code>--cold-start</code> is on by default in CI, <code>--junit</code> writes
              JUnit XML, and <code>cairn run</code> exits with documented codes. The CI recipe is
              on <a class="ct-inline-link" href="/ci">/ci</a>.
            </p>
          </details>
          <details>
            <summary>Is the MCP server safe to register?</summary>
            <p>
              It runs over stdio. Shell hooks and service starts (docker, seed, tmux) are refused
              until you opt in with <code>--allow-hooks</code> or <code>--allow-services</code>, or
              the matching <code>CAIRN_MCP_ALLOW_*</code> environment variable.
            </p>
          </details>
          <details>
            <summary>How is it different from Playwright MCP?</summary>
            <p>
              Playwright MCP gives the agent a browser to drive. Cairntrace is a spec format and a
              runner on top of a browser (agent-browser by default, or Playwright). Use a browser
              MCP to explore. Use Cairntrace to keep the check and its evidence.
            </p>
          </details>
          <details>
            <summary>Which operating systems are supported?</summary>
            <p>
              The install docs cover macOS and Linux (Homebrew, npm, bun, and the curl installer).
              Windows is not documented as supported.
            </p>
          </details>
          <details>
            <summary>Does it send telemetry? Does run data leave my machine?</summary>
            <p>
              The CLI does not import an analytics SDK or send usage data. Runs write browser state
              and artifacts locally. Network calls come from what you configure or invoke, such as
              your app, datasources, or <code>cairn publish</code>. This website uses Vercel Analytics for page views and CTA clicks.
            </p>
          </details>
          <details>
            <summary>What license is it under, and do I need an account?</summary>
            <p>
              MIT. There is no Cairntrace account. Local runs use your files and your browser.
              Checkpoints that hold app logins are created by you with <code>cairn login</code>.
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
          <p>Install Cairntrace, run <code>cairn doctor</code>, and give your next coding task a browser contract.</p>

          <div class="ct-install-stack ct-final-install" role="group" aria-label="Install Cairntrace">
            <div class="ct-install-tabs" role="tablist" aria-label="Install method">
              <button
                v-for="option in installOptions"
                :id="`ct-install-final-tab-${option.id}`"
                :key="option.id"
                type="button"
                role="tab"
                class="ct-install-tab"
                :aria-selected="activeInstall.final === option.id ? 'true' : 'false'"
                aria-controls="ct-install-final-panel"
                :tabindex="activeInstall.final === option.id ? 0 : -1"
                @click="activeInstall.final = option.id"
                @keydown="onInstallKeydown($event, 'final')"
              >
                {{ option.label }}
              </button>
            </div>
            <div
              id="ct-install-final-panel"
              class="ct-install"
              role="tabpanel"
              :aria-labelledby="`ct-install-final-tab-${activeInstall.final}`"
            >
              <span class="ct-install-prompt" aria-hidden="true">$</span>
              <code>{{ installFor('final').command }}</code>
              <button
                type="button"
                :aria-label="copied.final ? 'Install command copied' : 'Copy install command'"
                @click="copyInstall('final')"
              >
                {{ copied.final ? 'Copied' : 'Copy' }}
              </button>
              <span class="visually-hidden" aria-live="polite">{{ copied.final ? 'Install command copied to clipboard.' : '' }}</span>
            </div>
          </div>
        </div>
        <div class="ct-final-actions">
          <a
            class="ct-button ct-button-light"
            href="/quickstart"
            @click="track('cta_click', { cta: 'quickstart', location: 'final' })"
          >Start the quickstart <span aria-hidden="true">→</span></a>
          <a
            class="ct-button ct-button-ghost"
            href="/mcp"
            @click="track('cta_click', { cta: 'connect_agent', location: 'final' })"
          >Connect an agent</a>
        </div>
      </div>
    </section>
  </main>
</template>
