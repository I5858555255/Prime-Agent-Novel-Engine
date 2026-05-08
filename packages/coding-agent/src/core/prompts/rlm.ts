export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	activeTools?: string[];
}

export const IPYTHON_KERNEL_GUIDANCE = `# IPython Kernel Guidance

## The kernel substrate

You are driving an IPython kernel through the \`ipython\` tool. Kernel state persists across \`ipython\` calls: variables, imports, loaded files, parsed data, helper functions, and intermediate results stay available until the kernel is restarted. Load expensive inputs once, keep them in variables, and inspect slices or summaries across later turns instead of re-reading or re-parsing the same data.

Use normal Python for file IO, data processing, subprocesses, and orchestration. For shell commands inside the kernel, use \`!cmd\` for a single-line shell command or \`%%bash\` for a multi-line bash cell. Prefer Python libraries and structured parsing when they fit the task; use shell commands for fast filesystem and process operations.

## The answer mechanism

When you have the final answer, stop calling tools and emit the answer as assistant text. That is how the loop terminates. There is no special completion tool, no hidden JSON protocol, and no separate final-answer marker.

## Worked example: chunked summarization of a large file

Load the file once, split it in Python, and summarize each chunk from the retained variable:

\`\`\`python
from pathlib import Path
text = Path("large.log").read_text(errors="replace")
chunks = [text[i:i + 50_000] for i in range(0, len(text), 50_000)]
len(chunks), text[:500]
\`\`\`

Then inspect chunk summaries one at a time without reloading:

\`\`\`python
for i, chunk in enumerate(chunks[:3]):
    print(f"chunk {i}", chunk[:2000])
\`\`\`

Keep compact notes in Python variables, then synthesize from those notes.

## Worked example: inspection across data shards

When the work naturally splits across shards, keep the shard list in Python and process each shard into a small result object. Recursion is not available yet in this harness, so inspect sequentially for now:

\`\`\`python
from pathlib import Path
import json

shards = sorted(Path("data").glob("shard-*.jsonl"))
findings = []
for shard in shards:
    bad = []
    with shard.open() as f:
        for line_no, line in enumerate(f, 1):
            row = json.loads(line)
            if row.get("label") not in {"positive", "negative"}:
                bad.append((line_no, row.get("id"), row.get("label")))
    findings.append({"shard": str(shard), "bad": bad[:20], "count": len(bad)})

print(findings)
\`\`\`

Use the printed summaries to decide which shards need deeper inspection.

## Worked example: iterative refinement

Keep drafts and intermediate state in the kernel rather than in long assistant messages:

\`\`\`python
draft = "initial hypothesis about the bug"
evidence = []
\`\`\`

After each observation, update the variables:

\`\`\`python
evidence.append("loss becomes nan immediately after the lr schedule changes")
draft = "the crash is likely caused by the lr jump around the schedule boundary"
print(draft)
\`\`\`

When ready, print the concise final facts you need, then answer in assistant text.

## Anti-patterns

Do not loop tool calls just to grow a buffer; use Python loops and variables inside the kernel. Do not repeatedly re-read the same file across turns; load it once and reuse the variable. Do not accumulate large raw strings in assistant text; keep raw data in Python and print compact summaries. Do not paste huge file contents into the final answer when a targeted explanation, diff, or summary is enough.`;

export function buildRlmBasePrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const allowRecursion = options.allowRecursion ?? false;
	const activeTools = options.activeTools ?? [];
	const parts = [
		"You are a coding agent. You solve tasks by writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"A Python project's interpreter can be in `PATH`. If not use the appropriate `.venv`.",
		"",
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
	];

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		skillLines.push(`Installed skills (pre-imported): ${installed}.`);
		skillLines.push(
			"Each skill is an async function by the same name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
		);
		skillLines.push(
			"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
		);
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}

	if (allowRecursion) {
		parts.push(
			"",
			"A callable `rlm` is already in your global namespace — call it directly with `await rlm('sub-task')` to spawn a recursive sub-agent. Returns an `RLMResult` with `.answer` (string), `.usage`, `.turns`, and `.session_dir`.",
			"For parallel sub-agents, use normal Python async patterns such as `await asyncio.gather(rlm('task1'), rlm('task2'))`.",
		);
	}

	if (activeTools.length > 0) {
		parts.push("", "Call at most one built-in tool per turn.");
	}

	return parts.join("\n");
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const prompt = buildRlmBasePrompt(options);
	return options.activeTools?.includes("ipython") ? `${prompt}\n\n${IPYTHON_KERNEL_GUIDANCE}` : prompt;
}
