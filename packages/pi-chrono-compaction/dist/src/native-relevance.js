import { CHRONOLOGICAL_REPLAY_LIMITS } from "./chronological-replay.js";
export const NATIVE_RELEVANCE_LIMITS = Object.freeze({ terms: 16, topicWords: 8, textLines: 3, pathsPerCard: 2 });
const CURRENT_STATUSES = {
    todo: ["pending", "in_progress", "blocked"], notes: ["active"],
    workplan: ["draft", "active", "paused"], memory: ["active"],
};
const normalize = (term) => term.slice(0, CHRONOLOGICAL_REPLAY_LIMITS.termUnits).trim().toLowerCase();
function cardTerms(card) {
    const title = card.title.slice(0, 256), text = card.text.slice(0, 2048);
    // Resource paths are selection terms only. Do not turn URL components into paths.
    const pathText = `${title}\n${text}`.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`()\[\]<>]+/gi, " ");
    const paths = [];
    for (const match of pathText.matchAll(/(?:\.{0,2}\/|[\p{L}\p{N}_@.-]+\/)[\p{L}\p{N}_@./-]+/gu)) {
        const path = match[0].replace(/[./]+$/, "");
        const resourcePath = path.startsWith("/") || /^\.\.?\//.test(path) || /\/[^/]+\.[\p{L}\p{N}_-]+$/u.test(path);
        if (!resourcePath || path.length < 3 || path.length > CHRONOLOGICAL_REPLAY_LIMITS.termUnits || paths.includes(path))
            continue;
        paths.push(path);
        if (paths.length === NATIVE_RELEVANCE_LIMITS.pathsPerCard)
            break;
    }
    const sourceText = `${title}\n${text.split("\n", NATIVE_RELEVANCE_LIMITS.textLines).filter(line => !line.startsWith("Recorded:")).join("\n")}`
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`()\[\]<>]+/gi, " ");
    const commits = [...new Set(sourceText.match(/\b[0-9a-f]{7,40}\b/gi) ?? [])]
        .filter(token => /[a-f]/i.test(token) && /\d/.test(token)).slice(0, NATIVE_RELEVANCE_LIMITS.topicWords);
    // Generic prose and short native IDs can match unrelated text or timestamps.
    // Keep native identities in the receipt. Add only concrete resource anchors.
    return [...paths, ...commits];
}
/** Consume only the already-admitted current pages. Terms guide lexical detail
 * selection, not instructions, task completion, or an additional native read.
 * Keep explicit model hints first and share the remaining allowance across owners. */
export function nativeReplayRelevance(native, modelHints) {
    const terms = [...new Set(modelHints.slice(0, CHRONOLOGICAL_REPLAY_LIMITS.relevanceTerms).map(normalize).filter(Boolean))];
    const seen = new Set(terms);
    const queues = native.providers.map(provider => {
        if (provider.status !== "ok" || provider.page?.readiness !== "ready")
            return [];
        const activePlan = provider.providerId === "workplan" && provider.page.cards.some(card => card.status === "active");
        return provider.page.cards.filter(card => CURRENT_STATUSES[provider.providerId].includes(card.status)
            && (!activePlan || card.status === "active")
            && (provider.providerId !== "memory" || card.category === "knowledge")).flatMap(cardTerms);
    });
    const positions = queues.map(() => 0);
    let added = 0, progress = true;
    while (progress && added < NATIVE_RELEVANCE_LIMITS.terms && terms.length < CHRONOLOGICAL_REPLAY_LIMITS.relevanceTerms) {
        progress = false;
        for (let index = 0; index < queues.length; index++) {
            const queue = queues[index];
            while (positions[index] < queue.length) {
                const term = normalize(queue[positions[index]]);
                positions[index] = positions[index] + 1;
                if (!term || seen.has(term))
                    continue;
                seen.add(term);
                terms.push(term);
                added++;
                progress = true;
                break;
            }
            if (added === NATIVE_RELEVANCE_LIMITS.terms || terms.length === CHRONOLOGICAL_REPLAY_LIMITS.relevanceTerms)
                break;
        }
    }
    return terms;
}
//# sourceMappingURL=native-relevance.js.map