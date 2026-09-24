const fs = require('fs');
const p = '/app/dist/core/engines/webjs/WebjsClientCore.js';
let c = fs.readFileSync(p, 'utf8');

// Replace the chatPromises line to add per-chat error handling
const old = 'const chatPromises = chats.map((chat) => window.WWebJS.getChatModel(chat));\n                return await Promise.all(chatPromises);';
const newCode = 'const chatPromises = chats.map((chat) => window.WWebJS.getChatModel(chat).catch(function(e) { console.warn("getChatModel failed:", e.message); return null; }));\n                const results = await Promise.all(chatPromises);\n                return results.filter(function(r) { return r !== null; });';

if (c.includes(old)) {
    c = c.replace(old, newCode);
    fs.writeFileSync(p, c);
    console.log('Patched getChats with per-chat error handling');
} else {
    console.log('Pattern not found, checking context...');
    const idx = c.indexOf('getChatModel');
    if (idx >= 0) {
        console.log('Context:', c.substring(idx - 50, idx + 200));
    }
}
