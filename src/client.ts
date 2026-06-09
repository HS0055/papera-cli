// PaperaClient — a thin typed wrapper over the Papera HTTP API plus the one
// piece of orchestration the magic needs: generate a v2 layout, wrap it as a
// v2 notebook page, and persist it (returning a real, openable notebook URL).
//
// Everything here is plain `fetch` against the same endpoints the web app uses.
// Auth is a single Bearer token — an API key (papera_live_…) for headless use,
// or a session token for the login→mint-key handshake.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export class PaperaError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "PaperaError";
    this.status = status;
    this.code = code;
  }
}

/** Raw response of POST /api/generate-layout-v2. */
export interface GeneratedLayout {
  title: string;
  theme: unknown;
  elements: unknown[];
  params?: unknown[];
  meta?: {
    quality?: { passed?: boolean; overall?: number };
    classifiedPageType?: string;
    recipeId?: string;
  };
}

/** A notebook as returned (summarized) by GET /api/notebooks. */
export interface NotebookSummary {
  id: string;
  title: string;
  coverColor?: string;
  pageCount: number;
  url: string;
}

/** A page as returned by GET /api/notebooks (v1 blocks + v2 fields, flat). */
export interface RemotePage {
  id: string;
  title: string;
  createdAt?: string;
  paperType?: string;
  aesthetic?: string;
  themeColor?: string;
  aiGenerated?: boolean;
  version?: 1 | 2;
  elements?: unknown;
  theme?: unknown;
  params?: unknown;
  blocks?: unknown[];
}

export interface RemoteNotebook {
  id: string;
  title: string;
  coverColor?: string;
  collection?: string;
  bookmarks?: string[];
  createdAt?: string;
  pages: RemotePage[];
}

export interface CreatePageResult {
  notebookId: string;
  url: string;
  title: string;
  pageCount: number;
  appended: boolean;
}

const MAX_PAGES_PER_CALL = 5;

export interface PaperaClientOptions {
  apiUrl: string;
  appUrl: string;
  /** Default Bearer token (an API key) for authenticated calls. */
  apiKey?: string;
}

export class PaperaClient {
  constructor(private readonly opts: PaperaClientOptions) {}

  get appUrl(): string {
    return this.opts.appUrl;
  }

  notebookUrl(notebookId: string): string {
    return `${this.opts.appUrl}/app/notebook/${notebookId}`;
  }

  private async req<T = any>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      /** Override the Bearer token (e.g. a session token during login). */
      token?: string;
      /** Set false to skip auth entirely (login). */
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const { method = "GET", body, token, auth = true } = init;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const bearer = token ?? this.opts.apiKey;
    if (auth) {
      if (!bearer) {
        throw new PaperaError(
          "Not authenticated. Run `papera login`, or set PAPERA_API_KEY.",
          401,
          "no_credentials",
        );
      }
      headers["Authorization"] = `Bearer ${bearer}`;
    }

    let res: Response;
    try {
      res = await fetch(`${this.opts.apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PaperaError(
        `Network error reaching Papera (${this.opts.apiUrl}): ${(e as Error).message}`,
        undefined,
        "network",
      );
    }

    const text = await res.text();
    let json: any = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text.slice(0, 500) };
      }
    }
    if (!res.ok) {
      throw new PaperaError(
        json?.error || `HTTP ${res.status}`,
        res.status,
        json?.code,
      );
    }
    return json as T;
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  /**
   * Email+password → mint a long-lived API key. The session token never leaves
   * this method; the caller stores only the returned key.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ key: string; email: string }> {
    const loginRes = await this.req<{ sessionToken?: string; user?: { email?: string } }>(
      "/api/auth/login",
      { method: "POST", body: { email, password }, auth: false },
    );
    const sessionToken = loginRes.sessionToken;
    if (!sessionToken) {
      throw new PaperaError("Login did not return a session token.", 500);
    }
    const keyRes = await this.req<{ key?: string }>("/api/keys/create", {
      method: "POST",
      body: { name: `papera CLI (${hostname()})` },
      token: sessionToken,
    });
    if (!keyRes.key) {
      throw new PaperaError("Could not mint an API key.", 500);
    }
    return { key: keyRes.key, email: loginRes.user?.email ?? email };
  }

  /** Email+password → a session token only (for key management, which by
   *  design cannot be driven by an API key). */
  async loginSession(email: string, password: string): Promise<string> {
    const loginRes = await this.req<{ sessionToken?: string }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    if (!loginRes.sessionToken) {
      throw new PaperaError("Login did not return a session token.", 500);
    }
    return loginRes.sessionToken;
  }

  /** List the account's active API keys (prefix only — never plaintext). */
  async listKeys(sessionToken: string): Promise<
    Array<{ id: string; prefix: string; name: string | null; createdAt: number; lastUsedAt: number | null }>
  > {
    const res = await this.req<{ keys?: Array<{ id: string; prefix: string; name: string | null; createdAt: number; lastUsedAt: number | null }> }>(
      "/api/keys",
      { token: sessionToken },
    );
    return Array.isArray(res.keys) ? res.keys : [];
  }

  /** Revoke one API key by id. Idempotent. */
  async revokeKey(sessionToken: string, id: string): Promise<void> {
    await this.req<{ revoked?: boolean }>("/api/keys/revoke", {
      method: "POST",
      body: { id },
      token: sessionToken,
    });
  }

  // ── Notebooks ───────────────────────────────────────────────────────────

  /** Full notebooks payload (used by list + get + append). */
  async fetchNotebooks(): Promise<RemoteNotebook[]> {
    const res = await this.req<{ notebooks?: RemoteNotebook[] }>("/api/notebooks");
    return Array.isArray(res.notebooks) ? res.notebooks : [];
  }

  async listNotebooks(): Promise<NotebookSummary[]> {
    const notebooks = await this.fetchNotebooks();
    return notebooks.map((nb) => ({
      id: nb.id,
      title: nb.title,
      coverColor: nb.coverColor,
      pageCount: Array.isArray(nb.pages) ? nb.pages.length : 0,
      url: this.notebookUrl(nb.id),
    }));
  }

  async getNotebook(notebookId: string): Promise<RemoteNotebook | null> {
    const notebooks = await this.fetchNotebooks();
    return notebooks.find((nb) => nb.id === notebookId) ?? null;
  }

  /** Lightweight account summary for the interactive header (email/plan/Ink). */
  async getAccount(): Promise<{ email?: string; plan?: string; ink?: number }> {
    const me = await this.req<any>("/api/auth/me").catch(() => ({}));
    const user = me?.user ?? me ?? {};
    let ink: number | undefined;
    try {
      const bal = await this.req<any>("/api/ink/balance");
      ink = typeof bal?.total === "number" ? bal.total : undefined;
    } catch {
      /* balance is best-effort */
    }
    return { email: user?.email, plan: user?.plan, ink };
  }

  /**
   * One agentic-console turn through the Papera backend brain. The server
   * holds the Gemini key, so this works for any logged-in user with NO
   * personal Gemini key. We send the client's system prompt + the running
   * conversation; the server returns the model's next raw text (a JSON action
   * the caller parses). Free — Ink is only charged when a turn creates a page.
   */
  async chatStep(
    system: string,
    messages: { role: "user" | "model"; content: string }[],
  ): Promise<string> {
    const res = await this.req<{ text?: string }>("/api/chat", {
      method: "POST",
      body: { system, messages },
    });
    return res.text ?? "";
  }

  /** POST /api/generate-layout-v2 — one Gemini composition (10 Ink). */
  async generateLayout(prompt: string): Promise<GeneratedLayout> {
    return this.req<GeneratedLayout>("/api/generate-layout-v2", {
      method: "POST",
      body: { prompt },
    });
  }

  /** Persist a notebook synchronously and get back the canonical Convex id. */
  private async saveSync(notebook: unknown): Promise<{ id: string; pageCount: number }> {
    return this.req<{ id: string; pageCount: number }>("/api/notebooks/save-sync", {
      method: "POST",
      body: { notebook },
    });
  }

  /**
   * Update an existing notebook: full-snapshot upsert by id. Used by
   * `papera sync` to write changed tracker cells back. The caller passes the
   * full notebook (all pages) with the mutation applied, so no pages are lost.
   */
  async saveNotebook(notebook: {
    id: string;
    title: string;
    coverColor?: string;
    bookmarks?: string[];
    pages: unknown[];
  }): Promise<{ id: string; pageCount: number }> {
    return this.saveSync({
      coverColor: "bg-indigo-900",
      bookmarks: [],
      isShared: false,
      ...notebook,
    });
  }

  /** Wrap a generated layout as a saveable v2 page. */
  private layoutToPage(layout: GeneratedLayout, prompt: string) {
    return {
      id: randomUUID(),
      title: layout.title,
      createdAt: new Date().toISOString(),
      // v2 paints its surface from theme.paper; 'blank' is the inert default
      // the page shape still requires.
      paperType: "blank",
      version: 2 as const,
      elements: layout.elements,
      theme: layout.theme,
      params: layout.params,
      aiPrompt: prompt,
      aiGenerated: true,
    };
  }

  /**
   * THE killer path: prompt → generated v2 page(s) → durable notebook → URL.
   *
   * Creates a NEW notebook by default. If `notebookId` is given, the new
   * page(s) are appended to that existing notebook (its current pages are
   * re-sent so the snapshot upsert preserves them).
   */
  async createPageFromPrompt(
    prompt: string,
    opts: { notebookId?: string; pageCount?: number; notebookTitle?: string } = {},
  ): Promise<CreatePageResult> {
    const pageCount = Math.max(1, Math.min(opts.pageCount ?? 1, MAX_PAGES_PER_CALL));

    // N pages = N independent generations (mirrors the web's multi-page flow).
    const newPages: ReturnType<typeof this.layoutToPage>[] = [];
    let firstTitle = "";
    for (let i = 0; i < pageCount; i++) {
      const layout = await this.generateLayout(prompt);
      if (i === 0) firstTitle = layout.title;
      newPages.push(this.layoutToPage(layout, prompt));
    }

    if (opts.notebookId) {
      // Append: re-send the existing pages + the new ones.
      const existing = await this.getNotebook(opts.notebookId);
      if (!existing) {
        throw new PaperaError(
          `Notebook ${opts.notebookId} not found.`,
          404,
          "notebook_not_found",
        );
      }
      const mergedPages = [...(existing.pages ?? []), ...newPages];
      const saved = await this.saveSync({
        id: existing.id,
        title: existing.title,
        coverColor: existing.coverColor || "bg-indigo-900",
        bookmarks: existing.bookmarks ?? [],
        isShared: false,
        createdAt: existing.createdAt,
        pages: mergedPages,
      });
      return {
        notebookId: saved.id,
        url: this.notebookUrl(saved.id),
        title: existing.title,
        pageCount: newPages.length,
        appended: true,
      };
    }

    // New notebook. `id` is a client UUID (stored as clientId); save-sync
    // returns the canonical Convex id we build the URL from.
    const title = opts.notebookTitle?.trim() || firstTitle || "Untitled";
    const saved = await this.saveSync({
      id: randomUUID(),
      title,
      coverColor: "bg-indigo-900",
      bookmarks: [],
      isShared: false,
      createdAt: new Date().toISOString(),
      pages: newPages,
    });
    return {
      notebookId: saved.id,
      url: this.notebookUrl(saved.id),
      title,
      pageCount: newPages.length,
      appended: false,
    };
  }

  /**
   * Section planner for the `papera doc` flow. Sends the FULL (distilled)
   * document text to the backend brain and asks it to split the material into
   * `targetPages` coherent, content-rich page sections. Each returned
   * `prompt` is a self-contained ≤1900-char description the v2 generator can
   * turn into one faithful page. Metered like any chat call (charged by the
   * real tokens of the document it reads).
   */
  async planDocSections(
    docsText: string,
    targetPages: number,
  ): Promise<{ title: string; prompt: string }[]> {
    const system =
      `You split SOURCE DOCUMENTS into coherent Papera notebook-page sections. ` +
      `Produce EXACTLY ${targetPages} section(s) that together cover the documents faithfully — ` +
      `group related material, preserve real content (key facts, lists, numbers, structure), and never invent placeholders. ` +
      `Respond with ONE JSON object and nothing else: ` +
      `{"sections":[{"title":"<short page title>","prompt":"<self-contained description, max 1500 chars, of a notebook page capturing THIS section's actual content so a layout generator can build a faithful, useful page (include the concrete items/sections/data, not generic filler)>"}]}. ` +
      `Use the documents' real wording and details.`;
    const text = await this.chatStep(system, [{ role: "user", content: docsText }]);
    let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) cleaned = cleaned.slice(a, b + 1);
    let parsed: { sections?: Array<{ title?: unknown; prompt?: unknown }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new PaperaError("The planner returned an unparseable response. Try again.", 502);
    }
    const raw = Array.isArray(parsed.sections) ? parsed.sections : [];
    return raw
      .map((s) => ({
        title: String(s.title ?? "Section").slice(0, 120),
        prompt: String(s.prompt ?? "").slice(0, 1900),
      }))
      .filter((s) => s.prompt.trim().length > 0);
  }

  /**
   * Plan a GOAL into page sections via the Papera backend brain (Gemini) —
   * the fallback for `papera plan` when no OpenAI key is set. Same shape as
   * the OpenAI planner so the two are interchangeable. Metered like chat.
   */
  async planGoalSections(
    goal: string,
    targetPages: number,
  ): Promise<{ title: string; prompt: string }[]> {
    const { PLANNER_SYSTEM, parseSections } = await import("./openai.js");
    const text = await this.chatStep(PLANNER_SYSTEM(targetPages), [
      { role: "user", content: goal },
    ]);
    return parseSections(text);
  }

  /**
   * Generate ONE v2 page per section prompt and persist them as a single
   * multi-page notebook. Mirrors `createPageFromPrompt` but with a distinct
   * prompt per page (vs. N pages from one prompt). Charges the standard
   * per-page Ink server-side, once per section.
   */
  async createNotebookFromSections(
    title: string,
    sections: { title: string; prompt: string }[],
    onPage?: (index: number, total: number) => void,
  ): Promise<CreatePageResult> {
    const pages: ReturnType<typeof this.layoutToPage>[] = [];
    for (let i = 0; i < sections.length; i++) {
      onPage?.(i, sections.length);
      const layout = await this.generateLayout(sections[i].prompt);
      pages.push(this.layoutToPage(layout, sections[i].prompt));
    }
    const saved = await this.saveSync({
      id: randomUUID(),
      title,
      coverColor: "bg-indigo-900",
      bookmarks: [],
      isShared: false,
      createdAt: new Date().toISOString(),
      pages,
    });
    return {
      notebookId: saved.id,
      url: this.notebookUrl(saved.id),
      title,
      pageCount: pages.length,
      appended: false,
    };
  }
}
