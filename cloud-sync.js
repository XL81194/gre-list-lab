(function initGreCloudSync(window, document) {
    "use strict";

    const STORAGE_KEY = "gre-list-lab-state-v1";
    const CLOUD_META_KEY = "gre-list-lab-cloud-meta-v1";
    const FEEDBACK_QUEUE_KEY = "gre-list-lab-feedback-queue-v1";
    const config = window.GRE_SYNC_CONFIG || {};
    const cloud = {
        client: null,
        session: null,
        ready: false,
        syncing: false,
        resyncRequested: false,
        timer: null,
        pollTimer: null,
        status: "local",
        lastError: "",
    };

    function configured() {
        return Boolean(
            config.enabled &&
            config.supabaseUrl &&
            config.supabasePublishableKey &&
            window.supabase?.createClient
        );
    }

    function readJson(key, fallback) {
        try {
            const value = JSON.parse(window.localStorage.getItem(key) || "null");
            return value ?? fallback;
        } catch (error) {
            console.warn(`[GRE List Lab] 无法读取 ${key}`, error);
            return fallback;
        }
    }

    function writeJson(key, value) {
        window.localStorage.setItem(key, JSON.stringify(value));
    }

    function readLocalState() {
        return readJson(STORAGE_KEY, null);
    }

    function cloudMeta() {
        const current = readJson(CLOUD_META_KEY, {});
        if (!current.clientId) {
            current.clientId = window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            writeJson(CLOUD_META_KEY, current);
        }
        return current;
    }

    function updateCloudMeta(patch) {
        const next = { ...cloudMeta(), ...patch };
        writeJson(CLOUD_META_KEY, next);
        return next;
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
        window.setTimeout(() => item.remove(), 3600);
    }

    function formatSyncTime(value) {
        const date = new Date(value || "");
        if (Number.isNaN(date.getTime())) {
            return "尚未同步";
        }
        return new Intl.DateTimeFormat("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    }

    function statusCopy() {
        if (!configured()) {
            return { label: "仅本机保存", detail: "云同步正在配置", className: "is-local" };
        }
        if (cloud.syncing) {
            return { label: "正在同步", detail: "请稍候…", className: "is-syncing" };
        }
        if (!cloud.session) {
            return { label: "本机已保存", detail: "登录后可跨设备同步", className: "is-local" };
        }
        if (cloud.status === "error") {
            return { label: "本机已保存", detail: "云端暂时未同步", className: "is-error" };
        }
        const meta = cloudMeta();
        return {
            label: "云端已同步",
            detail: meta.lastSyncedAt ? formatSyncTime(meta.lastSyncedAt) : "正在准备首次同步",
            className: "is-synced",
        };
    }

    function renderCloudStatus() {
        const copy = statusCopy();
        document.querySelectorAll("[data-cloud-status]").forEach((item) => {
            item.textContent = copy.label;
            item.className = `cloud-status ${copy.className}`;
        });
        document.querySelectorAll("[data-cloud-detail]").forEach((item) => {
            item.textContent = copy.detail;
        });
        document.querySelectorAll("[data-cloud-email]").forEach((item) => {
            item.textContent = cloud.session?.user?.email || "未登录";
        });
        document.querySelectorAll("[data-cloud-signed-in]").forEach((item) => {
            item.hidden = !cloud.session;
        });
        document.querySelectorAll("[data-cloud-signed-out]").forEach((item) => {
            item.hidden = Boolean(cloud.session);
        });
        document.querySelectorAll("[data-requires-cloud]").forEach((item) => {
            item.disabled = !configured();
        });
        document.querySelectorAll("[data-cloud-configured]").forEach((item) => {
            item.hidden = !configured();
        });
        document.querySelectorAll("[data-cloud-unconfigured]").forEach((item) => {
            item.hidden = configured();
        });
    }

    function activityTime(progress) {
        const values = [
            progress?.lastReviewed,
            progress?.voluntaryReviewLast,
            progress?.firstLearnedAt,
            progress?.sprint?.lastRecognitionAt,
            progress?.sprint?.redEnteredAt,
            progress?.sprint?.redClearedAt,
            ...Object.values(progress?.equivalence?.passes || {}).flatMap((record) => [
                record?.lastAnsweredAt,
                record?.completedAt,
            ]),
        ];
        return Math.max(
            0,
            ...values.map((value) => new Date(value || 0).getTime()).filter(Number.isFinite)
        );
    }

    function unionStrings(first, second) {
        return [...new Set([...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])])];
    }

    function mergeNumberMap(first, second) {
        const result = { ...(first || {}) };
        Object.entries(second || {}).forEach(([key, value]) => {
            result[key] = Math.max(Number(result[key] || 0), Number(value || 0));
        });
        return result;
    }

    function timestamp(value) {
        const time = new Date(value || 0).getTime();
        return Number.isFinite(time) ? time : 0;
    }

    function earlierDate(first, second) {
        if (!first) {
            return second || null;
        }
        if (!second) {
            return first;
        }
        return timestamp(first) <= timestamp(second) ? first : second;
    }

    function laterDate(first, second) {
        if (!first) {
            return second || null;
        }
        if (!second) {
            return first;
        }
        return timestamp(first) >= timestamp(second) ? first : second;
    }

    function mergeDailyStats(localStats, remoteStats) {
        const result = {};
        const dates = new Set([
            ...Object.keys(localStats || {}),
            ...Object.keys(remoteStats || {}),
        ]);
        dates.forEach((date) => {
            const local = localStats?.[date] || {};
            const remote = remoteStats?.[date] || {};
            result[date] = {
                ...remote,
                ...local,
                fastAttempts: Math.max(
                    Number(local.fastAttempts || 0),
                    Number(remote.fastAttempts || 0)
                ),
                fastCorrect: Math.max(
                    Number(local.fastCorrect || 0),
                    Number(remote.fastCorrect || 0)
                ),
                reviews: Math.max(
                    Number(local.reviews || 0),
                    Number(remote.reviews || 0)
                ),
                redCleared: Math.max(
                    Number(local.redCleared || 0),
                    Number(remote.redCleared || 0)
                ),
            };
        });
        return result;
    }

    function mergeSprint(localSprint, remoteSprint, preferLocal) {
        const primary = preferLocal ? localSprint || {} : remoteSprint || {};
        const secondary = preferLocal ? remoteSprint || {} : localSprint || {};
        return {
            ...secondary,
            ...primary,
            dailyStats: mergeDailyStats(
                localSprint?.dailyStats,
                remoteSprint?.dailyStats
            ),
        };
    }

    function mergeEquivalence(localEq, remoteEq, preferLocal) {
        const primary = preferLocal ? localEq || {} : remoteEq || {};
        const secondary = preferLocal ? remoteEq || {} : localEq || {};
        const passes = {};
        const passKeys = new Set([
            ...Object.keys(localEq?.passes || {}),
            ...Object.keys(remoteEq?.passes || {}),
        ]);
        passKeys.forEach((key) => {
            const localRecord = localEq?.passes?.[key] || {};
            const remoteRecord = remoteEq?.passes?.[key] || {};
            const localTime = Math.max(
                new Date(localRecord.lastAnsweredAt || 0).getTime(),
                new Date(localRecord.completedAt || 0).getTime()
            );
            const remoteTime = Math.max(
                new Date(remoteRecord.lastAnsweredAt || 0).getTime(),
                new Date(remoteRecord.completedAt || 0).getTime()
            );
            passes[key] = {
                ...(localTime >= remoteTime ? remoteRecord : localRecord),
                ...(localTime >= remoteTime ? localRecord : remoteRecord),
                attempts: Math.max(Number(localRecord.attempts || 0), Number(remoteRecord.attempts || 0)),
                correct: Math.max(Number(localRecord.correct || 0), Number(remoteRecord.correct || 0)),
            };
        });
        return {
            ...secondary,
            ...primary,
            passes,
            attempts: Math.max(Number(localEq?.attempts || 0), Number(remoteEq?.attempts || 0)),
            correct: Math.max(Number(localEq?.correct || 0), Number(remoteEq?.correct || 0)),
            weakReviewAttempts: Math.max(
                Number(localEq?.weakReviewAttempts || 0),
                Number(remoteEq?.weakReviewAttempts || 0)
            ),
            errorCounts: mergeNumberMap(localEq?.errorCounts, remoteEq?.errorCounts),
            weakReviewDates: unionStrings(localEq?.weakReviewDates, remoteEq?.weakReviewDates).sort(),
            completedWeakReviewDates: unionStrings(
                localEq?.completedWeakReviewDates,
                remoteEq?.completedWeakReviewDates
            ).sort(),
        };
    }

    function mergeWordProgress(localProgress, remoteProgress) {
        if (!localProgress) {
            return remoteProgress;
        }
        if (!remoteProgress) {
            return localProgress;
        }
        const preferLocal = activityTime(localProgress) >= activityTime(remoteProgress);
        const primary = preferLocal ? localProgress : remoteProgress;
        const secondary = preferLocal ? remoteProgress : localProgress;
        return {
            ...secondary,
            ...primary,
            firstLearnedAt: earlierDate(
                localProgress.firstLearnedAt,
                remoteProgress.firstLearnedAt
            ),
            correctCount: Math.max(
                Number(localProgress.correctCount || 0),
                Number(remoteProgress.correctCount || 0)
            ),
            voluntaryReviewCount: Math.max(
                Number(localProgress.voluntaryReviewCount || 0),
                Number(remoteProgress.voluntaryReviewCount || 0)
            ),
            voluntaryReviewCorrect: Math.max(
                Number(localProgress.voluntaryReviewCorrect || 0),
                Number(remoteProgress.voluntaryReviewCorrect || 0)
            ),
            equivalence: mergeEquivalence(
                localProgress.equivalence,
                remoteProgress.equivalence,
                preferLocal
            ),
            sprint: {
                ...(preferLocal
                    ? remoteProgress.sprint || {}
                    : localProgress.sprint || {}),
                ...(preferLocal
                    ? localProgress.sprint || {}
                    : remoteProgress.sprint || {}),
            },
        };
    }

    function mergeProgress(localProgress, remoteProgress) {
        const result = {};
        const bookIds = new Set([
            ...Object.keys(localProgress || {}),
            ...Object.keys(remoteProgress || {}),
        ]);
        bookIds.forEach((bookId) => {
            result[bookId] = {};
            const wordIds = new Set([
                ...Object.keys(localProgress?.[bookId] || {}),
                ...Object.keys(remoteProgress?.[bookId] || {}),
            ]);
            wordIds.forEach((wordId) => {
                result[bookId][wordId] = mergeWordProgress(
                    localProgress?.[bookId]?.[wordId],
                    remoteProgress?.[bookId]?.[wordId]
                );
            });
        });
        return result;
    }

    function mergeChecks(localChecks, remoteChecks) {
        const result = { ...(remoteChecks || {}) };
        Object.entries(localChecks || {}).forEach(([key, value]) => {
            result[key] = Boolean(value || result[key]);
        });
        return result;
    }

    function mergeReviewCursors(localCursors, remoteCursors) {
        const result = { ...(remoteCursors || {}) };
        Object.entries(localCursors || {}).forEach(([key, localCursor]) => {
            const remoteCursor = result[key];
            result[key] = !remoteCursor || timestamp(localCursor?.updatedAt) >= timestamp(remoteCursor?.updatedAt)
                ? localCursor
                : remoteCursor;
        });
        return result;
    }

    function mergeStates(localState, remoteState, remoteUpdatedAt = null) {
        if (!localState) {
            return remoteState;
        }
        if (!remoteState) {
            return localState;
        }
        const localTime = timestamp(localState.updatedAt);
        // `updated_at` belongs to the database row, not to the study state. Every
        // upsert changes it, so copying it back into state.updatedAt creates a
        // write -> newer row timestamp -> reload -> write loop. Only use it as a
        // compatibility fallback for old cloud states that have no own timestamp.
        const remoteStateTime = timestamp(remoteState.updatedAt);
        const remoteTime = remoteStateTime || timestamp(remoteUpdatedAt);
        const preferLocal = localTime >= remoteTime;
        const primary = preferLocal ? localState : remoteState;
        const secondary = preferLocal ? remoteState : localState;
        return {
            ...secondary,
            ...primary,
            version: Math.max(Number(localState.version || 1), Number(remoteState.version || 1)),
            route: "dashboard",
            updatedAt: laterDate(localState.updatedAt, remoteState.updatedAt),
            settings: {
                ...(secondary.settings || {}),
                ...(primary.settings || {}),
            },
            plans: {
                ...(secondary.plans || {}),
                ...(primary.plans || {}),
            },
            notes: {
                ...(secondary.notes || {}),
                ...(primary.notes || {}),
            },
            progress: mergeProgress(localState.progress, remoteState.progress),
            calendarChecks: mergeChecks(localState.calendarChecks, remoteState.calendarChecks),
            voluntaryReviewCursors: mergeReviewCursors(
                localState.voluntaryReviewCursors,
                remoteState.voluntaryReviewCursors
            ),
            equivalenceReplayCursors: mergeReviewCursors(
                localState.equivalenceReplayCursors,
                remoteState.equivalenceReplayCursors
            ),
            sprint: mergeSprint(localState.sprint, remoteState.sprint, preferLocal),
            savedSession: primary.savedSession || secondary.savedSession || null,
        };
    }

    function stateContent(state) {
        if (!state) {
            return "{}";
        }
        const comparable = { ...state };
        // These fields do not change what the user sees after a reload. Excluding
        // them prevents a harmless timestamp or route normalization from causing
        // a refresh, while the full state is still saved locally and remotely.
        delete comparable.updatedAt;
        delete comparable.route;
        return JSON.stringify(comparable);
    }

    async function synchronize({
        reloadIfChanged = false,
        announce = false,
        queueIfBusy = false,
    } = {}) {
        if (!cloud.client || !cloud.session) {
            return false;
        }
        if (cloud.syncing) {
            // Only a local study save needs a guaranteed follow-up upload.
            // Focus/pageshow/auth/poll events are read checks and may fire in a
            // burst; queuing all of them can keep the app syncing forever when a
            // request lasts longer than the polling interval.
            if (queueIfBusy) {
                cloud.resyncRequested = true;
            }
            return false;
        }
        cloud.syncing = true;
        cloud.status = "syncing";
        cloud.lastError = "";
        renderCloudStatus();
        try {
            const userId = cloud.session.user.id;
            const localState = readLocalState();
            const { data, error } = await cloud.client
                .from("user_progress")
                .select("state, updated_at")
                .eq("user_id", userId)
                .maybeSingle();
            if (error) {
                throw error;
            }
            const merged = mergeStates(
                localState,
                data?.state || null,
                data?.updated_at || null
            );
            const localSerialized = JSON.stringify(localState || {});
            const mergedSerialized = JSON.stringify(merged || {});
            const remoteSerialized = JSON.stringify(data?.state || {});
            const learningContentChanged = stateContent(localState) !== stateContent(merged);
            if (merged && mergedSerialized !== localSerialized) {
                window.localStorage.setItem(STORAGE_KEY, mergedSerialized);
            }
            if (!data || mergedSerialized !== remoteSerialized) {
                const { error: saveError } = await cloud.client.from("user_progress").upsert(
                    {
                        user_id: userId,
                        state: merged || {},
                        client_updated_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "user_id" }
                );
                if (saveError) {
                    throw saveError;
                }
            }
            updateCloudMeta({ lastSyncedAt: new Date().toISOString() });
            cloud.status = "synced";
            if (announce) {
                toast("学习进度已同步到云端。");
            }
            if (learningContentChanged) {
                // Update the in-memory app without reloading the document. A full
                // reload can re-trigger auth, pageshow and polling events and was
                // the final route by which slow devices could enter a refresh loop.
                window.dispatchEvent(new CustomEvent("gre:cloud-state-updated"));
            }
            return true;
        } catch (error) {
            console.warn("[GRE List Lab] 云同步失败", error);
            cloud.status = "error";
            cloud.lastError = String(error?.message || error || "未知错误");
            if (announce) {
                toast("云端暂时没有同步成功，本机进度仍已安全保存。");
            }
            return false;
        } finally {
            cloud.syncing = false;
            renderCloudStatus();
            if (cloud.resyncRequested) {
                cloud.resyncRequested = false;
                window.setTimeout(() => synchronize({ reloadIfChanged: true }), 0);
            }
        }
    }

    function scheduleSync() {
        if (!cloud.session || !cloud.ready) {
            return;
        }
        window.clearTimeout(cloud.timer);
        cloud.timer = window.setTimeout(() => synchronize({ queueIfBusy: true }), 1600);
    }

    function pullLatestProgress() {
        if (
            document.visibilityState === "hidden" ||
            !cloud.session ||
            !cloud.ready ||
            cloud.syncing
        ) {
            return;
        }
        synchronize({ reloadIfChanged: true });
    }

    function startForegroundPolling() {
        window.clearInterval(cloud.pollTimer);
        cloud.pollTimer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                pullLatestProgress();
            }
        }, 15000);
    }

    async function sendMagicLink(email) {
        if (!configured()) {
            toast("云同步还没有完成配置。");
            return;
        }
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { error } = await cloud.client.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
        });
        if (error) {
            throw error;
        }
        toast("登录链接已发送，请到邮箱中打开。");
    }

    async function signOut() {
        if (!cloud.client) {
            return;
        }
        await synchronize();
        await cloud.client.auth.signOut();
        cloud.session = null;
        cloud.status = "local";
        renderCloudStatus();
        toast("已退出云同步，本机进度仍然保留。");
    }

    async function deleteCloudProgress() {
        if (!cloud.client || !cloud.session) {
            return;
        }
        const confirmed = window.confirm(
            "确定删除云端学习进度吗？本机进度不会删除，之后仍可重新同步。"
        );
        if (!confirmed) {
            return;
        }
        const { error } = await cloud.client
            .from("user_progress")
            .delete()
            .eq("user_id", cloud.session.user.id);
        if (error) {
            toast("云端进度删除失败，请稍后再试。");
            return;
        }
        updateCloudMeta({ lastSyncedAt: null });
        toast("云端学习进度已删除，本机进度仍然保留。");
        renderCloudStatus();
    }

    function feedbackContext() {
        const state = readLocalState() || {};
        const saved = state.savedSession || {};
        return {
            appVersion: config.appVersion || "unknown",
            selectedBookId: state.selectedBookId || "",
            route: state.route || "",
            studyMode: saved.studyMode || "",
            groupIds: Array.isArray(saved.sourceGroupIds) ? saved.sourceGroupIds.slice(0, 4) : [],
            currentWordId: saved.current?.wordId || "",
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            browser: /Edg\//.test(navigator.userAgent)
                ? "Edge"
                : /Chrome\//.test(navigator.userAgent)
                  ? "Chrome"
                  : /Safari\//.test(navigator.userAgent)
                    ? "Safari"
                    : /Firefox\//.test(navigator.userAgent)
                      ? "Firefox"
                      : "Other",
        };
    }

    function queuedFeedback() {
        return readJson(FEEDBACK_QUEUE_KEY, []);
    }

    function queueFeedback(payload) {
        const queue = queuedFeedback();
        queue.push(payload);
        writeJson(FEEDBACK_QUEUE_KEY, queue.slice(-20));
    }

    async function transmitFeedback(payload) {
        if (!cloud.client) {
            return false;
        }
        const { error } = await cloud.client.from("feedback").insert({
            user_id: cloud.session?.user?.id || null,
            client_id: cloudMeta().clientId,
            category: payload.category,
            impact: payload.impact,
            message: payload.message,
            contact: payload.contact || null,
            context: payload.context,
            created_at: payload.createdAt,
        });
        if (error) {
            throw error;
        }
        return true;
    }

    async function flushFeedbackQueue() {
        if (!cloud.client) {
            return;
        }
        const queue = queuedFeedback();
        if (!queue.length) {
            return;
        }
        const remaining = [];
        for (const item of queue) {
            try {
                await transmitFeedback(item);
            } catch (error) {
                remaining.push(item);
            }
        }
        writeJson(FEEDBACK_QUEUE_KEY, remaining);
    }

    async function submitFeedback(form) {
        const data = new FormData(form);
        if (String(data.get("website") || "")) {
            return;
        }
        const message = String(data.get("message") || "").trim();
        if (message.length < 4) {
            toast("请再具体描述一下问题，至少填写4个字。");
            return;
        }
        const meta = cloudMeta();
        if (meta.lastFeedbackAt && Date.now() - new Date(meta.lastFeedbackAt).getTime() < 30000) {
            toast("反馈已收到，请稍等一会儿再提交下一条。");
            return;
        }
        const payload = {
            category: String(data.get("category") || "suggestion"),
            impact: String(data.get("impact") || "minor"),
            message: message.slice(0, 2000),
            contact: String(data.get("contact") || "").trim().slice(0, 160),
            context: feedbackContext(),
            createdAt: new Date().toISOString(),
        };
        let sent = false;
        if (cloud.client) {
            try {
                sent = await transmitFeedback(payload);
            } catch (error) {
                console.warn("[GRE List Lab] 反馈提交失败，已进入本机队列", error);
            }
        }
        if (!sent) {
            queueFeedback(payload);
        }
        updateCloudMeta({ lastFeedbackAt: new Date().toISOString() });
        form.reset();
        closeModal("feedback");
        toast(sent ? "感谢反馈，已经提交成功。" : "反馈已暂存在本机，云端接通后会自动发送。");
    }

    function openModal(name) {
        const modal = document.querySelector(`[data-modal="${name}"]`);
        if (!modal) {
            return;
        }
        renderCloudStatus();
        modal.hidden = false;
        const focusTarget = modal.querySelector("input:not([type=hidden]), textarea, button");
        window.setTimeout(() => focusTarget?.focus(), 0);
    }

    function closeModal(name) {
        const modal = document.querySelector(`[data-modal="${name}"]`);
        if (modal) {
            modal.hidden = true;
        }
    }

    async function initialize() {
        cloudMeta();
        renderCloudStatus();
        if (!configured()) {
            return;
        }
        cloud.client = window.supabase.createClient(
            config.supabaseUrl,
            config.supabasePublishableKey,
            {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true,
                },
            }
        );
        cloud.client.auth.onAuthStateChange((event, session) => {
            cloud.session = session;
            renderCloudStatus();
            if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
                window.setTimeout(() => synchronize({ reloadIfChanged: event === "SIGNED_IN" }), 0);
            }
        });
        const { data, error } = await cloud.client.auth.getSession();
        if (error) {
            cloud.status = "error";
        } else {
            cloud.session = data.session;
            cloud.status = cloud.session ? "synced" : "local";
        }
        cloud.ready = true;
        renderCloudStatus();
        if (cloud.session) {
            await synchronize({ reloadIfChanged: true });
        }
        startForegroundPolling();
        await flushFeedbackQueue();
    }

    window.addEventListener("gre:state-saved", scheduleSync);

    document.addEventListener("click", async (event) => {
        const trigger = event.target.closest("[data-cloud-action]");
        if (!trigger) {
            return;
        }
        const action = trigger.dataset.cloudAction;
        if (action === "open-sync") {
            openModal("cloud-sync");
        } else if (action === "close-sync") {
            closeModal("cloud-sync");
        } else if (action === "open-feedback") {
            openModal("feedback");
        } else if (action === "close-feedback") {
            closeModal("feedback");
        } else if (action === "open-privacy") {
            openModal("privacy");
        } else if (action === "close-privacy") {
            closeModal("privacy");
        } else if (action === "sync-now") {
            await synchronize({ announce: true, reloadIfChanged: true });
        } else if (action === "sign-out") {
            await signOut();
        } else if (action === "delete-cloud-progress") {
            await deleteCloudProgress();
        }
    });

    document.getElementById("cloud-login-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const email = String(new FormData(event.currentTarget).get("email") || "").trim();
        if (!email) {
            return;
        }
        const button = event.currentTarget.querySelector("[type=submit]");
        if (button) {
            button.disabled = true;
            button.textContent = "正在发送…";
        }
        try {
            await sendMagicLink(email);
        } catch (error) {
            console.warn("[GRE List Lab] 邮箱登录失败", error);
            toast("登录链接发送失败，请检查邮箱后重试。");
        } finally {
            if (button) {
                button.disabled = !configured();
                button.textContent = "发送登录链接";
            }
        }
    });

    document.getElementById("feedback-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector("[type=submit]");
        if (button) {
            button.disabled = true;
        }
        try {
            await submitFeedback(event.currentTarget);
        } finally {
            if (button) {
                button.disabled = false;
            }
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }
        ["cloud-sync", "feedback", "privacy"].forEach(closeModal);
    });

    window.addEventListener("focus", pullLatestProgress);
    window.addEventListener("online", pullLatestProgress);
    window.addEventListener("pageshow", pullLatestProgress);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            pullLatestProgress();
        }
    });

    window.GRE_CLOUD = {
        synchronize,
        getStatus: () => ({
            configured: configured(),
            signedIn: Boolean(cloud.session),
            status: cloud.status,
            lastError: cloud.lastError,
            lastSyncedAt: cloudMeta().lastSyncedAt || null,
        }),
    };

    initialize();
})(window, document);
