// OpenAI planning brain for `papera plan`.
//
// "C" (native in the bare CLI): the CLI calls OpenAI DIRECTLY with the user's
// own key — reusing their GPT access, no Papera-side key, no backend. Returns
// page sections that the existing v2 generator turns into a real notebook.

// OpenAI's models change often; let the user override. gpt-4o-mini is a cheap,
// broadly-available planner. (Codex/GPT-5/o-series also work — set the env.)
const MODEL = process.env.PAPERA_OPENAI_MODEL || "gpt-4o-mini";

/** Parse the single {"sections":[{title,prompt}]} object from model text. */
export function parseSections(text: string): { title: string; prompt: string }[] {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) cleaned = cleaned.slice(a, b + 1);
  let parsed: { sections?: Array<{ title?: unknown; prompt?: unknown }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("planner returned unparseable JSON");
  }
  const raw = Array.isArray(parsed.sections) ? parsed.sections : [];
  return raw
    .map((s) => ({
      title: String(s.title ?? "Section").slice(0, 120),
      prompt: String(s.prompt ?? "").slice(0, 1900),
    }))
    .filter((s) => s.prompt.trim().length > 0);
}

const PLANNER_SYSTEM = (targetPages: number) =>
  `You are a planning assistant for Papera. Turn the user's GOAL into a concrete, ` +
  `actionable plan split into EXACTLY ${targetPages} notebook page section(s). ` +
  `Each section is one page of the plan (phases, milestones, checklists, schedules, trackers — ` +
  `whatever fits the goal). Respond with ONE JSON object and nothing else: ` +
  `{"sections":[{"title":"<short page title>","prompt":"<self-contained description, max 1500 chars, ` +
  `of a notebook page with the REAL plan content for this section — concrete steps, items, dates, ` +
  `metrics — so a layout generator can build a useful page>"}]}.`;

/** Plan a goal into page sections using the user's OpenAI key (client-side). */
export async function openaiPlanGoal(
  goal: string,
  targetPages: number,
  apiKey: string,
): Promise<{ title: string; prompt: string }[]> {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      temperature: 0.5,
      messages: [
        { role: "system", content: PLANNER_SYSTEM(targetPages) },
        { role: "user", content: goal },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${t.slice(0, 180)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return parseSections(data?.choices?.[0]?.message?.content ?? "");
}

export { PLANNER_SYSTEM, MODEL as OPENAI_MODEL };
