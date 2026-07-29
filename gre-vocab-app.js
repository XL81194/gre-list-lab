(function initGreVocabApp(window, document) {
    "use strict";

    const STORAGE_KEY = "gre-list-lab-state-v1";
    const CUSTOM_BOOKS_KEY = "gre-list-lab-custom-books-v1";
    const BACKUP_VERSION = 1;
    const REVIEW_OFFSETS = [0, 1, 3, 7, 14, 29];
    const MAX_INTRA_CYCLES = 12;
    const BATCH_SIZE = 20;
    const MEANING_FLOW_VERSION = 2;
    const QUALITY_SCORE = { wrong: 0, hard: 3, good: 4, easy: 5 };
    const INITIAL_EF = { easy: 2.8, good: 2.5, hard: 1.8, wrong: 1.3 };
    const INTRA_EF = { easy: 0.15, good: 0.05, hard: -0.1, wrong: -0.2 };
    const DEFAULT_SETTINGS = { dailyNew: 20, reviewLimit: 100, masteryCount: 4 };
    const DEFAULT_PLAN = {
        startDate: "",
        mode: "lists",
        listsPerDay: 2,
        wordsPerDay: 100,
    };

    function loadCustomBooks() {
        try {
            const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_BOOKS_KEY) || "[]");
            return Array.isArray(parsed) ? parsed.filter((book) => book?.id && Array.isArray(book.groups)) : [];
        } catch (error) {
            console.warn("[GRE List Lab] 无法读取自定义词书", error);
            return [];
        }
    }

    const BUILT_IN_BOOKS = Array.isArray(window.GRE_VOCAB_BOOKS)
        ? window.GRE_VOCAB_BOOKS
        : [];
    const BOOKS = [...BUILT_IN_BOOKS, ...loadCustomBooks()];

    const wordIndex = new Map();
    const groupIndex = new Map();
    function indexBook(book) {
        if (!book || !Array.isArray(book.groups)) {
            return;
        }
        book.groups.forEach((group) => {
            groupIndex.set(`${book.id}:${group.id}`, group);
            group.words.forEach((word) => {
                wordIndex.set(word.id, { book, group, word });
            });
        });
    }
    BOOKS.forEach(indexBook);

    const ui = {
        calendarMonth: firstOfMonth(new Date()),
        calendarSelectedDate: localDateKey(new Date()),
        listQuery: "",
    };

    let session = null;
    let planTaskMap = new Map();
    let state = loadState();

    function defaultState() {
        const today = localDateKey(new Date());
        const plans = {};
        BOOKS.forEach((book) => {
            plans[book.id] = { ...DEFAULT_PLAN, startDate: today };
        });
        return {
            version: BACKUP_VERSION,
            selectedBookId: BOOKS[0]?.id || "",
            route: "dashboard",
            settings: { ...DEFAULT_SETTINGS },
            progress: {},
            notes: {},
            calendarChecks: {},
            savedSession: null,
            plans,
        };
    }

    function loadState() {
        const fallback = defaultState();
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return fallback;
            }
            const saved = JSON.parse(raw);
            const selectedBookId = BOOKS.some((book) => book.id === saved.selectedBookId)
                ? saved.selectedBookId
                : fallback.selectedBookId;
            return {
                ...fallback,
                ...saved,
                selectedBookId,
                route: "dashboard",
                settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
                progress: saved.progress && typeof saved.progress === "object" ? saved.progress : {},
                notes: saved.notes && typeof saved.notes === "object" ? saved.notes : {},
                calendarChecks:
                    saved.calendarChecks && typeof saved.calendarChecks === "object"
                        ? saved.calendarChecks
                        : {},
                plans: Object.fromEntries(
                    BOOKS.map((book) => [
                        book.id,
                        {
                            ...fallback.plans[book.id],
                            ...(saved.plans?.[book.id] || {}),
                        },
                    ])
                ),
            };
        } catch (error) {
            console.warn("[GRE List Lab] 无法读取本地进度", error);
            return fallback;
        }
    }

    function saveState() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            console.warn("[GRE List Lab] 无法保存本地进度", error);
            toast("本地进度保存失败，请导出备份。");
        }
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, Number(value) || 0));
    }

    function parseLocalDate(value) {
        const parts = String(value || "").split("-").map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) {
            return new Date();
        }
        return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
    }

    function localDateKey(date) {
        const input = date instanceof Date ? date : new Date(date);
        return [
            input.getFullYear(),
            String(input.getMonth() + 1).padStart(2, "0"),
            String(input.getDate()).padStart(2, "0"),
        ].join("-");
    }

    function addDays(date, amount) {
        const next = new Date(date.getTime());
        next.setDate(next.getDate() + amount);
        return next;
    }

    function firstOfMonth(date) {
        return new Date(date.getFullYear(), date.getMonth(), 1, 12);
    }

    function sameDate(a, b) {
        return localDateKey(a) === localDateKey(b);
    }

    function formatLongDate(value) {
        const date = value instanceof Date ? value : parseLocalDate(value);
        return new Intl.DateTimeFormat("zh-CN", {
            month: "long",
            day: "numeric",
            weekday: "long",
        }).format(date);
    }

    function formatShortDate(value) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) {
            return "待安排";
        }
        return new Intl.DateTimeFormat("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    }

    function currentBook() {
        return BOOKS.find((book) => book.id === state.selectedBookId) || BOOKS[0] || null;
    }

    function savedSessionForBook(book) {
        const saved = state.savedSession;
        if (!book || !saved || saved.bookId !== book.id || !Array.isArray(saved.roundWordIds)) {
            return null;
        }
        return saved.roundWordIds.every((wordId) => wordIndex.has(wordId)) ? saved : null;
    }

    function persistStudySession() {
        if (!session || session.stage === "complete") {
            return;
        }
        state.savedSession = JSON.parse(JSON.stringify(session));
        saveState();
    }

    function clearSavedSession() {
        state.savedSession = null;
        saveState();
    }

    function resumeSavedSession() {
        const saved = savedSessionForBook(currentBook());
        if (!saved) {
            toast("没有可继续的学习记录。");
            return;
        }
        session = JSON.parse(JSON.stringify(saved));
        if (session.studyMode === "meaning" && session.flowVersion !== MEANING_FLOW_VERSION) {
            restartMeaningSessionAsMicroLoop();
            toast("学习流程已升级：本组词将按新的穿插强化方式重新开始。");
        }
        navigate("study");
    }

    function allWords(book) {
        return book ? book.groups.flatMap((group) => group.words) : [];
    }

    function baseProgress() {
        return {
            easeFactor: null,
            interval: 1,
            repetitions: 0,
            intraCycles: 0,
            correctCount: 0,
            lastReviewed: null,
            nextReview: null,
        };
    }

    function getProgress(bookId, wordId) {
        return {
            ...baseProgress(),
            ...(state.progress[bookId]?.[wordId] || {}),
        };
    }

    function setProgress(bookId, wordId, value) {
        if (!state.progress[bookId]) {
            state.progress[bookId] = {};
        }
        state.progress[bookId][wordId] = {
            ...baseProgress(),
            ...value,
        };
        saveState();
    }

    function getBookStats(book) {
        const words = allWords(book);
        const now = Date.now();
        let learned = 0;
        let mastered = 0;
        let due = 0;
        words.forEach((word) => {
            const progress = getProgress(book.id, word.id);
            if (progress.lastReviewed) {
                learned += 1;
            }
            if (progress.correctCount >= state.settings.masteryCount) {
                mastered += 1;
            }
            if (progress.nextReview && new Date(progress.nextReview).getTime() <= now) {
                due += 1;
            }
        });
        return {
            total: words.length,
            learned,
            mastered,
            due,
            newCount: words.length - learned,
            learnedPercent: words.length ? Math.round((learned / words.length) * 100) : 0,
            masteredPercent: words.length ? Math.round((mastered / words.length) * 100) : 0,
        };
    }

    function getGroupStats(book, group) {
        let learned = 0;
        let mastered = 0;
        group.words.forEach((word) => {
            const progress = getProgress(book.id, word.id);
            if (progress.lastReviewed) {
                learned += 1;
            }
            if (progress.correctCount >= state.settings.masteryCount) {
                mastered += 1;
            }
        });
        return {
            total: group.words.length,
            learned,
            mastered,
            percent: group.words.length ? Math.round((learned / group.words.length) * 100) : 0,
        };
    }

    function groupRangeLabel(groups) {
        if (!groups.length) {
            return "暂无 List";
        }
        if (groups.length === 1) {
            return groups[0].label;
        }
        const numericLabels = groups.map((group) => group.label.match(/\d+/)?.[0]);
        if (numericLabels.every(Boolean)) {
            const prefix = groups[0].label.replace(/\s*\d+.*/, "").trim() || "List";
            return `${prefix} ${numericLabels[0]}–${numericLabels[numericLabels.length - 1]}`;
        }
        return groups.map((group) => group.label).join(" + ");
    }

    function buildPlan(book) {
        if (!book) {
            return [];
        }
        const planSettings = {
            ...DEFAULT_PLAN,
            startDate: localDateKey(new Date()),
            ...(state.plans[book.id] || {}),
        };
        const startDate = parseLocalDate(planSettings.startDate);
        const tasks = [];
        const scopes = [];
        if (planSettings.mode === "words") {
            const words = allWords(book);
            const wordsPerDay = clamp(planSettings.wordsPerDay, 1, 1000);
            for (let index = 0; index < words.length; index += wordsPerDay) {
                const wordSlice = words.slice(index, index + wordsPerDay);
                scopes.push({
                    label: `第 ${index + 1}–${index + wordSlice.length} 词`,
                    wordIds: wordSlice.map((word) => word.id),
                    groupIds: [...new Set(wordSlice.map((word) => word.groupId))],
                    scopeKey: `words-${index + 1}-${index + wordSlice.length}`,
                });
            }
        } else {
            const listsPerDay = clamp(planSettings.listsPerDay, 1, 20);
            for (let index = 0; index < book.groups.length; index += listsPerDay) {
                const groupSlice = book.groups.slice(index, index + listsPerDay);
                scopes.push({
                    label: groupRangeLabel(groupSlice),
                    wordIds: groupSlice.flatMap((group) => group.words.map((word) => word.id)),
                    groupIds: groupSlice.map((group) => group.id),
                    scopeKey: `lists-${index + 1}-${index + groupSlice.length}`,
                });
            }
        }
        scopes.forEach((scope, dayIndex) => {
            const learningDate = addDays(startDate, dayIndex);
            tasks.push(
                createPlanTask(book, learningDate, "learn", scope, 0, startDate)
            );
            REVIEW_OFFSETS.forEach((offset) => {
                tasks.push(
                    createPlanTask(
                        book,
                        addDays(learningDate, offset),
                        "review",
                        scope,
                        offset,
                        startDate
                    )
                );
            });
        });
        tasks.sort((a, b) => {
            if (a.date !== b.date) {
                return a.date.localeCompare(b.date);
            }
            return a.type === "learn" ? -1 : 1;
        });
        return tasks;
    }

    function createPlanTask(book, date, type, scope, offset, startDate) {
        const dateKey = localDateKey(date);
        const planStart = localDateKey(startDate);
        const key = [
            book.id,
            planStart,
            dateKey,
            type,
            offset,
            scope.scopeKey,
        ].join("|");
        const learnedCount = scope.wordIds.filter(
            (wordId) => getProgress(book.id, wordId).lastReviewed
        ).length;
        return {
            key,
            bookId: book.id,
            date: dateKey,
            type,
            label: scope.label,
            groupIds: scope.groupIds,
            wordIds: scope.wordIds,
            offset,
            done:
                type === "learn"
                    ? scope.wordIds.length > 0 && learnedCount === scope.wordIds.length
                    : Boolean(state.calendarChecks[key]),
        };
    }

    function tasksForDate(book, dateKey) {
        return buildPlan(book).filter((task) => task.date === dateKey);
    }

    function checkedTaskCount(book) {
        const tasks = buildPlan(book);
        return {
            total: tasks.length,
            checked: tasks.filter((task) => task.done).length,
        };
    }

    function calculateStreak() {
        const completedDates = new Set();
        BOOKS.forEach((book) => {
            buildPlan(book).forEach((task) => {
                if (task.done) {
                    completedDates.add(task.date);
                }
            });
        });
        let cursor = new Date();
        if (!completedDates.has(localDateKey(cursor))) {
            cursor = addDays(cursor, -1);
        }
        let streak = 0;
        while (completedDates.has(localDateKey(cursor))) {
            streak += 1;
            cursor = addDays(cursor, -1);
        }
        return streak;
    }

    function renderBookSelector() {
        const select = document.querySelector('[data-field="book-select"]');
        if (!select) {
            return;
        }
        select.innerHTML = BOOKS.map(
            (book) =>
                `<option value="${escapeHtml(book.id)}"${
                    book.id === state.selectedBookId ? " selected" : ""
                }>${escapeHtml(book.title)}</option>`
        ).join("");
        const book = currentBook();
        const dot = document.querySelector('[data-field="book-dot"]');
        if (dot && book) {
            dot.style.background = book.accent;
            dot.style.boxShadow = `0 0 0 6px ${book.accent}1c`;
        }
    }

    function renderGlobalChrome() {
        renderBookSelector();
        const label = document.querySelector('[data-field="today-label"]');
        if (label) {
            label.textContent = formatLongDate(new Date());
        }
        document.querySelectorAll('[data-field="streak"]').forEach((element) => {
            element.textContent = String(calculateStreak());
        });
        document.querySelectorAll(".nav-item").forEach((button) => {
            button.classList.toggle("is-active", button.dataset.route === state.route);
        });
        document.querySelectorAll(".route").forEach((view) => {
            view.classList.toggle("is-active", view.dataset.view === state.route);
        });
    }

    function render() {
        renderGlobalChrome();
        if (state.route === "dashboard") {
            renderDashboard();
        } else if (state.route === "books") {
            renderBooks();
        } else if (state.route === "lists") {
            renderLists();
        } else if (state.route === "calendar") {
            renderCalendar();
        } else if (state.route === "study") {
            renderStudy();
        }
    }

    function renderDashboard() {
        const target = document.getElementById("dashboard-content");
        const book = currentBook();
        if (!target || !book) {
            return;
        }
        const stats = getBookStats(book);
        const todayKey = localDateKey(new Date());
        const todayTasks = tasksForDate(book, todayKey);
        const planPercent = stats.learnedPercent;
        const nextReviews = buildPlan(book)
            .filter((task) => task.date >= todayKey && !task.done)
            .slice(0, 4);
        const savedSession = savedSessionForBook(book);
        const savedRound = savedSession?.studyMode === "meaning"
            ? "20 词微循环"
            : "拼写检测";
        const todayPlan = todayTasks.length
            ? todayTasks
                  .map(
                      (task) => `
                        <div class="plan-task ${task.done ? "is-done" : ""}">
                            <span class="plan-task-icon">${task.type === "learn" ? "N" : "R"}</span>
                            <span>${task.type === "learn" ? "新学" : "复习"} ${escapeHtml(task.label)}</span>
                        </div>
                    `
                  )
                  .join("")
            : `<div class="plan-task"><span class="plan-task-icon">✓</span><span>今天没有固定 List 任务，可处理到期复习。</span></div>`;

        target.innerHTML = `
            <div class="hero">
                <div class="hero-copy">
                    <span class="eyebrow">TODAY · ${escapeHtml(formatLongDate(new Date()))}</span>
                    <h1>今天，把一组难词<br>变成你的词。</h1>
                    <p>${escapeHtml(book.title)}已按原书顺序分组。学新词与到期复习分开进入；每组最多 20 词，模糊或不认识的词会在组内自动多次复现。</p>
                    <div class="hero-actions">
                        ${
                            savedSession
                                ? `<button class="button button-primary" type="button" data-action="resume-study">继续上次学习 · ${savedRound}</button>`
                                : ""
                        }
                        <button class="button button-primary" type="button" data-action="start-new" data-study-mode="meaning">
                            学习新词 · ${Math.min(state.settings.dailyNew, stats.newCount)}
                        </button>
                        <button class="button button-outline-light" type="button" data-action="start-review" data-study-mode="meaning">
                            到期复习 · ${stats.due}
                        </button>
                        <button class="button button-outline-light" type="button" data-action="start-review" data-study-mode="spelling">拼写检测</button>
                        <button class="button button-outline-light" type="button" data-route="calendar">查看计划日历</button>
                    </div>
                </div>
                <div class="hero-plan">
                    <div class="hero-plan-head">
                        <div>
                            <small>计划完成度 · 已学习单词</small>
                            <strong>${stats.learned} / ${stats.total}</strong>
                        </div>
                        <span class="plan-ring" style="--progress:${planPercent * 3.6}deg" data-label="${planPercent}%"></span>
                    </div>
                    <div class="plan-task-list">${todayPlan}</div>
                </div>
            </div>

            <div class="metric-grid">
                <div class="metric-card"><span>到期复习</span><strong>${stats.due}</strong><small>优先进入今日队列</small></div>
                <div class="metric-card"><span>已学词汇</span><strong>${stats.learned}</strong><small>共 ${stats.total} 词</small></div>
                <div class="metric-card"><span>已经掌握</span><strong>${stats.mastered}</strong><small>标准：正确 ${state.settings.masteryCount} 次</small></div>
                <div class="metric-card"><span>连续打卡</span><strong>${calculateStreak()}</strong><small>每次勾选日历任务都会记录</small></div>
            </div>

            <div class="dashboard-lower">
                <section class="panel">
                    <div class="panel-head">
                    <h2>${BOOKS.length} 本词书，各自进度</h2>
                        <button class="text-button" type="button" data-route="books">管理词书 →</button>
                    </div>
                    ${BOOKS.map((item) => {
                        const itemStats = getBookStats(item);
                        return `
                            <button class="book-progress-row text-button" type="button" data-action="select-book" data-book-id="${escapeHtml(item.id)}">
                                <span class="dot" style="background:${item.accent}"></span>
                                <span>
                                    <strong>${escapeHtml(item.title)}</strong>
                                    <small>${item.groupCount} 组 · ${itemStats.learned}/${itemStats.total} 已学</small>
                                    <span class="progress-track" style="color:${item.accent}"><span style="width:${itemStats.learnedPercent}%"></span></span>
                                </span>
                                <b>${itemStats.learnedPercent}%</b>
                            </button>
                        `;
                    }).join("")}
                </section>

                <section class="panel">
                    <div class="panel-head">
                        <h2>接下来</h2>
                        <button class="text-button" type="button" data-route="calendar">完整日历 →</button>
                    </div>
                    <div class="next-review">
                        ${
                            nextReviews.length
                                ? nextReviews
                                      .map((task) => {
                                          const date = parseLocalDate(task.date);
                                          return `
                                            <div class="review-date-row">
                                                <span class="review-date-badge"><strong>${date.getDate()}</strong><small>${date.getMonth() + 1}月</small></span>
                                                <p>${task.type === "learn" ? "新学" : "复习"} ${escapeHtml(task.label)}<small>${task.offset ? `第 +${task.offset} 天回顾` : "当天加固"}</small></p>
                                            </div>
                                          `;
                                      })
                                      .join("")
                                : `<div class="empty-state">当前计划任务已全部完成。</div>`
                        }
                    </div>
                </section>
            </div>
        `;
    }

    function renderBooks() {
        const target = document.getElementById("books-content");
        if (!target) {
            return;
        }
        target.innerHTML = `
            <div class="page-heading">
                <div>
                    <span class="eyebrow">SEPARATE LIBRARIES</span>
                    <h1 id="books-title">每本词书，独立进度。</h1>
                    <p>每本书保留自己的顺序、List 分组、计划和学习记录。切换词书不会把另一册的单词插进当前队列。</p>
                </div>
                <button class="button button-dark" type="button" data-action="open-book-import">＋ 导入自己的词书</button>
            </div>
            <div class="book-grid">
                ${BOOKS.map((book, index) => {
                    const stats = getBookStats(book);
                    return `
                        <article class="book-card ${
                            book.id === state.selectedBookId ? "is-current" : ""
                        }" style="--book-accent:${book.accent}">
                            <span class="book-index">0${index + 1} / 0${BOOKS.length}</span>
                            <h2>${escapeHtml(book.title)}</h2>
                            <p>${escapeHtml(book.subtitle)}</p>
                            <div class="book-card-stats">
                                <span><strong>${book.groupCount}</strong><small>LIST / DAY</small></span>
                                <span><strong>${book.wordCount.toLocaleString()}</strong><small>WORDS</small></span>
                                <span><strong>${stats.due}</strong><small>DUE</small></span>
                            </div>
                            <span class="progress-track"><span style="width:${stats.learnedPercent}%"></span></span>
                            <div class="book-card-actions">
                                <button class="button button-soft" type="button" data-action="open-book-lists" data-book-id="${escapeHtml(book.id)}">查看分组</button>
                                <button class="button button-dark" type="button" data-action="study-book" data-study-kind="new" data-study-mode="meaning" data-book-id="${escapeHtml(book.id)}">学习新词</button>
                                <button class="button button-soft" type="button" data-action="study-book" data-study-kind="review" data-study-mode="meaning" data-book-id="${escapeHtml(book.id)}">到期复习</button>
                                <button class="button button-soft" type="button" data-action="study-book" data-study-kind="review" data-study-mode="spelling" data-book-id="${escapeHtml(book.id)}">练拼写</button>
                            </div>
                        </article>
                    `;
                }).join("")}
            </div>
        `;
    }

    function renderLists() {
        const target = document.getElementById("lists-content");
        const book = currentBook();
        if (!target || !book) {
            return;
        }
        const query = ui.listQuery.trim().toLowerCase();
        const groups = book.groups.filter((group) => {
            if (!query) {
                return true;
            }
            return (
                group.label.toLowerCase().includes(query) ||
                group.words.some((word) => word.word.toLowerCase().includes(query))
            );
        });
        target.innerHTML = `
            <div class="page-heading">
                <div>
                    <span class="eyebrow">ORIGINAL ORDER</span>
                    <h1 id="lists-title">${escapeHtml(book.title)}<br>原书分组</h1>
                    <p>${escapeHtml(book.source)} · 共 ${book.groupCount} 组、${book.wordCount.toLocaleString()} 条词汇。</p>
                </div>
            </div>
            <div class="lists-toolbar">
                <div class="search-box"><span>⌕</span><input data-field="list-search" type="search" value="${escapeHtml(ui.listQuery)}" placeholder="搜索 List 或单词"></div>
                <div class="toolbar-actions">
                    <button class="button button-dark" type="button" data-action="start-new" data-study-mode="meaning">学习新词</button>
                    <button class="button button-soft" type="button" data-action="start-review" data-study-mode="meaning">到期复习</button>
                    <button class="button button-soft" type="button" data-action="start-review" data-study-mode="spelling">拼写检测</button>
                </div>
            </div>
            <div class="list-grid">
                ${groups.map((group) => {
                    const stats = getGroupStats(book, group);
                    const status =
                        stats.learned === 0
                            ? ["未开始", ""]
                            : stats.learned === stats.total
                              ? ["已完成首轮", "is-done"]
                              : ["学习中", "is-started"];
                    return `
                        <article class="list-card" style="--book-accent:${book.accent}">
                            <div class="list-card-head">
                                <div>
                                    <h3>${escapeHtml(group.label)}</h3>
                                    <small>${stats.total} 个单词</small>
                                </div>
                                <span class="status-pill ${status[1]}">${status[0]}</span>
                            </div>
                            <div
                                class="list-card-progress"
                                role="progressbar"
                                aria-label="${escapeHtml(group.label)}学习进度"
                                aria-valuemin="0"
                                aria-valuemax="100"
                                aria-valuenow="${stats.percent}"
                            ><span style="width:${stats.percent}%"></span></div>
                            <div class="list-card-foot">
                                <div class="list-card-stats">
                                    <span><strong>${stats.learned}</strong><small>已学习</small></span>
                                    <span><strong>${stats.total - stats.learned}</strong><small>未学习</small></span>
                                    <span><strong>${stats.mastered}</strong><small>已掌握</small></span>
                                </div>
                                <div class="list-card-buttons">
                                    <button class="is-primary" type="button" data-action="study-group" data-study-kind="new" data-study-mode="meaning" data-group-id="${escapeHtml(group.id)}">学新词</button>
                                    <button type="button" data-action="study-group" data-study-kind="review" data-study-mode="meaning" data-group-id="${escapeHtml(group.id)}">复习</button>
                                    <button type="button" data-action="study-group" data-study-kind="review" data-study-mode="spelling" data-group-id="${escapeHtml(group.id)}">拼写</button>
                                </div>
                            </div>
                        </article>
                    `;
                }).join("") || `<div class="empty-state">没有找到匹配的 List 或单词。</div>`}
            </div>
        `;
    }

    function calendarCells(monthDate) {
        const first = firstOfMonth(monthDate);
        const start = addDays(first, -first.getDay());
        return Array.from({ length: 42 }, (_, index) => addDays(start, index));
    }

    function renderCalendar() {
        const target = document.getElementById("calendar-content");
        const book = currentBook();
        if (!target || !book) {
            return;
        }
        const plan = buildPlan(book);
        planTaskMap = new Map(plan.map((task) => [task.key, task]));
        const monthTitle = new Intl.DateTimeFormat("zh-CN", {
            year: "numeric",
            month: "long",
        }).format(ui.calendarMonth);
        const cells = calendarCells(ui.calendarMonth);
        const selectedTasks = plan.filter((task) => task.date === ui.calendarSelectedDate);
        const planSettings = {
            ...DEFAULT_PLAN,
            startDate: localDateKey(new Date()),
            ...(state.plans[book.id] || {}),
        };
        const startDate = planSettings.startDate;
        const chunks =
            planSettings.mode === "words"
                ? Math.ceil(book.wordCount / planSettings.wordsPerDay)
                : Math.ceil(book.groups.length / planSettings.listsPerDay);
        const endDate = plan.length ? plan[plan.length - 1].date : startDate;

        target.innerHTML = `
            <div class="page-heading">
                <div>
                    <span class="eyebrow">FORGETTING CURVE · CHECK-IN</span>
                    <h1 id="calendar-title">专属背词日历</h1>
                    <p>按原书顺序安排新词，并在当天、+1、+3、+7、+14、+29 天回顾。你可以按每天几个 List 或几个单词制定计划；调整节奏只重排日历，不会清空已经学过的词。预计 ${chunks} 个新学日。</p>
                </div>
            </div>
            <div class="calendar-layout">
                <section class="calendar-card">
                    <div class="calendar-controls">
                        <div class="calendar-controls-left">
                            <button class="icon-button" type="button" data-action="calendar-prev" aria-label="上个月">‹</button>
                            <strong class="calendar-month">${escapeHtml(monthTitle)}</strong>
                            <button class="icon-button" type="button" data-action="calendar-next" aria-label="下个月">›</button>
                        </div>
                        <div class="calendar-controls-right">
                            <label>开始日期 <input data-field="plan-start" type="date" value="${escapeHtml(startDate)}"></label>
                            <button class="button button-soft" type="button" data-action="calendar-today">今天</button>
                        </div>
                    </div>
                    <div class="plan-builder">
                        <label>
                            <span>计划方式</span>
                            <select data-field="plan-mode">
                                <option value="lists"${planSettings.mode === "lists" ? " selected" : ""}>每天按 List</option>
                                <option value="words"${planSettings.mode === "words" ? " selected" : ""}>每天按单词数</option>
                            </select>
                        </label>
                        <label class="${planSettings.mode === "lists" ? "" : "is-hidden"}">
                            <span>每天新学 List</span>
                            <input data-field="plan-lists" type="number" min="1" max="20" value="${planSettings.listsPerDay}">
                        </label>
                        <label class="${planSettings.mode === "words" ? "" : "is-hidden"}">
                            <span>每天新学单词</span>
                            <input data-field="plan-words" type="number" min="1" max="1000" value="${planSettings.wordsPerDay}">
                        </label>
                        <small>保存后立即重排计划；已有学习进度和复习记录不变。</small>
                    </div>
                    <div class="calendar-weekdays">
                        ${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => `<span>${day}</span>`).join("")}
                    </div>
                    <div class="calendar-grid">
                        ${cells.map((date) => {
                            const dateKey = localDateKey(date);
                            const tasks = plan.filter((task) => task.date === dateKey);
                            const otherMonth = date.getMonth() !== ui.calendarMonth.getMonth();
                            return `
                                <div class="calendar-day ${otherMonth ? "is-other" : ""} ${
                                    sameDate(date, new Date()) ? "is-today" : ""
                                }" data-action="select-calendar-date" data-date="${dateKey}">
                                    <span class="day-number">${date.getDate()}</span>
                                    <div class="day-tasks">
                                        ${tasks.slice(0, 5).map((task) => `
                                            <button class="day-task ${task.type === "review" ? "is-review" : ""} ${
                                                task.done ? "is-done" : ""
                                            }" type="button" data-action="select-calendar-date" data-date="${dateKey}">
                                                <span class="day-task-dot"></span>
                                                <span>${task.type === "learn" ? "新" : "复"} ${escapeHtml(task.label)}</span>
                                            </button>
                                        `).join("")}
                                        ${tasks.length > 5 ? `<span class="day-task">+${tasks.length - 5} 项</span>` : ""}
                                    </div>
                                </div>
                            `;
                        }).join("")}
                    </div>
                </section>

                <aside class="agenda-card">
                    <div>
                        <span class="eyebrow">AGENDA</span>
                        <h2>${escapeHtml(formatLongDate(ui.calendarSelectedDate))}</h2>
                        <p>${selectedTasks.length ? `${selectedTasks.length} 项任务` : "今天没有计划任务"}</p>
                        <div class="plan-note">当前计划从 ${startDate} 开始，最后一次回顾在 ${endDate}。修改计划不会重置已学习单词；新计划会自动识别已经完成的新词。</div>
                    </div>
                    <div class="agenda-list">
                        ${selectedTasks.length ? selectedTasks.map((task) => `
                            <div class="agenda-item ${task.done ? "is-done" : ""}">
                                <div class="agenda-item-head">
                                    <button class="agenda-check" type="button" data-action="toggle-plan-task" data-task-key="${escapeHtml(task.key)}" aria-label="切换完成状态">${task.done ? "✓" : ""}</button>
                                    <span>
                                        <strong>${task.type === "learn" ? "新学" : "复习"} ${escapeHtml(task.label)}</strong>
                                        <small>${task.type === "learn" ? "按原书顺序进入新词" : task.offset === 0 ? "当天加固" : `学习后第 ${task.offset} 天回顾`}</small>
                                    </span>
                                </div>
                                <button class="button button-soft" type="button" data-action="start-plan-task" data-task-key="${escapeHtml(task.key)}">开始这项任务</button>
                            </div>
                        `).join("") : `<div class="empty-state">选中有任务的日期即可打卡。</div>`}
                    </div>
                </aside>
            </div>
        `;
    }

    function selectBook(bookId, route) {
        if (!BOOKS.some((book) => book.id === bookId)) {
            return;
        }
        state.selectedBookId = bookId;
        if (route) {
            state.route = route;
        }
        saveState();
        render();
    }

    function navigate(route) {
        const valid = ["dashboard", "books", "lists", "calendar", "study"];
        if (!valid.includes(route)) {
            return;
        }
        state.route = route;
        document.body.classList.remove("mobile-nav-open");
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function dueWords(book, scopeWords) {
        const now = Date.now();
        const source = scopeWords || allWords(book);
        return source
            .filter((word) => {
                const progress = getProgress(book.id, word.id);
                return progress.nextReview && new Date(progress.nextReview).getTime() <= now;
            })
            .sort((a, b) => {
                const aTime = new Date(getProgress(book.id, a.id).nextReview).getTime();
                const bTime = new Date(getProgress(book.id, b.id).nextReview).getTime();
                return aTime - bTime;
            });
    }

    function firstIncompleteGroups(book, count = 2) {
        return book.groups
            .filter((group) => getGroupStats(book, group).learned < group.words.length)
            .slice(0, count)
            .map((group) => group.id);
    }

    function uniqueWords(words) {
        const seen = new Set();
        return words.filter((word) => {
            if (seen.has(word.id)) {
                return false;
            }
            seen.add(word.id);
            return true;
        });
    }

    function startStudy(options = {}) {
        const book = currentBook();
        if (!book) {
            return;
        }
        const mode = options.mode || "new";
        let groupIds = Array.isArray(options.groupIds) ? options.groupIds : [];
        let wordIds = Array.isArray(options.wordIds) ? options.wordIds : [];
        if (!groupIds.length && !wordIds.length && mode === "new") {
            const learnTask = tasksForDate(book, localDateKey(new Date())).find(
                (task) => task.type === "learn"
            );
            groupIds = learnTask?.groupIds || firstIncompleteGroups(book);
            wordIds = learnTask?.wordIds || [];
        }
        const scopedGroups = groupIds
            .map((groupId) => groupIndex.get(`${book.id}:${groupId}`))
            .filter(Boolean);
        const explicitWords = wordIds
            .map((wordId) => wordIndex.get(wordId)?.word)
            .filter(Boolean);
        const scopedWords = explicitWords.length
            ? explicitWords
            : scopedGroups.length
              ? scopedGroups.flatMap((group) => group.words)
              : allWords(book);
        let candidates = [];

        const groupSize = clamp(state.settings.dailyNew, 1, BATCH_SIZE);
        if (mode === "new" || mode === "group-new") {
            candidates = scopedWords
                .filter(
                    (word) => !getProgress(book.id, word.id).lastReviewed
                )
                .slice(0, groupSize);
        } else if (mode === "due-review" || mode === "group-review") {
            candidates = dueWords(book, scopedWords).slice(
                0,
                options.studyMode === "spelling"
                    ? state.settings.reviewLimit
                    : groupSize
            );
        } else if (mode === "plan-review") {
            candidates = scopedWords
                .filter((word) => getProgress(book.id, word.id).lastReviewed)
                .sort((a, b) => {
                    const aProgress = getProgress(book.id, a.id);
                    const bProgress = getProgress(book.id, b.id);
                    return (aProgress.correctCount || 0) - (bProgress.correctCount || 0);
                })
                .slice(
                    0,
                    options.studyMode === "spelling"
                        ? state.settings.reviewLimit
                        : groupSize
                );
        } else {
            candidates = scopedWords.filter(
                (word) => !getProgress(book.id, word.id).lastReviewed
            ).slice(0, groupSize);
        }

        if (!candidates.length) {
            toast(
                mode.includes("review")
                    ? "当前范围没有到期复习词。"
                    : "当前范围的新词已经学完了。"
            );
            return;
        }

        session = {
            bookId: book.id,
            title: scopedGroups.length ? groupRangeLabel(scopedGroups) : "今日综合任务",
            studyMode: options.studyMode === "spelling" ? "spelling" : "meaning",
            sourceTaskKey: options.taskKey || null,
            sourceTaskType: options.taskType || null,
            sourceGroupIds: scopedGroups.map((group) => group.id),
            sourceWordIds: scopedWords.map((word) => word.id),
            pendingIds:
                options.studyMode === "spelling" ? candidates.map((word) => word.id) : [],
            roundWordIds: candidates.map((word) => word.id),
            activeQueue: [],
            current: null,
            stage: "loading",
            recognitionQuality: null,
            attempts: 0,
            typed: "",
            meaningVisible: false,
            meaningRound: 1,
            flowVersion:
                options.studyMode === "spelling" ? null : MEANING_FLOW_VERSION,
            scheduledCount:
                options.studyMode === "spelling" ? candidates.length : candidates.length,
            completedWordIds: [],
            roundResults: {},
            answeredCount: 0,
            totalTarget: candidates.length,
            completed: 0,
            correct: 0,
            near: 0,
            wrong: 0,
            lastResult: null,
        };
        clearSavedSession();
        loadNextBatch();
        navigate("study");
    }

    function loadNextBatch() {
        if (!session) {
            return;
        }
        if (session.studyMode === "meaning") {
            session.activeQueue = session.roundWordIds.map((wordId) => ({
                wordId,
                step: "recognition",
                attempt: 1,
                tempProgress: null,
                intraReview: false,
                cycleType: "normal",
            }));
            moveToNextWord();
            return;
        }
        const batch = session.pendingIds.splice(0, BATCH_SIZE);
        session.activeQueue = batch.map((wordId) => ({
            wordId,
            tempProgress: null,
            intraReview: false,
            cycleType: "normal",
        }));
        moveToNextWord();
    }

    function moveToNextWord() {
        if (!session) {
            return;
        }
        session.lastResult = null;
        session.meaningVisible = false;
        session.recognitionQuality = null;
        session.attempts = 0;
        session.typed = "";
        if (!session.activeQueue.length) {
            session.current = null;
            if (session.studyMode === "meaning") {
                session.stage =
                    session.flowVersion === MEANING_FLOW_VERSION
                        ? "complete"
                        : session.meaningRound < 3
                          ? "round-finished"
                          : "complete";
            } else {
                session.stage = session.pendingIds.length ? "batch-finished" : "complete";
            }
            if (session.stage === "complete") {
                clearSavedSession();
            } else {
                persistStudySession();
            }
            renderStudy();
            return;
        }
        session.current = session.activeQueue.shift();
        session.recognitionQuality = session.studyMode === "spelling" ? "easy" : null;
        if (session.studyMode === "spelling") {
            session.stage = "spelling";
        } else {
            const step = session.current.step || "recognition";
            const stepNumber = { recognition: 1, choice: 2, input: 3 }[step] || 1;
            session.meaningRound = stepNumber;
            session.stage = `meaning-round-${stepNumber}`;
        }
        if (session.stage === "meaning-round-2") {
            session.current.choiceOptions = buildMeaningChoices(sessionBook(), sessionWord());
        }
        persistStudySession();
        renderStudy();
    }

    function startNextMeaningRound() {
        if (!session || session.studyMode !== "meaning" || session.meaningRound >= 3) {
            return;
        }
        session.meaningRound += 1;
        loadNextBatch();
    }

    function restartMeaningSessionAsMicroLoop() {
        if (!session || session.studyMode !== "meaning") {
            return;
        }
        session.flowVersion = MEANING_FLOW_VERSION;
        session.activeQueue = session.roundWordIds.map((wordId) => ({
            wordId,
            step: "recognition",
            attempt: 1,
            tempProgress: null,
            intraReview: false,
            cycleType: "normal",
        }));
        session.current = null;
        session.stage = "loading";
        session.meaningRound = 1;
        session.roundResults = {};
        session.answeredCount = 0;
        session.scheduledCount = session.roundWordIds.length;
        session.completedWordIds = [];
        session.completed = 0;
        session.correct = 0;
        session.near = 0;
        session.wrong = 0;
        moveToNextWord();
    }

    function queueMeaningStep(wordId, step, gap, details = {}) {
        if (!session || session.studyMode !== "meaning") {
            return;
        }
        const position = Math.min(
            session.activeQueue.length,
            Math.max(0, Number(gap) || 0)
        );
        session.activeQueue.splice(position, 0, {
            wordId,
            step,
            attempt: Number(details.attempt || 1),
            reinforcement: Boolean(details.reinforcement),
            tempProgress: null,
            intraReview: false,
            cycleType: "micro-loop",
        });
        session.scheduledCount = Number(session.scheduledCount || 0) + 1;
    }

    function meaningResultFor(wordId) {
        if (!session.roundResults[wordId]) {
            session.roundResults[wordId] = {
                recognitionHistory: [],
                choiceHistory: [],
                inputScheduled: false,
            };
        }
        const result = session.roundResults[wordId];
        result.recognitionHistory = Array.isArray(result.recognitionHistory)
            ? result.recognitionHistory
            : result.round1
              ? [result.round1]
              : [];
        result.choiceHistory = Array.isArray(result.choiceHistory)
            ? result.choiceHistory
            : result.round2
              ? [result.round2]
              : [];
        return result;
    }

    function sessionWord() {
        return session?.current ? wordIndex.get(session.current.wordId)?.word || null : null;
    }

    function sessionBook() {
        return BOOKS.find((book) => book.id === session?.bookId) || null;
    }

    function currentSessionProgress() {
        const word = sessionWord();
        const book = sessionBook();
        if (!word || !book) {
            return baseProgress();
        }
        return {
            ...getProgress(book.id, word.id),
            ...(session.current.tempProgress || {}),
        };
    }

    function redactAnswer(text, answer) {
        const cleaned = String(text || "释义见原书");
        if (!answer) {
            return cleaned;
        }
        return cleaned.replace(new RegExp(escapeRegExp(answer), "gi"), "＿＿＿＿");
    }

    function chineseMeaning(text) {
        const chunks = String(text || "").match(
            /[\u3400-\u9fff]+(?:[\s，、；;：:（）()·…-]*[\u3400-\u9fff]+)*/g
        );
        if (!chunks?.length) {
            return String(text || "释义见原书").trim();
        }
        return chunks
            .map((chunk) =>
                chunk
                    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
                    .trim()
            )
            .filter(Boolean)
            .join("；");
    }

    function stableHash(value) {
        let hash = 2166136261;
        for (const character of String(value)) {
            hash ^= character.codePointAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function buildMeaningChoices(book, word) {
        if (!book || !word) {
            return [];
        }
        const correct = chineseMeaning(word.meaning);
        const context = wordIndex.get(word.id);
        const nearby = context?.group?.words || [];
        const pool = [...nearby, ...allWords(book)]
            .filter((candidate) => candidate.id !== word.id)
            .map((candidate) => chineseMeaning(candidate.meaning))
            .filter((meaning) => meaning && meaning !== correct);
        const distractors = [...new Set(pool)]
            .sort(
                (a, b) =>
                    stableHash(`${word.id}:${a}`) - stableHash(`${word.id}:${b}`)
            )
            .slice(0, 3);
        return [correct, ...distractors]
            .map((meaning) => ({
                meaning,
                correct: meaning === correct,
            }))
            .sort(
                (a, b) =>
                    stableHash(`${word.id}:choice:${a.meaning}`) -
                    stableHash(`${word.id}:choice:${b.meaning}`)
            );
    }

    const SEMANTIC_EQUIVALENTS = [
        ["抱怨", "发牢骚"],
        ["讨厌", "厌恶", "憎恶"],
        ["提高", "提升", "增强", "改善"],
        ["困难", "艰难", "难以理解", "难懂", "晦涩"],
        ["短暂", "短促", "转瞬即逝"],
        ["迅速", "快速", "敏捷"],
        ["缓慢", "迟缓", "慢"],
        ["邪恶", "恶毒", "恶劣"],
        ["坦率", "直率", "直接"],
        ["聚集", "积累", "汇集"],
        ["阻碍", "妨碍", "阻止", "阻拦"],
        ["支持", "帮助", "援助"],
        ["批评", "指责", "责备"],
        ["赞美", "称赞", "表扬"],
        ["欺骗", "蒙骗", "诈骗"],
        ["节俭", "节约", "俭朴"],
        ["吝啬", "小气"],
        ["勇敢", "无畏"],
        ["胆怯", "懦弱", "害怕"],
        ["明显", "显著", "突出的"],
        ["模糊", "含糊", "不清楚"],
        ["虚假", "假的", "伪造"],
        ["真实", "真的", "实际"],
        ["普通", "平常", "一般"],
        ["杰出", "出色", "优秀", "卓越"],
        ["古老", "古代", "悠久"],
        ["新颖", "新奇", "创新"],
        ["减少", "降低", "削弱"],
        ["增加", "增多", "扩大"],
        ["混乱", "杂乱", "无序"],
        ["谨慎", "小心", "慎重"],
        ["鲁莽", "草率", "轻率"],
        ["快乐", "高兴", "愉快"],
        ["悲伤", "难过", "哀伤"],
        ["愤怒", "生气", "恼怒"],
        ["平静", "冷静", "镇定"],
    ];

    function normalizeSemantic(value) {
        let normalized = String(value || "")
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[a-z0-9]/g, "")
            .replace(/[，。；、：！？,.!?;:（）()\[\]【】“”"'·…—\s]/g, "")
            .replace(/^(意思是|就是|指的是|一种|一个|使人|让人)(?=.)/g, "")
            .replace(/^表示(?=.{2,})/g, "")
            .replace(/(的意思|的含义)$/g, "")
            .replace(/[的地得]/g, "");
        SEMANTIC_EQUIVALENTS.forEach((group, index) => {
            group.forEach((term) => {
                normalized = normalized.replace(
                    new RegExp(escapeRegExp(term), "g"),
                    `义${index}义`
                );
            });
        });
        return normalized;
    }

    function ngrams(value, size) {
        const result = [];
        for (let index = 0; index <= value.length - size; index += 1) {
            result.push(value.slice(index, index + size));
        }
        return result;
    }

    function diceSimilarity(a, b) {
        if (!a || !b) {
            return 0;
        }
        if (a === b) {
            return 1;
        }
        const size = Math.min(a.length, b.length) < 2 ? 1 : 2;
        const left = ngrams(a, size);
        const right = ngrams(b, size);
        const remaining = [...right];
        let overlap = 0;
        left.forEach((token) => {
            const index = remaining.indexOf(token);
            if (index >= 0) {
                overlap += 1;
                remaining.splice(index, 1);
            }
        });
        return (2 * overlap) / Math.max(1, left.length + right.length);
    }

    function evaluateMeaningAnswer(input, word) {
        const rawAnswer = chineseMeaning(word.meaning);
        const plain = (value) =>
            String(value || "")
                .normalize("NFKC")
                .toLowerCase()
                .replace(/[\s，。；、：！？,.!?;:（）()\[\]【】“”"'·…—]/g, "");
        const plainInput = plain(input);
        const plainTargets = [rawAnswer, ...rawAnswer.split(/[，、；;/（）()]/)]
            .map(plain)
            .filter(Boolean);
        if (plainInput && plainTargets.includes(plainInput)) {
            return { status: "correct", score: 1, expected: rawAnswer };
        }
        const targets = [
            rawAnswer,
            ...rawAnswer.split(/[，、；;/（）()]/),
        ]
            .map(normalizeSemantic)
            .filter((value) => value.length >= 1);
        const user = normalizeSemantic(input);
        if (!user) {
            return { status: "wrong", score: 0, expected: rawAnswer };
        }
        let best = 0;
        targets.forEach((target) => {
            if (
                Math.min(user.length, target.length) >= 2 &&
                (user.includes(target) || target.includes(user))
            ) {
                best = Math.max(best, 0.96);
            } else {
                best = Math.max(best, diceSimilarity(user, target));
            }
        });
        return {
            status: best >= 0.72 ? "correct" : best >= 0.38 ? "close" : "wrong",
            score: best,
            expected: rawAnswer,
        };
    }

    function renderStudy() {
        const target = document.getElementById("study-content");
        if (!target) {
            return;
        }
        if (!session) {
            target.innerHTML = `
                <div class="study-shell">
                    <div class="study-card session-finish">
                        <div><span class="finish-mark">→</span><h2 id="study-title">还没有开始任务</h2><p>从今日、词书或 List 页面开始一轮学习。</p><button class="button button-dark" type="button" data-route="dashboard">返回今日</button></div>
                    </div>
                </div>
            `;
            return;
        }
        const book = sessionBook();
        const word = sessionWord();
        const totalSteps =
            session.studyMode === "meaning"
                ? Math.max(session.scheduledCount || 0, session.answeredCount || 0, 1)
                : session.totalTarget;
        const totalDone =
            session.studyMode === "meaning"
                ? Math.min(session.answeredCount || 0, totalSteps)
                : Math.min(session.completed, totalSteps);
        const percent = totalSteps
            ? Math.round((totalDone / totalSteps) * 100)
            : 0;
        const body = renderStudyCardBody(book, word);

        target.innerHTML = `
            <div class="study-shell">
                <div class="study-head">
                    <div class="study-head-left">
                        <button class="save-exit-button" type="button" data-action="save-and-leave-study" aria-label="保存进度并退出">← 保存并退出</button>
                        <div>
                            <h1 id="study-title">${escapeHtml(session.title)}</h1>
                            <p>${escapeHtml(book?.title || "")} · ${session.studyMode === "spelling" ? "进阶拼写检测" : `20 词微循环 · ${session.meaningRound === 1 ? "认识判断" : session.meaningRound === 2 ? "英译汉选义" : "中文释义填空"}`}</p>
                        </div>
                    </div>
                    <div class="study-progress">
                        <span class="progress-track"><span style="width:${percent}%"></span></span>
                        <span>${totalDone}/${totalSteps}</span>
                    </div>
                </div>
                <div class="study-card">${body}</div>
            </div>
        `;

        if (session.stage === "spelling" || session.stage === "meaning-round-3") {
            window.setTimeout(() => {
                const input = target.querySelector(
                    session.stage === "spelling" ? ".spelling-input" : ".meaning-input"
                );
                input?.focus();
            }, 0);
        }
    }

    function renderStudyCardBody(book, word) {
        if (session.stage === "batch-finished") {
            return `
                <div class="session-finish">
                    <div>
                        <span class="finish-mark">✓</span>
                        <h2>这一批完成了</h2>
                        <p>还有 ${session.pendingIds.length} 个词在本轮队列中。休息一下，或继续下一批。</p>
                        <div class="finish-stats">
                            <span><strong>${session.correct}</strong><small>顺利完成</small></span>
                            <span><strong>${session.near}</strong><small>需要加固</small></span>
                            <span><strong>${session.wrong}</strong><small>次日再见</small></span>
                        </div>
                        <button class="button button-dark" type="button" data-action="next-batch">继续下一批</button>
                    </div>
                </div>
            `;
        }
        if (session.stage === "round-finished" && session.flowVersion !== MEANING_FLOW_VERSION) {
            const finishedRound = session.meaningRound || 1;
            const nextRound = finishedRound + 1;
            const nextLabel =
                nextRound === 2 ? "四选一辨认中文词义" : "输入中文释义";
            return `
                <div class="session-finish">
                    <div>
                        <span class="finish-mark">${finishedRound}</span>
                        <h2>第 ${finishedRound} 轮完成</h2>
                        <p>本轮 ${session.totalTarget} 个词已经走完。下一轮将使用同一批词进行${nextLabel}。</p>
                        <div class="round-roadmap">
                            <span class="${finishedRound >= 1 ? "is-done" : ""}"><b>1</b>认识判断</span>
                            <span class="${finishedRound >= 2 ? "is-done" : ""}"><b>2</b>四选一</span>
                            <span><b>3</b>中文填空</span>
                        </div>
                        <button class="button button-dark" type="button" data-action="next-meaning-round">进入第 ${nextRound} 轮</button>
                    </div>
                </div>
            `;
        }
        if (session.stage === "complete") {
            const sourceStats = sessionSourceStats();
            if (session.sourceTaskKey) {
                state.calendarChecks[session.sourceTaskKey] =
                    session.sourceTaskType === "review" ||
                    (sourceStats.total > 0 && sourceStats.remaining === 0);
                saveState();
            }
            const accuracy = session.completed
                ? Math.round((session.correct / session.completed) * 100)
                : 0;
            return `
                <div class="session-finish">
                    <div>
                        <span class="finish-mark">✦</span>
                        <h2>这组 ${session.totalTarget} 词完成</h2>
                        <p>${
                            sourceStats.total
                                ? sourceStats.remaining
                                    ? `进度已保存。当前大 List 任务还剩 ${sourceStats.remaining} 个未学词；下一组会严格从后续词继续。`
                                    : "本次大 List 任务中的词已经全部学习完成。"
                                : "这次学习已经写入本机进度，下一次会从后续词继续。"
                        }</p>
                        <div class="finish-stats">
                            <span><strong>${session.completed}</strong><small>完成词数</small></span>
                            <span><strong>${accuracy}%</strong><small>一次通过率</small></span>
                            <span><strong>${session.wrong}</strong><small>错误重排</small></span>
                        </div>
                        <button class="button button-dark" type="button" data-action="finish-session">返回今日</button>
                    </div>
                </div>
            `;
        }
        if (!word || !book) {
            return `<div class="empty-state">正在准备词汇…</div>`;
        }
        const context = wordIndex.get(word.id);
        if (session.stage === "meaning-round-1") {
            return `
                <div class="study-meta">
                    <span>${escapeHtml(context?.group.label || "")}</span>
                    <span>${session.current.reinforcement ? "再次确认 · 认识判断" : "步骤 1 · 认识判断"}</span>
                </div>
                <div class="study-word">${escapeHtml(word.word)}</div>
                <div class="phonetic">
                    ${word.phonetic ? `[${escapeHtml(word.phonetic)}]` : "按播放键听读音"}
                    <button class="speak-button" type="button" data-action="speak-word" aria-label="朗读单词">◖</button>
                </div>
                <p class="study-prompt">先凭第一反应判断；选择后会显示完整词义、用法和例句。</p>
                <div class="rating-row">
                    <button class="rating-button easy" type="button" data-quality="easy">认识<small>看到单词就知道意思</small></button>
                    <button class="rating-button good" type="button" data-quality="good">模糊<small>有印象，但不够确定</small></button>
                    <button class="rating-button hard" type="button" data-quality="wrong">不认识<small>没有想起正确词义</small></button>
                </div>
            `;
        }
        if (session.stage === "meaning-round-2") {
            const options = session.current.choiceOptions || buildMeaningChoices(book, word);
            return `
                <div class="study-meta">
                    <span>${escapeHtml(context?.group.label || "")}</span>
                    <span>${session.current.reinforcement ? "加固 · 英译汉四选一" : "步骤 2 · 英译汉四选一"}</span>
                </div>
                <div class="study-word choice-word">${escapeHtml(word.word)}</div>
                <div class="phonetic">
                    ${word.phonetic ? `[${escapeHtml(word.phonetic)}]` : ""}
                    <button class="speak-button" type="button" data-action="speak-word" aria-label="朗读单词">◖</button>
                </div>
                <p class="study-prompt">请选择最符合这个单词的中文意思。</p>
                <div class="meaning-choice-grid">
                    ${options
                        .map(
                            (option, index) => `
                                <button class="meaning-choice" type="button" data-action="choose-meaning" data-choice-index="${index}">
                                    <span>${String.fromCharCode(65 + index)}</span>
                                    <strong>${escapeHtml(option.meaning)}</strong>
                                </button>
                            `
                        )
                        .join("")}
                </div>
            `;
        }
        if (session.stage === "meaning-round-3") {
            return `
                <div class="study-meta">
                    <span>${escapeHtml(context?.group.label || "")}</span>
                    <span>步骤 3 · 中文释义填空</span>
                </div>
                <div class="study-word choice-word">${escapeHtml(word.word)}</div>
                <div class="phonetic">
                    ${word.phonetic ? `[${escapeHtml(word.phonetic)}]` : ""}
                    <button class="speak-button" type="button" data-action="speak-word" aria-label="朗读单词">◖</button>
                </div>
                <div class="meaning-input-shell">
                    <label for="meaning-answer">用你自己的中文表达词义，不需要与原书逐字一致</label>
                    <textarea class="meaning-input" id="meaning-answer" rows="3" autocomplete="off" placeholder="例如：抱怨、发牢骚">${escapeHtml(session.typed)}</textarea>
                    <button class="button button-dark" type="button" data-action="submit-meaning">判断语义（Enter）</button>
                </div>
            `;
        }
        if (session.stage === "semantic-review") {
            const pending = session.pendingSemantic;
            return `
                <div class="study-meta">
                    <span>${escapeHtml(context?.group.label || "")}</span>
                    <span>语义需要确认</span>
                </div>
                <div class="semantic-review">
                    <span class="semantic-mark">?</span>
                    <h2>暂时没有匹配到相近词义</h2>
                    <p>系统会忽略措辞差异并识别一部分常见近义表达，但这次差异仍然较大。你可以自行确认，避免机器误判。</p>
                    <div class="semantic-compare">
                        <div><small>你的填写</small><strong>${escapeHtml(pending?.typed || "")}</strong></div>
                        <div><small>原书中文词义</small><strong>${escapeHtml(pending?.expected || chineseMeaning(word.meaning))}</strong></div>
                    </div>
                    <div class="semantic-actions">
                        <button class="button button-ghost" type="button" data-action="confirm-semantic" data-semantic-result="wrong">按“不认识”记录</button>
                        <button class="button button-dark" type="button" data-action="confirm-semantic" data-semantic-result="close">我的意思是对的</button>
                    </div>
                </div>
            `;
        }
        if (session.stage === "spelling") {
            const remaining = 3 - session.attempts;
            return `
                <div class="study-meta">
                    <span>${escapeHtml(context?.group.label || "")}</span>
                    <span>进阶拼写检测</span>
                </div>
                <div class="spelling-shell">
                    <span class="eyebrow">SPELL IT BACK</span>
                    <h2>${escapeHtml(redactAnswer(word.meaning, word.word))}</h2>
                    <p class="attempt-hint">${session.attempts ? `刚才拼写不对，还剩 ${remaining} 次机会` : "根据释义，拼出完整单词"}</p>
                    <input class="spelling-input" name="spelling" type="text" value="${escapeHtml(session.typed)}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="输入英文拼写">
                    <div class="spelling-actions">
                        <button class="button button-ghost" type="button" data-action="skip-spelling">跳过</button>
                        <button class="button button-dark" type="button" data-action="submit-spelling">提交（Enter）</button>
                    </div>
                </div>
            `;
        }
        if (session.stage === "feedback") {
            const result = session.lastResult;
            const progress = currentSessionProgress();
            const note = state.notes[word.id] || "";
            const detail = word.example || word.sourceText || word.meaning;
            const icon = result.status === "correct" ? "✓" : result.status === "near" ? "↻" : "!";
            const primaryMeaning = chineseMeaning(word.meaning);
            const scheduleText = result.roundOnly
                ? result.reinforcementScheduled
                    ? "已自动加入本组后续加固，稍后会再次出现"
                    : "已记录到本组记忆轨迹"
                : result.saved
                  ? `下次复习：${formatShortDate(progress.nextReview)}`
                  : result.verification
                    ? "将在本轮较后位置再次验证"
                    : "将在本轮 3–8 个词后再次出现";
            const isMeaningResult = String(result.mode || "").startsWith("meaning");
            const responseLabel =
                result.mode === "meaning-choice"
                    ? "你的选择"
                    : result.mode === "meaning-input"
                      ? "你的填写"
                      : isMeaningResult
                        ? "你的判断"
                        : "你的拼写";
            return `
                <div class="study-meta">
                    <span>${escapeHtml(context?.group.label || "")}</span>
                    <span>${escapeHtml(result.qualityLabel)}</span>
                </div>
                <div class="feedback">
                    <div class="feedback-meaning-hero">
                        <span class="eyebrow">中文词义</span>
                        <h2>${escapeHtml(primaryMeaning)}</h2>
                        <p>
                            <strong>${escapeHtml(word.word)}</strong>
                            ${word.phonetic ? `<span>[${escapeHtml(word.phonetic)}]</span>` : ""}
                            <button class="speak-button" type="button" data-action="speak-word" aria-label="朗读单词">◖</button>
                        </p>
                    </div>
                    <div class="feedback-status">
                        <span><b>${icon}</b>${escapeHtml(result.qualityLabel)}</span>
                        <small>${escapeHtml(scheduleText)}</small>
                    </div>
                    <div class="answer-grid">
                        <div class="answer-cell"><small>${responseLabel}</small><strong>${escapeHtml(result.typed || "已跳过")}</strong></div>
                        ${
                            result.roundOnly
                                ? `<div class="answer-cell"><small>微循环进度</small><strong>${session.answeredCount}/${Math.max(session.scheduledCount || 0, session.answeredCount || 0)}</strong></div>`
                                : `<div class="answer-cell"><small>记忆参数</small><strong>EF ${Number(progress.easeFactor || 1.3).toFixed(2)} · 间隔 ${progress.interval || 1} 天 · 正确 ${progress.correctCount || 0} 次</strong></div>`
                        }
                        <div class="answer-cell is-wide"><small>原书完整释义</small><strong>${escapeHtml(word.meaning)}</strong></div>
                    </div>
                    <div class="source-detail">${escapeHtml(detail)}</div>
                    <div class="note-row">
                        <input data-field="word-note" type="text" value="${escapeHtml(note)}" placeholder="写下词根、联想或易混词">
                        <button class="button button-soft" type="button" data-action="save-note">保存笔记</button>
                    </div>
                    <div class="feedback-actions"><button class="button button-dark" type="button" data-action="next-word">下一词（Enter）</button></div>
                </div>
            `;
        }
        return `<div class="empty-state">正在准备下一词…</div>`;
    }

    function calculateEaseFactor(oldEF, quality) {
        const q = QUALITY_SCORE[quality] ?? 0;
        const ef = oldEF || 2.5;
        return clamp(
            ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
            1.3,
            3
        );
    }

    function scheduleSuccess(progress, quality, now) {
        const easeFactor = calculateEaseFactor(
            progress.easeFactor || INITIAL_EF[quality] || 2.5,
            quality
        );
        const repetitions = Number(progress.repetitions || 0) + 1;
        const interval =
            repetitions === 1
                ? 6
                : Math.max(1, Math.round((progress.interval || 1) * easeFactor));
        return {
            ...progress,
            easeFactor,
            repetitions,
            interval,
            intraCycles: 0,
            correctCount: Number(progress.correctCount || 0) + 1,
            lastReviewed: now.toISOString(),
            nextReview: addDays(now, interval).toISOString(),
        };
    }

    function scheduleFailure(progress, now) {
        return {
            ...progress,
            easeFactor: Math.max(1.3, Number(progress.easeFactor || 1.5) - 0.2),
            repetitions: 0,
            interval: 1,
            intraCycles: 0,
            lastReviewed: now.toISOString(),
            nextReview: addDays(now, 1).toISOString(),
        };
    }

    function adjustIntra(progress, quality) {
        return {
            ...progress,
            easeFactor: clamp(
                Number(progress.easeFactor || INITIAL_EF[quality] || 2.5) +
                    (INTRA_EF[quality] || 0),
                1.3,
                3
            ),
            intraCycles: Number(progress.intraCycles || 0) + 1,
        };
    }

    function insertIntraReview(progress, cycleType) {
        const min = cycleType === "easy-verification" ? 20 : 3;
        const spread = cycleType === "easy-verification" ? 11 : 6;
        const position = Math.min(
            session.activeQueue.length,
            Math.floor(Math.random() * spread) + min
        );
        session.activeQueue.splice(position, 0, {
            wordId: session.current.wordId,
            tempProgress: { ...progress },
            intraReview: true,
            cycleType,
        });
    }

    function rateMeaning(quality) {
        if (!session || session.stage !== "meaning-round-1") {
            return;
        }
        const labels = {
            easy: "认识",
            good: "模糊",
            wrong: "不认识",
        };
        const word = sessionWord();
        const result = meaningResultFor(word.id);
        result.round1 = quality;
        result.recognitionHistory.push(quality);
        const attempt = result.recognitionHistory.length;
        let reinforcementScheduled = false;
        if (attempt === 1) {
            if (quality === "easy") {
                queueMeaningStep(word.id, "choice", 4, { attempt: 1 });
            } else if (quality === "good") {
                queueMeaningStep(word.id, "choice", 2, {
                    attempt: 1,
                    reinforcement: true,
                });
                queueMeaningStep(word.id, "recognition", 6, {
                    attempt: 2,
                    reinforcement: true,
                });
                reinforcementScheduled = true;
            } else {
                queueMeaningStep(word.id, "choice", 1, {
                    attempt: 1,
                    reinforcement: true,
                });
                queueMeaningStep(word.id, "recognition", 4, {
                    attempt: 2,
                    reinforcement: true,
                });
                queueMeaningStep(word.id, "choice", 7, {
                    attempt: 2,
                    reinforcement: true,
                });
                reinforcementScheduled = true;
            }
        } else if (quality !== "easy") {
            const pendingChoices = session.activeQueue.filter(
                (item) => item.wordId === word.id && item.step === "choice"
            ).length;
            const targetChoices = quality === "wrong" ? 3 : 2;
            if (result.choiceHistory.length + pendingChoices < targetChoices) {
                queueMeaningStep(word.id, "choice", quality === "wrong" ? 2 : 4, {
                    attempt: result.choiceHistory.length + pendingChoices + 1,
                    reinforcement: true,
                });
            }
            if (quality === "wrong" && attempt < 3) {
                const hasPendingRecognition = session.activeQueue.some(
                    (item) => item.wordId === word.id && item.step === "recognition"
                );
                if (!hasPendingRecognition) {
                    queueMeaningStep(word.id, "recognition", 6, {
                        attempt: attempt + 1,
                        reinforcement: true,
                    });
                }
            }
            reinforcementScheduled = true;
        }
        session.answeredCount += 1;
        session.lastResult = {
            status: quality === "easy" ? "correct" : quality === "good" ? "near" : "wrong",
            quality,
            qualityLabel: labels[quality] || "模糊",
            typed: labels[quality] || "模糊",
            mode: "meaning-self",
            roundOnly: true,
            round: 1,
            reinforcementScheduled,
            saved: false,
            verification: false,
        };
        session.stage = "feedback";
        persistStudySession();
        renderStudy();
    }

    function chooseMeaning(index) {
        if (!session || session.stage !== "meaning-round-2") {
            return;
        }
        const word = sessionWord();
        const options = session.current.choiceOptions || [];
        const selected = options[Number(index)];
        if (!word || !selected) {
            return;
        }
        const correct = Boolean(selected.correct);
        const result = meaningResultFor(word.id);
        result.round2 = correct ? "correct" : "wrong";
        result.choiceHistory.push(correct ? "correct" : "wrong");
        const choiceAttempts = result.choiceHistory.length;
        let reinforcementScheduled = false;
        const pendingChoiceCount = session.activeQueue.filter(
            (item) => item.wordId === word.id && item.step === "choice"
        ).length;
        if (!correct && choiceAttempts + pendingChoiceCount < 3) {
            queueMeaningStep(word.id, "choice", 3, {
                attempt: choiceAttempts + 1,
                reinforcement: true,
            });
            reinforcementScheduled = true;
        }
        if (!result.inputScheduled && (correct || choiceAttempts >= 2)) {
            queueMeaningStep(word.id, "input", correct ? 5 : 6, {
                attempt: 1,
            });
            result.inputScheduled = true;
        }
        session.answeredCount += 1;
        session.lastResult = {
            status: correct ? "correct" : "wrong",
            quality: correct ? "easy" : "wrong",
            qualityLabel: correct ? "选择正确" : "选择错误",
            typed: selected.meaning,
            mode: "meaning-choice",
            roundOnly: true,
            round: 2,
            reinforcementScheduled,
            saved: false,
            verification: false,
        };
        session.stage = "feedback";
        persistStudySession();
        renderStudy();
    }

    function overallMeaningQuality(wordId, semanticStatus) {
        const result = meaningResultFor(wordId);
        const latestRecognition =
            result.recognitionHistory[result.recognitionHistory.length - 1] ||
            result.round1 ||
            "wrong";
        const correctChoices = result.choiceHistory.filter(
            (item) => item === "correct"
        ).length;
        const allChoicesCorrect =
            result.choiceHistory.length > 0 &&
            correctChoices === result.choiceHistory.length;
        if (semanticStatus === "wrong") {
            return "wrong";
        }
        if (semanticStatus === "close") {
            return latestRecognition === "wrong" || !correctChoices ? "hard" : "good";
        }
        if (latestRecognition === "easy" && allChoicesCorrect) {
            return "easy";
        }
        return correctChoices ? "good" : "hard";
    }

    function commitMeaningInput(semanticStatus) {
        if (!session) {
            return;
        }
        const word = sessionWord();
        const pending = session.pendingSemantic;
        if (!word || !pending) {
            return;
        }
        session.roundResults[word.id] = {
            ...(session.roundResults[word.id] || {}),
            round3: semanticStatus,
        };
        const quality = overallMeaningQuality(word.id, semanticStatus);
        const semanticLabels = {
            correct: "语义一致",
            close: "语义接近",
            wrong: "语义未匹配",
        };
        session.pendingSemantic = null;
        session.answeredCount += 1;
        if (semanticStatus === "wrong") {
            queueMeaningStep(word.id, "choice", 2, {
                attempt: meaningResultFor(word.id).choiceHistory.length + 1,
                reinforcement: true,
            });
            queueMeaningStep(word.id, "recognition", 5, {
                attempt: meaningResultFor(word.id).recognitionHistory.length + 1,
                reinforcement: true,
            });
        } else if (semanticStatus === "close") {
            queueMeaningStep(word.id, "choice", 4, {
                attempt: meaningResultFor(word.id).choiceHistory.length + 1,
                reinforcement: true,
            });
        }
        applyStudyResult({
            skipped: false,
            typed: pending.typed,
            directQuality: quality,
            resultMode: "meaning-input",
            forceSave: true,
            qualityLabelOverride: semanticLabels[semanticStatus],
            semanticStatus,
        });
    }

    function submitMeaningInput() {
        if (!session || session.stage !== "meaning-round-3") {
            return;
        }
        const word = sessionWord();
        const input = document.querySelector(".meaning-input");
        const typed = String(input?.value || session.typed || "").trim();
        if (!typed) {
            toast("先写下你理解的中文意思。");
            return;
        }
        session.typed = typed;
        const evaluation = evaluateMeaningAnswer(typed, word);
        session.pendingSemantic = { ...evaluation, typed };
        if (evaluation.status === "wrong") {
            session.stage = "semantic-review";
            persistStudySession();
            renderStudy();
            return;
        }
        commitMeaningInput(evaluation.status);
    }

    function submitSpelling(skipped) {
        if (!session || session.stage !== "spelling") {
            return;
        }
        const word = sessionWord();
        const input = document.querySelector(".spelling-input");
        const typed = skipped ? "" : String(input?.value || session.typed || "").trim();
        if (!skipped && !typed) {
            toast("先输入拼写，再提交。");
            return;
        }
        session.typed = typed;
        const correct =
            !skipped && typed.toLocaleLowerCase() === word.word.trim().toLocaleLowerCase();
        if (correct) {
            applyStudyResult({ skipped: false, typed, resultMode: "spelling" });
            return;
        }
        session.attempts += 1;
        if (skipped || session.attempts >= 3) {
            applyStudyResult({ skipped, typed, resultMode: "spelling" });
            return;
        }
        session.typed = "";
        renderStudy();
        toast(`拼写不对，还剩 ${3 - session.attempts} 次机会。`);
    }

    function applyStudyResult({
        skipped,
        typed,
        directQuality = null,
        resultMode = "spelling",
        forceSave = false,
        qualityLabelOverride = "",
        semanticStatus = "",
    }) {
        const book = sessionBook();
        const word = sessionWord();
        if (!book || !word || !session?.current) {
            return;
        }
        const now = new Date();
        const base = currentSessionProgress();
        const isNew = !base.lastReviewed && base.easeFactor == null;
        const isIntra = session.current.intraReview;
        const cycleType = session.current.cycleType;
        let quality = directQuality || session.recognitionQuality || "easy";
        if (resultMode === "spelling") {
            if (skipped || session.attempts >= 3) {
                quality = "wrong";
            } else if (session.attempts >= 2) {
                quality = "hard";
            } else if (session.attempts === 1 && quality === "easy") {
                quality = "good";
            }
        }

        let nextProgress = { ...base };
        let saved = false;
        let verification = false;

        if (forceSave) {
            nextProgress.easeFactor =
                nextProgress.easeFactor || INITIAL_EF[quality] || 1.3;
            nextProgress =
                quality === "wrong"
                    ? scheduleFailure(nextProgress, now)
                    : scheduleSuccess(nextProgress, quality, now);
            saved = true;
        } else if (isNew) {
            nextProgress.easeFactor = INITIAL_EF[quality] || 1.3;
            nextProgress.intraCycles = 1;
            if (quality === "easy") {
                nextProgress = scheduleSuccess(nextProgress, "easy", now);
                saved = true;
            } else {
                insertIntraReview(nextProgress, "normal");
            }
        } else if (isIntra) {
            if (cycleType === "easy-verification" && quality === "easy") {
                nextProgress = scheduleSuccess(nextProgress, "easy", now);
                saved = true;
            } else if (quality === "wrong") {
                nextProgress = adjustIntra(nextProgress, "wrong");
                if (nextProgress.intraCycles >= MAX_INTRA_CYCLES) {
                    nextProgress = scheduleFailure(nextProgress, now);
                    saved = true;
                } else {
                    insertIntraReview(nextProgress, "normal");
                }
            } else if (quality === "easy") {
                nextProgress = adjustIntra(nextProgress, "easy");
                nextProgress.intraCycles = 0;
                insertIntraReview(nextProgress, "easy-verification");
                verification = true;
            } else {
                nextProgress = adjustIntra(nextProgress, quality);
                if (nextProgress.intraCycles >= MAX_INTRA_CYCLES) {
                    nextProgress = scheduleSuccess(nextProgress, quality, now);
                    saved = true;
                } else {
                    insertIntraReview(nextProgress, "normal");
                }
            }
        } else if (quality === "wrong") {
            nextProgress = scheduleFailure(nextProgress, now);
            saved = true;
        } else {
            nextProgress = scheduleSuccess(nextProgress, quality, now);
            saved = true;
        }

        const isMeaningResult = String(resultMode).startsWith("meaning");
        const needsReinforcement =
            quality === "hard" ||
            semanticStatus === "close" ||
            (isMeaningResult && quality === "good") ||
            (resultMode === "spelling" && (session.attempts > 0 || skipped));

        if (saved) {
            setProgress(book.id, word.id, nextProgress);
            session.completedWordIds = Array.isArray(session.completedWordIds)
                ? session.completedWordIds
                : [];
            if (!session.completedWordIds.includes(word.id)) {
                session.completedWordIds.push(word.id);
                session.completed += 1;
            }
            if (quality === "wrong") {
                session.wrong += 1;
            } else if (needsReinforcement) {
                session.near += 1;
            } else {
                session.correct += 1;
            }
        } else {
            session.current.tempProgress = nextProgress;
        }

        const status =
            quality === "wrong"
                ? "wrong"
                : needsReinforcement
                  ? "near"
                  : "correct";
        const meaningQualityLabels = {
            easy: "认识",
            good: "模糊",
            hard: "较难",
            wrong: "不认识",
        };
        const spellingQualityLabels = {
            easy: "拼写正确",
            good: "一次纠正",
            hard: "多次纠正",
            wrong: "拼写错误",
        };
        session.lastResult = {
            status,
            quality,
            qualityLabel:
                qualityLabelOverride ||
                (isMeaningResult
                    ? meaningQualityLabels[quality]
                    : spellingQualityLabels[quality]),
            typed,
            skipped,
            saved,
            verification,
            mode: resultMode,
            semanticStatus,
        };
        session.stage = "feedback";
        persistStudySession();
        renderStudy();
    }

    function speakCurrentWord() {
        const word = sessionWord();
        if (!word || !("speechSynthesis" in window)) {
            toast("当前浏览器不支持语音朗读。");
            return;
        }
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(word.word);
        utterance.lang = "en-US";
        utterance.rate = 0.82;
        window.speechSynthesis.speak(utterance);
    }

    function sessionSourceStats() {
        const book = sessionBook();
        const groupIds = Array.isArray(session?.sourceGroupIds)
            ? session.sourceGroupIds
            : [];
        const sourceWordIds = Array.isArray(session?.sourceWordIds)
            ? session.sourceWordIds
            : [];
        if (!book || (!groupIds.length && !sourceWordIds.length)) {
            return { total: 0, learned: 0, remaining: 0 };
        }
        const words = sourceWordIds.length
            ? sourceWordIds
                  .map((wordId) => wordIndex.get(wordId)?.word)
                  .filter(Boolean)
            : groupIds.flatMap(
                  (groupId) => groupIndex.get(`${book.id}:${groupId}`)?.words || []
              );
        const learned = words.filter(
            (word) => getProgress(book.id, word.id).lastReviewed
        ).length;
        return {
            total: words.length,
            learned,
            remaining: Math.max(0, words.length - learned),
        };
    }

    function openBookImport() {
        const modal = document.querySelector('[data-modal="book-import"]');
        const form = document.getElementById("book-import-form");
        if (!modal || !form) {
            return;
        }
        form.reset();
        form.elements.listSize.value = 100;
        modal.hidden = false;
        window.setTimeout(() => form.elements.title.focus(), 0);
    }

    function closeBookImport() {
        const modal = document.querySelector('[data-modal="book-import"]');
        if (modal) {
            modal.hidden = true;
        }
    }

    function splitDelimitedLine(line, delimiter) {
        const cells = [];
        let value = "";
        let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index];
            if (character === '"') {
                if (quoted && line[index + 1] === '"') {
                    value += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else if (character === delimiter && !quoted) {
                cells.push(value.trim());
                value = "";
            } else {
                value += character;
            }
        }
        cells.push(value.trim());
        return cells;
    }

    function rowsFromText(text, extension) {
        const lines = String(text || "")
            .replace(/\r/g, "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        const rows = [];
        let currentList = "";
        lines.forEach((line, lineIndex) => {
            const heading = line.match(/^(?:list|day|第)\s*([0-9一二三四五六七八九十百]+)\s*(?:组|天)?$/i);
            if (heading) {
                currentList = `List ${heading[1]}`;
                return;
            }
            let cells;
            if (extension === "csv" || (line.includes(",") && !line.includes("\t"))) {
                cells = splitDelimitedLine(line, ",");
            } else if (line.includes("\t")) {
                cells = splitDelimitedLine(line, "\t");
            } else {
                const matched = line.match(
                    /^([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*)?)\s*(?:[-—:：]\s*|\s+)(.+)$/
                );
                if (!matched) {
                    return;
                }
                cells = [matched[1], matched[2]];
            }
            const first = String(cells[0] || "").trim();
            if (
                lineIndex === 0 &&
                /^(word|单词|英文)$/i.test(first)
            ) {
                return;
            }
            const word = first.match(/[A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*)?/)?.[0];
            const meaning = String(cells[1] || "").trim();
            if (!word || !meaning) {
                return;
            }
            rows.push({
                word,
                meaning,
                phonetic: String(cells[2] || "").trim(),
                example: String(cells[3] || "").trim(),
                list: String(cells[4] || currentList).trim(),
            });
        });
        return rows;
    }

    async function textFromPdf(file) {
        const localModuleUrl = new URL(
            "assets/vendor/pdf.min.mjs",
            document.baseURI
        ).href;
        const localWorkerUrl = new URL(
            "assets/vendor/pdf.worker.min.mjs",
            document.baseURI
        ).href;
        const cdnModuleUrl =
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.min.mjs";
        const cdnWorkerUrl =
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.worker.min.mjs";
        let pdfjs;
        let workerUrl = localWorkerUrl;
        try {
            pdfjs = await import(localModuleUrl);
        } catch (localError) {
            console.info("[GRE List Lab] 使用在线 PDF 解析组件", localError);
            pdfjs = await import(cdnModuleUrl);
            workerUrl = cdnWorkerUrl;
        }
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        const lines = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            const rows = new Map();
            content.items.forEach((item) => {
                const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
                if (!rows.has(y)) {
                    rows.set(y, []);
                }
                rows.get(y).push({
                    x: item.transform?.[4] || 0,
                    text: String(item.str || "").trim(),
                });
            });
            [...rows.entries()]
                .sort((a, b) => b[0] - a[0])
                .forEach(([, items]) => {
                    const line = items
                        .sort((a, b) => a.x - b.x)
                        .map((item) => item.text)
                        .filter(Boolean)
                        .join(" ");
                    if (line) {
                        lines.push(line);
                    }
                });
        }
        return lines.join("\n");
    }

    function normalizeImportedGroups(input, listSize, bookId) {
        const sourceGroups = Array.isArray(input?.groups) ? input.groups : null;
        let rows = Array.isArray(input) ? input : Array.isArray(input?.words) ? input.words : [];
        if (sourceGroups) {
            rows = sourceGroups.flatMap((group, groupIndexValue) =>
                (group.words || []).map((word) => ({
                    ...word,
                    list: group.label || `List ${groupIndexValue + 1}`,
                }))
            );
        }
        const buckets = [];
        const bucketMap = new Map();
        rows.forEach((entry, index) => {
            const word = String(entry?.word || entry?.english || "").trim();
            const meaning = String(
                entry?.meaning || entry?.chinese || entry?.translation || ""
            ).trim();
            if (!word || !meaning) {
                return;
            }
            const explicitLabel = String(entry?.list || entry?.group || "").trim();
            const fallbackNumber = Math.floor(index / listSize) + 1;
            const label = explicitLabel || `List ${fallbackNumber}`;
            if (!bucketMap.has(label)) {
                const group = {
                    id: `list-${buckets.length + 1}`,
                    label,
                    order: buckets.length + 1,
                    words: [],
                };
                bucketMap.set(label, group);
                buckets.push(group);
            }
            const group = bucketMap.get(label);
            group.words.push({
                id: `${bookId}-${group.id}-${group.words.length + 1}`,
                groupId: group.id,
                word,
                meaning,
                phonetic: String(entry?.phonetic || entry?.pronunciation || "").trim(),
                example: String(entry?.example || "").trim(),
                sourceText: meaning,
            });
        });
        return buckets.filter((group) => group.words.length);
    }

    async function importCustomBook(form) {
        const data = new FormData(form);
        const file = form.elements.bookFile.files?.[0];
        const title = String(data.get("title") || file?.name?.replace(/\.[^.]+$/, "") || "").trim();
        const listSize = clamp(data.get("listSize"), 1, 1000);
        if (!file || !title) {
            throw new Error("请填写词书名称并选择文件");
        }
        const extension = file.name.split(".").pop()?.toLowerCase() || "";
        let source;
        if (extension === "json") {
            source = JSON.parse(await file.text());
        } else {
            const text = extension === "pdf" ? await textFromPdf(file) : await file.text();
            source = rowsFromText(text, extension);
        }
        const bookId = `custom-${Date.now().toString(36)}`;
        const groups = normalizeImportedGroups(source, listSize, bookId);
        const wordCount = groups.reduce((sum, group) => sum + group.words.length, 0);
        if (!wordCount) {
            throw new Error("没有识别到“英文单词 + 中文释义”，请检查文件格式");
        }
        const accents = ["#27675a", "#d97845", "#6f63a8", "#2875a7", "#a64f64"];
        const book = {
            id: bookId,
            title,
            subtitle: `自定义导入 · ${localDateKey(new Date())}`,
            accent: accents[BOOKS.length % accents.length],
            source: file.name,
            isCustom: true,
            groups,
            groupCount: groups.length,
            wordCount,
        };
        const customBooks = [...BOOKS.filter((item) => item.isCustom), book];
        window.localStorage.setItem(CUSTOM_BOOKS_KEY, JSON.stringify(customBooks));
        BOOKS.push(book);
        indexBook(book);
        state.plans[book.id] = {
            ...DEFAULT_PLAN,
            startDate: localDateKey(new Date()),
        };
        state.selectedBookId = book.id;
        saveState();
        closeBookImport();
        navigate("books");
        toast(`已导入《${title}》：${groups.length} 个 List，${wordCount} 词。`);
    }

    function openSettings() {
        const modal = document.querySelector('[data-modal="settings"]');
        const form = document.getElementById("settings-form");
        if (!modal || !form) {
            return;
        }
        form.elements.dailyNew.value = state.settings.dailyNew;
        form.elements.reviewLimit.value = state.settings.reviewLimit;
        form.elements.masteryCount.value = state.settings.masteryCount;
        modal.hidden = false;
        window.setTimeout(() => form.elements.dailyNew.focus(), 0);
    }

    function closeSettings() {
        const modal = document.querySelector('[data-modal="settings"]');
        if (modal) {
            modal.hidden = true;
        }
    }

    function exportProgress() {
        const payload = {
            app: "GRE List Lab",
            version: BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            state,
            customBooks: BOOKS.filter((book) => book.isCustom),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `gre-list-lab-progress-${localDateKey(new Date())}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        toast("进度备份已导出。");
    }

    async function importProgress(file) {
        try {
            const payload = JSON.parse(await file.text());
            if (!payload || payload.app !== "GRE List Lab" || !payload.state) {
                throw new Error("不是 GRE List Lab 进度文件");
            }
            const imported = payload.state;
            if (Array.isArray(payload.customBooks)) {
                const existingIds = new Set(BOOKS.map((book) => book.id));
                payload.customBooks.forEach((book) => {
                    if (!existingIds.has(book.id) && Array.isArray(book.groups)) {
                        book.isCustom = true;
                        BOOKS.push(book);
                        indexBook(book);
                        existingIds.add(book.id);
                    }
                });
                window.localStorage.setItem(
                    CUSTOM_BOOKS_KEY,
                    JSON.stringify(BOOKS.filter((book) => book.isCustom))
                );
            }
            state = {
                ...defaultState(),
                ...imported,
                route: "dashboard",
                settings: { ...DEFAULT_SETTINGS, ...(imported.settings || {}) },
                plans: Object.fromEntries(
                    BOOKS.map((book) => [
                        book.id,
                        {
                            ...DEFAULT_PLAN,
                            startDate: localDateKey(new Date()),
                            ...(imported.plans?.[book.id] || {}),
                        },
                    ])
                ),
            };
            saveState();
            closeSettings();
            render();
            toast("进度已恢复。");
        } catch (error) {
            toast(`导入失败：${error.message || error}`);
        }
    }

    function toast(message) {
        const region = document.querySelector(".toast-region");
        if (!region) {
            return;
        }
        const item = document.createElement("div");
        item.className = "toast";
        item.textContent = message;
        region.appendChild(item);
        window.setTimeout(() => item.remove(), 3200);
    }

    document.addEventListener("click", (event) => {
        const routeButton = event.target.closest("[data-route]");
        if (routeButton) {
            event.preventDefault();
            navigate(routeButton.dataset.route);
            return;
        }
        const trigger = event.target.closest("[data-action]");
        if (!trigger) {
            return;
        }
        const action = trigger.dataset.action;
        if (action === "mobile-menu") {
            document.body.classList.toggle("mobile-nav-open");
        } else if (action === "open-settings") {
            openSettings();
        } else if (action === "close-settings") {
            closeSettings();
        } else if (action === "open-book-import") {
            openBookImport();
        } else if (action === "close-book-import") {
            closeBookImport();
        } else if (action === "select-book") {
            selectBook(trigger.dataset.bookId, "dashboard");
        } else if (action === "open-book-lists") {
            selectBook(trigger.dataset.bookId, "lists");
        } else if (action === "study-book") {
            selectBook(trigger.dataset.bookId);
            startStudy({
                mode:
                    trigger.dataset.studyKind === "review"
                        ? "due-review"
                        : "new",
                studyMode: trigger.dataset.studyMode || "meaning",
            });
        } else if (action === "study-group") {
            startStudy({
                mode:
                    trigger.dataset.studyKind === "review"
                        ? "group-review"
                        : "group-new",
                groupIds: [trigger.dataset.groupId],
                studyMode: trigger.dataset.studyMode || "meaning",
            });
        } else if (action === "start-new") {
            startStudy({
                mode: "new",
                studyMode: trigger.dataset.studyMode || "meaning",
            });
        } else if (action === "start-review") {
            startStudy({
                mode: "due-review",
                studyMode: trigger.dataset.studyMode || "meaning",
            });
        } else if (action === "resume-study") {
            resumeSavedSession();
        } else if (action === "calendar-prev") {
            ui.calendarMonth = new Date(
                ui.calendarMonth.getFullYear(),
                ui.calendarMonth.getMonth() - 1,
                1,
                12
            );
            renderCalendar();
        } else if (action === "calendar-next") {
            ui.calendarMonth = new Date(
                ui.calendarMonth.getFullYear(),
                ui.calendarMonth.getMonth() + 1,
                1,
                12
            );
            renderCalendar();
        } else if (action === "calendar-today") {
            ui.calendarMonth = firstOfMonth(new Date());
            ui.calendarSelectedDate = localDateKey(new Date());
            renderCalendar();
        } else if (action === "select-calendar-date") {
            event.stopPropagation();
            ui.calendarSelectedDate = trigger.dataset.date;
            ui.calendarMonth = firstOfMonth(parseLocalDate(trigger.dataset.date));
            renderCalendar();
        } else if (action === "toggle-plan-task") {
            const key = trigger.dataset.taskKey;
            state.calendarChecks[key] = !state.calendarChecks[key];
            saveState();
            renderCalendar();
            renderGlobalChrome();
        } else if (action === "start-plan-task") {
            const task = planTaskMap.get(trigger.dataset.taskKey);
            if (task) {
                startStudy({
                    mode: task.type === "review" ? "plan-review" : "group-new",
                    groupIds: task.groupIds,
                    wordIds: task.wordIds,
                    taskKey: task.key,
                    taskType: task.type,
                    studyMode: "meaning",
                });
            }
        } else if (action === "save-and-leave-study") {
            persistStudySession();
            navigate("dashboard");
            toast("学习位置已保存，下次可以继续。");
        } else if (action === "speak-word") {
            speakCurrentWord();
        } else if (action === "choose-meaning") {
            chooseMeaning(trigger.dataset.choiceIndex);
        } else if (action === "submit-meaning") {
            submitMeaningInput();
        } else if (action === "confirm-semantic") {
            commitMeaningInput(trigger.dataset.semanticResult || "wrong");
        } else if (action === "submit-spelling") {
            submitSpelling(false);
        } else if (action === "skip-spelling") {
            submitSpelling(true);
        } else if (action === "next-word") {
            moveToNextWord();
        } else if (action === "next-batch") {
            loadNextBatch();
        } else if (action === "next-meaning-round") {
            startNextMeaningRound();
        } else if (action === "finish-session") {
            session = null;
            clearSavedSession();
            navigate("dashboard");
        } else if (action === "save-note") {
            const word = sessionWord();
            const input = document.querySelector('[data-field="word-note"]');
            if (word && input) {
                state.notes[word.id] = input.value.trim();
                saveState();
                toast("笔记已保存。");
            }
        } else if (action === "export-progress") {
            exportProgress();
        } else if (action === "import-progress") {
            document.querySelector('[data-field="progress-file"]')?.click();
        }
    });

    document.addEventListener("click", (event) => {
        const rating = event.target.closest("[data-quality]");
        if (rating) {
            rateMeaning(rating.dataset.quality);
        }
    });

    document.addEventListener("input", (event) => {
        if (event.target.matches('[data-field="list-search"]')) {
            ui.listQuery = event.target.value;
            renderLists();
            const input = document.querySelector('[data-field="list-search"]');
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
        }
        if (event.target.matches(".spelling-input") && session) {
            session.typed = event.target.value;
            persistStudySession();
        }
        if (event.target.matches(".meaning-input") && session) {
            session.typed = event.target.value;
            persistStudySession();
        }
    });

    document.addEventListener("change", (event) => {
        if (event.target.matches('[data-field="book-select"]')) {
            selectBook(event.target.value, state.route === "study" ? "dashboard" : state.route);
        } else if (event.target.matches('[data-field="plan-start"]')) {
            const book = currentBook();
            if (book && event.target.value) {
                state.plans[book.id] = {
                    ...DEFAULT_PLAN,
                    ...(state.plans[book.id] || {}),
                    startDate: event.target.value,
                };
                ui.calendarSelectedDate = event.target.value;
                ui.calendarMonth = firstOfMonth(parseLocalDate(event.target.value));
                saveState();
                renderCalendar();
            }
        } else if (event.target.matches('[data-field="plan-mode"]')) {
            const book = currentBook();
            if (book) {
                state.plans[book.id] = {
                    ...DEFAULT_PLAN,
                    ...(state.plans[book.id] || {}),
                    mode: event.target.value === "words" ? "words" : "lists",
                };
                saveState();
                renderCalendar();
                toast("计划已重排，学习进度保持不变。");
            }
        } else if (event.target.matches('[data-field="plan-lists"]')) {
            const book = currentBook();
            if (book) {
                state.plans[book.id] = {
                    ...DEFAULT_PLAN,
                    ...(state.plans[book.id] || {}),
                    listsPerDay: clamp(event.target.value, 1, 20),
                };
                saveState();
                renderCalendar();
                toast("每日 List 数已更新，学习进度保持不变。");
            }
        } else if (event.target.matches('[data-field="plan-words"]')) {
            const book = currentBook();
            if (book) {
                state.plans[book.id] = {
                    ...DEFAULT_PLAN,
                    ...(state.plans[book.id] || {}),
                    wordsPerDay: clamp(event.target.value, 1, 1000),
                };
                saveState();
                renderCalendar();
                toast("每日单词数已更新，学习进度保持不变。");
            }
        } else if (event.target.matches('[data-field="progress-file"]')) {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
                importProgress(file);
            }
        }
    });

    document.getElementById("settings-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        state.settings = {
            dailyNew: clamp(data.get("dailyNew"), 5, BATCH_SIZE),
            reviewLimit: clamp(data.get("reviewLimit"), 1, 300),
            masteryCount: clamp(data.get("masteryCount"), 1, 10),
        };
        saveState();
        closeSettings();
        render();
        toast("学习设置已保存。");
    });

    document.getElementById("book-import-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('[type="submit"]');
        if (button) {
            button.disabled = true;
            button.textContent = "正在识别…";
        }
        try {
            await importCustomBook(event.currentTarget);
        } catch (error) {
            toast(`导入失败：${error.message || error}`);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "导入并生成计划";
            }
        }
    });

    document.addEventListener("keydown", (event) => {
        const settingsOpen = !document.querySelector('[data-modal="settings"]')?.hidden;
        const bookImportOpen = !document.querySelector('[data-modal="book-import"]')?.hidden;
        if (settingsOpen || bookImportOpen) {
            if (event.key === "Escape") {
                if (settingsOpen) {
                    closeSettings();
                }
                if (bookImportOpen) {
                    closeBookImport();
                }
            }
            return;
        }
        if (!session || state.route !== "study") {
            return;
        }
        if (event.key === "Enter") {
            if (session.stage === "spelling") {
                event.preventDefault();
                submitSpelling(false);
            } else if (
                session.stage === "meaning-round-3" &&
                !event.shiftKey
            ) {
                event.preventDefault();
                submitMeaningInput();
            } else if (session.stage === "feedback") {
                event.preventDefault();
                moveToNextWord();
            } else if (session.stage === "round-finished") {
                event.preventDefault();
                startNextMeaningRound();
            }
        } else if (event.key === "Escape") {
            persistStudySession();
            navigate("dashboard");
            toast("学习位置已保存。");
        }
    });

    render();
})(window, document);
