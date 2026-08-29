const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const storage = new Map();
const document = {
    visibilityState: "visible",
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    addEventListener() {},
    createElement() { return { appendChild() {}, remove() {} }; },
};
const window = {
    document,
    GRE_SYNC_CONFIG: {},
    localStorage: {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); },
    },
    addEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: { randomUUID() { return "00000000-0000-4000-8000-000000000000"; } },
};
const context = vm.createContext({
    window,
    document,
    console,
    Date,
    Math,
    JSON,
    CustomEvent: class CustomEvent {},
    FormData: class FormData {},
    navigator: { userAgent: "test" },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
});

let source = fs.readFileSync(path.join(root, "cloud-sync.js"), "utf8");
const tail = /\s*initialize\(\);\s*\}\)\(window, document\);\s*$/;
assert.match(source, tail, "同步脚本入口结构发生变化，测试挂钩无法注入");
source = source.replace(
    tail,
    `
    window.__CLOUD_SYNC_TEST__ = {
        activityTime,
        mergeWordProgress,
        mergeProgress,
        mergeStates,
        mergeSprint,
        stateContent,
    };
})(window, document);
`
);
vm.runInContext(source, context);

const api = window.__CLOUD_SYNC_TEST__;

const oldLocal = {
    version: 2,
    updatedAt: "2026-08-28T08:00:00.000Z",
    settings: { dailyNew: 20 },
    plans: { gre3000: { wordsPerDay: 20 } },
    notes: { local: "保留本机笔记" },
    progress: {
        gre3000: {
            localOnly: {
                lastReviewed: "2026-08-28T08:00:00.000Z",
                correctCount: 1,
            },
            shared: {
                lastReviewed: "2026-08-28T08:00:00.000Z",
                correctCount: 2,
                sprint: {
                    red: false,
                    lastRecognitionAt: "2026-08-28T08:00:00.000Z",
                },
            },
        },
    },
    sprint: {
        enabled: true,
        dailyTarget: 300,
        dailyStats: {
            "2026-08-29": { fastAttempts: 5, fastCorrect: 3, reviews: 1 },
        },
    },
};

const newerRemote = {
    version: 3,
    updatedAt: "2026-08-29T08:00:00.000Z",
    settings: { dailyNew: 18 },
    plans: { gre3000: { wordsPerDay: 300 } },
    notes: { remote: "保留云端笔记" },
    progress: {
        gre3000: {
            remoteOnly: {
                lastReviewed: "2026-08-29T07:00:00.000Z",
                correctCount: 1,
            },
            shared: {
                lastReviewed: "2026-08-28T08:00:00.000Z",
                correctCount: 3,
                sprint: {
                    red: true,
                    fuzzyStreak: 2,
                    lastRecognitionAt: "2026-08-29T07:30:00.000Z",
                },
            },
        },
    },
    sprint: {
        enabled: true,
        dailyTarget: 300,
        dailyStats: {
            "2026-08-29": { fastAttempts: 8, fastCorrect: 4, reviews: 2 },
        },
    },
};

const merged = api.mergeStates(
    oldLocal,
    newerRemote,
    "2026-08-29T08:00:01.000Z"
);

assert.equal(merged.settings.dailyNew, 18, "较新的云端设置应进入当前设备");
assert.equal(merged.plans.gre3000.wordsPerDay, 300);
assert.equal(merged.notes.local, "保留本机笔记");
assert.equal(merged.notes.remote, "保留云端笔记");
assert.ok(merged.progress.gre3000.localOnly, "本机独有进度不能丢失");
assert.ok(merged.progress.gre3000.remoteOnly, "云端独有进度必须拉取");
assert.equal(
    merged.progress.gre3000.shared.sprint.red,
    true,
    "较新的冲刺识别结果必须覆盖旧设备的红词状态"
);
assert.equal(merged.progress.gre3000.shared.correctCount, 3);
assert.equal(merged.sprint.dailyStats["2026-08-29"].fastAttempts, 8);
assert.equal(merged.sprint.dailyStats["2026-08-29"].reviews, 2);

const identicalLocal = {
    version: 3,
    route: "dashboard",
    updatedAt: "2026-08-29T10:00:00.000Z",
    progress: { gre3000: { word1: { correctCount: 2 } } },
};
const identicalRemote = JSON.parse(JSON.stringify(identicalLocal));
const normalizedIdentical = api.mergeStates(
    identicalLocal,
    identicalRemote,
    "2026-08-29T10:00:00.000Z"
);
const mergedWithNewerRowTime = api.mergeStates(
    normalizedIdentical,
    normalizedIdentical,
    "2026-08-29T10:05:00.000Z"
);
assert.equal(
    mergedWithNewerRowTime.updatedAt,
    normalizedIdentical.updatedAt,
    "数据库行更新时间不能写回学习状态，否则会形成同步刷新循环"
);
assert.equal(
    JSON.stringify(mergedWithNewerRowTime),
    JSON.stringify(normalizedIdentical),
    "相同学习状态不应仅因数据库更新时间变化而再次上传"
);

const timestampOnlyChange = {
    ...identicalLocal,
    updatedAt: "2026-08-29T10:06:00.000Z",
};
assert.equal(
    api.stateContent(timestampOnlyChange),
    api.stateContent(identicalLocal),
    "仅同步元数据变化时不应刷新页面"
);
const realProgressChange = {
    ...identicalLocal,
    progress: { gre3000: { word1: { correctCount: 3 } } },
};
assert.notEqual(
    api.stateContent(realProgressChange),
    api.stateContent(identicalLocal),
    "真实学习进度变化必须触发界面更新"
);

const sprintOnlyLocal = {
    lastReviewed: "2026-08-20T00:00:00.000Z",
    sprint: {
        red: true,
        lastRecognitionAt: "2026-08-29T09:00:00.000Z",
    },
};
const staleRemote = {
    lastReviewed: "2026-08-20T00:00:00.000Z",
    sprint: {
        red: false,
        lastRecognitionAt: "2026-08-28T09:00:00.000Z",
    },
};
assert.equal(
    api.mergeWordProgress(sprintOnlyLocal, staleRemote).sprint.red,
    true,
    "冲刺识别时间必须参与单词级新旧判断"
);

console.log("Cloud sync smoke checks passed: lossless merge, sprint timestamps, and no timestamp refresh loop.");
