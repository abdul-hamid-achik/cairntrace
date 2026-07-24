import { defineConfig } from 'vitepress'
import { buildSeoHead, resolvePageDescription, resolveSeoTitle, SITE_URL } from './seo'

export default defineConfig({
  lang: 'en-US',
  title: 'Cairntrace',
  titleTemplate: ':title | Cairntrace',
  description:
    'Local-first behavioral browser specs for AI coding agents. Define durable outcomes, replay them in a real browser, and collect repair-ready evidence.',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
    ['link', { rel: 'manifest', href: '/site.webmanifest' }],
    ['meta', { name: 'theme-color', content: '#101a14' }],
    ['meta', { name: 'author', content: 'Abdul Hamid Achik' }],
  ],

  sitemap: {
    hostname: SITE_URL,
  },

  transformPageData(pageData) {
    const description = resolvePageDescription(pageData)
    const seoHead = buildSeoHead({
      page: pageData.relativePath,
      pageData,
      title: resolveSeoTitle(pageData),
      description,
    })

    return {
      description,
      frontmatter: {
        ...pageData.frontmatter,
        head: [...(pageData.frontmatter.head ?? []), ...seoHead],
      },
    }
  },

  transformHead({ page }) {
    if (page === '404.md') {
      return [['meta', { name: 'robots', content: 'noindex,follow' }]]
    }
  },

  themeConfig: {
    siteTitle: 'cairntrace',
    logo: { light: '/favicon.svg', dark: '/favicon.svg', alt: 'Cairntrace home' },
    nav: [
      { text: 'Quickstart', link: '/quickstart' },
      {
        text: 'Learn',
        items: [
          { text: 'Overview', link: '/overview' },
          { text: 'Authoring contracts', link: '/authoring' },
          { text: 'Agent workflow', link: '/agents' },
          { text: 'Discovery sessions', link: '/discover' },
          { text: 'Export & import', link: '/export' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Steps', link: '/steps' },
          { text: 'Verifiers', link: '/verifiers' },
          { text: 'Commands', link: '/commands' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Artifacts', link: '/artifacts' },
        ],
      },
      { text: 'MCP', link: '/mcp' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/overview' },
            { text: 'Quickstart', link: '/quickstart' },
            { text: 'Concepts', link: '/authoring' },
            { text: 'Discovery sessions', link: '/discover' },
            { text: 'Export & import', link: '/export' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Steps', link: '/steps' },
            { text: 'Verifiers', link: '/verifiers' },
            { text: 'Artifacts', link: '/artifacts' },
            { text: 'Configuration', link: '/configuration' },
            { text: 'Distribution', link: '/distribution' },
            { text: 'GitHub', link: '/github' },
            { text: 'MCP', link: '/mcp' },
            { text: 'Snippets', link: '/snippets' },
            { text: 'Troubleshooting', link: '/troubleshooting' },
            { text: 'Glyphrun Comparison', link: '/glyphrun-comparison' },
            { text: 'Topics', link: '/topics' },
          ],
        },
        {
          text: 'Commands',
          items: [
            { text: 'All commands', link: '/commands' },
            { text: 'Doctor & clean', link: '/doctor' },
            { text: 'Discover & snapshot', link: '/discover' },
            { text: 'Export & import', link: '/export' },
            { text: 'Checkpoints & login', link: '/checkpoint' },
            { text: 'Stash', link: '/stash' },
            { text: 'Clip', link: '/clip' },
            { text: 'Process monitoring', link: '/monitor' },
            { text: 'Investigate & audit', link: '/investigate' },
            { text: 'Annotate', link: '/annotate' },
            { text: 'Secrets', link: '/secrets' },
            { text: 'Services', link: '/services' },
          ],
        },
        {
          text: 'For Agents',
          items: [
            { text: 'Agent Loop', link: '/agents' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/abdul-hamid-achik/cairntrace' },
    ],

    editLink: {
      pattern: 'https://github.com/abdul-hamid-achik/cairntrace/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    outline: { level: [2, 3], label: 'On this page' },
    lastUpdated: { text: 'Updated' },
    docFooter: { prev: 'Previous', next: 'Next' },

    footer: {
      message: 'Local-first browser specs for coding agents. Released under the MIT License.',
      copyright: 'Copyright © Abdul Hamid Achik',
    },

    search: { provider: 'local' },
  },
})
