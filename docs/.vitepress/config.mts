import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type PageData, type SiteConfig } from "vitepress";
import {
  buildSeoHead,
  resolvePageDescription,
  resolveSeoTitle,
  SITE_URL,
} from "./seo";

function splitFrontmatter(source: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: source };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (pair) data[pair[1]] = pair[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return { data, body: source.slice(match[0].length) };
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function pageUrl(page: string): string {
  const route = page
    .replace(/(^|\/)index\.md$/, "$1")
    .replace(/\.md$/, "")
    .replace(/^\//, "");
  return route ? `${SITE_URL}/${route}` : `${SITE_URL}/`;
}

export default defineConfig({
  lang: "en-US",
  title: "Cairntrace",
  titleTemplate: ":title | Cairntrace",
  description:
    "Local-first behavioral browser specs for AI coding agents. Define durable outcomes, replay them in a real browser, and collect repair-ready evidence.",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32.png",
      },
    ],
    [
      "link",
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
    ],
    ["link", { rel: "manifest", href: "/site.webmanifest" }],
    ["meta", { name: "theme-color", content: "#101a14" }],
    ["meta", { name: "author", content: "Abdul Hamid Achik" }],
  ],

  sitemap: {
    hostname: SITE_URL,
  },

  transformPageData(pageData) {
    const description = resolvePageDescription(pageData);
    const seoHead = buildSeoHead({
      page: pageData.relativePath,
      pageData,
      title: resolveSeoTitle(pageData),
      description,
    });

    return {
      description,
      frontmatter: {
        ...pageData.frontmatter,
        head: [...(pageData.frontmatter.head ?? []), ...seoHead],
      },
    };
  },

  transformHead({ page }) {
    if (page === "404.md") {
      return [["meta", { name: "robots", content: "noindex,follow" }]];
    }
  },

  // Writes /llms.txt (an index of every docs page) and /llms-full.txt (the
  // concatenated markdown sources) into the build output. Uses only node:fs
  // and node:path; descriptions come from resolvePageDescription so they match
  // the page meta tags.
  buildEnd(siteConfig: SiteConfig) {
    const pages = siteConfig.pages.filter((page) => page !== "404.md");
    const entries = pages.map((page) => {
      const source = readFileSync(join(siteConfig.srcDir, page), "utf-8");
      const { data, body } = splitFrontmatter(source);
      const title = data.title || firstHeading(body) || page;
      const description = resolvePageDescription({
        frontmatter: data,
        relativePath: page,
        title,
      } as unknown as PageData).replace(/\s+/g, " ");
      return { url: pageUrl(page), title, description, body: body.trim() };
    });

    const index = [
      "# Cairntrace",
      "",
      `> ${siteConfig.site.description ?? ""}`,
      "",
      "## Docs",
      "",
      ...entries.map(
        (entry) => `- [${entry.title}](${entry.url}): ${entry.description}`,
      ),
      "",
    ].join("\n");

    const full = entries
      .map((entry) => `# ${entry.title}\n\nSource: ${entry.url}\n\n${entry.body}\n`)
      .join("\n---\n\n");

    writeFileSync(join(siteConfig.outDir, "llms.txt"), index, "utf-8");
    writeFileSync(join(siteConfig.outDir, "llms-full.txt"), full, "utf-8");
  },

  themeConfig: {
    siteTitle: "cairntrace",
    logo: {
      light: "/favicon.svg",
      dark: "/favicon.svg",
      alt: "Cairntrace home",
    },
    nav: [
      { text: "Quickstart", link: "/quickstart" },
      {
        text: "Learn",
        items: [
          { text: "Overview", link: "/overview" },
          { text: "Authoring contracts", link: "/authoring" },
          { text: "Agent workflow", link: "/agents" },
          { text: "Author a spec from a request", link: "/author-flow" },
          { text: "Discovery sessions", link: "/discover" },
          { text: "Journey briefs", link: "/brief" },
          { text: "Export & import", link: "/export" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Steps", link: "/steps" },
          { text: "Widgets & forms", link: "/widgets" },
          { text: "Verifiers", link: "/verifiers" },
          { text: "Commands", link: "/commands" },
          { text: "Configuration", link: "/configuration" },
          { text: "Artifacts", link: "/artifacts" },
        ],
      },
      { text: "MCP", link: "/mcp" },
    ],

    sidebar: {
      "/": [
        {
          text: "Getting Started",
          items: [
            { text: "Overview", link: "/overview" },
            { text: "Quickstart", link: "/quickstart" },
            { text: "Distribution", link: "/distribution" },
            { text: "MCP", link: "/mcp" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Authoring contracts", link: "/authoring" },
            { text: "Author a spec from a request", link: "/author-flow" },
            { text: "Discovery sessions", link: "/discover" },
            { text: "Agent workflow", link: "/agents" },
            { text: "Journey briefs", link: "/brief" },
            { text: "Export & import", link: "/export" },
            { text: "Snippets", link: "/snippets" },
            { text: "Fixtures", link: "/fixtures" },
            { text: "Services", link: "/services" },
            { text: "Secrets", link: "/secrets" },
            { text: "Delegated runners", link: "/delegate" },
            { text: "Checkpoints & login", link: "/checkpoint" },
            { text: "Video capture", link: "/video" },
            { text: "Troubleshooting", link: "/troubleshooting" },
          ],
        },
        {
          text: "Commands",
          items: [
            { text: "All commands", link: "/commands" },
            { text: "Doctor & clean", link: "/doctor" },
            { text: "Stash", link: "/stash" },
            { text: "Clip", link: "/clip" },
            { text: "Process monitoring", link: "/monitor" },
            { text: "Investigate & audit", link: "/investigate" },
            { text: "Annotate", link: "/annotate" },
            { text: "Project catalog", link: "/catalog" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Steps", link: "/steps" },
            { text: "Widgets & forms", link: "/widgets" },
            { text: "Verifiers", link: "/verifiers" },
            { text: "Script verifiers & SDK", link: "/scripts" },
            { text: "Artifacts", link: "/artifacts" },
            { text: "Configuration", link: "/configuration" },
            { text: "Exit codes", link: "/exit-codes" },
            { text: "Topics", link: "/topics" },
          ],
        },
        {
          text: "Project",
          items: [
            { text: "Glyphrun Comparison", link: "/glyphrun-comparison" },
            { text: "GitHub", link: "/github" },
          ],
        },
      ],
    },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/abdul-hamid-achik/cairntrace",
      },
    ],

    editLink: {
      pattern:
        "https://github.com/abdul-hamid-achik/cairntrace/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    outline: { level: [2, 3], label: "On this page" },
    lastUpdated: { text: "Updated" },
    docFooter: { prev: "Previous", next: "Next" },

    footer: {
      message:
        "Local-first browser specs for coding agents. Released under the MIT License.",
      copyright: "Copyright © Abdul Hamid Achik",
    },

    search: { provider: "local" },
  },
});
