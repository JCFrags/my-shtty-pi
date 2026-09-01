import { VERSION as INSTALLED_PI_VERSION } from '@earendil-works/pi-coding-agent';
import { EXCLUSIVE_MAXIMUM_PI_VERSION, MINIMUM_NODE_VERSION, MINIMUM_PI_VERSION, SUPPORTED_NODE_RANGE, SUPPORTED_PI_RANGE, } from '../constants.js';
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const minimumNode = parseRequiredConstant(MINIMUM_NODE_VERSION);
const minimumPi = parseRequiredConstant(MINIMUM_PI_VERSION);
const maximumPi = parseRequiredConstant(EXCLUSIVE_MAXIMUM_PI_VERSION);
function parseRequiredConstant(version) {
    const parsed = parseVersion(version);
    if (!parsed) {
        throw new TypeError(`Invalid internal version constant: ${version}`);
    }
    return parsed;
}
function parseVersion(version) {
    const match = SEMVER_PATTERN.exec(version);
    if (!match)
        return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger))
        return undefined;
    return { major, minor, patch, prerelease: match[4] !== undefined };
}
function compareVersions(left, right) {
    if (left.major !== right.major)
        return left.major < right.major ? -1 : 1;
    if (left.minor !== right.minor)
        return left.minor < right.minor ? -1 : 1;
    if (left.patch !== right.patch)
        return left.patch < right.patch ? -1 : 1;
    return 0;
}
function unsupportedFact(target, detectedVersion, supportedRange, reason) {
    return {
        target,
        detectedVersion,
        supportedRange,
        status: 'unsupported',
        supported: false,
        reason,
    };
}
function evaluateNode(version) {
    if (version === null || version === undefined) {
        return unsupportedFact('node', undefined, SUPPORTED_NODE_RANGE, 'malformed_version');
    }
    const parsed = parseVersion(version);
    if (!parsed)
        return unsupportedFact('node', version, SUPPORTED_NODE_RANGE, 'malformed_version');
    if (parsed.prerelease) {
        return unsupportedFact('node', version, SUPPORTED_NODE_RANGE, 'prerelease_version');
    }
    if (compareVersions(parsed, minimumNode) < 0) {
        return unsupportedFact('node', version, SUPPORTED_NODE_RANGE, 'below_minimum');
    }
    return {
        target: 'node',
        detectedVersion: version,
        supportedRange: SUPPORTED_NODE_RANGE,
        status: 'supported',
        supported: true,
        reason: 'supported',
    };
}
function evaluatePi(version) {
    if (version === null || version === undefined) {
        return {
            target: 'pi',
            detectedVersion: undefined,
            supportedRange: SUPPORTED_PI_RANGE,
            status: 'unresolved',
            supported: false,
            reason: 'version_unresolved',
        };
    }
    const parsed = parseVersion(version);
    if (!parsed)
        return unsupportedFact('pi', version, SUPPORTED_PI_RANGE, 'malformed_version');
    if (parsed.prerelease) {
        return unsupportedFact('pi', version, SUPPORTED_PI_RANGE, 'prerelease_version');
    }
    if (compareVersions(parsed, minimumPi) < 0) {
        return unsupportedFact('pi', version, SUPPORTED_PI_RANGE, 'below_minimum');
    }
    if (compareVersions(parsed, maximumPi) >= 0) {
        return unsupportedFact('pi', version, SUPPORTED_PI_RANGE, 'at_or_above_maximum');
    }
    return {
        target: 'pi',
        detectedVersion: version,
        supportedRange: SUPPORTED_PI_RANGE,
        status: 'supported',
        supported: true,
        reason: 'supported',
    };
}
/** Evaluate injected host versions without I/O, commands, or package-file reads. */
export function evaluateHostCompatibility(versions) {
    const node = evaluateNode(versions.nodeVersion);
    const pi = evaluatePi(versions.piVersion);
    const unsupportedTargets = [];
    if (node.status === 'unsupported')
        unsupportedTargets.push('node');
    if (pi.status === 'unsupported')
        unsupportedTargets.push('pi');
    return {
        supported: unsupportedTargets.length === 0,
        node,
        pi,
        unsupportedTargets,
    };
}
/**
 * Evaluate the current host through the public Pi VERSION export.
 * Callers can inject both values to keep integration tests deterministic.
 */
export function evaluateCurrentHostCompatibility(versions = {
    nodeVersion: process.versions.node,
    piVersion: INSTALLED_PI_VERSION,
}) {
    return evaluateHostCompatibility(versions);
}
