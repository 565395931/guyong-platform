"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebjsClientCore = void 0;
const promiseTimeout_1 = require("../../../utils/promiseTimeout");
const events_1 = require("events");
const lodash = require("lodash");
const whatsapp_web_js_1 = require("whatsapp-web.js");
const structures_1 = require("whatsapp-web.js/src/structures");
const structures_2 = require("whatsapp-web.js/src/structures");
const WPage_1 = require("./WPage");
const { LoadLodash } = require('./_lodash.js');
const { LoadPaginator } = require('./_Paginator.js');
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory');
const { exposeFunctionIfAbsent, } = require('whatsapp-web.js/src/util/Puppeteer');
class ChannelMessageReaction {
}
function extractReactionsByMessageKey(newsletterReactions) {
    const reactions = new Map();
    for (const reaction of newsletterReactions) {
        const key = reaction.parentMsgKey._serialized;
        const emojiCountMap = reaction.emojiCountMap;
        const reactionList = [];
        for (const emoji in emojiCountMap) {
            reactionList.push({
                reaction: emoji,
                count: emojiCountMap[emoji],
            });
        }
        reactions.set(key, reactionList);
    }
    return reactions;
}
class WebjsClientCore extends whatsapp_web_js_1.Client {
    constructor(options, tags) {
        super(options);
        this.tags = tags;
        this.events = new events_1.EventEmitter();
        this.wpage = null;
        this.on(whatsapp_web_js_1.Events.AUTHENTICATED, async () => {
            await this.attachCustomEventListeners();
            await this.injectWaha();
        });
        this.on(whatsapp_web_js_1.Events.READY, async () => {
            await this.attachCustomEventListeners();
            await this.injectWaha();
        });
    }
    async initialize() {
        const result = await super.initialize();
        if (this.pupPage && !(this.pupPage instanceof WPage_1.WPage)) {
            this.wpage = new WPage_1.WPage(this.pupPage);
            this.wpage.on(WPage_1.PAGE_CALL_ERROR_EVENT, (event) => {
                this.events.emit(WPage_1.PAGE_CALL_ERROR_EVENT, event);
            });
            this.pupPage = this.wpage;
        }
        return result;
    }
    async injectWaha() {
        await this.pupPage.evaluate(LoadLodash);
        await this.pupPage.evaluate(LoadPaginator);
    }
    hideUXFreshLook() {
        return this.pupPage.evaluate(() => {
            const WAWebUserPrefsUiRefresh = window.require('WAWebUserPrefsUiRefresh');
            if (!WAWebUserPrefsUiRefresh) {
                return false;
            }
            if (WAWebUserPrefsUiRefresh.getUiRefreshNuxAcked()) {
                return false;
            }
            WAWebUserPrefsUiRefresh.incrementNuxViewCount();
            WAWebUserPrefsUiRefresh.setUiRefreshNuxAcked(true);
            const WAWebModalManager = window.require('WAWebModalManager');
            WAWebModalManager.ModalManager.close();
            return true;
        });
    }
    async attachCustomEventListeners() {
        await exposeFunctionIfAbsent(this.pupPage, 'onNewMessageId', (messageId) => {
            this.events.emit('message.id', { id: messageId });
            return;
        });
        if (this.tags) {
            await this.attachTagsEvents();
        }
    }
    async attachTagsEvents() {
        await this.pupPage.evaluate(() => {
            if (window.decodeStanzaBack) {
                return;
            }
            const tags = ['receipt', 'presence', 'chatstate'];
            const WAWap = window.require('WAWap');
            window.decodeStanzaBack = WAWap.decodeStanza;
            WAWap.decodeStanza = async (...args) => {
                const result = await window.decodeStanzaBack(...args);
                if (tags.includes(result === null || result === void 0 ? void 0 : result.tag)) {
                    setTimeout(() => window.onTag(result), 0);
                }
                return result;
            };
        });
    }
    async destroy() {
        var _a;
        this.events.removeAllListeners();
        (_a = this.wpage) === null || _a === void 0 ? void 0 : _a.removeAllListeners();
        await super.destroy();
    }
    async setPushName(name) {
        await this.ensureWahaInjected();
        await this.pupPage.evaluate(async (pushName) => {
            return await window
                .require('WAWebSetPushnameConnAction')
                .setPushname(pushName);
        }, name);
        if (this.info) {
            this.info.pushname = name;
        }
    }
    async unpair() {
        await this.pupPage.evaluate(async () => {
            var _a;
            const Socket = (_a = window.require('WAWebSocketModel')) === null || _a === void 0 ? void 0 : _a.Socket;
            if (Socket && typeof Socket.logout === 'function') {
                await Socket.logout();
            }
        });
    }
    async createLabel(name, color) {
        await this.ensureWahaInjected();
        const labelId = (await this.pupPage.evaluate(async (name, color) => {
            return await window
                .require('WAWebBizLabelEditingAction')
                .labelAddAction(name, color);
        }, name, color));
        return labelId;
    }
    async deleteLabel(label) {
        await this.ensureWahaInjected();
        return await this.pupPage.evaluate(async (label) => {
            return await window
                .require('WAWebBizLabelEditingAction')
                .labelDeleteAction(label.id, label.name, label.color);
        }, label);
    }
    async updateLabel(label) {
        await this.ensureWahaInjected();
        return await this.pupPage.evaluate(async (label) => {
            return await window.require('WAWebBizLabelEditingAction').labelEditAction(label.id, label.name, undefined, label.color);
        }, label);
    }
    async getChats(pagination, filter) {
        if (lodash.isEmpty(pagination)) {
            return await super.getChats();
        }
        await this.ensureWahaInjected();
        pagination.limit || (pagination.limit = Infinity);
        pagination.offset || (pagination.offset = 0);
        const chats = await this.pupPage.evaluate(async (pagination, filter) => {
            try {
                let chats = window
                    .require('WAWebCollections')
                    .Chat.getModelsArray()
                    .slice();
                if (filter && filter.ids && filter.ids.length > 0) {
                    chats = chats.filter((chat) => filter.ids.includes(chat.id._serialized));
                }
                const paginator = new window.Paginator(pagination);
                chats = paginator.apply(chats);
                const chatPromises = chats.map((chat) => window.WWebJS.getChatModel(chat).catch(function(e) { console.warn("getChatModel failed:", e.message); return null; }));
                const results = await Promise.all(chatPromises);
                return results.filter(function(r) { return r !== null; });
            } catch(err) {
                return { __error: true, message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : '', name: err && err.name ? err.name : '' };
            }
        }, pagination, filter);
        if (chats && chats.__error) {
            console.error('[getChats PAGE ERROR]', JSON.stringify(chats));
            throw new Error('Page evaluate error: ' + chats.message + ' | stack: ' + chats.stack);
        }
        return chats.map((chat) => ChatFactory.create(this, chat));
    }
    async ensureWahaInjected() {
        const hasWaha = await this.pupPage.evaluate(() => {
            return Boolean(window.Paginator);
        });
        if (!hasWaha) {
            await this.injectWaha();
        }
    }
    async sendTextStatus(status) {
        const waColor = 'FF' + status.backgroundColor.replace('#', '');
        const color = parseInt(waColor, 16);
        const textStatus = {
            text: status.text,
            color: color,
            font: status.font,
        };
        const sentMsg = await this.pupPage.evaluate(async (status) => {
            await window
                .require('WAWebSendStatusMsgAction')
                .sendStatusTextMsgAction(status);
            const meUser = window.require('WAWebUserPrefsMeUser').getMaybeMePnUser();
            const myStatus = window
                .require('WAWebCollections')
                .Status.getModelsArray()
                .findLast((x) => x.id == meUser);
            if (!myStatus) {
                return undefined;
            }
            const msg = myStatus.msgs.last();
            return msg ? window.WWebJS.getMessageModel(msg) : undefined;
        }, textStatus);
        return sentMsg ? new structures_1.Message(this, sentMsg) : undefined;
    }
    async getMessages(chatId, filter, pagination) {
        const messages = await this.pupPage.evaluate(async (chatId, filter, pagination) => {
            var _a, _b;
            pagination.limit || (pagination.limit = Infinity);
            pagination.offset || (pagination.offset = 0);
            const msgFilter = (m) => {
                if (m.isNotification) {
                    return false;
                }
                if (filter['filter.fromMe'] != null &&
                    m.id.fromMe !== filter['filter.fromMe']) {
                    return false;
                }
                if (filter['filter.timestamp.gte'] != null &&
                    m.t < filter['filter.timestamp.gte']) {
                    return false;
                }
                if (filter['filter.timestamp.lte'] != null &&
                    m.t > filter['filter.timestamp.lte']) {
                    return false;
                }
                if (filter['filter.ack'] != null && m.ack !== filter['filter.ack']) {
                    return false;
                }
                return true;
            };
            const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
            if (!chat)
                return [];
            let msgs = [];
            const WAWebDBMessageFindLocal = window.require('WAWebDBMessageFindLocal');
            if (WAWebDBMessageFindLocal === null || WAWebDBMessageFindLocal === void 0 ? void 0 : WAWebDBMessageFindLocal.msgFindByDirection) {
                const BATCH_SIZE = 20;
                const lastReceivedSerialized = (_a = chat.lastReceivedKey) === null || _a === void 0 ? void 0 : _a._serialized;
                if (!lastReceivedSerialized) {
                    console.warn('getMessages: missing lastReceivedKey, falling back to loaded chat.msgs for', chatId);
                    msgs = chat.msgs && typeof chat.msgs.getModelsArray === 'function'
                        ? chat.msgs.getModelsArray()
                        : [];
                }
                else {
                    let currentAnchorKey = window
                        .require('WAWebMsgKey')
                        .fromString(lastReceivedSerialized);
                    const anchorMsg = window
                        .require('WAWebCollections')
                        .Msg.get(lastReceivedSerialized);
                    if (anchorMsg) {
                        msgs.push(anchorMsg);
                    }
                    const neededFiltered = Number.isFinite(pagination.limit + pagination.offset)
                        ? pagination.limit + pagination.offset
                        : Infinity;
                    const toModel = (m) => {
                        var _a;
                        if (m && typeof m.serialize === 'function')
                            return m;
                        const serializedId = (_a = m === null || m === void 0 ? void 0 : m.id) === null || _a === void 0 ? void 0 : _a._serialized;
                        const Msg = window.require('WAWebCollections').Msg;
                        if (serializedId) {
                            const stored = Msg.get(serializedId);
                            if (stored)
                                return stored;
                        }
                        return new Msg.modelClass(m);
                    };
                    while (true) {
                        const result = await WAWebDBMessageFindLocal.msgFindByDirection({
                            anchor: currentAnchorKey,
                            count: BATCH_SIZE,
                            direction: 'before',
                        });
                        const batch = Array.isArray(result)
                            ? result
                            : (result === null || result === void 0 ? void 0 : result.messages) || [];
                        if (!batch || batch.length === 0)
                            break;
                        const batchModels = batch.map(toModel);
                        msgs = [...batchModels, ...msgs];
                        const seenIds = new Set();
                        msgs = msgs.filter((m) => {
                            var _a;
                            const sid = (_a = m === null || m === void 0 ? void 0 : m.id) === null || _a === void 0 ? void 0 : _a._serialized;
                            if (!sid || seenIds.has(sid))
                                return false;
                            seenIds.add(sid);
                            return true;
                        });
                        if (msgs.filter(msgFilter).length >= neededFiltered)
                            break;
                        if (filter['filter.timestamp.gte'] != null) {
                            const batchMinT = batchModels.reduce((min, m) => { var _a; return Math.min(min, (_a = m.t) !== null && _a !== void 0 ? _a : Infinity); }, Infinity);
                            if (batchMinT < filter['filter.timestamp.gte'])
                                break;
                        }
                        if (batch.length < BATCH_SIZE)
                            break;
                        const oldestInBatch = batchModels[batchModels.length - 1];
                        const oldestSerialized = (_b = oldestInBatch === null || oldestInBatch === void 0 ? void 0 : oldestInBatch.id) === null || _b === void 0 ? void 0 : _b._serialized;
                        if (!oldestSerialized)
                            break;
                        currentAnchorKey = window
                            .require('WAWebMsgKey')
                            .fromString(oldestSerialized);
                    }
                }
            }
            else {
                msgs = chat.msgs.getModelsArray();
                while (msgs.length < pagination.limit + pagination.offset) {
                    const loadedMessages = await window
                        .require('WAWebChatLoadMessages')
                        .loadEarlierMsgs(chat, chat.msgs);
                    if (!loadedMessages || loadedMessages.length == 0)
                        break;
                    msgs = [...loadedMessages, ...msgs];
                    msgs = msgs.sort((a, b) => b.t - a.t);
                    const earliest = msgs[msgs.length - 1];
                    if (earliest.t < (filter['filter.timestamp.gte'] || Infinity)) {
                        break;
                    }
                }
            }
            msgs = msgs.filter(msgFilter);
            msgs = msgs.sort((a, b) => b.t - a.t);
            const offset = Math.max(0, pagination.offset);
            const limit = pagination.limit;
            if (Number.isFinite(limit)) {
                const end = Math.min(offset + limit, msgs.length);
                msgs = msgs.slice(offset, end);
            }
            else if (offset > 0) {
                msgs = msgs.slice(offset);
            }
            return msgs.map((m) => window.WWebJS.getMessageModel(m));
        }, chatId, filter, pagination);
        return messages.map((m) => new structures_1.Message(this, m));
    }
    async getAllLids(pagination) {
        const lids = (await this.pupPage.evaluate(async (pagination) => {
            pagination.limit || (pagination.limit = Infinity);
            pagination.offset || (pagination.offset = 0);
            pagination.sortBy || (pagination.sortBy = 'lid');
            const WAWebApiContact = window.require('WAWebApiContact');
            await WAWebApiContact.warmUpAllLidPnMappings();
            const lidMap = WAWebApiContact.lidPnCache['$1'];
            const values = Array.from(lidMap.values());
            const result = values.map((map) => {
                return {
                    lid: map.lid._serialized,
                    pn: map.phoneNumber._serialized,
                };
            });
            const paginator = new window.Paginator(pagination);
            const page = paginator.apply(result);
            return page;
        }, pagination));
        return lids;
    }
    async getLidsCount() {
        const count = (await this.pupPage.evaluate(async () => {
            const WAWebApiContact = window.require('WAWebApiContact');
            await WAWebApiContact.warmUpAllLidPnMappings();
            const lidMap = WAWebApiContact.lidPnCache['$1'];
            return lidMap.size;
        }));
        return count;
    }
    async findPNByLid(lid) {
        const pn = await this.pupPage.evaluate(async (lid) => {
            const WAWebApiContact = window.require('WAWebApiContact');
            const WAWebWidFactory = window.require('WAWebWidFactory');
            const wid = WAWebWidFactory.createWid(lid);
            const result = WAWebApiContact.getPhoneNumber(wid);
            return result ? result._serialized : null;
        }, lid);
        return pn;
    }
    async findLIDByPhoneNumber(phoneNumber) {
        const lid = (await this.pupPage.evaluate(async (pn) => {
            const WAWebApiContact = window.require('WAWebApiContact');
            const WAWebWidFactory = window.require('WAWebWidFactory');
            const wid = WAWebWidFactory.createWid(pn);
            const result = WAWebApiContact.getCurrentLid(wid);
            return result ? result._serialized : null;
        }, phoneNumber));
        return lid;
    }
    async subscribePresence(chatId) {
        await this.pupPage.evaluate(async (chatId) => {
            const d = require;
            const WidFactory = d('WAWebWidFactory');
            const wid = WidFactory.createWidFromWidLike(chatId);
            const chat = d('WAWebChatCollection').ChatCollection.get(wid);
            const tc = chat == null ? void 0 : chat.getTcToken();
            await d('WAWebContactPresenceBridge').subscribePresence(wid, tc);
        }, chatId);
    }
    async getCurrentPresence(chatId) {
        const result = await this.pupPage.evaluate(async (chatId) => {
            const d = require;
            const WidFactory = d('WAWebWidFactory');
            const PresenceCollection = d('WAWebPresenceCollection').PresenceCollection;
            const wid = WidFactory.createWidFromWidLike(chatId);
            const presence = PresenceCollection.get(wid);
            if (!presence) {
                return [];
            }
            let chatstates = [];
            if (chatId.endsWith('@c.us')) {
                chatstates = [presence.chatstate];
            }
            else {
                chatstates = presence.chatstates.getModelsArray();
            }
            return chatstates.map((chatstate) => {
                return {
                    participant: chatstate.id._serialized,
                    lastSeen: chatstate.t,
                    state: chatstate.type,
                };
            });
        }, chatId);
        return result;
    }
    async getPresence(chatId) {
        await this.sendPresenceAvailable();
        await this.subscribePresence(chatId);
        await (0, promiseTimeout_1.sleep)(3000);
        return await this.getCurrentPresence(chatId);
    }
    async channelFetchMessageByInvite(inviteCode, limit) {
        const response = await this.pupPage.evaluate(async (code, limit) => {
            window.require('WAWebNewsletterGatingUtils').getMaxMsgCountFromServer = () => limit;
            const result = await window
                .require('WAWebNewsletterPreviewJob')
                .getNewsletterPreviewData(code, 'guest');
            for (const newsletterReaction of result.newsletterReactions) {
                newsletterReaction.emojiCountMap = Object.fromEntries(newsletterReaction.emojiCountMap);
            }
            await window
                .require('WAWebLoadNewsletterPreviewChatAction')
                .loadNewsletterPreviewChat(code);
            return result;
        }, inviteCode, limit);
        const messageInstances = response.newsletterMessages
            .filter((msg) => msg.type != 'revoked')
            .map((msg) => {
            return new structures_2.Message(this, msg);
        });
        const reactions = extractReactionsByMessageKey(response.newsletterReactions);
        const messages = messageInstances.map((msg) => {
            return {
                message: msg,
                reactions: reactions.get(msg.id._serialized) || [],
                viewCount: msg.rawData.viewCount,
            };
        });
        return messages;
    }
    async searchChannelsView(params) {
        const newsletters = await this.pupPage.evaluate(async (params) => {
            return await window
                .require('WAWebNewsletterDirectorySearchJob')
                .getNewsletterDirectoryList(params);
        }, params);
        return newsletters;
    }
    async searchChannelsText(params) {
        const newsletters = await this.pupPage.evaluate(async (params) => {
            return await window
                .require('WAWebNewsletterDirectorySearchJob')
                .getNewsletterDirectorySearchResults(params);
        }, params);
        return newsletters;
    }
}
exports.WebjsClientCore = WebjsClientCore;
//# sourceMappingURL=WebjsClientCore.js.map
