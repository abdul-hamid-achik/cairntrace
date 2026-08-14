import type { HeadConfig, PageData } from 'vitepress'

export const SITE_URL = 'https://cairntrace.dev'

const SOCIAL_IMAGE = `${SITE_URL}/og-cairntrace.png`
const GITHUB_URL = 'https://github.com/abdul-hamid-achik/cairntrace'

const pageDescriptions: Record<string, string> = {
  'index.md':
    'Cairntrace is a local-first browser testing layer for AI coding agents. Define behavioral outcomes, replay them in a real browser, and return repair-ready evidence.',
  'overview.md':
    'Learn how Cairntrace turns intent and outcomes into durable behavioral browser specs for coding agents, with repairable steps and local-first evidence.',
  'quickstart.md':
    'Install Cairntrace from source, write a typed browser spec, verify its contract, and run your first cold-start browser check.',
  'authoring.md':
    'Author durable Cairntrace browser specs with typed outcomes, repairable steps, contract hashes, semantic locators, and cold-start replay.',
  'steps.md':
    'Reference every typed Cairntrace browser step, including navigation, semantic interactions, requests, downloads, batches, snapshots, and process monitoring.',
  'verifiers.md':
    'Reference Cairntrace outcome verifiers for text, URLs, network traffic, console errors, element counts, files, JSON, workbooks, scripts, and process metrics.',
  'artifacts.md':
    'Understand Cairntrace run artifacts: self-contained HTML and JSON reports, agent context, outcome evidence, snapshots, screenshots, console, and network logs.',
  'configuration.md':
    'Configure Cairntrace projects, environments, browser backends, artifact capture, services, secrets, logging, retention, and report themes.',
  'commands.md':
    'Explore the Cairntrace CLI command surface for running, verifying, discovering, healing, comparing, investigating, and managing behavioral browser specs.',
  'agents.md':
    'Use Cairntrace from Codex, Claude Code, Cursor, OpenCode, or any MCP-aware coding agent through one stable CLI, MCP, and artifact interface.',
  'mcp.md':
    'Connect coding agents to the Cairntrace MCP server for browser-spec authoring, verification, replay, discovery, healing, and evidence retrieval.',
  'discover.md':
    'Explore live pages through Cairntrace discovery sessions, capture accessibility snapshots and locator inventories, and export recorded interactions as specs.',
  'export.md':
    'Export Cairntrace browser specs to Playwright JS or TypeScript with coverage reports, or import Playwright tests into reviewable YAML.',
  'brief.md':
    'Compile a passing Cairntrace spec into an agent-neutral journey brief so a harness can complete the same flow when authored locators do not replay.',
  'troubleshooting.md':
    'Diagnose Cairntrace cold-start gates, outcome failures, request errors, timeouts, contract mismatches, backend problems, and flaky browser behavior.',
  'annotate.md':
    'Attach Cairntrace browser-run status, outcomes, and contract hashes to code symbols so agents can connect behavioral evidence to the code under review.',
  'checkpoint.md':
    'Capture, inspect, and restore Cairntrace browser checkpoints for authenticated cold-start specs and repeatable login workflows.',
  'clip.md':
    'Extract focused video evidence from a recorded Cairntrace browser run with timestamps, frame markers, and artifact-aware run references.',
  'distribution.md':
    'Install and update Cairntrace from GitHub releases or main, run the Bun launcher from source, and understand the project versioning policy.',
  'doctor.md':
    'Check Cairntrace browser backends and local dependencies with doctor, then safely prune retained browser-run artifacts with clean.',
  'github.md':
    'Understand the Cairntrace repository architecture, CI checks, release process, contribution flow, and coding-agent working agreements.',
  'glyphrun-comparison.md':
    'Compare Cairntrace browser specs with Glyphrun terminal specs, including their shared contracts, artifact packs, MCP shape, and different execution surfaces.',
  'investigate.md':
    'Trace failed Cairntrace browser outcomes back to relevant application code with focused agent context, run evidence, semantic search, and audit workflows.',
  'monitor.md':
    'Measure browser process CPU and memory during Cairntrace runs, capture point-in-time profiles, and assert performance budgets with typed outcomes.',
  'secrets.md':
    'Inject TinyVault secrets into Cairntrace services and runs without printing secret values or leaking credentials into browser-test artifacts.',
  'services.md':
    'Let Cairntrace manage Docker, seed data, tmux development servers, readiness checks, health checks, environment overrides, and teardown around a spec suite.',
  'snippets.md':
    'Build reusable Cairntrace actions and conditional browser-step snippets for login, setup, and repeated interactions across behavioral specs.',
  'stash.md':
    'Archive, search, restore, and share self-contained Cairntrace browser-run artifact packs through the optional local-first stash integration.',
  'topics.md':
    'Browse focused Cairntrace documentation topics for advanced browser-spec authoring, runner behavior, evidence, and integration decisions.',
}

export function resolvePageDescription(pageData: PageData): string {
  const explicit = pageData.frontmatter.description
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()

  return (
    pageDescriptions[pageData.relativePath] ??
    `${pageData.title} documentation for Cairntrace, the local-first behavioral browser-spec layer for AI coding agents.`
  )
}

function canonicalUrl(page: string): string {
  const route = page
    .replace(/(^|\/)index\.md$/, '$1')
    .replace(/\.md$/, '')
    .replace(/^\//, '')

  return route ? `${SITE_URL}/${route}` : `${SITE_URL}/`
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

interface SeoContext {
  page: string
  pageData: PageData
  title: string
  description: string
}

export function buildSeoHead({
  page,
  pageData,
  title,
  description,
}: SeoContext): HeadConfig[] {
  if (pageData.isNotFound || page === '404.md' || pageData.frontmatter.noindex === true) {
    return [['meta', { name: 'robots', content: 'noindex,follow' }]]
  }

  const url = canonicalUrl(page)
  const isHome = page === 'index.md'
  const webPageId = `${url}#webpage`
  const websiteId = `${SITE_URL}/#website`

  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebPage',
      '@id': webPageId,
      url,
      name: title,
      description,
      inLanguage: 'en-US',
      isPartOf: { '@id': websiteId },
    },
  ]

  if (isHome) {
    graph.unshift(
      {
        '@type': 'WebSite',
        '@id': websiteId,
        url: `${SITE_URL}/`,
        name: 'Cairntrace',
        description,
        inLanguage: 'en-US',
      },
      {
        '@type': 'SoftwareSourceCode',
        '@id': `${SITE_URL}/#software`,
        name: 'Cairntrace',
        alternateName: 'cairn',
        url: `${SITE_URL}/`,
        codeRepository: GITHUB_URL,
        license: `${GITHUB_URL}/blob/main/LICENSE`,
        programmingLanguage: 'TypeScript',
        runtimePlatform: 'Bun 1.3 or newer',
        description,
      },
    )
  }

  return [
    ['link', { rel: 'canonical', href: url }],
    [
      'meta',
      {
        name: 'robots',
        content: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Cairntrace' }],
    ['meta', { property: 'og:locale', content: 'en_US' }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:image', content: SOCIAL_IMAGE }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    [
      'meta',
      {
        property: 'og:image:alt',
        content: 'Cairntrace — browser specs that coding agents can run, read, and repair',
      },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE }],
    ['meta', { name: 'twitter:image:alt', content: 'Cairntrace behavioral browser specs' }],
    ['script', { type: 'application/ld+json' }, safeJson({ '@context': 'https://schema.org', '@graph': graph })],
  ]
}

export function resolveSeoTitle(pageData: PageData): string {
  if (pageData.frontmatter.titleTemplate === false || pageData.titleTemplate === false) {
    return pageData.title
  }

  return pageData.title === 'Cairntrace' ? pageData.title : `${pageData.title} | Cairntrace`
}
