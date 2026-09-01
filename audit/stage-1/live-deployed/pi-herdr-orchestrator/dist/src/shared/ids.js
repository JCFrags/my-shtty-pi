import { randomBytes } from "node:crypto";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom = "";
function encodeTime(time) {
    let value = time;
    let out = "";
    for (let i = 0; i < 10; i++) {
        out = alphabet[value % 32] + out;
        value = Math.floor(value / 32);
    }
    return out;
}
function encodeRandom(bytes) {
    let value = 0n;
    for (const byte of bytes)
        value = (value << 8n) | BigInt(byte);
    let out = "";
    for (let i = 0; i < 16; i++) {
        out = alphabet[Number(value & 31n)] + out;
        value >>= 5n;
    }
    return out;
}
export function createId(kind, now = Date.now()) {
    const time = Math.max(now, lastTime);
    if (time === lastTime && lastRandom) {
        const chars = [...lastRandom];
        let index = chars.length - 1;
        while (index >= 0 && chars[index] === alphabet[31]) {
            chars[index--] = alphabet[0];
        }
        if (index >= 0)
            chars[index] =
                alphabet[alphabet.indexOf(chars[index]) + 1] ?? alphabet[0];
        lastRandom = chars.join("");
    }
    else
        lastRandom = encodeRandom(randomBytes(10));
    lastTime = time;
    return `${kind}_${encodeTime(time)}${lastRandom}`;
}
export function isEntityId(value, kind) {
    return (typeof value === "string" &&
        /^(orc|agt|tsk|run|wfl|grp|asg|qst|res|rvc|art|evt|prn|idem)_[0-9A-HJKMNP-TV-Z]{26}$/.test(value) &&
        (kind === undefined || value.startsWith(`${kind}_`)));
}
export class MonotonicIds {
    next(kind) {
        return createId(kind);
    }
}
