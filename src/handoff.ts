/** Local ticket history stays on disk; only the model's prompt uses the latest checkpoint. */
export function compactDescription(description: string | null): string | null {
  if (!description) return description;
  const heading = /^## Comments[ \t]*\r?$/m.exec(description);
  if (!heading) return description;
  const body = description.slice(0, heading.index).trimEnd();
  const comments = description.slice(heading.index + heading[0].length);
  const entries = [...comments.matchAll(/^### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]*\r?$/gm)];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const text = comments.slice(entry.index + entry[0].length, entries[i + 1]?.index).trim();
    if (/^## Handoff\r?\n\s*\S/.test(text)) {
      return `${body}\n\n## Comments\n\n${comments.slice(entry.index)}`;
    }
  }
  return description;
}

export const handoffInstructions = `
## Review handoff
Reuse the existing workspace and branch. Read the ticket requirements, latest handoff and newer feedback; inspect relevant files and diffs and build on completed work.
Before handing off or reporting a blocker, post a comment through $SYMPHONY_TRACKER whose first line is exactly "## Handoff". Aim for at most 200 words: completed work, relevant files/branch, key decisions, tests/results, remaining issues, and all unresolved feedback or requirement changes from earlier comments. Use this as the workflow's summary comment, without a duplicate summary. It replaces older comments in the next run's prompt, so make it self-contained. Keep the original requirements authoritative and apply newer review feedback. Do not include tool logs.
When a human decision is needed, post a separate comment with a "## Decisions" section. Put each question on its own plain line, followed by its explicit answer options as "- Option" lines. Include concrete options whenever the alternatives are known; omit options only for an open-ended question. Do not use subheadings for questions. The dashboard lets the user choose an option or type an answer and submit the answers as a comment.
The full comment history remains in the local ticket file if details need checking.
`.trim();
