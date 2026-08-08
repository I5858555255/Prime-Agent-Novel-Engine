const MONTH_NAMES = new Map([
	["jan", 1],
	["feb", 2],
	["mar", 3],
	["apr", 4],
	["may", 5],
	["jun", 6],
	["jul", 7],
	["aug", 8],
	["sep", 9],
	["oct", 10],
	["nov", 11],
	["dec", 12],
]);

const WEEKDAY_NAMES = new Map([
	["sun", 0],
	["mon", 1],
	["tue", 2],
	["wed", 3],
	["thu", 4],
	["fri", 5],
	["sat", 6],
]);

interface CronField {
	values: readonly number[];
	valueSet: ReadonlySet<number>;
	unrestricted: boolean;
}

interface CronFields {
	minute: CronField;
	hour: CronField;
	dayOfMonth: CronField;
	month: CronField;
	dayOfWeek: CronField;
}

export function nextCronRunAfter(expression: string, after: Date): Date {
	if (!Number.isFinite(after.getTime())) {
		throw new Error("Cron schedule requires a valid reference date");
	}
	const fields = parseCronExpression(expression);
	const wall = localTimeAsUtcDate(after);
	wall.setUTCMinutes(wall.getUTCMinutes() + 1);
	const finalYear = wall.getUTCFullYear() + 400;

	while (wall.getUTCFullYear() <= finalYear) {
		if (!fields.month.valueSet.has(wall.getUTCMonth() + 1)) {
			advanceToAllowedMonth(wall, fields.month.values);
			continue;
		}
		if (!matchesCronDay(wall, fields)) {
			advanceWallDay(wall);
			continue;
		}
		if (!fields.hour.valueSet.has(wall.getUTCHours())) {
			advanceToAllowedHour(wall, fields.hour.values);
			continue;
		}
		if (!fields.minute.valueSet.has(wall.getUTCMinutes())) {
			advanceToAllowedMinute(wall, fields.minute.values);
			continue;
		}

		const instant = wallTimeToLocalInstant(wall);
		if (sameWallTime(instant, wall) && instant.getTime() > after.getTime()) {
			return instant;
		}
		wall.setUTCMinutes(wall.getUTCMinutes() + 1);
	}

	throw new Error(`Cron schedule has no future occurrence in a 400-year Gregorian cycle: ${expression}`);
}

export function normalizeCronAlias(text: string): string {
	switch (text.toLowerCase()) {
		case "@yearly":
		case "@annually":
			return "0 0 1 1 *";
		case "@monthly":
			return "0 0 1 * *";
		case "@weekly":
			return "0 0 * * 0";
		case "@daily":
		case "@midnight":
			return "0 0 * * *";
		case "@hourly":
			return "0 * * * *";
		case "@reboot":
			throw new Error("@reboot is unsupported because scheduled prompts require a time-based recurrence");
		default:
			return text;
	}
}

function parseCronExpression(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			"Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', a supported @ alias, or five fields: minute hour day month weekday",
		);
	}
	return {
		minute: parseCronField(parts[0]!, 0, 59),
		hour: parseCronField(parts[1]!, 0, 23),
		dayOfMonth: parseCronField(parts[2]!, 1, 31),
		month: parseCronField(parts[3]!, 1, 12, MONTH_NAMES),
		dayOfWeek: normalizeWeekdays(parseCronField(parts[4]!, 0, 7, WEEKDAY_NAMES)),
	};
}

function parseCronField(field: string, min: number, max: number, names?: ReadonlyMap<string, number>): CronField {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) {
			throw new Error(`Invalid cron field: ${field}`);
		}
		const stepParts = part.split("/");
		if (stepParts.length > 2) {
			throw new Error(`Invalid cron step: ${part}`);
		}
		const rangeText = stepParts[0]!;
		const step = stepParts[1] === undefined ? 1 : parseCronNumber(stepParts[1], 1, max);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else {
			const rangeParts = rangeText.split("-");
			if (rangeParts.length === 1) {
				if (stepParts[1] !== undefined) {
					throw new Error(`Cron steps require a range or wildcard: ${part}`);
				}
				start = parseCronValue(rangeParts[0], min, max, names);
				end = start;
			} else if (rangeParts.length === 2) {
				start = parseCronValue(rangeParts[0], min, max, names);
				end = parseCronValue(rangeParts[1], min, max, names);
				if (start > end) {
					throw new Error(`Invalid cron range: ${rangeText}`);
				}
			} else {
				throw new Error(`Invalid cron range: ${rangeText}`);
			}
		}
		for (let value = start; value <= end; value += step) {
			values.add(value);
		}
	}
	const sortedValues = [...values].sort((left, right) => left - right);
	return { values: sortedValues, valueSet: new Set(sortedValues), unrestricted: field === "*" };
}

function parseCronValue(
	value: string | undefined,
	min: number,
	max: number,
	names?: ReadonlyMap<string, number>,
): number {
	const named = value === undefined ? undefined : names?.get(value.toLowerCase());
	if (named !== undefined) {
		return named;
	}
	return parseCronNumber(value, min, max);
}

function parseCronNumber(value: string | undefined, min: number, max: number): number {
	if (!value || !/^\d+$/.test(value)) {
		throw new Error(`Invalid cron number or name: ${value ?? ""}`);
	}
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) {
		throw new Error(`Cron number out of range: ${value}`);
	}
	return parsed;
}

function normalizeWeekdays(field: CronField): CronField {
	const valueSet = new Set(field.values.map((value) => (value === 7 ? 0 : value)));
	const values = [...valueSet].sort((left, right) => left - right);
	return { ...field, values, valueSet };
}

function matchesCronDay(wall: Date, fields: CronFields): boolean {
	const dayOfMonthMatches = fields.dayOfMonth.valueSet.has(wall.getUTCDate());
	const dayOfWeekMatches = fields.dayOfWeek.valueSet.has(wall.getUTCDay());
	if (!fields.dayOfMonth.unrestricted && !fields.dayOfWeek.unrestricted) {
		return dayOfMonthMatches || dayOfWeekMatches;
	}
	return dayOfMonthMatches && dayOfWeekMatches;
}

function localTimeAsUtcDate(date: Date): Date {
	const wall = new Date(0);
	wall.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
	wall.setUTCHours(date.getHours(), date.getMinutes(), 0, 0);
	return wall;
}

function wallTimeToLocalInstant(wall: Date): Date {
	const instant = new Date(
		wall.getUTCFullYear(),
		wall.getUTCMonth(),
		wall.getUTCDate(),
		wall.getUTCHours(),
		wall.getUTCMinutes(),
		0,
		0,
	);
	if (wall.getUTCFullYear() >= 0 && wall.getUTCFullYear() < 100) {
		instant.setFullYear(wall.getUTCFullYear());
	}
	return instant;
}

function sameWallTime(instant: Date, wall: Date): boolean {
	return (
		instant.getFullYear() === wall.getUTCFullYear() &&
		instant.getMonth() === wall.getUTCMonth() &&
		instant.getDate() === wall.getUTCDate() &&
		instant.getHours() === wall.getUTCHours() &&
		instant.getMinutes() === wall.getUTCMinutes()
	);
}

function advanceToAllowedMonth(wall: Date, months: readonly number[]): void {
	const currentMonth = wall.getUTCMonth() + 1;
	const nextMonth = months.find((month) => month > currentMonth);
	const year = nextMonth === undefined ? wall.getUTCFullYear() + 1 : wall.getUTCFullYear();
	const month = nextMonth ?? months[0]!;
	wall.setUTCFullYear(year, month - 1, 1);
	wall.setUTCHours(0, 0, 0, 0);
}

function advanceWallDay(wall: Date): void {
	wall.setUTCDate(wall.getUTCDate() + 1);
	wall.setUTCHours(0, 0, 0, 0);
}

function advanceToAllowedHour(wall: Date, hours: readonly number[]): void {
	const nextHour = hours.find((hour) => hour > wall.getUTCHours());
	if (nextHour === undefined) {
		advanceWallDay(wall);
		return;
	}
	wall.setUTCHours(nextHour, 0, 0, 0);
}

function advanceToAllowedMinute(wall: Date, minutes: readonly number[]): void {
	const nextMinute = minutes.find((minute) => minute > wall.getUTCMinutes());
	if (nextMinute === undefined) {
		wall.setUTCHours(wall.getUTCHours() + 1, 0, 0, 0);
		return;
	}
	wall.setUTCMinutes(nextMinute, 0, 0);
}
