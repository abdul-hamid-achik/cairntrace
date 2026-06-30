import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Cairntrace',
  description: 'Local-first behavioral browser-spec layer for coding agents. Specs declare intent + outcomes as the behavior contract and steps as repairable hints.',
  cleanUrls: true,
  lastUpdated: true,


  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'description', content: 'cairntrace documentation site.' }],
  ],

  sitemap: { hostname: 'https://cairntrace.dev' },
  themeConfig: {
    siteTitle: 'Cairntrace',
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/overview' },
      { text: 'Authoring', link: '/authoring' },
      { text: 'Reference', link: '/steps' },
      { text: 'Agents', link: '/agents' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/overview' },
            { text: 'Quickstart', link: '/quickstart' },
            { text: 'Concepts', link: '/authoring' },
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

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Abdul Hamid Achik',
    },

    search: { provider: 'local' },
  },
})
