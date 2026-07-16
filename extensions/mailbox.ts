/** A session-scoped event mailbox with exact permission-approval cleanup. */
export interface MailEvent<Status extends string = string> {
	id: string;
	parentSessionId: string;
	agentName: string;
	kind: "completion" | "permission";
	status: Status;
	finalResponse?: string;
	error?: string;
	approvalId?: string;
	summary?: string;
	allowOnceOffered?: boolean;
	createdAt: number;
}

export interface PermissionMailKey {
	parentSessionId: string;
	agentName: string;
	approvalId: string;
}

export function isExactPermissionMail<Status extends string>(event: MailEvent<Status>, key: PermissionMailKey): boolean {
	return event.kind === "permission"
		&& event.parentSessionId === key.parentSessionId
		&& event.agentName === key.agentName
		&& event.approvalId === key.approvalId;
}

/**
 * Retains unclaimed events. Permission events are only claimable while their
 * matching approval remains pending; callers supply that live-state predicate.
 */
export class Mailbox<Status extends string = string> {
	private readonly events: MailEvent<Status>[] = [];

	push(event: MailEvent<Status>): void {
		this.events.push(event);
	}

	claim(match: (event: MailEvent<Status>) => boolean, isPermissionPending: (event: MailEvent<Status>) => boolean): MailEvent<Status> | undefined {
		this.discardStalePermissions(isPermissionPending);
		const index = this.events.findIndex(match);
		return index < 0 ? undefined : this.events.splice(index, 1)[0];
	}

	removePermission(key: PermissionMailKey): void {
		for (let index = this.events.length - 1; index >= 0; index--) {
			if (isExactPermissionMail(this.events[index]!, key)) this.events.splice(index, 1);
		}
	}

	remove(match: (event: MailEvent<Status>) => boolean): void {
		for (let index = this.events.length - 1; index >= 0; index--) {
			if (match(this.events[index]!)) this.events.splice(index, 1);
		}
	}

	private discardStalePermissions(isPermissionPending: (event: MailEvent<Status>) => boolean): void {
		for (let index = this.events.length - 1; index >= 0; index--) {
			const event = this.events[index]!;
			if (event.kind === "permission" && !isPermissionPending(event)) this.events.splice(index, 1);
		}
	}
}

/**
 * Validate/compute the decision before changing mailbox or approval state,
 * then remove the exact mail event before resolving ACP.
 */
export function resolveAndSettlePermission<T, Status extends string = string>(
	mailbox: Mailbox<Status>,
	key: PermissionMailKey,
	resolveDecision: () => T,
	settle: (decision: T) => void,
): T {
	const decision = resolveDecision();
	mailbox.removePermission(key);
	settle(decision);
	return decision;
}
