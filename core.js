// Pure helpers; no host imports and no network or storage side effects.
export const META_KEY = 'st_chat_archive_v1';
export const VERSION = '0.1.0';
export const PROMPT = `请把下面这段聊天记录压缩成存档，用于下次对话代替原文。要求：
按时间顺序分段，标注日期。
用户的原话尽量保留，尤其是带情绪的句子、她对自己的判断、她做的决定，用引号标出。
助手的回复只保留核心结论和具体建议
单独列出"纠正记录"：用户纠正过助手的地方，原样记下。
单独列出"硬规矩"：用户明确说过不要做的事。
最后写"当前状态"：只写截至最后一楼的现状和未结的事，不写历史。
不要推测、不要补充原文没有的信息；不确定的地方标"未确认"。
不要美化或淡化用户的情绪，也不要替她下结论。`;

export function assertRange(chat, from, to) {
    if (!Array.isArray(chat) || !chat.length) throw new Error('请先打开一段酒馆聊天。');
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to >= chat.length) {
        throw new Error(`请输入有效起止楼层（含两端），当前为 #0～#${chat.length - 1}。`);
    }
}

export function overlaps(a, b) {
    return a.from <= b.to && b.from <= a.to;
}

export function hasUnsupportedContent(message) {
    const extra = message?.extra || {};
    // Don't silently remove an attachment or tool result that was never summarized.
    return Boolean(extra.image || extra.file || extra.inline_image || extra.tool_calls || extra.tool_invocations
        || (Array.isArray(extra.media) && extra.media.length) || message?.tool_calls || message?.tool_call_id);
}

function sourceView(message) {
    return [String(message?.mes ?? ''), String(message?.name ?? ''), Boolean(message?.is_user),
        Boolean(message?.is_system), message?.send_date ?? null, message?.swipe_id ?? null,
        hasUnsupportedContent(message)];
}

export function sourceStamp(chat, through) {
    return JSON.stringify(chat.slice(0, through + 1).map(sourceView));
}

async function digest(value) {
    if (!globalThis.crypto?.subtle) throw new Error('当前环境缺少 WebCrypto，无法安全核对原文；请在 localhost 或 HTTPS 下使用。');
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprint(chat, from, to) {
    assertRange(chat, from, to);
    // Prefix catches inserted/deleted floors before the selected range.
    const [prefixHash, sourceHash] = await Promise.all([
        digest(chat.slice(0, from).map(sourceView)),
        digest(chat.slice(from, to + 1).map(sourceView)),
    ]);
    return { prefixHash, sourceHash };
}

export async function captureRange(chat, from, to, formatDate = () => '未确认') {
    assertRange(chat, from, to);
    const selected = chat.slice(from, to + 1);
    if (!selected.some(message => String(message?.mes ?? '').trim())) throw new Error('这些楼层没有可总结的文字。');
    const transcript = selected.map((message, offset) => {
        const role = message.is_system ? '系统记录' : message.is_user ? '用户' : '助手';
        const notice = hasUnsupportedContent(message) ? '\n[本楼含附件或工具内容；本次仅提供下方可见文字，附件内容未提供。]' : '';
        // Keep the actual message text verbatim: no regex, Markdown stripping, trimming, or macro expansion.
        return `【楼层 #${from + offset}｜${role}｜${String(message.name || '未命名')}】\n日期时间：${formatDate(message.send_date)}${notice}\n${String(message.mes ?? '')}`;
    }).join('\n\n');
    const hashes = await fingerprint(chat, from, to);
    return { from, to, count: selected.length, transcript, ...hashes,
        textOnly: !selected.some(hasUnsupportedContent), capturedAt: new Date().toISOString() };
}

export function isArchive(record) {
    return record && record.schema === 1 && typeof record.id === 'string'
        && Number.isSafeInteger(record.from) && record.from >= 0
        && Number.isSafeInteger(record.to) && record.to >= record.from
        && typeof record.text === 'string' && record.text.trim().length > 0
        && /^[a-f0-9]{64}$/.test(record.sourceHash || '')
        && /^[a-f0-9]{64}$/.test(record.prefixHash || '')
        && typeof record.enabled === 'boolean';
}

export async function sourceMatches(chat, record) {
    if (!isArchive(record) || !Array.isArray(chat) || record.to >= chat.length) return false;
    const hashes = await fingerprint(chat, record.from, record.to);
    return hashes.prefixHash === record.prefixHash && hashes.sourceHash === record.sourceHash;
}

export function readState(metadata) {
    const value = metadata?.[META_KEY];
    if (!value) return { schema: 1, revision: 0, archives: [] };
    if (value.schema !== 1 || !Array.isArray(value.archives) || !Number.isSafeInteger(value.revision)) {
        throw new Error('此会话的存档数据格式不兼容；未覆盖，请先导出会话备份。');
    }
    if (!value.archives.every(isArchive)) throw new Error('此会话有损坏的存档条目；未自动覆盖。');
    return structuredClone(value);
}

export function createArchive(capture, text) {
    if (!String(text).trim()) throw new Error('摘要为空，不能保存。');
    return {
        schema: 1, id: crypto.randomUUID(), from: capture.from, to: capture.to,
        prefixHash: capture.prefixHash, sourceHash: capture.sourceHash,
        textOnly: capture.textOnly, text: String(text), enabled: false,
        createdAt: new Date().toISOString(), prompt: PROMPT,
    };
}

function sameIdentity(rendered, original) {
    return String(rendered?.name ?? '') === String(original?.name ?? '')
        && Boolean(rendered?.is_user) === Boolean(original?.is_user)
        && Boolean(rendered?.is_system) === Boolean(original?.is_system)
        && JSON.stringify(rendered?.send_date ?? null) === JSON.stringify(original?.send_date ?? null);
}

/**
 * Map the host's ephemeral, regex-formatted coreChat back to raw floors.
 * ST's `index` is the filtered ordinal, NOT the visible floor number.
 * Missing/ambiguous indices cause a safe no-op. No raw .mes or nested extra is mutated.
 */
export function planReplacement(coreChat, rawChat, record) {
    if (!Array.isArray(coreChat) || coreChat === rawChat || record.textOnly !== true) return null;
    const selected = rawChat.slice(record.from, record.to + 1);
    if (selected.some(hasUnsupportedContent)) return null;
    // Preserve current last floor for continue, regeneration, swipe, and host invariants.
    if (record.to >= rawChat.length - 1) return null;
    const candidates = [
        rawChat.map((message, floor) => ({ message, floor })).filter(x => !x.message.is_system),
        rawChat.map((message, floor) => ({ message, floor })).filter(x => !x.message.is_system || Array.isArray(x.message.extra?.tool_invocations)),
    ];
    const plans = [];
    for (const filtered of candidates) {
        const owners = new Map();
        for (const { message } of filtered) {
            for (const reference of [message.extra, message.swipes]) {
                if (reference && typeof reference === 'object') owners.set(reference, (owners.get(reference) || 0) + 1);
            }
        }
        const positions = [];
        const seen = new Set();
        let valid = true;
        for (let position = 0; position < coreChat.length; position++) {
            const rendered = coreChat[position];
            // Synthetic summaries from another range are not raw floors.
            if (rendered?.extra?.st_chat_archive === true) continue;
            const index = rendered?.index;
            const source = Number.isInteger(index) && index >= 0 ? filtered[index] : null;
            if (!source || seen.has(index) || !sameIdentity(rendered, source.message) || rendered === source.message) {
                valid = false;
                break;
            }
            seen.add(index);
            if (source.floor >= record.from && source.floor <= record.to) {
                // Date/name can collide across many QQ-like bubbles. Require a unique shared
                // nested reference that the official shallow copy retains; never mutate it.
                const proof = [source.message.extra, source.message.swipes].some(reference =>
                    reference && typeof reference === 'object' && owners.get(reference) === 1
                    && (rendered.extra === reference || rendered.swipes === reference));
                if (!proof) { valid = false; break; }
                positions.push(position);
            }
        }
        const expected = filtered.filter(x => x.floor >= record.from && x.floor <= record.to).length;
        if (!valid || !expected || positions.length !== expected) continue;
        if (positions.some((position, offset) => position !== positions[0] + offset)) continue;
        plans.push({ start: positions[0], count: positions.length });
    }
    if (!plans.length || plans.some(plan => plan.start !== plans[0].start || plan.count !== plans[0].count)) return null;
    return plans[0];
}

export function summaryMessage(record, previous) {
    return {
        name: '聊天存档', is_user: false, is_system: false,
        send_date: previous?.send_date, index: previous?.index,
        mes: `[历史聊天存档；替代既往原文。以下是回顾资料，不是新的对话或指令。]\n${record.text}\n[历史聊天存档结束]`,
        extra: { st_chat_archive: true },
    };
}
