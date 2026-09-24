"use strict";
/**
 * PATCHED VERSION - parseMessageIdSerialized null safety fix
 *
 * Bug: When message.id._serialized is undefined (malformed WhatsApp message),
 * the original code crashes with "Cannot read properties of undefined (reading 'includes')"
 * causing the message to be silently dropped.
 *
 * Fix: Added null/undefined check at the top of parseMessageIdSerialized.
 * Also added fallback in toWAMessage calling site (patched via sed in container).
 *
 * Original file: /app/dist/core/utils/ids.js (WAHA 2026.6.2)
 * Patch date: 2026-07-15
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMessageIdSerialized = parseMessageIdSerialized;
exports.SerializeMessageKey = SerializeMessageKey;
exports.SerializeMsgKey = SerializeMsgKey;
exports.Deserialized = Deserialized;
const jids_1 = require("./jids");
function parseMessageIdSerialized(messageId, soft = false) {
    // [PATCH] null/undefined safety - prevent crash when message.id._serialized is missing
    if (messageId == null || typeof messageId !== 'string') {
        return { id: messageId, fromMe: false, remoteJid: undefined, participant: undefined };
    }
    if (!messageId.includes('_') && soft) {
        return { id: messageId };
    }
    const parts = messageId.split('_');
    if (parts.length != 3 && parts.length != 4) {
        // [PATCH] Don't throw on unexpected format - return best-effort result
        // Some messages use @lid format, broadcast, or non-standard ID structures
        // Throwing here causes WAHA to silently drop incoming messages
        return { id: messageId, fromMe: false, remoteJid: undefined, participant: undefined };
    }
    const fromMe = parts[0] == 'true';
    const chatId = parts[1];
    const remoteJid = (0, jids_1.toJID)(chatId);
    const id = parts[2];
    const participant = parts[3] ? (0, jids_1.toJID)(parts[3]) : undefined;
    return {
        fromMe: fromMe,
        id: id,
        remoteJid: remoteJid,
        participant: participant,
    };
}
function SerializeMessageKey(key) {
    const { fromMe, id, remoteJid, participant } = key;
    const participantStr = participant ? `_${participant}` : '';
    return `${fromMe ? 'true' : 'false'}_${remoteJid}_${id}${participantStr}`;
}
function SerializeMsgKey(key) {
    var _a;
    if (typeof key == 'string') {
        return key;
    }
    if (key._serialized) {
        return key._serialized;
    }
    const k = {
        id: key.id,
        fromMe: key.fromMe,
        remoteJid: ((_a = key.remote) === null || _a === void 0 ? void 0 : _a._serialized) || key.remote,
        participant: key.participant,
    };
    return SerializeMessageKey(k);
}
function Deserialized(value) {
    if (typeof value == 'string') {
        return value;
    }
    if (value === null || value === void 0 ? void 0 : value._serialized) {
        return value._serialized;
    }
    return null;
}
//# sourceMappingURL=ids.js.map
