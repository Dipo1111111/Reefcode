/**
 * A small POSIX-ish shell lexer, for deciding what a command *is* before it runs.
 *
 * It is deliberately not a shell parser. It understands quotes, escapes, `&&`, `||`, `;`, `|`,
 * and redirections, which is enough to split a command line into simple segments and read their
 * tokens. Anything it cannot parse returns `undefined`, and the policy treats that as "no match":
 * never guess, fall back to the tier default.
 */

export interface ShellSegment {
	/** Tokens of one simple command, quotes removed. */
	tokens: string[];
	/** Operators that preceded this segment (`&&`, `||`, `;`, `|`). */
	precededBy?: string;
	/** Redirections found in this segment, as `>file`, `>>file`, `<file`. */
	redirections: string[];
}

const OPERATORS = ["&&", "||", ";;", ";", "|"];

/** Split a command line into simple segments. `undefined` when the line cannot be read. */
export function parseShell(command: string): ShellSegment[] | undefined {
	const segments: ShellSegment[] = [];
	let tokens: string[] = [];
	let redirections: string[] = [];
	let current = "";
	let hasCurrent = false;
	let quote: '"' | "'" | undefined;
	let pendingOperator: string | undefined;

	const pushToken = () => {
		if (hasCurrent) {
			tokens.push(current);
			current = "";
			hasCurrent = false;
		}
	};
	const pushSegment = () => {
		pushToken();
		if (tokens.length > 0) {
			segments.push({ tokens, redirections, ...(pendingOperator ? { precededBy: pendingOperator } : {}) });
			pendingOperator = undefined;
		}
		tokens = [];
		redirections = [];
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quote) {
			if (char === "\\" && quote === '"') {
				i++;
				current += command[i] ?? "";
				hasCurrent = true;
				continue;
			}
			if (char === quote) {
				quote = undefined;
				hasCurrent = true;
				continue;
			}
			current += char;
			hasCurrent = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			hasCurrent = true;
			continue;
		}
		if (char === "\\") {
			i++;
			current += command[i] ?? "";
			hasCurrent = true;
			continue;
		}
		if (char === "\n") {
			pushSegment();
			continue;
		}
		if (char === " " || char === "\t") {
			pushToken();
			continue;
		}
		if (char === ">" || char === "<") {
			pushToken();
			let op = char;
			if (command[i + 1] === ">" || command[i + 1] === "&") {
				op += command[i + 1];
				i++;
			}
			let target = "";
			while (i + 1 < command.length && /[^\s;&|]/.test(command[i + 1] as string)) {
				i++;
				target += command[i];
			}
			redirections.push(`${op}${target}`);
			continue;
		}
		const two = command.slice(i, i + 2);
		if (OPERATORS.includes(two)) {
			pushSegment();
			pendingOperator = two;
			i++;
			continue;
		}
		if (OPERATORS.includes(char)) {
			pushSegment();
			pendingOperator = char;
			continue;
		}
		if (char === "`" || char === "$" || char === "(" || char === ")") {
			// Substitutions are not modelled. A caller that needs them must not allow the segment.
			return undefined;
		}
		current += char;
		hasCurrent = true;
	}
	if (quote) return undefined;
	pushSegment();
	return segments;
}

/**
 * Unwrap a command that only runs another command: `bash -c "..."`, `sh -c ...`, `env X=1 cmd`,
 * `time cmd`, `nohup cmd`. Returns the inner command text when the wrapper is understood.
 */
export function unwrap(tokens: string[]): string | undefined {
	const [head, ...rest] = tokens;
	if (!head) return undefined;
	if (["bash", "sh", "zsh", "dash"].includes(head)) {
		const index = rest.findIndex((token) => token === "-c" || token === "-lc" || token === "-cl");
		if (index === -1) return undefined;
		return rest.slice(index + 1).join(" ");
	}
	if (head === "sudo" || head === "command" || head === "time" || head === "nohup" || head === "exec") {
		const index = rest.findIndex((token) => !token.startsWith("-"));
		return index === -1 ? undefined : rest.slice(index).join(" ");
	}
	if (head === "env") {
		const index = rest.findIndex((token) => !token.includes("="));
		return index === -1 ? undefined : rest.slice(index).join(" ");
	}
	return undefined;
}

/** Every unwrapping level, so `sudo bash -c "rm -rf /"` can be matched at the bottom. */
export function expand(tokens: string[], depth = 0): string[][] {
	if (depth > 4) return [tokens];
	const inner = unwrap(tokens);
	if (!inner) return [tokens];
	const parsed = parseShell(inner);
	if (!parsed) return [tokens];
	return [tokens, ...parsed.flatMap((segment) => expand(segment.tokens, depth + 1))];
}
