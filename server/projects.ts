import type { ProjectsAccess } from "../shared/attention";
import { missingProjectScope } from "./queries";

// Projects are extra on Next up's issues [NXT-12]: these decide, from what GitHub answered, whether they can be read, and
// keep anything that goes wrong with them from costing the search they ride on.

type Answer = Pick<ProjectsAccess, "state" | "error">;

// Why projects can't be read: the scope, or something else in GitHub's own words.
export function projectsFailure(message: string): Answer {
  return missingProjectScope(message) ? { state: "missing" } : { state: "failed", error: message };
}

// What the probe's answer says. On only when GitHub actually lists the viewer's projects: a partial answer with errors, or
// no answer at all, isn't a yes. `before` is the last answer: a failure for another reason after projects worked leaves
// them on, as each search falls back on its own.
export function probeAnswer(result: { data: { viewer?: { projectsV2?: unknown } | null } | null; errors: string[] } | Error, before: Answer["state"]): Answer {
  if (!(result instanceof Error) && result.data?.viewer?.projectsV2) return { state: "on" };
  const answer = projectsFailure(result instanceof Error ? result.message : result.errors.join("; ") || "GitHub didn't list your projects");
  return answer.state === "failed" && before === "on" ? { state: "on", error: answer.error } : answer;
}

// What went wrong reading projects in one refresh, each said once, for Settings; nothing when all went well.
export function projectsWarning(problems: string[]): string | undefined {
  return problems.length ? [...new Set(problems.flatMap((problem) => problem.split("; ")))].join("; ") : undefined;
}

// One of Next up's searches with projects, falling back to the same search without them whatever goes wrong: GitHub
// failing it, or answering without its results. Boards the token can't see come back empty within an answer that has
// its results, which is kept. `failure` says what went wrong, for Settings.
export async function searchWithProjects<T>(
  withProjects: () => Promise<{ data: T | null; errors: string[] }>,
  without: () => Promise<T>,
  hasResults: (data: T) => boolean,
): Promise<{ data: T; failure?: string; partly?: string }> {
  let failure: string;
  try {
    const { data, errors } = await withProjects();
    if (data && hasResults(data)) return errors.length ? { data, partly: errors.join("; ") } : { data };
    failure = errors.join("; ") || "GitHub returned no results";
  } catch (error) {
    failure = (error as Error).message;
  }
  return { data: await without(), failure };
}
