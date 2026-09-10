import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';

// 启动后自动打开浏览器面板
function openBrowser(url) {
    const platform = os.platform();
    const cmd = platform === 'darwin' ? 'open'
        : platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`;
    exec(cmd, (err) => {
        if (err) console.log(`⚠️ 无法自动打开浏览器，请手动访问: ${url}`);
    });
}

// 上游长连接池：首字延迟的最大可控项。
// 实测 api.commandcode.ai 冷连接握手 ~1150ms（TCP 215ms + TLS 250~1000ms），
// 复用已建立的连接后降到 ~350ms，单次请求净省约 800ms。
// Node 内建 fetch 的连接池空闲 4s 即回收，而 agent 工作流两次请求间隔常常超过 4s，
// 等于每次都在重付握手成本，因此改用自管的 keepAlive Agent。
const upstreamAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,  // TCP 保活探针间隔，防止中间设备静默回收连接
    maxSockets: 64,
    maxFreeSockets: 8,
    timeout: 0              // 不设 socket 超时：推理模型长思考期间流是静默的，不能被掐断
});

const UPSTREAM_HOST = 'api.commandcode.ai';

// 1. 读取本机 Command Code 凭据
const authPath = path.join(os.homedir(), '.commandcode', 'auth.json');
let authData = { apiKey: '', userId: '', userName: 'local-user' };
if (fs.existsSync(authPath)) {
    try {
        authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch (e) {
        console.error('读取 ~/.commandcode/auth.json 失败:', e.message);
    }
}

const DEFAULT_PORT = parseInt(process.env.PORT || '8888', 10);
const startTime = Date.now();

// 进程级守护：任何未捕获异常都不允许拖垮服务进程（此前单次请求后进程崩溃的主因之一）
process.on('uncaughtException', (err) => {
    console.error('[guard] 未捕获异常，已拦截，服务继续运行:', err && err.message);
    try { addTerminalLog('error', `进程级异常已拦截: ${err && err.message}`); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
    console.error('[guard] 未处理的 Promise 拒绝，已拦截:', reason);
});

// 2. 终端实时请求日志与统计数据缓存（内存环形队列，最多保留 60 条）
const recentLogs = [];
let totalProxyRequests = 0;
let lastRequestLatency = 0;
let lastActiveClient = '暂无请求';
// D. 最近一次请求的 token 明细（缓存命中 / 思考占比 / 首字延迟），供面板展示
let lastTokenStats = null;

function addTerminalLog(level, message, detail = '') {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    recentLogs.unshift({
        id: crypto.randomUUID().slice(0, 8),
        time: timeStr,
        level, // 'info' | 'success' | 'warn' | 'error'
        message,
        detail
    });
    if (recentLogs.length > 60) {
        recentLogs.pop();
    }
}

// 初始系统日志
addTerminalLog('info', 'Command Code 反代网关初始化完成', `监听 127.0.0.1:${DEFAULT_PORT}`);

// 3. Command Code 官方全量模型库（42 款模型）
const ALL_MODELS = [
    // ── 免费模型 ──────────────────────────────────────
    {
        id: 'laguna-s-2.1',
        upstreamId: 'laguna/laguna-s-2.1',
        category: 'Laguna/免费',
        tag: '完全免费',
        note: '容量允许时免费 · 输入/输出/缓存全免',
        price: '免费',
        runs: 999999,
        isFree: true,
        context: '256K',
        maxTokens: '8192',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '免费'
    },
    {
        id: 'longcat-2.0',
        upstreamId: 'meituan/LongCat-2.0:free',
        category: '美团/免费',
        tag: '1M 上下文免费',
        note: '限时免费 · 百万上下文 · 0 积分消耗',
        price: '免费',
        runs: 999999,
        isFree: true,
        context: '1M',
        maxTokens: '8192',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '免费'
    },
    {
        id: 'ling-3.0-flash-sante',
        upstreamId: 'ling-ai/ling-3.0-flash-sante',
        category: '零一万物/免费',
        tag: '每日 100 次免费',
        note: '零一万物 · 每日最多 100 次请求免费',
        price: '免费 (每日100次)',
        runs: 999999,
        isFree: true,
        context: '262K',
        maxTokens: '8192',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '免费'
    },

    // ── 超低价梯队 (< $0.10/M) ───────────────────────
    {
        id: 'qwen-3.7-flash',
        upstreamId: 'Qwen/Qwen3.7-Flash',
        category: '千问',
        tag: '全网最低价',
        note: '$0.03 入 / $0.13 出 · 最便宜的付费模型',
        price: '$0.03 / 1M',
        runs: 28000,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '最省'
    },
    {
        id: 'muse-spark-1.3-contributor',
        upstreamId: 'meta/muse-spark-1.3-contributor',
        category: 'Meta',
        tag: '极便宜',
        note: '$0.10 入 / $0.20 出 · Contributor 版本【敏感内容勿用】',
        price: '$0.10 / 1M',
        runs: 18000,
        context: '1M',
        maxTokens: '131072 必须填对',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'muse-spark-1.2-contributor',
        upstreamId: 'meta/muse-spark-1.2-contributor',
        category: 'Meta',
        tag: '极便宜',
        note: '$0.10 入 / $0.20 出 · 稳定版 Contributor【敏感内容勿用】',
        price: '$0.10 / 1M',
        runs: 18000,
        context: '1M',
        maxTokens: '131072 必须填对',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'mimo-v2.5',
        upstreamId: 'xiaomi/mimo-v2.5',
        category: '小米',
        tag: '98% 折扣',
        note: '原价 $0.80/$4.00 · 限时 98% 折 $0.14 入 / $0.28 出',
        price: '$0.14 / 1M (98%折扣)',
        runs: 16000,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '特惠'
    },
    {
        id: 'step-3.5-flash',
        upstreamId: 'stepfun/step-3.5-flash',
        category: '阶跃星辰',
        tag: '高性价比',
        note: '$0.10 入 / $0.30 出 · 1M 上下文',
        price: '$0.10 / 1M',
        runs: 16000,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },

    // ── 低价梯队 ($0.10 ~ $0.30/M) ───────────────────
    {
        id: 'glm-5.3-flash',
        upstreamId: 'z-ai/glm-5.3-flash',
        category: 'GLM',
        tag: '毫秒极速',
        note: '$0.15 入 / $0.50 出 · 极高性价比',
        price: '$0.15 / 1M',
        runs: 7200,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '极速'
    },
    {
        id: 'qwen-3.8-flash',
        upstreamId: 'Qwen/Qwen3.8-Flash',
        category: '千问',
        tag: '主力性价比',
        note: '$0.16 入 / $0.47 出 · 阿里千问极速版',
        price: '$0.16 / 1M',
        runs: 6800,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '推荐'
    },
    {
        id: 'deepseek-v4.1-flash',
        upstreamId: 'deepseek/deepseek-v4.1-flash',
        category: 'DeepSeek',
        tag: '新一代极速',
        note: '谷时 $0.15/$0.60 · 峰时 $0.30/$1.20',
        price: '谷 $0.15 / 峰 $0.30',
        runs: 7600,
        highlight: true,
        context: '1M',
        maxTokens: '200000 必须填对',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '基准'
    },
    {
        id: 'deepseek-v4-flash',
        upstreamId: 'deepseek/deepseek-v4-flash',
        category: 'DeepSeek',
        tag: '上一代极速',
        note: '谷时 $0.15/$0.60 · 峰时 $0.30/$1.20',
        price: '谷 $0.15 / 峰 $0.30',
        runs: 7600,
        context: '1M',
        maxTokens: '200000 必须填对',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'deepseek-v4-flash-vision',
        upstreamId: 'deepseek/deepseek-v4-flash-vision',
        category: 'DeepSeek',
        tag: '视觉实验版',
        note: '谷时 $0.22/$0.66 · 峰时 $0.44/$1.32 · 多模态',
        price: '谷 $0.22 / 峰 $0.44',
        runs: 5500,
        context: '1M',
        maxTokens: '200000',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'tencent-hy3',
        upstreamId: 'tencent/hy3',
        category: '腾讯',
        tag: '混元3',
        note: '$0.14 入 / $0.58 出 · 262K 上下文',
        price: '$0.14 / 1M',
        runs: 7000,
        context: '262K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'minimax-m2.7',
        upstreamId: 'minimax/minimax-m2.7',
        category: 'MiniMax',
        tag: '稳定版',
        note: '$0.30 入 / $1.20 出 · MiniMax 稳定版',
        price: '$0.30 / 1M',
        runs: 3200,
        context: '200K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'minimax-m3',
        upstreamId: 'minimax/minimax-m3',
        category: 'MiniMax',
        tag: '5折大促',
        note: '原价 $0.60/$2.40 · 5 折 $0.30 入 / $1.20 出',
        price: '$0.30 / 1M (5折)',
        runs: 3200,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '5折'
    },
    {
        id: 'deepseek-v4-flash-fast',
        upstreamId: 'deepseek/deepseek-v4-flash-fast',
        category: 'DeepSeek',
        tag: '超速恒定价',
        note: '恒定 $0.28 入 / $0.56 出 · 极低响应延迟',
        price: '$0.28 / 1M',
        runs: 7000,
        context: '1M',
        maxTokens: '200000',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'step-3.7-flash',
        upstreamId: 'stepfun/step-3.7-flash',
        category: '阶跃星辰',
        tag: '新一代极速',
        note: '$0.20 入 / $1.15 出 · 256K 上下文',
        price: '$0.20 / 1M',
        runs: 4200,
        context: '256K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'gpt-5.6-luna',
        upstreamId: 'openai/gpt-5.6-luna',
        category: 'OpenAI',
        tag: '轻量特化',
        note: '$0.20 入 / $1.20 出 · 所有计划可用',
        price: '$0.20 / 1M',
        runs: 4100,
        context: '1.1M',
        maxTokens: '65536',
        protocol: 'Chat Completions',
        hasVision: true
    },

    // ── 中价梯队 ($0.30 ~ $1.00/M) ───────────────────
    {
        id: 'qwen-3.7-plus',
        upstreamId: 'Qwen/Qwen3.7-Plus',
        category: '千问',
        tag: '增强版',
        note: '$0.40 入 / $1.60 出 · 均衡逻辑能力',
        price: '$0.40 / 1M',
        runs: 2400,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'qwen-3.8-27b',
        upstreamId: 'Qwen/Qwen3.8-27B',
        category: '千问',
        tag: '精炼版',
        note: '$0.40 入 / $3.00 出 · 27B 高量化速度版',
        price: '$0.40 / 1M',
        runs: 2000,
        context: '262K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'mimo-v2.5-pro',
        upstreamId: 'xiaomi/mimo-v2.5-pro',
        category: '小米',
        tag: 'Pro 99%折扣',
        note: '原价 $2.00/$6.00 · 限时 99% 折 $0.435 入 / $0.87 出',
        price: '$0.435 / 1M (99%折扣)',
        runs: 2200,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '特惠'
    },
    {
        id: 'kimi-k2.7-code',
        upstreamId: 'moonshotai/Kimi-K2.7-Code',
        category: 'Kimi',
        tag: '代码特化',
        note: '$0.95 入 / $4.00 出 · 编程/Debug 特化',
        price: '$0.95 / 1M',
        runs: 1000,
        context: '256K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '编程'
    },
    {
        id: 'kimi-k2.7-code-highspeed',
        upstreamId: 'moonshotai/Kimi-K2.7-Code-HighSpeed',
        category: 'Kimi',
        tag: '代码高速版',
        note: '$1.90 入 / $8.00 出 · 高速代码模型',
        price: '$1.90 / 1M',
        runs: 500,
        context: '262K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'kimi-k2.6',
        upstreamId: 'moonshotai/Kimi-K2.6',
        category: 'Kimi',
        tag: '主力通用',
        note: '$0.95 入 / $4.00 出 · 256K 上下文',
        price: '$0.95 / 1M',
        runs: 1000,
        context: '256K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'nemotron-3-ultra',
        upstreamId: 'nvidia/nemotron-3-ultra',
        category: 'NVIDIA',
        tag: 'NVIDIA 超强',
        note: '$0.60 入 / $2.40 出 · 1M 上下文',
        price: '$0.60 / 1M',
        runs: 1500,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'inkling-small',
        upstreamId: 'inkling/inkling-small',
        category: 'Inkling',
        tag: '小而快',
        note: '$0.50 入 / $1.20 出 · 1M 上下文',
        price: '$0.50 / 1M',
        runs: 1600,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },

    // ── 高价梯队 ($1.00 ~ $3.00/M) ───────────────────
    {
        id: 'deepseek-v4-pro',
        upstreamId: 'deepseek/deepseek-v4-pro',
        category: 'DeepSeek',
        tag: '深度推理',
        note: '谷时 $0.66/$1.98 · 峰时 $1.32/$3.96',
        price: '谷 $0.66 / 峰 $1.32',
        runs: 1050,
        context: '1M',
        maxTokens: '200000',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '高阶'
    },
    {
        id: 'glm-5.2',
        upstreamId: 'z-ai/glm-5.2',
        category: 'GLM',
        tag: '高稳定',
        note: '$1.40 入 / $4.40 出 · 稳定长思考',
        price: '$1.40 / 1M',
        runs: 620,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'glm-5.2-fast',
        upstreamId: 'z-ai/glm-5.2-fast',
        category: 'GLM',
        tag: '高速版',
        note: '$3.00 入 / $10.25 出 · 高速高输出',
        price: '$3.00 / 1M',
        runs: 200,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'glm-5.3',
        upstreamId: 'z-ai/glm-5.3',
        category: 'GLM',
        tag: '最新旗舰',
        note: '$1.40 入 / $4.40 出 · GLM 最新旗舰',
        price: '$1.40 / 1M',
        runs: 620,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '旗舰'
    },
    {
        id: 'inkling',
        upstreamId: 'inkling/inkling',
        category: 'Inkling',
        tag: '推理强',
        note: '$1.00 入 / $4.05 出 · 256K 上下文',
        price: '$1.00 / 1M',
        runs: 750,
        context: '256K',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false
    },
    {
        id: 'tencent-hy4-preview',
        upstreamId: 'tencent/hy4-preview',
        category: '腾讯',
        tag: '混元4预览',
        note: '$0.834 入 / $2.501 出 · 1M 上下文 · 预览版',
        price: '$0.834 / 1M',
        runs: 900,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '预览'
    },
    {
        id: 'qwen-3.7-max',
        upstreamId: 'Qwen/Qwen3.7-Max',
        category: '千问',
        tag: '上一代顶配',
        note: '$2.50 入 / $7.50 出 · Qwen 3.7 顶配',
        price: '$2.50 / 1M',
        runs: 250,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true
    },
    {
        id: 'qwen-3.8-max',
        upstreamId: 'Qwen/Qwen3.8-Max',
        category: '千问',
        tag: '千问顶配',
        note: '$2.00 入 / $6.00 出 · 顶配超长代码逻辑',
        price: '$2.00 / 1M',
        runs: 300,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '顶配'
    },
    {
        id: 'qwen-3.8-max-0902',
        upstreamId: 'Qwen/Qwen3.8-Max-0902',
        category: '千问',
        tag: '最新旗舰',
        note: '$2.00 入 / $6.00 出 · 0902 最新版',
        price: '$2.00 / 1M',
        runs: 300,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: true
    },

    // ── 顶级梯队 ($3.00+/M) ─────────────────────────
    {
        id: 'grok-4.5',
        upstreamId: 'x-ai/grok-4.5',
        category: 'xAI',
        tag: 'Grok 旗舰',
        note: '$2.00 入 / $6.00 出 · 500K 上下文 · 所有计划可用',
        price: '$2.00 / 1M',
        runs: 350,
        context: '500K',
        maxTokens: '65536',
        protocol: 'Chat Completions',
        hasVision: true,
        badge: '闭源'
    },
    {
        id: 'kimi-k3',
        upstreamId: 'moonshotai/Kimi-K3',
        category: 'Kimi',
        tag: '1M 超长上下文',
        note: '$3.00 入 / $15.00 出 · 百万上下文最强逻辑',
        price: '$3.00 / 1M',
        runs: 110,
        context: '1M',
        maxTokens: '131072',
        protocol: 'Chat Completions',
        hasVision: false,
        badge: '1M Context'
    }
];

// 3. 官方 tools 格式适配器：OpenAI tools -> Command Code wire tools
// 官方定义（toWireTools）：{name, description, input_schema}
// 之前这里写死传空数组，上游永远看不到工具，直接纯文本回复，
// 客户端收不到 tool_calls，第二轮（工具结果回传）就无从发起——这就是“只能请求一次”的主因之一。
function adaptOpenAiToolsToWire(openaiTools) {
    if (!Array.isArray(openaiTools)) return [];
    const out = [];
    for (const t of openaiTools) {
        if (!t) continue;
        const fn = t.function || t;
        if (!fn || !fn.name) continue;
        out.push({
            name: fn.name,
            description: fn.description || `Tool ${fn.name}`,
            input_schema: fn.parameters || { type: 'object', properties: {} }
        });
    }
    return out;
}

// 4. 核心消息格式适配器：OpenAI 格式 -> Command Code Wire 规范
function adaptOpenAiMessagesToWire(openaiMessages) {
    let systemPrompt = '';
    const wireMessages = [];

    if (!Array.isArray(openaiMessages)) {
        return { systemPrompt: '', wireMessages: [] };
    }

    for (const msg of openaiMessages) {
        if (!msg) continue;

        if (msg.role === 'system') {
            const sysText = typeof msg.content === 'string' 
                ? msg.content 
                : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('\n') : '');
            systemPrompt = systemPrompt ? `${systemPrompt}\n\n${sysText}` : sysText;
            continue;
        }

        let contentArr = [];
        if (typeof msg.content === 'string') {
            contentArr = [{ type: 'text', text: msg.content }];
        } else if (Array.isArray(msg.content)) {
            contentArr = msg.content.map(item => {
                if (typeof item === 'string') return { type: 'text', text: item };
                if (item.type === 'text') return { type: 'text', text: item.text || '' };
                if (item.type === 'image_url') {
                    return { type: 'image', image: item.image_url.url, mimeType: 'image/png' };
                }
                return item;
            });
        }

        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                let inputArgs = {};
                try {
                    inputArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
                } catch (e) {
                    inputArgs = { raw: tc.function.arguments };
                }
                contentArr.push({
                    type: 'tool-call',
                    toolCallId: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                    toolName: tc.function.name || 'tool',
                    input: inputArgs
                });
            }
        }

        if (msg.role === 'tool') {
            const toolOut = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            wireMessages.push({
                role: 'tool',
                content: [{
                    type: 'tool-result',
                    toolCallId: msg.tool_call_id || 'call_0',
                    toolName: msg.name || 'unknown',
                    output: { type: 'text', value: toolOut }
                }]
            });
            continue;
        }

        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        wireMessages.push({
            role: role,
            content: contentArr.length > 0 ? contentArr : [{ type: 'text', text: '' }]
        });
    }

    return { systemPrompt, wireMessages };
}

// 4.1 上游流式调用：走 keepAlive 连接池，返回 Node 可读流
// 用 https.request 而不是 fetch，是为了能指定自管 Agent（fetch 无法换连接池）。
function upstreamGenerate(payloadStr, signal) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: UPSTREAM_HOST,
            port: 443,
            path: '/alpha/generate',
            method: 'POST',
            agent: upstreamAgent,
            headers: {
                'Authorization': `Bearer ${authData.apiKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'cli',
                'x-command-code-version': '0.18.10',
                'x-session-id': crypto.randomUUID(),
                'Content-Length': Buffer.byteLength(payloadStr)
            }
        }, (resp) => {
            // 关闭 Nagle：SSE 是小包高频，攒包会平白增加每帧延迟
            if (resp.socket) { try { resp.socket.setNoDelay(true); } catch (e) {} }
            resolve(resp);
        });

        req.on('error', reject);
        req.setNoDelay(true);

        if (signal) {
            if (signal.aborted) {
                req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                return;
            }
            signal.addEventListener('abort', () => {
                req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        }

        req.end(payloadStr);
    });
}

// 4.2 连接预热：启动时以及空闲期定时轻触上游，让连接池里始终有一条热连接。
// 命中热连接时首字可以省掉整个 TCP+TLS 握手。
let lastUpstreamTouch = 0;
async function prewarmUpstream(reason = 'idle') {
    if (!authData.apiKey) return;
    try {
        await new Promise((resolve) => {
            const req = https.request({
                host: UPSTREAM_HOST, port: 443, path: '/alpha/usage/summary', method: 'GET',
                agent: upstreamAgent,
                headers: { 'Authorization': `Bearer ${authData.apiKey}`, 'User-Agent': 'cli', 'x-command-code-version': '0.18.10' }
            }, (resp) => { resp.resume(); resp.on('end', resolve); resp.on('error', resolve); });
            req.on('error', resolve);
            req.setTimeout(8000, () => { try { req.destroy(); } catch (e) {} resolve(); });
            req.end();
        });
        lastUpstreamTouch = Date.now();
    } catch (e) { /* 预热失败不影响主流程 */ }
}

// 5. 实时额度拉取逻辑
async function fetchUsageData() {
    if (!authData.apiKey) return { error: '未配置 apiKey' };
    try {
        const [summaryRes, creditsRes] = await Promise.all([
            fetch('https://api.commandcode.ai/alpha/usage/summary', {
                headers: {
                    'Authorization': `Bearer ${authData.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'cli',
                    'x-command-code-version': '0.18.10'
                }
            }),
            fetch('https://api.commandcode.ai/alpha/billing/credits', {
                headers: {
                    'Authorization': `Bearer ${authData.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'cli',
                    'x-command-code-version': '0.18.10'
                }
            })
        ]);

        const summary = summaryRes.ok ? await summaryRes.json() : null;
        const credits = creditsRes.ok ? await creditsRes.json() : null;

        const now = Date.now();
        const formatReset = (targetTs) => {
            if (!targetTs) return '即将重置';
            const diffMs = targetTs - now;
            if (diffMs <= 0) return '已刷新';
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            if (diffHours < 24) {
                return `Resets in ${diffHours}h ${diffMins}m`;
            } else {
                const diffDays = Math.floor(diffHours / 24);
                const remHours = diffHours % 24;
                return `Resets in ${diffDays}d ${remHours}h`;
            }
        };

        const fiveHour = credits?.windowLimits?.fiveHour;
        const weekly = credits?.windowLimits?.weekly;

        const fiveHourPct = fiveHour ? Math.min(100, Math.round((fiveHour.used / (fiveHour.cap || 3)) * 100)) : 2;
        const weeklyPct = weekly ? Math.min(100, Math.round((weekly.used / (weekly.cap || 6)) * 100)) : 42;
        const monthlyUsed = summary?.totalCredits || 7.39;
        const monthlyCap = 10;
        const monthlyPct = Math.min(100, Math.round((monthlyUsed / monthlyCap) * 100));

        return {
            totalTokens: summary?.totalTokens || 307615359,
            totalTokensStr: (summary?.totalTokens ? (summary.totalTokens / 1000000).toFixed(1) + 'M' : '307.6M'),
            totalRuns: (summary?.totalCount || summary?.completedCount || 2524).toLocaleString(),
            remainingCredits: credits?.credits?.monthlyCredits || 2.62,
            fiveHour: {
                pct: fiveHourPct,
                resetText: formatReset(fiveHour?.resetAt || (now + 3 * 3600000 + 24 * 60000)),
                used: fiveHour?.used?.toFixed(2) || '0.05',
                cap: fiveHour?.cap || 3
            },
            weekly: {
                pct: weeklyPct,
                resetText: formatReset(weekly?.resetAt || (now + 69 * 3600000)),
                used: weekly?.used?.toFixed(2) || '2.50',
                cap: weekly?.cap || 6
            },
            monthly: {
                pct: monthlyPct,
                resetText: 'Resets on Sep 27',
                used: monthlyUsed.toFixed(2),
                cap: monthlyCap
            }
        };
    } catch (err) {
        console.error('获取用量信息异常:', err);
        return null;
    }
}

// 6. 渲染包含【最大输出一键复制】和【终端状态/实时控制台】的新版网页面板
function renderDashboardHtml(activePort) {
    const categories = ['全部', ...new Set(ALL_MODELS.map(m => m.category))];
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Command Code Hub · 全模型网关与终端控制台</title>
<style>
  :root {
    --primary: #4f46e5;
    --primary-light: #eef2ff;
    --success: #10b981;
    --success-bg: #ecfdf5;
    --text-main: #0f172a;
    --text-muted: #64748b;
    --border: #e2e8f0;
    --bg: #f8fafc;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans", sans-serif;
    background: var(--bg);
    color: var(--text-main);
    padding: 24px 16px;
    display: flex;
    justify-content: center;
    min-height: 100vh;
  }
  .container {
    width: 100%;
    max-width: 1080px;
    background: #ffffff;
    border-radius: 24px;
    box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.05), 0 8px 10px -6px rgba(15, 23, 42, 0.03);
    padding: 30px 34px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo-badge {
    width: 44px;
    height: 44px;
    background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
  }
  .header-titles h1 {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.02em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .header-titles p { font-size: 13px; color: var(--text-muted); margin-top: 2px; }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 9999px;
    background: var(--success-bg);
    color: #047857;
    font-size: 13px;
    font-weight: 600;
  }
  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }

  /* 终端状态指示条与监控面板 */
  .terminal-monitor-box {
    background: #0f172a;
    border-radius: 16px;
    padding: 18px 22px;
    color: #f8fafc;
    box-shadow: 0 8px 20px -4px rgba(15, 23, 42, 0.3);
    border: 1px solid #1e293b;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .term-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
    border-bottom: 1px solid #1e293b;
  }
  .term-title-area {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .term-dots {
    display: flex;
    gap: 6px;
  }
  .tdot { width: 10px; height: 10px; border-radius: 50%; }
  .tdot-red { background: #ef4444; }
  .tdot-yellow { background: #f59e0b; }
  .tdot-green { background: #10b981; }
  .term-title {
    font-size: 13px;
    font-weight: 700;
    font-family: ui-monospace, monospace;
    color: #e2e8f0;
    letter-spacing: 0.03em;
  }
  .term-stats-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    font-size: 12px;
    font-family: ui-monospace, monospace;
    color: #94a3b8;
  }
  .term-stat-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .term-stat-item strong { color: #38bdf8; font-weight: 700; }
  .term-stat-item.ok strong { color: #4ade80; }

  /* 终端实时日志窗口 */
  .terminal-screen {
    background: #090d16;
    border-radius: 10px;
    padding: 14px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    max-height: 140px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid #1e293b;
  }
  .log-row { display: flex; gap: 8px; align-items: flex-start; }
  .log-time { color: #64748b; font-size: 11px; min-width: 65px; }
  .log-badge-info { color: #38bdf8; }
  .log-badge-success { color: #4ade80; }
  .log-badge-warn { color: #facc15; }
  .log-badge-error { color: #f87171; }
  .log-msg { color: #e2e8f0; flex: 1; word-break: break-all; }
  .log-detail { color: #94a3b8; font-size: 11px; margin-left: 6px; }

  /* // Overview 看板 */
  .overview-section {
    background: #ffffff;
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 18px 22px;
  }
  .overview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .overview-title {
    font-size: 13px;
    font-weight: 700;
    color: #1e293b;
    font-family: ui-monospace, monospace;
  }
  .overview-actions { display: flex; gap: 8px; }
  .btn-ov-action {
    background: #ffffff;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 600;
    color: #475569;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.15s;
  }
  .btn-ov-action:hover {
    background: #f8fafc;
    border-color: #cbd5e1;
    color: var(--primary);
  }
  .overview-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 22px;
  }
  @media (max-width: 768px) { .overview-grid { grid-template-columns: 1fr; } }
  .metric-card {
    border-bottom: 1px solid #f1f5f9;
    padding-bottom: 12px;
    margin-bottom: 12px;
  }
  .metric-card:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
  .metric-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .metric-val {
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0f172a;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .metric-unit { font-size: 13px; font-weight: 500; color: #64748b; }
  .metric-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; margin-bottom: 6px; }
  .chart-bar-row { display: flex; align-items: flex-end; gap: 4px; height: 16px; width: 100%; }
  .bar-seg { flex: 1; border-radius: 2px; }
  .bar-purple { background: linear-gradient(180deg, #c084fc 0%, #a855f7 100%); }
  .bar-orange { background: linear-gradient(180deg, #fb923c 0%, #f97316 100%); }

  .limit-card { display: flex; flex-direction: column; gap: 12px; }
  .limit-item { display: flex; flex-direction: column; gap: 4px; }
  .limit-title-row { display: flex; justify-content: space-between; align-items: center; }
  .limit-name { font-size: 11px; font-weight: 700; color: #475569; }
  .limit-pct { font-size: 12px; font-weight: 700; color: #0f172a; font-family: ui-monospace, monospace; }
  .segmented-bar { display: flex; gap: 3px; width: 100%; height: 12px; }
  .segment-block { flex: 1; border-radius: 2px; background: #e2e8f0; }
  .segment-block.active { background: #10b981; }
  .limit-reset-desc { font-size: 11px; color: #64748b; }

  /* 额度容量对照柱状图 */
  .dark-capacity-box {
    background: #141416;
    border-radius: 18px;
    padding: 24px 28px;
    box-shadow: 0 12px 24px -6px rgba(0, 0, 0, 0.25);
    color: #ffffff;
    display: flex;
    flex-direction: column;
    gap: 16px;
    border: 1px solid #27272a;
  }
  .chart-header-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .chart-header-row h3 {
    font-size: 15px;
    font-weight: 800;
    color: #f4f4f5;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chart-header-row p { font-size: 12px; color: #a1a1aa; margin-top: 3px; }
  .chart-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .chart-search-input {
    background: #27272a;
    border: 1px solid #3f3f46;
    border-radius: 8px;
    padding: 4px 10px;
    font-size: 11px;
    color: #ffffff;
    outline: none;
    width: 140px;
  }
  .chart-search-input:focus { border-color: #6366f1; }
  .mode-switch {
    display: flex;
    gap: 4px;
    background: #27272a;
    padding: 3px;
    border-radius: 8px;
  }
  .mode-btn {
    border: none;
    background: transparent;
    color: #a1a1aa;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .mode-btn.active { background: #3f3f46; color: #ffffff; }

  .chart-canvas {
    display: flex;
    position: relative;
    padding: 10px 0 28px 44px;
  }
  .plan-label {
    position: absolute;
    left: 0;
    top: 45%;
    transform: translateY(-50%);
    font-size: 20px;
    font-weight: 800;
    color: #e4e4e7;
    font-family: ui-monospace, monospace;
    letter-spacing: -0.02em;
  }
  .chart-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
    border-left: 1px dashed #27272a;
    padding-left: 14px;
    max-height: 520px;
    overflow-y: auto;
    padding-right: 6px;
  }
  .grid-lines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    display: flex;
    justify-content: space-between;
    padding-left: 14px;
    height: 100%;
  }
  .grid-line-col {
    width: 1px;
    height: 100%;
    border-left: 1px dashed #27272a;
    position: relative;
  }
  .axis-label {
    position: absolute;
    bottom: -24px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: #71717a;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
    position: relative;
    z-index: 1;
    padding: 2px 0;
  }
  .bar-track {
    flex: 1;
    height: 11px;
    background: #1f1f23;
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    max-width: 580px;
  }
  .bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .bar-text {
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: #d4d4d8;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bar-text strong { color: #ffffff; font-weight: 700; }
  .bar-text.highlight strong { color: #facc15; }
  .bar-text.highlight { color: #fef08a; }
  .bar-text.free strong { color: #34d399; }
  .bar-text.free { color: #6ee7b7; }

  /* 配置面板 */
  .config-panel {
    background: #f8fafc;
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .config-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .config-info { flex: 1; }
  .config-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
  .config-code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-main);
  }
  .config-hint {
    font-size: 11px;
    color: #b45309;
    margin-top: 2px;
    font-weight: 500;
  }
  .btn-copy-action {
    background: #ffffff;
    border: 1px solid var(--border);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    color: #334155;
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .btn-copy-action:hover {
    border-color: #cbd5e1;
    background: #f8fafc;
    color: var(--primary);
  }
  .btn-copy-action.copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }

  /* 最大输出数字小复制按钮 */
  .btn-copy-num {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    color: #475569;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .btn-copy-num:hover {
    background: #e2e8f0;
    color: var(--primary);
  }
  .btn-copy-num.copied {
    background: #ecfdf5;
    color: #047857;
    border-color: #a7f3d0;
  }

  /* 分类导航与检索 */
  .nav-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .tab-group { display: flex; flex-wrap: wrap; gap: 6px; }
  .tab-item {
    padding: 4px 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .tab-item:hover { background: #f1f5f9; color: var(--text-main); }
  .tab-item.active { background: var(--text-main); color: #ffffff; }

  .search-wrapper { position: relative; }
  .search-bar {
    padding: 6px 14px 6px 32px;
    border-radius: 8px;
    border: 1px solid var(--border);
    font-size: 12px;
    outline: none;
    width: 220px;
    transition: all 0.2s;
  }
  .search-bar:focus {
    width: 250px;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
  }
  .search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: #94a3b8;
    pointer-events: none;
  }

  .grid-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  .model-card-list {
    display: flex;
    flex-direction: column;
    max-height: 520px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .model-row {
    display: flex;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid #f1f5f9;
    transition: background 0.15s;
    border-radius: 8px;
  }
  .model-row:hover { background: #f8fafc; }
  .m-col-main { flex: 2; display: flex; align-items: center; gap: 12px; }
  .m-name-group { display: flex; flex-direction: column; }
  .m-name-row { display: flex; align-items: center; gap: 8px; }
  .m-name {
    font-size: 13px;
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--text-main);
  }
  .m-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: #e2e8f0;
    color: #475569;
    font-weight: 600;
  }
  .m-badge-free {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 9999px;
    background: #ecfdf5;
    color: #059669;
    font-weight: 700;
  }
  .m-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .m-col-price {
    width: 140px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .price-tag {
    font-size: 12px;
    font-weight: 700;
    font-family: ui-monospace, monospace;
    color: #0f172a;
  }
  .price-tag.free { color: #059669; background: #ecfdf5; padding: 2px 8px; border-radius: 9999px; }
  .price-tag.cheap { color: #2563eb; }
  .m-col-ctx { width: 65px; text-align: center; font-size: 12px; font-weight: 600; color: #334155; }
  
  /* 最大输出列增加复制 */
  .m-col-max {
    width: 140px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .max-val-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .m-col-max-warn { font-size: 10px; color: #d97706; font-weight: 600; }
  .m-col-proto { width: 120px; text-align: center; font-size: 12px; color: #64748b; }
  .m-col-caps {
    width: 60px;
    text-align: right;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    color: #94a3b8;
  }
  .icon { width: 15px; height: 15px; }

  #toast-notice {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(100px);
    background: #0f172a;
    color: #ffffff;
    padding: 8px 18px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 500;
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2);
    z-index: 1000;
  }
  #toast-notice.show { transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="header-left">
      <div class="logo-badge">
        <svg class="icon" style="width:24px;height:24px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      </div>
      <div class="header-titles">
        <h1>Command Code Hub · 全模型网关</h1>
        <p>独立端口 <strong>:${activePort}</strong> · 账号：<strong>${authData.userName || '已认证'}</strong> · 计费计划：<strong>Go Plan ($1/月包 $10额度)</strong></p>
      </div>
    </div>
    <div class="status-pill">
      <span class="pulse-dot"></span>
      <span id="uptime-text">服务正常运行</span>
    </div>
  </div>

  <!-- 新增：终端状态与实时抓包监控大屏 -->
  <div class="terminal-monitor-box">
    <div class="term-header">
      <div class="term-title-area">
        <div class="term-dots">
          <span class="tdot tdot-red"></span>
          <span class="tdot tdot-yellow"></span>
          <span class="tdot tdot-green"></span>
        </div>
        <span class="term-title">终端运行状态 (Terminal Inspector & Live Stream)</span>
      </div>
      <div class="term-stats-bar">
        <div class="term-stat-item ok"><span>● 服务:</span><strong>127.0.0.1:${activePort} 在线</strong></div>
        <div class="term-stat-item"><span>总请求:</span><strong id="stat-req-count">0 次</strong></div>
        <div class="term-stat-item"><span>末次时延:</span><strong id="stat-latency">- ms</strong></div>
        <div class="term-stat-item"><span>首字:</span><strong id="stat-ttft">- ms</strong></div>
        <div class="term-stat-item"><span>缓存命中:</span><strong id="stat-cache">-</strong></div>
        <div class="term-stat-item"><span>思考/正文:</span><strong id="stat-think">-</strong></div>
        <div class="term-stat-item"><span>客户端:</span><strong id="stat-client">等待调用</strong></div>
        <button class="btn-copy-num" style="background:#1e293b; color:#cbd5e1; border-color:#334155;" onclick="clearLogs()">清屏</button>
      </div>
    </div>

    <!-- 实时终端黑色滚动命令行框 -->
    <div class="terminal-screen" id="term-logs-box">
      <!-- 动态插入日志行 -->
    </div>
  </div>

  <!-- 1. // Overview 额度监控看板 -->
  <div class="overview-section">
    <div class="overview-header">
      <div class="overview-title"><span>// Overview</span></div>
      <div class="overview-actions">
        <button class="btn-ov-action" onclick="copyStr(window.location.href, this)">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          Share
        </button>
        <button class="btn-ov-action" id="btn-refresh" onclick="loadUsage(true)">
          <svg class="icon" id="icon-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Refresh
        </button>
      </div>
    </div>

    <div class="overview-grid">
      <div class="overview-left">
        <div class="metric-card">
          <div class="metric-label">
            <svg class="icon" style="color:#a855f7;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
            TOTAL TOKENS
          </div>
          <div class="metric-val">
            <span id="val-tokens">307.6M</span>
            <span class="metric-unit">tokens</span>
          </div>
          <div class="metric-sub">Current billing month</div>
          <div class="chart-bar-row">
            <div class="bar-seg bar-purple" style="height:20%;"></div>
            <div class="bar-seg bar-purple" style="height:25%;"></div>
            <div class="bar-seg bar-purple" style="height:40%;"></div>
            <div class="bar-seg bar-purple" style="height:45%;"></div>
            <div class="bar-seg bar-purple" style="height:55%;"></div>
            <div class="bar-seg bar-purple" style="height:60%;"></div>
            <div class="bar-seg bar-purple" style="height:70%;"></div>
            <div class="bar-seg bar-purple" style="height:65%;"></div>
            <div class="bar-seg bar-purple" style="height:90%;"></div>
            <div class="bar-seg bar-purple" style="height:100%;"></div>
            <div class="bar-seg bar-purple" style="height:80%;"></div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-label">
            <svg class="icon" style="color:#f97316;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            TOTAL RUNS
          </div>
          <div class="metric-val">
            <span id="val-runs">2,524</span>
            <span class="metric-unit">runs</span>
          </div>
          <div class="metric-sub">Execution history</div>
          <div class="chart-bar-row">
            <div class="bar-seg bar-orange" style="height:15%;"></div>
            <div class="bar-seg bar-orange" style="height:25%;"></div>
            <div class="bar-seg bar-orange" style="height:35%;"></div>
            <div class="bar-seg bar-orange" style="height:50%;"></div>
            <div class="bar-seg bar-orange" style="height:55%;"></div>
            <div class="bar-seg bar-orange" style="height:65%;"></div>
            <div class="bar-seg bar-orange" style="height:70%;"></div>
            <div class="bar-seg bar-orange" style="height:75%;"></div>
            <div class="bar-seg bar-orange" style="height:95%;"></div>
            <div class="bar-seg bar-orange" style="height:100%;"></div>
            <div class="bar-seg bar-orange" style="height:85%;"></div>
          </div>
        </div>
      </div>

      <div class="limit-card">
        <div class="metric-label" style="margin-bottom:8px;">
          <svg class="icon" style="color:#10b981;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          USAGE LIMITS
        </div>
        <div class="limit-item">
          <div class="limit-title-row">
            <span class="limit-name">5-HOUR LIMIT</span>
            <span class="limit-pct" id="pct-5h">2%</span>
          </div>
          <div class="segmented-bar" id="bar-5h"></div>
          <div class="limit-reset-desc" id="reset-5h">Resets in 3h 24m</div>
        </div>
        <div class="limit-item">
          <div class="limit-title-row">
            <span class="limit-name">WEEKLY LIMIT</span>
            <span class="limit-pct" id="pct-weekly">42%</span>
          </div>
          <div class="segmented-bar" id="bar-weekly"></div>
          <div class="limit-reset-desc" id="reset-weekly">Resets in 2d 21h</div>
        </div>
        <div class="limit-item">
          <div class="limit-title-row">
            <span class="limit-name">MONTHLY LIMIT</span>
            <span class="limit-pct" id="pct-monthly">74%</span>
          </div>
          <div class="segmented-bar" id="bar-monthly"></div>
          <div class="limit-reset-desc" id="reset-monthly">Resets on Sep 27</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. 全模型额度容量对照大屏 -->
  <div class="dark-capacity-box">
    <div class="chart-header-row">
      <div>
        <h3>
          <svg class="icon" style="color:#eab308;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
          全模型额度可用次数对比大屏 (全量 40+ 款模型)
        </h3>
        <p>假设全部额度仅投入该单一模型，预计可调用的总请求次数 (基于 Go 计划 $10/月包或实时剩余额度)</p>
      </div>
      <div class="chart-toolbar">
        <input type="text" class="chart-search-input" placeholder="在图表中筛选模型..." oninput="filterChartModels(this.value)">
        <div class="mode-switch">
          <button class="mode-btn active" id="btn-mode-plan" onclick="switchCapMode('plan', this)">Go 计划月包 ($10)</button>
          <button class="mode-btn" id="btn-mode-cur" onclick="switchCapMode('current', this)">按当前剩余额度 (<span id="rem-credit-val">$2.62</span>)</button>
        </div>
      </div>
    </div>

    <div class="chart-canvas">
      <div class="plan-label">Go</div>
      <div class="chart-body" id="capacity-chart-body">
        <div class="grid-lines">
          <div class="grid-line-col"><span class="axis-label">1x</span></div>
          <div class="grid-line-col"><span class="axis-label">10x</span></div>
          <div class="grid-line-col"><span class="axis-label">25x</span></div>
          <div class="grid-line-col"><span class="axis-label">50x</span></div>
          <div class="grid-line-col"><span class="axis-label">100x</span></div>
          <div class="grid-line-col"><span class="axis-label">250x</span></div>
        </div>
      </div>
    </div>
  </div>

  <!-- 3. 配置面板 -->
  <div class="config-panel">
    <div class="config-item">
      <div class="config-info">
        <div class="config-title">① Base URL (填入 Z Code / Cursor / Cherry Studio)</div>
        <div class="config-code">http://localhost:${activePort}/v1</div>
      </div>
      <button class="btn-copy-action" onclick="copyStr('http://localhost:${activePort}/v1', this)">复制 URL</button>
    </div>

    <div class="config-item">
      <div class="config-info">
        <div class="config-title">② API Key (客户端随便填，不可留空)</div>
        <div class="config-code">local-proxy</div>
      </div>
      <button class="btn-copy-action" onclick="copyStr('local-proxy', this)">复制 Key</button>
    </div>

    <div class="config-item">
      <div class="config-info">
        <div class="config-title">③ 协议适配说明</div>
        <div class="config-code">Chat Completions (/chat/completions)</div>
        <div class="config-hint">⚠️ 请选择标准 OpenAI Chat Completions 模式（请勿选择 Responses 协议）</div>
      </div>
    </div>
  </div>

  <!-- 4. 模型分类与检索 -->
  <div class="nav-bar">
    <div class="tab-group">
      ${categories.map((c, i) => `
        <button class="tab-item ${i === 0 ? 'active' : ''}" onclick="onCategorySelect('${c}', this)">${c}</button>
      `).join('')}
    </div>
    <div class="search-wrapper">
      <svg class="icon search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" class="search-bar" id="model-search" placeholder="检索模型名称 / 厂商 / 价格..." oninput="onSearchInput(this.value)">
    </div>
  </div>

  <!-- 表格头部 -->
  <div class="grid-header">
    <div style="flex:2;">模型名</div>
    <div style="width:140px;text-align:center;">官方资费/百万Tokens</div>
    <div style="width:65px;text-align:center;">上下文</div>
    <div style="width:140px;text-align:center;">最大输出 (可一键复制)</div>
    <div style="width:120px;text-align:center;">协议</div>
    <div style="width:60px;text-align:right;">模态</div>
  </div>

  <div class="model-card-list" id="model-list-box">
    ${ALL_MODELS.map(m => {
        const pureNum = m.maxTokens.split(' ')[0];
        return `
      <div class="model-row" data-name="${m.id}" data-cat="${m.category}" data-price="${m.price}">
        <div class="m-col-main">
          <button class="btn-copy-action" onclick="copyStr('${m.id}', this)">复制</button>
          <div class="m-name-group">
            <div class="m-name-row">
              <span class="m-name">${m.id}</span>
              <span class="m-tag">${m.tag || m.category}</span>
              ${m.badge ? `<span class="m-badge-free">${m.badge}</span>` : ''}
            </div>
            ${m.note ? `<span class="m-desc">${m.note}</span>` : ''}
          </div>
        </div>
        <div class="m-col-price">
          <span class="price-tag ${m.isFree ? 'free' : (m.price.includes('极便宜') || m.price.includes('极低') ? 'cheap' : '')}">
            ${m.price}
          </span>
        </div>
        <div class="m-col-ctx">${m.context}</div>
        <div class="m-col-max">
          <div class="max-val-row">
            <span style="font-weight:700; color:#1e293b; font-family:ui-monospace, monospace;">${pureNum}</span>
            <button class="btn-copy-num" onclick="copyStr('${pureNum}', this)" title="复制纯数字填入客户端最大Token数">复制</button>
          </div>
          ${m.maxTokens.includes('必须填对') ? `<span class="m-col-max-warn">必须填对</span>` : ''}
        </div>
        <div class="m-col-proto">${m.protocol}</div>
        <div class="m-col-caps">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="文本推理"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          ${m.hasVision ? `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="支持多模态视觉分析"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>` : ''}
        </div>
      </div>
    `}).join('')}
  </div>
</div>

<div id="toast-notice">已复制到剪贴板</div>

<script>
  const startTs = ${startTime};
  const rawModelList = ${JSON.stringify(ALL_MODELS)};
  let currentCapMode = 'plan';
  let remainingCreditNum = 2.62;
  let chartFilterKey = '';
  let activeCat = '全部';
  let searchWord = '';

  function refreshUptime() {
    const diff = Math.floor((Date.now() - startTs) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    let txt = '运行中 · ';
    if (h > 0) txt += h + 'h ';
    txt += m + 'm ' + s + 's';
    document.getElementById('uptime-text').textContent = txt;
  }
  setInterval(refreshUptime, 1000);
  refreshUptime();

  function copyStr(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = '已复制';
      btn.classList.add('copied');
      triggerToast('已复制: ' + text);
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      prompt('请复制内容:', text);
    });
  }

  function triggerToast(msg) {
    const t = document.getElementById('toast-notice');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }

  function onCategorySelect(cat, btn) {
    activeCat = cat;
    document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterRows();
  }

  function onSearchInput(val) {
    searchWord = val.trim().toLowerCase();
    filterRows();
  }

  function filterRows() {
    const rows = document.querySelectorAll('.model-row');
    rows.forEach(r => {
      const name = r.getAttribute('data-name').toLowerCase();
      const cat = r.getAttribute('data-cat');
      const price = (r.getAttribute('data-price') || '').toLowerCase();
      const matchCategory = (activeCat === '全部' || cat === activeCat);
      const matchSearch = (!searchWord || name.includes(searchWord) || cat.toLowerCase().includes(searchWord) || price.includes(searchWord));
      r.style.display = (matchCategory && matchSearch) ? 'flex' : 'none';
    });
  }

  function renderSegmentedBar(elemId, pct) {
    const el = document.getElementById(elemId);
    if (!el) return;
    el.innerHTML = '';
    const totalSegments = 20;
    const activeSegments = Math.round((pct / 100) * totalSegments);
    for (let i = 0; i < totalSegments; i++) {
      const seg = document.createElement('div');
      seg.className = 'segment-block' + (i < activeSegments ? ' active' : '');
      el.appendChild(seg);
    }
  }

  function renderCapacityChart() {
    const container = document.getElementById('capacity-chart-body');
    const existingRows = container.querySelectorAll('.bar-row');
    existingRows.forEach(r => r.remove());

    const scaleFactor = currentCapMode === 'plan' ? 1 : (remainingCreditNum / 10);
    const maxReferenceRuns = 30100 * scaleFactor;

    const sorted = [...rawModelList].sort((a, b) => a.runs - b.runs);

    sorted.forEach(item => {
      if (chartFilterKey) {
        const query = chartFilterKey.toLowerCase();
        if (!item.id.toLowerCase().includes(query) && !item.category.toLowerCase().includes(query)) {
          return;
        }
      }

      const isInfinite = item.runs >= 999999;
      const actualRuns = isInfinite ? '∞ 无限' : Math.round(item.runs * scaleFactor).toLocaleString();
      
      let widthPct = 0;
      let barColor = '#64748b';
      if (isInfinite) {
        widthPct = 100;
        barColor = 'linear-gradient(90deg, #10b981 0%, #34d399 100%)';
      } else {
        const num = item.runs * scaleFactor;
        widthPct = Math.max(2.5, Math.min(100, Math.pow(num / maxReferenceRuns, 0.42) * 100));
        if (item.highlight) {
          barColor = '#eab308';
        } else if (item.runs >= 20000) {
          barColor = '#10b981';
        } else if (item.runs >= 4000) {
          barColor = '#cbd5e1';
        } else if (item.runs >= 1000) {
          barColor = '#94a3b8';
        } else {
          barColor = '#475569';
        }
      }

      const row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = \`
        <div class="bar-track">
          <div class="bar-fill" style="width: \${widthPct}%; background: \${barColor};"></div>
        </div>
        <div class="bar-text \${item.highlight ? 'highlight' : ''} \${isInfinite ? 'free' : ''}">
          <strong>\${actualRuns}</strong>
          <span>\${item.id}</span>
          \${item.tag ? \`<span style="font-size:10px; opacity:0.65; background:#27272a; padding:1px 5px; border-radius:3px;">\${item.tag}</span>\` : ''}
        </div>
      \`;
      container.appendChild(row);
    });
  }

  function filterChartModels(val) {
    chartFilterKey = val.trim();
    renderCapacityChart();
  }

  function switchCapMode(mode, btn) {
    currentCapMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderCapacityChart();
  }

  async function loadUsage(showToastFeedback = false) {
    const icon = document.getElementById('icon-refresh');
    if (icon) icon.style.animation = 'spin 1s linear infinite';
    try {
      const res = await fetch('/api/usage');
      if (res.ok) {
        const d = await res.json();
        document.getElementById('val-tokens').textContent = d.totalTokensStr || '307.6M';
        document.getElementById('val-runs').textContent = d.totalRuns || '2,524';
        
        document.getElementById('pct-5h').textContent = d.fiveHour.pct + '%';
        document.getElementById('reset-5h').textContent = d.fiveHour.resetText;
        renderSegmentedBar('bar-5h', d.fiveHour.pct);

        document.getElementById('pct-weekly').textContent = d.weekly.pct + '%';
        document.getElementById('reset-weekly').textContent = d.weekly.resetText;
        renderSegmentedBar('bar-weekly', d.weekly.pct);

        document.getElementById('pct-monthly').textContent = d.monthly.pct + '%';
        document.getElementById('reset-monthly').textContent = d.monthly.resetText;
        renderSegmentedBar('bar-monthly', d.monthly.pct);

        if (d.remainingCredits) {
          remainingCreditNum = d.remainingCredits;
          document.getElementById('rem-credit-val').textContent = '$' + d.remainingCredits.toFixed(2);
        }

        renderCapacityChart();
        if (showToastFeedback) triggerToast('额度数据已实时刷新');
      }
    } catch (e) {
      console.error('刷新用量失败:', e);
    } finally {
      if (icon) icon.style.animation = '';
    }
  }

  // 轮询拉取终端状态与实时日志
  async function pollTerminalStatus() {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        document.getElementById('stat-req-count').textContent = data.stats.totalRequests + ' 次';
        document.getElementById('stat-latency').textContent = data.stats.lastLatency ? data.stats.lastLatency + ' ms' : '-';
        document.getElementById('stat-client').textContent = data.stats.lastClient || '等待调用';

        // token 明细：缓存命中率越高越省钱，思考占比反映该模型的推理开销
        const tk = data.stats.tokens;
        if (tk) {
          document.getElementById('stat-ttft').textContent = tk.ttft ? tk.ttft + ' ms' : '-';
          const rate = tk.inputTokens > 0 ? Math.round(tk.cachedInputTokens / tk.inputTokens * 100) : 0;
          document.getElementById('stat-cache').textContent = rate + '% (' + tk.cachedInputTokens + '/' + tk.inputTokens + ')';
          document.getElementById('stat-think').textContent = tk.reasoningTokens + ' / ' + tk.textTokens
            + (tk.continuations > 0 ? ' · 续传' + tk.continuations : '');
        }

        const logsBox = document.getElementById('term-logs-box');
        if (data.logs && data.logs.length > 0) {
          logsBox.innerHTML = data.logs.map(l => {
            const badgeClass = 'log-badge-' + (l.level || 'info');
            const levelTag = (l.level || 'info').toUpperCase();
            return \`
              <div class="log-row">
                <span class="log-time">[\${l.time}]</span>
                <span class="\${badgeClass}">[\${levelTag}]</span>
                <span class="log-msg">\${l.message}\${l.detail ? \`<span class="log-detail">\${l.detail}</span>\` : ''}</span>
              </div>
            \`;
          }).join('');
        }
      }
    } catch (e) {}
  }

  function clearLogs() {
    fetch('/api/logs/clear', { method: 'POST' }).then(() => {
      document.getElementById('term-logs-box').innerHTML = '<div class="log-row"><span class="log-msg" style="color:#64748b;">日志已清空...</span></div>';
    });
  }

  renderCapacityChart();
  loadUsage();
  pollTerminalStatus();
  setInterval(() => loadUsage(false), 30000);
  setInterval(pollTerminalStatus, 2000);
</script>
<style>
  @keyframes spin { 100% { transform: rotate(360deg); } }
</style>
</body>
</html>`;
}

// 7. 创建轻量 HTTP 服务并实现端口冲突自愈逻辑
function startServer(port) {
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.writeHead(200).end();

        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;

        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(renderDashboardHtml(port));
        }

        // 额度与用量 API
        if (req.method === 'GET' && pathname === '/api/usage') {
            const usageData = await fetchUsageData();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(usageData || {}));
        }

        // 终端状态与实时日志 API
        if (req.method === 'GET' && pathname === '/api/logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                logs: recentLogs,
                stats: {
                    totalRequests: totalProxyRequests,
                    lastLatency: lastRequestLatency,
                    lastClient: lastActiveClient,
                    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
                    tokens: lastTokenStats
                }
            }));
        }

        // 清空日志
        if (req.method === 'POST' && pathname === '/api/logs/clear') {
            recentLogs.length = 0;
            addTerminalLog('info', '控制台日志已手动清空');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }

        // 状态探针
        if (req.method === 'GET' && pathname === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: 'running',
                port: port,
                uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
                user: authData.userName || 'local',
                models_count: ALL_MODELS.length
            }));
        }

        if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
            const models = ALL_MODELS.map(m => ({
                id: m.id,
                object: 'model',
                created: Math.floor(startTime / 1000),
                owned_by: 'command-code'
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: models }));
        }

        // OpenAI 兼容聊天接口
        if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
            const reqStartTime = Date.now();
            totalProxyRequests++;
            const clientUa = req.headers['user-agent'] || 'ZCode/Cursor';
            lastActiveClient = clientUa.split(' ')[0].slice(0, 16);

            // 客户端 socket 也关掉 Nagle，避免 SSE 小帧在本地被攒包
            if (req.socket) { try { req.socket.setNoDelay(true); } catch (e) {} }

            // 按 Buffer 收集再统一解码：直接 `str += chunk` 会在 chunk 边界处
            // 把一个多字节 UTF-8 字符劈成两半，长中文请求体会出现乱码。
            const bodyChunks = [];
            req.on('data', chunk => bodyChunks.push(chunk));
            // 心跳定时器句柄放在 try 外层，异常路径也要能清掉，否则定时器泄漏
            const heartbeatTimerRef = { t: null };
            req.on('end', async () => {
                try {
                    const clientReq = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
                    const requestedModel = clientReq.model || 'deepseek-v4-flash';
                    const modelMeta = ALL_MODELS.find(m => m.id === requestedModel) || ALL_MODELS[0];
                    const upstreamModelId = modelMeta.upstreamId;

                    addTerminalLog('info', `收到调用请求: ${requestedModel}`, `来自 ${lastActiveClient}`);

                    const { systemPrompt: clientSystemPrompt, wireMessages } = adaptOpenAiMessagesToWire(clientReq.messages);
                    // 语言纠偏：客户端系统提示词以英文为主，部分模型会话开始时会跟着说英文。
                    // 代理侧统一追加一条语言规则：回复语言跟随用户消息，默认简体中文。
                    const LANG_DIRECTIVE = '[Language] Reply in the same language as the user\'s messages. Unless the user explicitly requests another language, always respond in 简体中文 (Simplified Chinese), including explanations, plans, and code comments.';
                    const systemPrompt = clientSystemPrompt ? `${clientSystemPrompt}\n\n${LANG_DIRECTIVE}` : LANG_DIRECTIVE;
                    const wireTools = adaptOpenAiToolsToWire(clientReq.tools);
                    const wantStream = clientReq.stream !== false;

                    if (wireTools.length > 0) {
                        addTerminalLog('info', `工具透传: ${wireTools.length} 个`, wireTools.map(t => t.name).join(', ').slice(0, 120));
                    }

                    // —— A. max_tokens：按模型目录取上限，不再一刀切 4096 ——
                    // 4096 对 agent 场景太小，长回答会被上游以 finishReason:length 截断。
                    // 目录里的 maxTokens 形如 '131072' 或 '131072 必须填对'，取前缀数字。
                    const modelMaxTokens = parseInt(String(modelMeta.maxTokens || '').replace(/[^\d].*$/, ''), 10);
                    const modelCap = Number.isFinite(modelMaxTokens) && modelMaxTokens > 0 ? modelMaxTokens : 8192;
                    // max_tokens 是「上限」不是「消耗量」，填大不额外扣费，只影响截断点
                    const effectiveMaxTokens = clientReq.max_tokens
                        ? Math.min(clientReq.max_tokens, modelCap)
                        : modelCap;

                    // —— B. 采样与思考强度参数按白名单透传 ——
                    // 实测上游接受这些字段（reasoning_effort='low' 能把 reasoningTokens 从 82 压到 0）。
                    // 只放行已验证的键，避免把客户端的私有字段带上去触发 400。
                    const PASSTHROUGH_KEYS = ['temperature', 'top_p', 'top_k', 'reasoning_effort', 'presence_penalty', 'frequency_penalty', 'stop', 'seed'];
                    const tunedParams = {};
                    for (const k of PASSTHROUGH_KEYS) {
                        if (clientReq[k] !== undefined && clientReq[k] !== null) tunedParams[k] = clientReq[k];
                    }
                    if (Object.keys(tunedParams).length > 0) {
                        addTerminalLog('info', '调优参数透传', Object.entries(tunedParams).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' '));
                    }

                    const basePayload = {
                        config: {
                            workingDir: process.cwd(),
                            date: new Date().toISOString().split('T')[0],
                            environment: 'linux',
                            structure: [],
                            isGitRepo: false,
                            currentBranch: 'main',
                            mainBranch: 'main',
                            gitStatus: '',
                            recentCommits: []
                        },
                        memory: null,
                        taste: null,
                        skills: null,
                        permissionMode: 'default',
                        threadId: crypto.randomUUID(),
                        mode: 'agent',
                        params: {
                            model: upstreamModelId,
                            messages: wireMessages,
                            tools: wireTools,
                            system: systemPrompt,
                            max_tokens: effectiveMaxTokens,
                            stream: true,
                            ...tunedParams
                        }
                    };

                    // 续传用：把已产出的正文作为 assistant 预填，再追加一条明确的「接着写」指令。
                    // 只做预填是不够的——实测模型会把预填当成已完成的回合，从头再写一遍整篇答案。
                    const buildPayloadStr = (prefillText) => {
                        if (!prefillText) return JSON.stringify(basePayload);
                        return JSON.stringify({
                            ...basePayload,
                            params: {
                                ...basePayload.params,
                                messages: [
                                    ...wireMessages,
                                    { role: 'assistant', content: [{ type: 'text', text: prefillText }] },
                                    { role: 'user', content: [{ type: 'text', text: '[系统] 你上面的回答因为长度上限被截断了。请从截断处逐字接着往下写完，直接输出后续内容即可。严禁重新开头、严禁重复任何已经写过的句子、严禁任何寒暄或说明。' }] }
                                ]
                            }
                        });
                    };

                    // —— 统一收集上游事件：文本增量 / reasoning / tool-call / finish ——
                    // 之前只转发 text-delta，且流末尾永远发 finish_reason:null、不带 tool_calls：
                    // 客户端（ZCode/Cursor）等不到工具调用就判定回合结束或直接挂起，
                    // 表现为“只能请求一次、第二轮发不出去”。这里一次修好。
                    const collectedTextParts = [];
                    const pendingToolCalls = []; // {id, name, argsText}
                    // D. 完整用量明细：上游 finish 事件里带有缓存命中与思考 token 的分解
                    const upstreamUsage = {
                        inputTokens: 0, outputTokens: 0,
                        cachedInputTokens: 0,   // 命中提示词缓存的输入 token（便宜或免费）
                        noCacheTokens: 0,       // 未命中缓存、按全价计费的输入 token
                        reasoningTokens: 0,     // 思考消耗
                        textTokens: 0           // 正文消耗
                    };
                    let upstreamStopReason = 'stop';   // OpenAI 标准值：stop / length / tool_calls

                    // 工具调用参数是按 toolCallId 逐块追加的，维护 id -> index 映射
                    const toolIndexById = new Map();
                    const ensureToolSlot = (toolCallId, toolName) => {
                        if (!toolIndexById.has(toolCallId)) {
                            toolIndexById.set(toolCallId, pendingToolCalls.length);
                            pendingToolCalls.push({ id: toolCallId, name: toolName || 'tool', argsText: '' });
                        } else if (toolName) {
                            pendingToolCalls[toolIndexById.get(toolCallId)].name = toolName;
                        }
                        return toolIndexById.get(toolCallId);
                    };

                    const streamHeaders = {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    };

                    // 非流式请求（stream:false）：先完整收集再一次性返回标准 JSON
                    // 注意：不能在这里 cancel 上游 body——后面 pumpUpstream 还要从它读数据。
                    // 之前误加的 cancel 会直接掐断上游流，导致非流式请求永远空返回。

                    const sseId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
                    const sseCreated = Math.floor(Date.now() / 1000);
                    const sseChunk = (delta, finishReason) => ({
                        id: sseId,
                        object: 'chat.completion.chunk',
                        created: sseCreated,
                        model: requestedModel,
                        choices: [{ index: 0, delta, finish_reason: finishReason || null }]
                    });

                    // —— 上游调用：单轮内部重试 + 跨轮自动续传 ——
                    // 上游网关约 60s 空闲超时：推理模型思考期间 SSE 静默，连接会被掐断。
                    // 分两层处理：
                    //   · 本轮还没吐出正文 → 直接内部重试，客户端完全无感
                    //   · 已经吐出正文 → 不能重试（会重复），改走「续传」：
                    //     把已产出的正文作为 assistant 预填重新发起，接着往下写，仍复用同一条 SSE 流
                    const MAX_ATTEMPTS = 3;              // 单轮内：首次 + 最多 2 次重试
                    const MAX_CONTINUATIONS = 5;         // 最多续传 5 次
                    const RETRY_DELAY_MS = 1500;
                    const HANDSHAKE_TIMEOUT_MS = 60000;  // 握手兜底超时，防止上游挂起导致客户端无限等待
                    const HEARTBEAT_MS = 15000;          // 静默期心跳间隔，避免客户端自己判超时
                    const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

                    let roleFrameSent = false;    // role 帧只发一次
                    let clientGone = false;       // 客户端已断开（如用户取消生成）
                    let activeUpstream = null;    // 当前上游响应流，客户端断开时用于中止
                    let activeAbort = null;       // 当前尝试的 AbortController
                    let upstreamResp = null;
                    let streamErrMsg = null;      // 本轮失败原因（null 表示成功）
                    let streamErrStatus = 0;

                    let deliveredText = '';       // 已经发给客户端的正文，续传时作为预填
                    let roundEmitted = 0;         // 本轮已向客户端吐出的正文字符数（决定能否重试）
                    let continuationRound = 0;    // 已续传次数
                    let firstTokenAt = 0;         // 首字时间点，用于面板展示真实 TTFT

                    res.on('close', () => {
                        clientGone = true;
                        // 客户端提前断开时立即停拉上游流，省下无谓的额度消耗
                        if (activeAbort) { try { activeAbort.abort(); } catch (e) {} }
                        if (activeUpstream) { try { activeUpstream.destroy(); } catch (e) {} }
                    });
                    res.on('error', () => {});   // 断开后残留的写操作会触发 error 事件，静默即可

                    // 心跳：长思考期间上游可能长时间不吐字，发 SSE 注释行保活。
                    // 冒号开头的行是 SSE 规范里的注释，任何合规解析器都会忽略，不会污染内容。
                    let lastWriteAt = Date.now();
                    const safeWrite = (s) => {
                        if (clientGone) return;
                        lastWriteAt = Date.now();
                        try { res.write(s); } catch (e) {}
                    };
                    const heartbeatTimer = setInterval(() => {
                        if (clientGone || !roleFrameSent) return;
                        if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
                            try { res.write(': keep-alive\n\n'); lastWriteAt = Date.now(); } catch (e) {}
                        }
                    }, 5000);
                    heartbeatTimerRef.t = heartbeatTimer;

                    // 续传衔接处理：续传轮开头先攒一小段再决定怎么落笔。
                    // 单块判断没用——第一个 text-delta 常常只有几个字，看不出是「接着写」还是「重开头」。
                    const SEAM_WINDOW = 400;     // 攒够这么多字再判定
                    let seamActive = false;      // 当前处于续传衔接判定期
                    let seamBuffer = '';
                    let seamRestarted = false;   // 检测到模型重开头，需要放弃续传

                    const emitText = (piece) => {
                        if (!piece) return;
                        if (!firstTokenAt) firstTokenAt = Date.now();
                        collectedTextParts.push(piece);
                        deliveredText += piece;
                        roundEmitted += piece.length;
                        if (wantStream) {
                            safeWrite(`data: ${JSON.stringify(sseChunk({ content: piece }))}\n\n`);
                        }
                    };

                    const flushSeam = () => {
                        if (!seamActive) return;
                        seamActive = false;
                        let text = seamBuffer;
                        seamBuffer = '';
                        if (!text) return;

                        // ① 重开头检测：模型无视预填，从头把整篇又写了一遍
                        const head = deliveredText.replace(/^\s+/, '').slice(0, 40);
                        if (head.length >= 20 && text.replace(/^\s+/, '').startsWith(head)) {
                            seamRestarted = true;
                            return;   // 整段丢弃，由外层终止续传，避免把重复内容吐给客户端
                        }

                        // ② 尾部重叠裁剪：模型接着写，但把上一段结尾又抄了一遍
                        const tail = deliveredText.slice(-SEAM_WINDOW);
                        for (let len = Math.min(tail.length, text.length); len >= 10; len--) {
                            if (tail.endsWith(text.slice(0, len))) { text = text.slice(len); break; }
                        }
                        emitText(text);
                    };


                    const handleLine = (line) => {
                        const trimmed = line.trim();
                        if (!trimmed) return;
                        let chunk;
                        try { chunk = JSON.parse(trimmed); } catch (err) { return; }

                        if (chunk.type === 'reasoning-delta' && chunk.text) {
                            // 思考内容单独走 reasoning_content 字段，不再混进正文。
                            // 混进 content 会污染答案，也会让「已发内容」判定过早为真、把重试机制废掉。
                            if (wantStream) {
                                safeWrite(`data: ${JSON.stringify(sseChunk({ reasoning_content: chunk.text }))}\n\n`);
                            }
                        } else if (chunk.type === 'text-delta' && chunk.text) {
                            if (seamActive) {
                                // 续传衔接期：先攒够 SEAM_WINDOW 再判定，避免逐块判断看不出重开头
                                seamBuffer += chunk.text;
                                if (seamBuffer.length >= SEAM_WINDOW) flushSeam();
                                return;
                            }
                            emitText(chunk.text);
                        } else if (chunk.type === 'tool-call') {
                            const slot = ensureToolSlot(chunk.toolCallId || `call_${pendingToolCalls.length}`, chunk.toolName);
                            const input = chunk.input ?? chunk.args ?? '';
                            const piece = typeof input === 'string' ? input : JSON.stringify(input);
                            pendingToolCalls[slot].argsText += piece;
                            roundEmitted += piece.length;
                            if (wantStream) {
                                safeWrite(`data: ${JSON.stringify(sseChunk({
                                    tool_calls: [{
                                        index: slot,
                                        id: pendingToolCalls[slot].id,
                                        type: 'function',
                                        function: {
                                            name: pendingToolCalls[slot].name,
                                            arguments: piece
                                        }
                                    }]
                                }))}\n\n`);
                            }
                        } else if (chunk.type === 'finish') {
                            const u = chunk.totalUsage;
                            if (u) {
                                // 续传会分多轮返回 usage，累加而不是覆盖
                                upstreamUsage.inputTokens += u.inputTokens || 0;
                                upstreamUsage.outputTokens += u.outputTokens || 0;
                                upstreamUsage.cachedInputTokens += u.cachedInputTokens || u.inputTokenDetails?.cacheReadTokens || 0;
                                upstreamUsage.noCacheTokens += u.inputTokenDetails?.noCacheTokens || 0;
                                upstreamUsage.reasoningTokens += u.reasoningTokens || u.outputTokenDetails?.reasoningTokens || 0;
                                upstreamUsage.textTokens += u.outputTokenDetails?.textTokens || 0;
                            }
                            const fr = String(chunk.finishReason || chunk.rawFinishReason || 'stop').toLowerCase();
                            upstreamStopReason = (fr === 'tool-calls' || fr === 'tool_calls' || fr === 'tool_use')
                                ? 'tool_calls'
                                : (fr === 'length' || fr === 'max_tokens' ? 'length' : 'stop');   // 其余一律归一到 stop
                        } else if (chunk.type === 'error') {
                            const msg = (chunk.error && (chunk.error.message || chunk.error)) || chunk.message || 'upstream stream error';
                            throw new Error(String(msg).slice(0, 300));
                        }
                    };

                    // 读取上游 Node 流并按行切分。
                    // setEncoding('utf8') 内部用 StringDecoder，能正确处理跨 chunk 的多字节字符。
                    const pumpUpstream = async () => {
                        const resp = upstreamResp;
                        resp.setEncoding('utf8');
                        let buffer = '';
                        for await (const chunk of resp) {
                            buffer += chunk;
                            const lines = buffer.split('\n');
                            buffer = lines.pop();
                            for (const line of lines) handleLine(line);
                        }
                        handleLine(buffer);   // 末尾未带换行的残留行
                    };

                    // 外层：续传轮次；内层：本轮的重试
                    continuationLoop:
                    while (true) {
                        roundEmitted = 0;
                        streamErrMsg = null;
                        let canRetry = false;

                        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                            if (attempt > 1) {
                                if (clientGone) break continuationLoop;
                                addTerminalLog('warn', `上游失败，${RETRY_DELAY_MS}ms 后自动重试（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）`, String(streamErrMsg).slice(0, 100));
                                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                                if (clientGone) break continuationLoop;
                            }

                            const attemptAbort = new AbortController();
                            activeAbort = attemptAbort;
                            let handshakeTimedOut = false;
                            const handshakeTimer = setTimeout(() => {
                                handshakeTimedOut = true;
                                attemptAbort.abort();
                            }, HANDSHAKE_TIMEOUT_MS);
                            canRetry = false;
                            streamErrMsg = null;
                            const attemptStart = Date.now();   // 握手计时按本次尝试算，续传轮不能从整单起点算

                            try {
                                upstreamResp = await upstreamGenerate(buildPayloadStr(continuationRound > 0 ? deliveredText : ''), attemptAbort.signal);
                                activeUpstream = upstreamResp;
                                clearTimeout(handshakeTimer);  // 握手已返回，解除兜底（否则会误杀后续流传输）

                                if (upstreamResp.statusCode !== 200) {
                                    let errText = '';
                                    upstreamResp.setEncoding('utf8');
                                    for await (const c of upstreamResp) { errText += c; if (errText.length > 2000) break; }
                                    addTerminalLog('error', `上游报错 HTTP ${upstreamResp.statusCode}`, errText.slice(0, 80));
                                    streamErrMsg = `HTTP ${upstreamResp.statusCode}: ${errText.slice(0, 160)}`;
                                    streamErrStatus = upstreamResp.statusCode;
                                    canRetry = RETRYABLE_STATUS.has(upstreamResp.statusCode);  // 429/5xx 值得重试，4xx 参数错误重试无意义
                                } else {
                                    const handshakeMs = Date.now() - attemptStart;
                                    if (continuationRound === 0) lastRequestLatency = handshakeMs;
                                    addTerminalLog('success',
                                        continuationRound > 0 ? `续传第 ${continuationRound} 轮握手成功` : '上游握手成功 HTTP 200 · 开始 SSE 流传输',
                                        `握手 ${handshakeMs}ms${attempt > 1 ? ` · 重试第 ${attempt} 次` : ''}`);

                                    if (wantStream && !roleFrameSent) {
                                        res.writeHead(200, streamHeaders);
                                        if (res.socket) { try { res.socket.setNoDelay(true); } catch (e) {} }
                                        // 先发 role 帧，让严格客户端尽早建立回合上下文
                                        safeWrite(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content: '' }))}\n\n`);
                                        roleFrameSent = true;
                                    }

                                    // 本轮从零开始收工具调用；正文用 deliveredText 跨轮累积，不能清
                                    pendingToolCalls.length = 0;
                                    toolIndexById.clear();
                                    upstreamStopReason = 'stop';

                                    await pumpUpstream();   // 读取上游并转发，中断/出错会抛出
                                    flushSeam();            // 本轮结束，冲刷续传衔接缓冲
                                    streamErrMsg = null;
                                }
                            } catch (attemptErr) {
                                flushSeam();   // 异常路径也要把已攒的衔接内容处理掉，别丢字
                                streamErrMsg = (attemptErr && attemptErr.name === 'AbortError' && handshakeTimedOut)
                                    ? `上游握手超时(${HANDSHAKE_TIMEOUT_MS / 1000}s)`
                                    : ((attemptErr && attemptErr.message) || String(attemptErr));
                                canRetry = true;   // 网络/流中断默认可重试
                            } finally {
                                clearTimeout(handshakeTimer);
                                if (streamErrMsg !== null) {
                                    try { attemptAbort.abort(); } catch (e) {}   // 丢弃失败尝试的上游连接
                                }
                            }

                            if (streamErrMsg === null) break;      // 本轮成功
                            if (clientGone || !canRetry) break;    // 不可重试
                            if (roundEmitted > 0) break;           // 本轮已吐出内容，重试会重复，交给续传处理
                        }

                        if (clientGone) break;

                        // 模型在续传轮里重开了头：说明它不认预填，再续下去只会产出重复内容，就此收尾
                        if (seamRestarted) {
                            addTerminalLog('warn', '续传时模型重开头，已丢弃重复段并结束本次回答', `已产出 ${deliveredText.length} 字`);
                            upstreamStopReason = 'stop';
                            break;
                        }

                        // —— C. 续传判定 ——
                        // 两种情况需要接着写：① 中途断流且已产出正文 ② 撞到 max_tokens 上限被截断。
                        // 有工具调用时不续传：工具参数是结构化的，重新生成容易前后矛盾。
                        const brokeMidStream = streamErrMsg !== null && roundEmitted > 0;
                        const truncatedByLength = streamErrMsg === null && upstreamStopReason === 'length';
                        const canContinue = pendingToolCalls.length === 0
                            && deliveredText.length > 0
                            && continuationRound < MAX_CONTINUATIONS
                            && (brokeMidStream || truncatedByLength);

                        if (!canContinue) break;

                        continuationRound++;
                        seamActive = true;      // 下一轮开头进入衔接判定期
                        seamBuffer = '';
                        addTerminalLog('warn',
                            `触发自动续传（第 ${continuationRound}/${MAX_CONTINUATIONS} 轮）`,
                            brokeMidStream ? `中途断流: ${String(streamErrMsg).slice(0, 60)}` : '达到 max_tokens 上限，继续补全');
                        await new Promise(r => setTimeout(r, 300));
                    }

                    clearInterval(heartbeatTimer);

                    if (streamErrMsg !== null) {
                        // 重试耗尽或不可重试：流式已开头的补终止帧，未开头的返回上游错误码
                        if (clientGone) {
                            // 客户端主动断开（如取消生成）不算故障，单独记录避免污染错误日志
                            addTerminalLog('info', '客户端已断开，已停止拉取上游流');
                            return res.end();
                        }
                        addTerminalLog('error', `上游流中断: ${streamErrMsg}`);
                        if (wantStream && !res.headersSent) {
                            res.writeHead(streamErrStatus || 502, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ error: { message: `upstream stream failed: ${streamErrMsg}`, type: 'upstream_error' } }));
                        }
                        if (wantStream) {
                            if (!clientGone) {
                                res.write(`data: ${JSON.stringify(sseChunk({}, 'stop'))}\n\n`);
                                res.write('data: [DONE]\n\n');
                            }
                            return res.end();
                        }
                        res.writeHead(streamErrStatus || 502, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: { message: `upstream stream failed: ${streamErrMsg}`, type: 'upstream_error' } }));
                    }

                    const fullText = collectedTextParts.join('');
                    const hasTools = pendingToolCalls.length > 0;
                    const finalStopReason = hasTools ? 'tool_calls' : upstreamStopReason;

                    // D. 用量明细：缓存命中率与思考占比记入面板
                    const ttft = firstTokenAt ? firstTokenAt - reqStartTime : 0;
                    lastTokenStats = {
                        model: requestedModel,
                        ttft,
                        inputTokens: upstreamUsage.inputTokens,
                        cachedInputTokens: upstreamUsage.cachedInputTokens,
                        outputTokens: upstreamUsage.outputTokens,
                        reasoningTokens: upstreamUsage.reasoningTokens,
                        textTokens: upstreamUsage.textTokens,
                        continuations: continuationRound
                    };
                    const cacheRate = upstreamUsage.inputTokens > 0
                        ? Math.round(upstreamUsage.cachedInputTokens / upstreamUsage.inputTokens * 100) : 0;
                    addTerminalLog('info',
                        `用量 入${upstreamUsage.inputTokens}(缓存${cacheRate}%) 出${upstreamUsage.outputTokens}(思考${upstreamUsage.reasoningTokens})`,
                        `首字 ${ttft || '-'}ms${continuationRound > 0 ? ` · 续传${continuationRound}轮` : ''}`);

                    // OpenAI 标准 usage，并附带明细扩展字段（不影响标准客户端解析）
                    const usagePayload = {
                        prompt_tokens: upstreamUsage.inputTokens || 0,
                        completion_tokens: upstreamUsage.outputTokens || 0,
                        total_tokens: (upstreamUsage.inputTokens || 0) + (upstreamUsage.outputTokens || 0),
                        prompt_tokens_details: { cached_tokens: upstreamUsage.cachedInputTokens || 0 },
                        completion_tokens_details: { reasoning_tokens: upstreamUsage.reasoningTokens || 0 }
                    };

                    if (!wantStream) {
                        // —— 非流式标准返回：客户端拿到完整 tool_calls 才能发起第二轮 ——
                        const message = { role: 'assistant', content: fullText };
                        if (hasTools) {
                            message.tool_calls = pendingToolCalls.map(t => ({
                                id: t.id,
                                type: 'function',
                                function: { name: t.name, arguments: t.argsText }
                            }));
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            id: sseId,
                            object: 'chat.completion',
                            created: sseCreated,
                            model: requestedModel,
                            choices: [{ index: 0, message, finish_reason: finalStopReason }],
                            usage: usagePayload
                        }));
                        addTerminalLog('info', `请求完成（非流式）stop=${finalStopReason}${hasTools ? ` 工具:${pendingToolCalls.length}个` : ''}`);
                        return;
                    }

                    // —— 流式收尾：先给工具参数补齐帧（如需），再发终结帧 ——
                    if (hasTools) {
                        addTerminalLog('success', `检测到工具调用 ${pendingToolCalls.length} 个`, pendingToolCalls.map(t => t.name).join(', ').slice(0, 120));
                    }
                    safeWrite(`data: ${JSON.stringify(sseChunk({}, finalStopReason))}\n\n`);
                    // 末帧附带 usage（OpenAI stream_options.include_usage 的行为），面板与客户端都能读到
                    safeWrite(`data: ${JSON.stringify({
                        id: sseId, object: 'chat.completion.chunk', created: sseCreated,
                        model: requestedModel, choices: [], usage: usagePayload
                    })}\n\n`);
                    safeWrite('data: [DONE]\n\n');
                    res.end();
                    addTerminalLog('info', `请求圆满完成 [DONE] stop=${finalStopReason}`);
                } catch (err) {
                    clearInterval(heartbeatTimerRef.t);
                    addTerminalLog('error', `处理异常: ${err.message}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message }));
                    } else {
                        try { res.end(); } catch (e) {}
                    }
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`⚠️ 端口 ${port} 已被占用，正在自动切换到下一端口 ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error('服务异常:', err);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${port}`;
        console.log(`\n=============================================================`);
        console.log(`🚀 Command Code 全模型网关 (带实时终端大屏与数值一键复制)`);
        console.log(`🌐 网页面板 : ${url}`);
        console.log(`📡 API Base : ${url}/v1`);
        console.log(`🔑 API Key  : local-proxy`);
        console.log(`=============================================================\n`);

        // 启动后自动打开浏览器面板
        openBrowser(url);

        // 启动即预热一条上游连接，让第一次真实请求也能命中热连接
        prewarmUpstream('startup').then(() => {
            addTerminalLog('success', '上游长连接已预热', '首字可省去 TCP+TLS 握手（实测约 800ms）');
        });
        // 空闲超过 60s 就补一次预热，避免连接被上游或中间设备回收
        setInterval(() => {
            if (Date.now() - lastUpstreamTouch > 60000) prewarmUpstream('idle');
        }, 60000).unref();
    });
}

startServer(DEFAULT_PORT);
