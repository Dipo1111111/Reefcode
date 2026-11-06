import { dirname } from "node:path";

/**
 * A skill that a message can name: its file, and the directory references inside it resolve against.
 */
export interface SkillMention {
	name: string;
	filePath: string;
	baseDir: string;
	/** The skill body, frontmatter already stripped. */
	body: string;
}

/**
 * Written above every skill body. A skill is a procedure, and procedures are written one step at a
 * time. Without this line the model replayed each step as its own turn: nine discovery calls on a
 * restore that needed two. The steps do not change; the batching does.
 */
export const SKILL_BATCHING_DIRECTIVE =
	"Run this procedure in as few turns as possible. Every independent read belongs in the same `script` call: step 1, and every step that only opens more files, is one call, not one per step. Only a step whose next move depends on the result earns a turn of its own.";

/** Build the block the model reads for one skill. */
export function renderSkillBlock(skill: SkillMention): string {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${SKILL_BATCHING_DIRECTIVE}\n\n${skill.body}\n</skill>`;
}

/**
 * Expand every skill a message names into a skill block placed before the prose.
 *
 * Two spellings name a skill: `skill:name`, which autocomplete inserts, and `/name`, which people
 * type. Both work anywhere in the message. A `/name` that leads the message yields to a built-in
 * command, so `/model` still opens the model picker; a name that resolves to nothing, built-in or
 * not, stays exactly as typed.
 *
 * @param resolve looks a name up; return undefined to leave the mention alone
 * @param builtinCommandNames built-in slash command names, without the slash
 */
export function expandSkillMentions(
	text: string,
	resolve: (name: string) => SkillMention | undefined,
	builtinCommandNames: ReadonlySet<string> = new Set(),
): string {
	if (!text.includes("skill:") && !text.includes("/")) return text;
	const blocks: string[] = [];
	// `/skill:name` is the spelling autocomplete and older docs use; treat it as `skill:name`.
	const prose = text
		.replace(/(^|\s)\/skill:/g, "$1skill:")
		.replace(
			/(^|\s)(skill:|\/)([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_-])/g,
			(match, lead: string, prefix: string, name: string) => {
				if (prefix === "/" && lead === "" && builtinCommandNames.has(name)) return match;
				const skill = resolve(name);
				if (!skill) return match;
				blocks.push(renderSkillBlock(skill));
				return lead;
			},
		)
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	if (blocks.length === 0) return text;
	return prose ? `${blocks.join("\n\n")}\n\n${prose}` : blocks.join("\n\n");
}

/** A skill mention resolved from a file path, for callers that only know where the file is. */
export function skillMentionFromFile(name: string, filePath: string, body: string): SkillMention {
	return { name, filePath, baseDir: dirname(filePath), body };
}
