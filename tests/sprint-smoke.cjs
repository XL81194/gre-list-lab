const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const storage = new Map();
const oldProgress = {
    easeFactor: 2.4,
    repetitions: 3,
    interval: 7,
    lastReviewed: "2026-08-20T08:00:00.000Z",
    nextReview: "2026-08-27T08:00:00.000Z",
};

storage.set(
    "gre-list-lab-state-v1",
    JSON.stringify({
        version: 2,
        selectedBookId: "gre3000",
        settings: { dailyNew: 20 },
        progress: { gre3000: { "gre3000-list-1-1": oldProgress } },
        notes: { "gre3000-list-1-1": "旧笔记" },
        calendarChecks: { legacy: true },
        plans: {},
    })
);

const classList = { add() {}, remove() {}, toggle() {} };
const document = {
    body: { classList },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
        return {
            className: "",
            textContent: "",
            appendChild() {},
            remove() {},
            click() {},
        };
    },
};

const window = {
    document,
    localStorage: {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); },
    },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    scrollTo() {},
    location: { href: "https://example.test/" },
};

const context = vm.createContext({
    window,
    document,
    console,
    Date,
    Math,
    JSON,
    Intl,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    Blob: class Blob {},
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    FileReader: class FileReader {},
    FormData: class FormData {},
    navigator: {},
    setTimeout,
    clearTimeout,
});

vm.runInContext(fs.readFileSync(path.join(root, "books.js"), "utf8"), context);

let source = fs.readFileSync(path.join(root, "gre-vocab-app.js"), "utf8");
const tail = /\s*migrateEquivalentProgress\(\);\s*render\(\);\s*\}\)\(window, document\);\s*$/;
assert.match(source, tail, "应用入口结构发生变化，测试挂钩无法注入");
source = source.replace(
    tail,
    `
    window.__SPRINT_TEST__ = {
        getState: () => state,
        setState: (value) => { state = value; },
        getSession: () => session,
        setSession: (value) => { session = value; },
        defaultState,
        loadState,
        getProgress,
        setProgress,
        sprintWordState,
        sprintRedWords,
        sprintFullStudyDays,
        buildPlan,
        rateMeaning,
        verifySprintChoice,
        meaningResultFor,
        coreChineseMeaning,
        semanticDirection,
        importantEquivalents,
        voluntaryReviewCursorKey,
        voluntaryReviewStartIndex,
        advanceVoluntaryReviewCursor,
        voluntaryReviewWords,
        allWords,
        getBook: (bookId) => BOOKS.find((book) => book.id === bookId),
        constants: { STORAGE_KEY, SPRINT_RECALL_LIMIT_MS, SPRINT_REVIEW_OFFSETS },
    };
})(window, document);
`
);
vm.runInContext(source, context);

const api = window.__SPRINT_TEST__;
const loaded = api.getState();
assert.equal(api.constants.STORAGE_KEY, "gre-list-lab-state-v1");
assert.equal(loaded.sprint.enabled, false);
assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.voluntaryReviewCursors)),
    {},
    "旧进度升级后应安全补充空的续刷位置"
);
assert.equal(loaded.notes["gre3000-list-1-1"], "旧笔记");
assert.ok(Number.isInteger(api.sprintFullStudyDays()) && api.sprintFullStudyDays() >= 0);
assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.progress.gre3000["gre3000-list-1-1"])),
    oldProgress,
    "旧学习进度必须原样保留"
);

const book = api.getBook("gre3000");
const word = api.allWords(book)[1];
loaded.sprint.enabled = true;
loaded.sprint.dailyStats = {};

function makeSession(shownAt) {
    return {
        bookId: book.id,
        title: "冲刺测试",
        studyMode: "meaning",
        sessionMode: "new",
        isSprint: true,
        isVoluntaryReview: false,
        activeQueue: [],
        current: { wordId: word.id, step: "recognition", shownAt },
        stage: "meaning-round-1",
        roundResults: {},
        answeredCount: 0,
        scheduledCount: 1,
        completedWordIds: [],
        reviewedWordIds: [],
        completed: 0,
        correct: 0,
        near: 0,
        wrong: 0,
        typed: "",
        attempts: 0,
    };
}

api.setSession(makeSession(Date.now() - 3000));
api.rateMeaning("easy");
let result = api.meaningResultFor(word.id);
assert.equal(result.round1, "good", "超过2.5秒点击认识必须自动降为模糊");
assert.equal(api.sprintWordState(api.getProgress(book.id, word.id)).fuzzyStreak, 1);

const session = api.getSession();
session.stage = "meaning-round-1";
session.current = { wordId: word.id, step: "recognition", shownAt: Date.now() - 500 };
api.rateMeaning("good");
assert.equal(
    api.sprintWordState(api.getProgress(book.id, word.id)).red,
    true,
    "连续两次模糊必须进入红词池"
);

const redProgress = api.getProgress(book.id, word.id);
api.setProgress(book.id, word.id, {
    ...redProgress,
    sprint: {
        ...api.sprintWordState(redProgress),
        red: true,
        fastCorrectStreak: 0,
    },
});

for (let attempt = 1; attempt <= 2; attempt += 1) {
    const verification = api.meaningResultFor(word.id);
    verification.recognitionDetails.push({
        quality: "easy",
        responseMs: 600,
        fastCandidate: true,
        verificationConsumed: false,
    });
    api.verifySprintChoice(book, word, true, verification);
    const current = api.sprintWordState(api.getProgress(book.id, word.id));
    assert.equal(current.fastCorrectStreak, attempt);
    assert.equal(current.red, attempt < 2, "红词必须在第二次快速正确验证后才退出");
}

assert.equal(api.sprintRedWords(book).some((item) => item.id === word.id), false);
assert.ok(api.coreChineseMeaning(word).length > 0);
assert.ok(["positive", "negative", "neutral"].includes(api.semanticDirection(word).className));

loaded.plans[book.id] = {
    startDate: "2026-08-29",
    mode: "words",
    listsPerDay: 2,
    wordsPerDay: 1,
};
const tasks = api.buildPlan(book);
const firstLearn = tasks.find((task) => task.type === "learn");
assert.ok(firstLearn, "冲刺计划应生成学习任务");
const offsets = tasks
    .filter(
        (task) =>
            task.type === "review" &&
            task.wordIds.length === firstLearn.wordIds.length &&
            task.wordIds.every((id, index) => id === firstLearn.wordIds[index])
    )
    .map((task) => task.offset)
    .sort((a, b) => a - b);
assert.deepEqual(
    JSON.parse(JSON.stringify(offsets)),
    [0, 1, 2, 4, 7],
    "冲刺计划复习间隔必须是0、1、2、4、7天"
);

const reviewWords = api.allWords(book).slice(0, 45);
loaded.progress[book.id] = loaded.progress[book.id] || {};
reviewWords.forEach((reviewWord) => {
    loaded.progress[book.id][reviewWord.id] = {
        ...loaded.progress[book.id][reviewWord.id],
        lastReviewed: "2026-10-24T08:00:00.000Z",
    };
});
const cursorKey = api.voluntaryReviewCursorKey(book.id, [book.groups[0].id]);
const orderedIds = reviewWords.map((reviewWord) => reviewWord.id);
const firstBatch = api.voluntaryReviewWords(book, reviewWords, "sequential", cursorKey).slice(0, 20);
assert.deepEqual(
    firstBatch.map((reviewWord) => reviewWord.id),
    orderedIds.slice(0, 20),
    "第一次顺序复习应从 List 开头取20词"
);
firstBatch.forEach((reviewWord) => {
    api.advanceVoluntaryReviewCursor(cursorKey, reviewWord.id, orderedIds);
});
const secondBatch = api.voluntaryReviewWords(book, reviewWords, "sequential", cursorKey).slice(0, 20);
assert.deepEqual(
    secondBatch.map((reviewWord) => reviewWord.id),
    orderedIds.slice(20, 40),
    "完成前20词后再次打开应继续第21至40词"
);
secondBatch.slice(0, 5).forEach((reviewWord) => {
    api.advanceVoluntaryReviewCursor(cursorKey, reviewWord.id, orderedIds);
});
assert.equal(
    api.voluntaryReviewWords(book, reviewWords, "sequential", cursorKey)[0].id,
    orderedIds[25],
    "中途退出后应从最后完成词的下一词继续"
);

delete loaded.voluntaryReviewCursors[cursorKey];
reviewWords.slice(0, 20).forEach((reviewWord) => {
    loaded.progress[book.id][reviewWord.id].voluntaryReviewCount = 2;
});
assert.equal(
    api.voluntaryReviewWords(book, reviewWords, "sequential", cursorKey)[0].id,
    orderedIds[20],
    "升级前已复习过前20词时，应从复习次数更少的第21词开始"
);

console.log("Sprint smoke checks passed: legacy state, sprint rules, and sequential List review cursor.");
