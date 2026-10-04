/**
 * Ambient globals of the sandboxed renderer (classic scripts, no bundler).
 *
 * Every renderer script is an IIFE that publishes onto `window.Studio`;
 * `lib/format.js`, `lib/events.js` and `lib/policy.js` are loaded as scripts
 * too and land on `window.CairnFormat` / `window.CairnEvents` /
 * `window.CairnPolicy`; `preload.js` exposes the IPC
 * bridge as `window.cairn`. Checked by `tsc -p tsconfig.renderer.json`.
 */

type CairnFormatApi = typeof import("../lib/format");
type CairnEventsApi = typeof import("../lib/events");
type CairnPolicyApi = typeof import("../lib/policy");

/** The contextBridge API from preload.js (channel allowlists enforced there). */
interface CairnBridge {
  call(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, listener: (payload: any) => void): () => void;
  smokeReady(payload: {
    ok: boolean;
    reason?: string | null;
    checks?: Record<string, unknown> | null;
  }): void;
  versions: { electron: string; node: string; chrome: string };
}

/** What `Studio.h` accepts as children. */
type StudioChild =
  | Node
  | string
  | number
  | boolean
  | null
  | undefined
  | StudioChild[];

/** A live/detected/invocation record (state.js `initLiveRecord`). */
type StudioRecord = Record<string, any>;

interface StudioView {
  id: string;
  label: string;
  glyph?: string;
  hidden?: boolean;
  render(
    root: HTMLElement,
    params?: Record<string, any>,
  ): unknown | Promise<unknown>;
  refresh?: () => void;
}

interface StudioState {
  booted: boolean;
  info: any;
  settings: any;
  project: any;
  projectError: unknown;
  runs: any[];
  runsRoot: { runsRoot: string; source?: string } | null;
  runsError: unknown;
  runsLoading: boolean;
  specNames: string[];
  labels: Array<{ key: string; count: number; values: string[] }>;
  filters: {
    status: string;
    spec: string;
    search: string;
    labels: string[];
    limit: number;
    groupByInvocation: boolean;
  };
  selectedRun: string | null;
  runDetail: any;
  specs: any[];
  selectedSpec: string | null;
  specText: string;
  specDirty: boolean;
  specSummary: any;
  specFindings: any;
  live: Map<string, StudioRecord>;
  liveOrder: string[];
  detected: Map<string, StudioRecord>;
  invocations: Map<string, StudioRecord>;
  locks: any;
  versions: any;
  view: string;
  viewParams: Record<string, any>;
}

/** A scrollable, bottom-following line pane (panes.js `createFollowPane`). */
interface StudioFollowPane {
  el: HTMLElement;
  pane: HTMLElement;
  append: (nodes: Node[]) => void;
  reset: () => void;
  setVisible: (visible: boolean) => void;
}

/** One tab + pane of an output panel (panes.js `createOutputPanel`). */
interface StudioOutputSource {
  id: string;
  label: string;
  pane: StudioFollowPane;
  tab: HTMLElement;
  offset: number;
  carry: string;
  fetched: boolean;
  file?: string;
  inFlight?: boolean;
  errorShown?: boolean;
  final?: boolean;
}

interface StudioOutputPanel {
  el: HTMLElement;
  sources: Map<string, StudioOutputSource>;
  addSource: (
    id: string,
    label: string,
    extra?: Record<string, any>,
  ) => StudioOutputSource;
  select: (id: string) => void;
  selected: () => string | null;
}

/** panes.js: follow panes and tailed-file output panels. */
interface StudioPanes {
  MAX_PANE_LINES: number;
  isNearBottom: (
    metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
    slack?: number,
  ) => boolean;
  splitChunk: (
    carry: string,
    chunk: string,
  ) => { lines: string[]; carry: string };
  line: (text: string, className?: string) => HTMLElement;
  eventLine: (event: Record<string, any>) => HTMLElement;
  logLine: (entry: Record<string, any>) => HTMLElement;
  createFollowPane: (options?: {
    className?: string;
    empty?: string;
    label?: string;
  }) => StudioFollowPane;
  createOutputPanel: (options?: { title?: string | null }) => StudioOutputPanel;
  pollFileSource: (
    source: StudioOutputSource,
    where: { runDir?: string; invocationId?: string },
  ) => Promise<void>;
  flushCarry: (source: StudioOutputSource) => void;
}

/** state.js `Studio.actions`: the IPC-backed loaders views call. */
interface StudioActions {
  loadInfo(): Promise<any>;
  loadProject(dir?: string | null): Promise<any>;
  loadRuns(): Promise<any[]>;
  loadDetected(): Promise<Map<string, StudioRecord>>;
  openRun(runDirOrId: string): Promise<any>;
  openSpec(file: string): Promise<any>;
  startRun(specPaths: string[], overrides?: Record<string, any>): Promise<any>;
  startSuite(name: string, overrides?: Record<string, any>): Promise<any>;
  cancelRun(token: string): Promise<any>;
  loadLocks(): Promise<any>;
  loadVersions(): Promise<any>;
  saveSettings(patch: Record<string, any>): Promise<any>;
  setCairnBin(value: string): Promise<any>;
  setArtifactRoot(value: string): Promise<any>;
  refresh(): void;
}

/** A bounded evidence table (lib/dataEvidence.js). */
interface StudioTable {
  columns: string[];
  rows: string[][];
  shown: number;
  total: number | null;
  truncated: boolean;
  /** Who cut the rows: the runner's evidence bound, or Studio's display cap. */
  cutBy?: "runner" | "studio" | null;
  hiddenColumns: number;
  unit: string;
}

/** Structured verifier evidence (lib/dataEvidence.js `normalizeRawEvidence`). */
interface StudioDataEvidence {
  kind: string;
  source: {
    name: string | null;
    kind: string | null;
    text: string;
    facts: Array<[string, string]>;
  } | null;
  request: string | null;
  facts: Array<[string, string]>;
  table: StudioTable | null;
  value: string | null;
  truncated: boolean;
  note: string | null;
  attempts: Array<{
    at: string | null;
    ok: boolean;
    summary: string;
    offsetMs: number | null;
  }> | null;
  attemptCount: number | null;
  polledMs: number | null;
  /** F17 xlsx: one line per check the verifier ran. */
  checks?: Array<{
    ok: boolean | null;
    label: string;
    detail: string | null;
  }> | null;
}

/** A `currentPhase` result as the phase banner paints it. */
interface StudioPhase {
  text: string;
  head?: string;
  detail?: string;
  stale?: boolean;
  budgetMs?: number | null;
  elapsedMs?: number | null;
}

/** ops.js: run-policy badges and panels, metrics table and sparkline. */
interface StudioOps {
  svg(
    tagName: string,
    attrs?: Record<string, string | number>,
    ...children: unknown[]
  ): SVGElement;
  formatMetric(
    value: number | null | undefined,
    unit?: string | null,
    options?: { signed?: boolean },
  ): string;
  badge(item: {
    key: string;
    label: string;
    tone: string;
    glyph: string;
    title: string;
  }): HTMLElement;
  badges(
    model: Record<string, any> | null | undefined,
    summary?: Record<string, any> | null,
  ): HTMLElement | null;
  exitBadge(code: number | null | undefined): HTMLElement | null;
  lockHeadline(active: Array<Record<string, any>>): string;
  lockSentence(lock: Record<string, any>): string;
  policyPanel(input: {
    policy?: Record<string, any> | null;
    summary?: Record<string, any> | null;
    services?: Array<Record<string, any>> | null;
  }): HTMLElement | null;
  sparkline(
    points: Array<{ runId: string; at: string | null; value: number }>,
    options: {
      name: string;
      unit?: string | null;
      basis?: string;
      currentRunId?: string | null;
      onOpen?: ((runId: string) => void) | null;
    },
  ): HTMLElement;
  metricsView(
    doc: Record<string, any> | null,
    options?: {
      history?: Record<string, any> | null;
      currentRunId?: string | null;
      onOpen?: ((runId: string) => void) | null;
    },
  ): HTMLElement;
}

/**
 * `window.Studio`. Members are optional because every script starts from
 * `globalThis.Studio || {}` and adds its own. There is no index signature:
 * a member nobody declares here (or a misspelt one) is a type error. Only the
 * helpers views export for tests (Studio.live, invocationsView, sessionsView,
 * catalogView) are `any`.
 */
interface StudioGlobal {
  // dom.js
  h?: (
    tagName: string,
    props?: Record<string, any> | StudioChild,
    ...children: StudioChild[]
  ) => HTMLElement;
  isProps?: (value: unknown) => boolean;
  clear?: <T extends Node>(node: T) => T;
  frag?: (...children: StudioChild[]) => DocumentFragment;
  dot?: (className?: string, tone?: string) => HTMLElement;
  tag?: (label: string, tone?: string) => HTMLElement;
  button?: (label: string, props?: Record<string, any>) => HTMLButtonElement;
  input?: (props?: Record<string, any>) => HTMLInputElement;
  select?: (
    options: Array<string | unknown[]>,
    props?: Record<string, any>,
  ) => HTMLSelectElement;
  keyValue?: (rows: Array<[string, any] | any[]>) => HTMLElement;
  loading?: (message?: string) => HTMLElement;
  empty?: (
    title: string,
    body?: string,
    actions?: HTMLElement[],
  ) => HTMLElement;
  errorBox?: (error: unknown, context?: string) => HTMLElement;
  jsonTree?: (value: unknown, depth?: number) => HTMLElement;
  // markdown.js
  markdown?: {
    render: (source: string) => HTMLElement;
    inline: (text: string) => Node[];
  };
  // state.js
  api?: {
    call(channel: string, ...args: unknown[]): Promise<any>;
    on(channel: string, listener: (payload: any) => void): () => void;
  };
  state?: StudioState;
  actions?: StudioActions;
  on?: (event: string, handler: (payload?: any) => void) => () => void;
  emit?: (event: string, payload?: any) => void;
  navigate?: (view: string, params?: Record<string, any>) => void;
  toast?: (
    title: string,
    body?: string | null,
    tone?: "ok" | "bad" | "info",
    ttl?: number,
  ) => void;
  setStatus?: (text: string) => void;
  setStatusRight?: (text: string) => void;
  confirm?: (options: {
    title: string;
    body?: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  promptText?: (options: {
    title: string;
    body?: string;
    placeholder?: string;
    confirmLabel?: string;
    maxLength?: number;
  }) => Promise<string | null>;
  runLabel?: (run: Record<string, any>) => string;
  runRefOf?: (detail: Record<string, any>) => string;
  outcomeLabel?: (run: Record<string, any>) => string;
  rollupSteps?: (record: StudioRecord) => any;
  initLiveRecord?: (record: Record<string, any>) => StudioRecord;
  markDirty?: (record: StudioRecord, sections: Iterable<string>) => void;
  applyEventsToRecord?: (
    record: StudioRecord,
    events: Array<Record<string, any>>,
  ) => StudioRecord;
  appendLog?: (record: StudioRecord, entry: Record<string, any>) => void;
  syncInvocations?: (list: Array<Record<string, any>>) => boolean;
  applyInvocationEvents?: (
    invocationId: string,
    events: Array<Record<string, any>>,
  ) => StudioRecord;
  syncDetected?: (runs: Array<Record<string, any>>) => boolean;
  applyExternalEvents?: (
    runId: string,
    events: Array<Record<string, any>>,
  ) => StudioRecord;
  markExternalFinished?: (payload: {
    runId: string;
    runDir?: string;
    status?: string;
    summary?: string;
    invocation?: Record<string, any>;
    refusal?: Record<string, any> | null;
  }) => StudioRecord;
  suppressDetectedRun?: (runId: string) => void;
  hideDetected?: (runId: string) => void;
  fmt?: CairnFormatApi;
  events?: CairnEventsApi;
  views?: Record<string, StudioView>;
  // components.js
  stashTag?: (
    stash: Record<string, any> | null | undefined,
  ) => HTMLElement | null;
  publishTag?: (
    publish: Record<string, any> | null | undefined,
  ) => HTMLElement | null;
  pinTag?: (
    pinned: { at?: string | null; reason?: string | null } | null | undefined,
  ) => HTMLElement | null;
  evidenceLines?: (lines: string[]) => HTMLElement;
  refusalBox?: (
    refusal:
      | {
          reason?: string | null;
          env?: string | null;
          requiresText?: string | null;
        }
      | null
      | undefined,
    options?: { summary?: string | null },
  ) => HTMLElement;
  rovingKeys?: (
    container: HTMLElement,
    options: {
      items: () => HTMLElement[];
      orientation?: "vertical" | "horizontal";
      roving?: boolean;
      onMove?: (item: HTMLElement) => void;
      onActivate?: (item: HTMLElement) => void;
    },
  ) => void;
  setRovingStop?: (items: HTMLElement[], preferred?: HTMLElement) => void;
  relTime?: (
    value: string | number | Date,
    options?: { prefix?: string; className?: string },
  ) => HTMLElement;
  refreshRelativeTimes?: (root?: ParentNode, now?: number) => void;
  originBadge?: (
    journal: { origin?: string | null; client?: string | null },
    options?: { fromApp?: boolean },
  ) => HTMLElement;
  livenessTag?: (liveness: {
    state?: string;
    reason?: string;
    heartbeatAgeMs?: number | null;
  }) => HTMLElement;
  setupNotice?: () => HTMLElement | null;
  pageHeader?: (
    title: string,
    subtitle: string,
    actions?: Node[] | null,
  ) => HTMLElement;
  panel?: (
    title: string,
    body: string | Node | Node[],
    options?: { actions?: Node[]; tight?: boolean; className?: string },
  ) => HTMLElement;
  paintPhaseBanner?: (
    banner: HTMLElement,
    phase: StudioPhase | null,
    idleText?: string,
  ) => void;
  statusTag?: (status: string | null | undefined) => HTMLElement;
  codeBlock?: (
    text: string,
    options?: { tight?: boolean; className?: string },
  ) => HTMLElement;
  artifactViewer?: (
    runDir: string,
    relativePath: string,
    options?: { maxBytes?: number; journal?: boolean },
  ) => Promise<Node>;
  videoViewer?: (runDir: string, relativePath: string) => Promise<Node>;
  traceViewer?: (
    runDir: string,
    relativePath: string,
    sensitivity?: string | null,
  ) => Promise<Node>;
  sensitivityTag?: (sensitivity: string) => HTMLElement;
  binaryNotice?: (
    runDir: string,
    relativePath: string,
    bytes: number,
    reason?: string,
  ) => HTMLElement;
  historyStrip?: (
    entries: Array<{
      runId: string;
      status: string;
      durationMs: number;
      startedAt: string;
    }>,
    currentRunId: string,
    onOpen: (runId: string) => void,
  ) => HTMLElement;
  ndjsonView?: (text: string) => HTMLElement;
  dataTable?: (table: StudioTable | null | undefined) => HTMLElement | null;
  attemptsTimeline?: (
    attempts:
      | Array<{
          ok: boolean;
          summary: string;
          offsetMs?: number | null;
          at?: string | null;
        }>
      | null
      | undefined,
    options?: {
      count?: number | null;
      polledMs?: number | null;
      title?: string;
    },
  ) => HTMLElement | null;
  dataEvidenceView?: (
    data: StudioDataEvidence | null | undefined,
    options?: { count?: number | null; polledMs?: number | null },
  ) => HTMLElement | null;
  outputsList?: (
    entries: Array<[string, string]> | null | undefined,
  ) => HTMLElement | null;
  copyButton?: (getText: () => string) => HTMLElement;
  revealButton?: (runDir: string, relativePath?: string) => HTMLElement;
  checkbox?: (
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    title?: string,
  ) => HTMLElement;
  // panes.js
  panes?: StudioPanes;
  // ops.js
  ops?: StudioOps;
  // View-private helpers a view exports for tests only.
  live?: any;
  invocationsView?: any;
  sessionsView?: any;
  catalogView?: any;
  suitesView?: any;
  configVarsView?: any;
  // specs.js: the Run path ⌘R shares with the Run button.
  specsView?: { runFocused(): Promise<void> };
}

declare var Studio: StudioGlobal;
declare var CairnFormat: CairnFormatApi;
declare var CairnEvents: CairnEventsApi;
declare var CairnPolicy: CairnPolicyApi;
declare var cairn: CairnBridge | undefined;

/*
 * format.js / events.js are dual-use: CommonJS in the main process and
 * node:test, globals here. Their `module` / `require` guards need a type;
 * the overload only admits the one sibling they load, so a renderer script
 * cannot quietly start requiring Node modules.
 */
declare var module: { exports: unknown } | undefined;
declare function require(id: "./format"): CairnFormatApi;
