import { StringEnum } from '@earendil-works/pi-ai';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { ACK_TOOL_NAME } from '../constants.js';
import { ERROR_DEFINITIONS } from '../domain/errors.js';
function oneOf(schemas) {
    return Type.Unsafe({ oneOf: schemas });
}
const answerId = Type.String({
    minLength: 40,
    maxLength: 64,
    pattern: '^ans_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const updateId = Type.String({
    minLength: 40,
    maxLength: 64,
    pattern: '^upd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const label = Type.String({ minLength: 1, maxLength: 160 });
const attachment = oneOf([
    Type.Object({
        kind: StringEnum(['file']),
        label,
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        external: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    Type.Object({
        kind: StringEnum(['line_range']),
        label,
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        startLine: Type.Integer({ minimum: 1, maximum: 2147483647 }),
        endLine: Type.Integer({ minimum: 1, maximum: 2147483647 }),
        external: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    Type.Object({
        kind: StringEnum(['test_run', 'command']),
        label,
        reference: Type.String({ minLength: 1, maxLength: 1000 }),
    }, { additionalProperties: false }),
    Type.Object({
        kind: StringEnum(['url']),
        label,
        url: Type.String({ minLength: 1, maxLength: 2000, format: 'uri' }),
    }, { additionalProperties: false }),
    Type.Object({
        kind: StringEnum(['note']),
        label,
        text: Type.String({ minLength: 1, maxLength: 4000 }),
    }, { additionalProperties: false }),
]);
export const ACK_TOOL_PARAMETERS = Type.Object({
    answerId,
    outcome: StringEnum([
        'applied',
        'partially_applied',
        'cannot_apply',
        'duplicate',
        'superseded',
    ]),
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    resultingUpdateIds: Type.Optional(Type.Array(updateId, { maxItems: 20, uniqueItems: true })),
    attachments: Type.Optional(Type.Array(attachment, { maxItems: 10 })),
}, { additionalProperties: false });
export const ACK_TOOL_DESCRIPTION = 'Acknowledge one immutable Signals answer after deduplicating and applying it.';
export const ACK_TOOL_PROMPT_SNIPPET = 'Acknowledge whether a delivered Signals answer was applied.';
export const ACK_TOOL_PROMPT_GUIDELINES = [
    'Deduplicate delivered answers by answerId before acting, then call signal_board_ack once for that answerId.',
    'Use signal_board_ack outcome applied or superseded only when the answer produced a durable decision.',
    'Use signal_board_ack outcome cannot_apply or partially_applied when more user attention is required.',
    'Signals records its inbox events only. Do not use signal_board_ack as task authority or as a todo checklist.',
];
export function registerAckTool(pi, lifecycle, pending) {
    pi.registerTool({
        name: ACK_TOOL_NAME,
        label: 'Signals Acknowledgement',
        description: ACK_TOOL_DESCRIPTION,
        promptSnippet: ACK_TOOL_PROMPT_SNIPPET,
        promptGuidelines: ACK_TOOL_PROMPT_GUIDELINES,
        parameters: ACK_TOOL_PARAMETERS,
        async execute(toolCallId, input) {
            try {
                const runtime = lifecycle.slot.requireHealthyLocked();
                if (!runtime.ok) {
                    const code = runtime.error.code === 'SB_DISABLED' ? 'SB_CONFIG_DISABLED' : runtime.error.code;
                    return throwFailure(toolCallId, publicError(code), pending);
                }
                const service = runtime.value.acknowledgementService;
                if (service === undefined) {
                    return throwFailure(toolCallId, publicError('SB_NOT_INITIALIZED'), pending);
                }
                const result = await service.acknowledge({
                    ...input,
                    commandId: `tool:${toolCallId}`,
                });
                if (!result.ok)
                    return throwFailure(toolCallId, result.error, pending);
                const details = successDetails(result.value);
                return { content: [{ type: 'text', text: successText(details) }], details };
            }
            catch (cause) {
                if (pending.has(toolCallId))
                    throw cause;
                return throwFailure(toolCallId, publicError('SB_INTERNAL'), pending);
            }
        },
        renderCall(input, theme, context) {
            const component = context.lastComponent ?? new Text('', 0, 0);
            component.setText(truncateToWidth(`${theme.fg('toolTitle', theme.bold(ACK_TOOL_NAME))} ${theme.fg('muted', safeInline(input.outcome, 20))} ${theme.fg('dim', safeInline(input.answerId, 20))}`, 240));
            return component;
        },
        renderResult(result, options, theme, context) {
            const component = context.lastComponent ?? new Text('', 0, 0);
            const details = parseDetails(result.details);
            if (details === undefined) {
                component.setText(theme.fg('error', 'ERROR SB_INTERNAL Result details unavailable.'));
            }
            else if (!details.ok) {
                component.setText(theme.fg('error', `ERROR ${safeCode(details.error.code)}`));
            }
            else {
                const decision = details.value.decisionDisplayId
                    ? ` decision ${safeInline(details.value.decisionDisplayId, 16)}`
                    : '';
                let text = theme.fg('success', `OK ${safeInline(details.value.outcome, 20)} ${safeInline(details.value.answerId, 20)}${decision}${details.noOp ? ' no-op' : ''}`);
                if (options.expanded) {
                    text += `\n${theme.fg('dim', `question ${safeInline(details.value.questionId, 64)}`)}`;
                    text += `\n${theme.fg('dim', `updates ${details.value.resultingUpdateIds.length}`)}`;
                }
                component.setText(text);
            }
            return component;
        },
    });
}
function successDetails(result) {
    const acknowledgement = result.acknowledgement;
    return freezeCopy({
        ok: true,
        value: {
            answerId: acknowledgement.answerId,
            questionId: acknowledgement.questionId,
            outcome: acknowledgement.outcome,
            ...(acknowledgement.decisionDisplayId === undefined
                ? {}
                : { decisionDisplayId: acknowledgement.decisionDisplayId }),
            resultingUpdateIds: acknowledgement.resultingUpdateIds,
        },
        event: result.event,
        noOp: result.noOp,
    });
}
function successText(details) {
    const decision = details.value.decisionDisplayId
        ? ` Decision ${details.value.decisionDisplayId} was recorded.`
        : '';
    return `Acknowledged ${details.value.answerId} as ${details.value.outcome}.${decision}${details.noOp ? ' This was an idempotent no-op.' : ''}`;
}
function throwFailure(id, error, pending) {
    pending.set(id, Object.freeze({ ok: false, error }));
    throw new Error(`Signals tool failed (${error.code}).`);
}
function publicError(code) {
    const definition = ERROR_DEFINITIONS[code];
    return Object.freeze({ code, message: definition.message, retryable: definition.retryable });
}
function parseDetails(value) {
    if (typeof value !== 'object' || value === null || !('ok' in value))
        return undefined;
    const candidate = value;
    if (candidate.ok === false && candidate.error && typeof candidate.error.code === 'string') {
        return candidate;
    }
    if (candidate.ok !== true || !('value' in candidate))
        return undefined;
    return candidate;
}
function safeCode(value) {
    return typeof value === 'string' && /^SB_[A-Z_]+$/u.test(value) ? value : 'SB_INTERNAL';
}
function safeInline(value, limit) {
    if (typeof value !== 'string')
        return '';
    const clean = [...value]
        .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
    })
        .join('')
        .replace(/\s+/gu, ' ')
        .trim();
    return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}
function freezeCopy(value) {
    if (typeof value !== 'object' || value === null)
        return value;
    if (Array.isArray(value))
        return Object.freeze(value.map((item) => freezeCopy(item)));
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
        if (child !== undefined)
            copy[key] = freezeCopy(child);
    }
    return Object.freeze(copy);
}
