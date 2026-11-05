/**
 * Approvals, batched.
 *
 * A model that issues six shell calls in one turn should ask the user once, not six times: six
 * dialogs is how a person learns to press "yes" without reading. Calls that arrive together are
 * collected for a window of a few milliseconds and shown as one list.
 *
 * The window is short because it is not waiting for a human, only for the other calls in the same
 * batch to arrive. A single call costs one dialog, as it should.
 */

/** How long to collect neighbouring asks before showing the one dialog. */
export const APPROVAL_WINDOW_MS = 40;

export interface ApprovalRequest {
	/** What is being asked, in one quotable line. */
	summary: string;
	/** Why the policy wants a human: the rule, the tier, the reason. */
	reason: string;
	/** Tool name, for the dialog heading and for logging. */
	tool: string;
}

export interface ApprovalBatchOptions {
	/** Shows one dialog for several requests. Returns true to allow every one of them. */
	confirm: (requests: readonly ApprovalRequest[]) => Promise<boolean>;
	/** Milliseconds to wait for neighbours. Defaults to {@link APPROVAL_WINDOW_MS}. */
	windowMs?: number;
	/** Injectable so the batcher can be tested without timers. Defaults to `setTimeout`. */
	schedule?: (run: () => void, ms: number) => void;
}

interface Pending {
	request: ApprovalRequest;
	resolve: (allowed: boolean) => void;
}

/**
 * Collects asks that arrive within the window and resolves them with one decision.
 *
 * A denial is per request: if the user says no, every request in that batch is denied, because they
 * were presented as one decision and pretending otherwise would hide what was refused.
 */
export class ApprovalBatcher {
	private pending: Pending[] = [];
	private scheduled = false;
	private readonly confirm: ApprovalBatchOptions["confirm"];
	private readonly windowMs: number;
	private readonly schedule: (run: () => void, ms: number) => void;

	constructor(options: ApprovalBatchOptions) {
		this.confirm = options.confirm;
		this.windowMs = options.windowMs ?? APPROVAL_WINDOW_MS;
		this.schedule = options.schedule ?? ((run, ms) => void setTimeout(run, ms));
	}

	/** Ask for one request. Resolves true when it may proceed. */
	ask(request: ApprovalRequest): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.pending.push({ request, resolve });
			if (this.scheduled) return;
			this.scheduled = true;
			this.schedule(() => void this.flush(), this.windowMs);
		});
	}

	/** Number of requests waiting for the dialog. */
	get size(): number {
		return this.pending.length;
	}

	/** Show the dialog for everything collected so far. Safe to call directly, which tests do. */
	async flush(): Promise<void> {
		if (this.pending.length === 0) {
			this.scheduled = false;
			return;
		}
		const batch = this.pending;
		this.pending = [];
		this.scheduled = false;
		let allowed = false;
		try {
			allowed = await this.confirm(batch.map((entry) => entry.request));
		} catch {
			// A dialog that throws is a denial: the safe direction is the one that stops.
			allowed = false;
		}
		for (const entry of batch) entry.resolve(allowed);
	}
}

/** The dialog text: one line per call, and the shared reason when they agree. */
export function describeBatch(requests: readonly ApprovalRequest[]): { title: string; body: string } {
	if (requests.length === 1) {
		const only = requests[0]!;
		return { title: `Allow this ${only.tool} call?`, body: `${only.summary}\n\n${only.reason}` };
	}
	const reasons = new Set(requests.map((entry) => entry.reason));
	const lines = requests.map((entry, index) => `${index + 1}. ${entry.tool}: ${entry.summary}`);
	const body = [lines.join("\n"), "", reasons.size === 1 ? [...reasons][0]! : "Several rules apply."].join("\n");
	return { title: `Allow ${requests.length} calls?`, body };
}
