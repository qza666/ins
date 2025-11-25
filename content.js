(async function () {
    if (!location.hostname.includes("instagram.com")) return;

    const CONFIG = {
        API_BASE: "https://ins.trtrc.com/api/",
        INS_BASE: "https://www.instagram.com/",
        STORAGE_KEY: "IG_CARD_AUTH",
        DB_KEY: "IG_LIKERS_DB",
        HEADERS: { "Content-Type": "application/json" },
        FILTER: {
            MIN_LIKES: 10,
            MAX_HOURS: 24,
            SCAN_LIMIT: 100,
            DEEP: {
                MAX_FOLLOWING: 500,
                CONCURRENCY: 100
            }
        },
        DELAY: {
            TAG_SWITCH_MIN: 10 * 60 * 1000,
            TAG_SWITCH_MAX: 20 * 60 * 1000,
            PAGE_MIN: 5 * 60 * 1000,
            PAGE_MAX: 10 * 60 * 1000,
            DB_FULL_MIN: 5 * 60 * 1000,
            DB_FULL_MAX: 10 * 60 * 1000
        },
        ACTION: {
            LIKE_MIN_DELAY: 60 * 1000,
            LIKE_MAX_DELAY: 120 * 1000,
            FOLLOW_RATE: 0.05
        }
    };

    const MIN_TAG_MEDIA_COUNT = 20000;
    const $ = (id) => document.getElementById(id);

    // ================= UI 初始化 =================
    const initPanel = async () => {
        // 防止重复注入
        if ($("igApp")) return;
        try {
            const html = await (await fetch(chrome.runtime.getURL("panel.html"))).text();
            const wrapper = document.createElement("div");
            wrapper.innerHTML = html;
            document.body.appendChild(wrapper.firstElementChild);
        } catch (e) {
            console.error("Panel Init Error:", e);
        }
    };
    await initPanel();

    const initInjectedScript = () => {
        if (document.getElementById("ig-injected-script")) return;
        const s = document.createElement("script");
        s.id = "ig-injected-script";
        s.src = chrome.runtime.getURL("injected.js");
        (document.head || document.documentElement).appendChild(s);
        s.onload = () => s.remove();
    };
    initInjectedScript();

    const UI = {
        app: $("igApp"),
        loginCard: $("igLoginCard"),
        backdrop: $("igModalBackdrop"),
        btnFloat: $("igFloatingBtn"),
        btnIcon: $("igFloatingIcon"),
        brandIcon: $("igBrandIcon"),
        inputKey: $("igInputCardKey"),
        btnLogin: $("igBtnLogin"),
        btnLoginText: $("igBtnLoginText"),
        loginSpinner: $("igLoginSpinner"),
        btnChange: $("igBtnChangeKey"),
        errorText: $("igErrorText"),
        countText: $("igCountdownText"),
        expireText: $("igExpireAtText"),
        keyText: $("igKeyShort"),
        toggle: $("igToggleGrowth"),
        statusText: $("igGrowthStatusText"),
        statFollowersNow: $("igFollowersNow"),
        statFollowingTotal: $("igFollowingTotal"),
        statLikesTotal: $("igLikesTotal"),

        initIcons() {
            if (this.btnIcon) this.btnIcon.src = chrome.runtime.getURL("icons/icon32.png");
            if (this.brandIcon) this.brandIcon.src = chrome.runtime.getURL("icons/icon48.png");
        },

        showLogin(showLoginCard) {
            if (!this.app || !this.backdrop || !this.loginCard) return;
            const shouldShowLogin = !!showLoginCard;

            this.backdrop.style.display = shouldShowLogin ? "flex" : "none";
            this.loginCard.style.display = shouldShowLogin ? "block" : "none";
            this.app.style.display = shouldShowLogin ? "none" : "block";

            // 悬浮按钮在未登录时不需要展示
            if (this.btnFloat) this.btnFloat.style.display = shouldShowLogin ? "none" : "flex";
        },

        toast(msg, type = "error") {
            if (!this.app) return;
            const toast = document.createElement("div");
            toast.className = "ig-custom-toast";
            toast.style.cssText = [
                "position:absolute",
                "top:60px",
                "left:50%",
                "transform:translateX(-50%)",
                `background:${type === "success" ? "#10b981" : "#ef4444"}`,
                "color:#fff",
                "padding:8px 16px",
                "border-radius:20px",
                "font-size:12px",
                "font-weight:500",
                "z-index:9999",
                "transition:opacity 0.3s",
                "pointer-events:none",
                "white-space:nowrap",
                "opacity:0",
                "box-shadow: 0 4px 6px rgba(0,0,0,0.1)"
            ].join(";");
            toast.textContent = msg;
            // 挂载到 body 避免被 app 的 overflow 隐藏
            document.body.appendChild(toast);
            
            // 计算位置：相对于 app 或者屏幕居中
            const rect = this.app.getBoundingClientRect();
            if (rect.width > 0) {
                 toast.style.top = (rect.top + 60) + "px";
                 toast.style.left = (rect.left + rect.width/2) + "px";
            } else {
                 toast.style.top = "20px";
                 toast.style.left = "50%";
                 toast.style.position = "fixed";
            }

            requestAnimationFrame(() => (toast.style.opacity = "1"));
            setTimeout(() => {
                toast.style.opacity = "0";
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        },

        forceOff(text = "已关闭") {
            this.toggle.checked = false;
            this.setStatus(text);
        },

        setStatus(text) {
            // 仅当是主要采集任务时才更新此文本，避免闪烁
            if (this.statusText) this.statusText.textContent = text;
        },

        updateStats(followers, following = 0, likes = 0) {
            this.statFollowersNow.textContent = followers;
            this.statFollowingTotal.textContent = following;
            this.statLikesTotal.textContent = likes;
        },

        incrementLikes() {
            let current = parseInt(this.statLikesTotal.textContent) || 0;
            this.statLikesTotal.textContent = current + 1;
        }
    };
    UI.initIcons();

    let currentKey = null;
    let countdownTimer = null;
    let likersDatabase = {}; 
    let processedUsersSet = new Set(); 

    // ================= 工具类 =================
    const Utils = {
        getCookie(name) {
            const value = `; ${document.cookie}`;
            const parts = value.split(`; ${name}=`);
            return parts.length === 2 ? parts.pop().split(";").shift() : null;
        },

        getWebSessionId() {
            return new Promise((resolve) => {
                const onMsg = (e) => {
                    if (e.source !== window || e.data?.type !== "WEBSESSION_ID") return;
                    window.removeEventListener("message", onMsg);
                    resolve(e.data.id || null);
                };
                window.addEventListener("message", onMsg);
                window.postMessage({ type: "GET_WEBSESSION_ID" }, "*");
                setTimeout(() => {
                    window.removeEventListener("message", onMsg);
                    resolve(null);
                }, 3000);
            });
        },

        getUuid() {
            let uuid = localStorage.getItem("ig_uuid");
            if (!uuid) {
                uuid = "dev-" + Date.now() + Math.random().toString(36).slice(2);
                localStorage.setItem("ig_uuid", uuid);
            }
            return uuid;
        },
        
        formatTime(ms) {
            const totalSec = Math.max(0, Math.floor(ms / 1000));
            const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
            const s = String(totalSec % 60).padStart(2, '0');
            return `${m}:${s}`;
        },

        // [修复] 核心修复：使用 Date.now() 解决浏览器后台节流导致的时间变慢问题
        async sleepWithCountdown(min, max, prefixMsg = "等待冷却", updateUI = true) {
            const totalMs = Math.floor(Math.random() * (max - min + 1) + min);
            const endTime = Date.now() + totalMs;
            
            return new Promise(resolve => {
                // 立即执行一次
                if (updateUI) UI.setStatus(`${prefixMsg}... 剩余 ${Utils.formatTime(totalMs)}`);

                const interval = setInterval(() => {
                    if (!UI.toggle.checked) {
                        clearInterval(interval);
                        resolve();
                        return;
                    }

                    const remaining = endTime - Date.now();
                    if (remaining <= 0) {
                        clearInterval(interval);
                        resolve();
                    } else {
                        if (updateUI) {
                            UI.setStatus(`${prefixMsg}... 剩余 ${Utils.formatTime(remaining)}`);
                        }
                    }
                }, 1000); // 即使浏览器将此延迟到1分钟执行一次，remaining 计算依然准确
            });
        },

        async sleep(min, max) {
            const ms = Math.floor(Math.random() * (max - min + 1) + min);
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        async runBatch(items, fn, concurrency = 100) {
            const results = [];
            const queue = [...items];
            
            // 使用递归 Promise 实现并发控制
            const worker = async () => {
                while (queue.length > 0 && UI.toggle.checked) {
                    const item = queue.shift();
                    try {
                        const res = await fn(item);
                        results.push(res);
                    } catch (e) {
                        console.error("Batch Error", e);
                    }
                }
            };

            const workers = Array(Math.min(items.length, concurrency)).fill(null).map(() => worker());
            await Promise.all(workers);
            return results;
        },

        Db: {
            async load() {
                const data = await new Promise(resolve => 
                    chrome.storage.local.get([CONFIG.DB_KEY, "IG_PROCESSED_USERS"], resolve)
                );
                likersDatabase = data[CONFIG.DB_KEY] || {};
                const processedList = data["IG_PROCESSED_USERS"] || [];
                processedUsersSet = new Set(processedList);
                Utils.Db.updateTotalStats();
            },

            async save() {
                const processedList = Array.from(processedUsersSet);
                await chrome.storage.local.set({ 
                    [CONFIG.DB_KEY]: likersDatabase,
                    "IG_PROCESSED_USERS": processedList
                });
            },
            
            async addResult(postPk, results) {
                const existingLikers = likersDatabase[postPk] || [];
                const existingUserIds = new Set(existingLikers.map(l => l.id));
                const newLikers = results.filter(liker => 
                    !existingUserIds.has(liker.id) && !processedUsersSet.has(liker.id)
                );

                if (newLikers.length > 0) {
                    likersDatabase[postPk] = existingLikers.concat(newLikers);
                    await Utils.Db.save();
                    Utils.Db.updateTotalStats();
                }
                return newLikers.length;
            },

            async extractRandomLiker() {
                const pks = Object.keys(likersDatabase).filter(pk => likersDatabase[pk].length > 0);
                if (pks.length === 0) return null;

                const randomPkIndex = Math.floor(Math.random() * pks.length);
                const randomPk = pks[randomPkIndex];
                
                const likers = likersDatabase[randomPk];
                const randomLikerIndex = Math.floor(Math.random() * likers.length);
                const liker = likers.splice(randomLikerIndex, 1)[0]; 
                
                processedUsersSet.add(liker.id); 

                // 清理空键值
                if (likers.length === 0) {
                    delete likersDatabase[randomPk];
                }

                await Utils.Db.save();
                Utils.Db.updateTotalStats();

                return liker; 
            },

            updateTotalStats() {
                let totalLikers = 0;
                for (const pk in likersDatabase) {
                    totalLikers += likersDatabase[pk].length;
                }
                UI.statFollowersNow.textContent = totalLikers;
            }
        }
    };

    const params = {
        csrftoken: null,
        uid: null,
        Claim: null,
        webSessionId: null
    };

    // [修复] 每次都重新获取最新的 Token，防止长时间运行后 Token 过期
    async function refreshIGParams() {
        params.csrftoken = Utils.getCookie("csrftoken");
        params.uid = Utils.getCookie("ds_user_id");
        params.Claim = sessionStorage.getItem("www-claim-v2");
        params.webSessionId = await Utils.getWebSessionId();
        
        if (!params.csrftoken || !params.uid) {
            console.warn("Cookies missing, might need login check");
        }
    }

    // ================= API 模块 =================
    const API = {
        async request(endpoint, payload = {}) {
            try {
                const res = await fetch(CONFIG.API_BASE + endpoint, {
                    method: "POST",
                    headers: CONFIG.HEADERS,
                    body: JSON.stringify({
                        key: currentKey,
                        uuid: Utils.getUuid(),
                        ...payload
                    })
                });
                if (!res.ok) throw new Error("Network Error");
                return await res.json();
            } catch (e) {
                return null;
            }
        },

        async verifyKey(key) {
            const originalKey = currentKey;
            currentKey = key;
            const res = await this.request("login.php", { key });
            if (!res || !res.success) currentKey = originalKey;
            return res;
        },

        async checkIGStatus(p) {
            try {
                const res = await fetch(CONFIG.INS_BASE + "api/v1/web/fxcal/ig_sso_users/", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "x-asbd-id": "359341",
                        "x-csrftoken": p.csrftoken,
                        "x-ig-app-id": "936619743392459",
                        "x-ig-www-claim": p.Claim,
                        "x-instagram-ajax": "1030271499",
                        "x-requested-with": "XMLHttpRequest",
                        "x-web-session-id": p.webSessionId
                    }
                });
                const data = await res.json();
                return data && data.status === "ok";
            } catch {
                return false;
            }
        }
    };

    const ActionAPI = {
        async like(postPk, postCode) {
            // 每次操作前刷新参数
            await refreshIGParams();
            const url = `${CONFIG.INS_BASE}api/v1/web/likes/${postPk}/like/`;
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "x-asbd-id": "359341",
                        "x-csrftoken": params.csrftoken,
                        "x-ig-app-id": "936619743392459",
                        "x-ig-www-claim": params.Claim,
                        "x-instagram-ajax": "1030293420",
                        "x-requested-with": "XMLHttpRequest",
                        "x-web-session-id": params.webSessionId
                    },
                    referrer: `${CONFIG.INS_BASE}p/${postCode}/`
                });
                return res.ok;
            } catch (e) {
                console.error("Like Failed:", e);
                return false;
            }
        },

        async follow(userId) {
            await refreshIGParams();
            const url = `${CONFIG.INS_BASE}api/v1/friendships/create/${userId}/`;
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "accept": "*/*",
                        "content-type": "application/x-www-form-urlencoded",
                        "x-asbd-id": "359341",
                        "x-csrftoken": params.csrftoken,
                        "x-ig-app-id": "936619743392459",
                        "x-ig-www-claim": params.Claim,
                        "x-instagram-ajax": "1030293420",
                        "x-requested-with": "XMLHttpRequest",
                        "x-web-session-id": params.webSessionId
                    },
                    body: `container_module=single_post&nav_chain=PolarisExploreRoot%3AexploreLandingPage%3A2%3Atopnav-link%2CPolarisPostModal%3ApostPage%3A3%3AmodalLink&user_id=${userId}&jazoest=21809`
                });
                const json = await res.json();
                return json.status === 'ok' || (json.friendship_status && json.friendship_status.following);
            } catch (e) {
                return false;
            }
        }
    };

    async function fetchTagMediaByName(tagName, nextMaxId = null, rankToken = null) {
        if (!tagName) throw new Error("标签名称不能为空");
        let clean = tagName.trim().replace(/^#|^＃/, "");

        await refreshIGParams();
        
        const query = "#" + clean;
        let url = CONFIG.INS_BASE + "api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=" + encodeURIComponent(query);

        if (nextMaxId) {
            url += `&search_session_id=&next_max_id=${encodeURIComponent(nextMaxId)}&rank_token=${encodeURIComponent(rankToken || "")}`;
        }

        const res = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: {
                "x-asbd-id": "359341",
                "x-csrftoken": params.csrftoken,
                "x-ig-app-id": "936619743392459",
                "x-ig-www-claim": params.Claim,
                "x-requested-with": "XMLHttpRequest",
                "x-web-session-id": params.webSessionId
            },
            referrer: CONFIG.INS_BASE + "explore/search/keyword/?q=" + encodeURIComponent(query)
        });

        if (!res.ok) throw new Error("获取标签帖子失败");
        return await res.json();
    }

    async function fetchLikers(pk, code) {
        if (!pk || !code) return [];
        await refreshIGParams();

        const url = `${CONFIG.INS_BASE}api/v1/media/${pk}/likers/`;
        const referrerUrl = `${CONFIG.INS_BASE}p/${code}/`;

        try {
            const res = await fetch(url, {
                method: "GET",
                credentials: "include",
                headers: {
                    "x-asbd-id": "359341",
                    "x-csrftoken": params.csrftoken,
                    "x-ig-app-id": "936619743392459",
                    "x-ig-www-claim": params.Claim,
                    "x-requested-with": "XMLHttpRequest",
                    "x-web-session-id": params.webSessionId
                },
                referrer: referrerUrl
            });

            if (!res.ok) return [];

            const data = await res.json();
            const users = data.users || [];
            return users.map(u => ({
                id: u.pk, 
                username: u.username
            }));
        } catch (e) {
            return [];
        }
    }

    async function deepFilterAndFetchPosts(originalPk, originalCode, likersList) {
        UI.setStatus(`深度筛选: ${likersList.length}人...`);
        let unProcessedLikers = likersList.filter(liker => !processedUsersSet.has(liker.id));
        
        const filterUserTask = async (liker) => {
            if (!UI.toggle.checked) return null;
            try {
                // 这里调用外部API判断用户质量
                const userRes = await API.request("api.php", { id: liker.id });
                if (!userRes || !userRes.data || !userRes.data.user) return null;

                const user = userRes.data.user;
                if (user.is_private === true) return null;
                if ((user.media_count || 0) === 0) return null;
                if ((user.follower_count || 0) > (user.following_count || 0)) return null;
                if ((user.following_count || 0) > CONFIG.FILTER.DEEP.MAX_FOLLOWING) return null;

                return { id: liker.id, username: liker.username };
            } catch (e) { return null; }
        };

        const qualifiedUsers = (await Utils.runBatch(unProcessedLikers, filterUserTask, CONFIG.FILTER.DEEP.CONCURRENCY))
            .filter(u => u !== null);

        const fetchPostsTask = async (u) => {
            if (!UI.toggle.checked) return null;
            try {
                // 获取用户主页前几个帖子
                const configRes = await API.request("api.php", { username: u.username });
                const edges = configRes?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges || [];
                let posts = edges.map(edge => ({
                    code: edge.node.code,
                    pk: edge.node.pk
                }));

                if (posts.length > 0) {
                    posts.sort(() => Math.random() - 0.5);
                    const limit = Math.floor(Math.random() * (8 - 5 + 1)) + 5;
                    posts = posts.slice(0, limit);
                }

                return { id: u.id, username: u.username, posts: posts };
            } catch (e) { return null; }
        };

        const finalResults = (await Utils.runBatch(qualifiedUsers, fetchPostsTask, CONFIG.FILTER.DEEP.CONCURRENCY))
            .filter(r => r !== null);

        const addedCount = await Utils.Db.addResult(originalPk, finalResults);
        if (addedCount > 0) UI.toast(`入库: ${addedCount}人`, "success");
    }

    function extractUniqueHashtagsFromConfig(configRes) {
        const edges = configRes?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges || [];
        const seen = new Set();
        const result = [];
        for (const edge of edges) {
            const text = edge?.node?.caption?.text;
            if (!text) continue;
            const matches = text.match(/[#＃][^\s#＃]+/g) || [];
            for (let rawTag of matches) {
                let tagBody = rawTag.replace(/^#|^＃/, "").trim();
                if (!tagBody) continue;
                const key = tagBody.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                result.push("#" + tagBody);
            }
        }
        return result;
    }

    async function expandAndRankTags(baseTags) {
        if (!baseTags || baseTags.length === 0) return [];
        UI.setStatus(`分析 ${baseTags.length} 个基础标签...`);
        const responses = await Promise.all(baseTags.map((tag) => API.request("api.php", { tag })));
        const tagMap = new Map();
        responses.forEach((res) => {
            if (!res || res.status !== "ok") return;
            const rawList = res.data?.xdt_api__v1__fbsearch__topsearch_connection?.hashtags || [];
            const sortedList = rawList.sort((a, b) => (b.hashtag?.media_count || 0) - (a.hashtag?.media_count || 0));
            const top5 = sortedList.slice(0, 5);
            for (const item of top5) {
                const name = item.hashtag?.name;
                const count = item.hashtag?.media_count || 0;
                if (!name || count < MIN_TAG_MEDIA_COUNT) continue;
                if (!tagMap.has(name)) tagMap.set(name, { name, count });
            }
        });
        return Array.from(tagMap.values()).sort((a, b) => b.count - a.count).map((item) => "#" + item.name);
    }

    async function performLogin(key) {
        const res = await API.verifyKey(key);
        if (!res || !res.success) return false;
        const remainingSec = Number(res.remaining_seconds);
        const expireTimestamp = Date.now() + remainingSec * 1000;
        await chrome.storage.local.set({
            [CONFIG.STORAGE_KEY]: { key, expireTimestamp, expireAtStr: res.expires_at }
        });
        currentKey = key;
        updateLoginUI(key, res.expires_at, expireTimestamp);
        await Utils.Db.load();
        return true;
    }

    function updateLoginUI(key, expireStr, expireTime) {
        UI.keyText.textContent = key;
        UI.expireText.textContent = expireStr || "未知";
        UI.errorText.textContent = "";
        UI.showLogin(false);
        if (UI.backdrop) UI.backdrop.style.display = "flex";
        if (countdownTimer) clearInterval(countdownTimer);
        const tick = () => {
            const remain = Math.floor((expireTime - Date.now()) / 1000);
            if (remain <= 0) {
                handleLogout("卡密已过期");
                return;
            }
            const h = String(Math.floor(remain / 3600)).padStart(2, "0");
            const m = String(Math.floor((remain % 3600) / 60)).padStart(2, "0");
            const s = String(remain % 60).padStart(2, "0");
            UI.countText.textContent = `${h}:${m}:${s}`;
        };
        tick();
        countdownTimer = setInterval(tick, 1000);
    }

    async function handleLogout(msg = "") {
        clearInterval(countdownTimer);
        await chrome.storage.local.remove(CONFIG.STORAGE_KEY);
        currentKey = null;
        UI.showLogin(true);
        if (UI.inputKey) UI.inputKey.value = "";
        UI.forceOff("已关闭");
        UI.updateStats(0); 
        if (msg) UI.errorText.textContent = msg;
    }

    // ================= 任务1：采集者 (Scraper) =================
    async function startGrowthTask() {
        if (!currentKey) throw new Error("请先使用卡密登录");

        UI.setStatus("正在初始化...");
        await refreshIGParams();
        if (!params.csrftoken || !params.uid) throw new Error("环境参数异常,请刷新页面");

        UI.setStatus("检查IG状态...");
        const isSsoOk = await API.checkIGStatus(params);
        if (!isSsoOk) throw new Error("IG 账号状态异常");

        UI.setStatus("获取用户信息...");
        const userRes = await API.request("api.php", { id: params.uid });
        if (!userRes || userRes.status !== "ok" || !userRes.data?.user) throw new Error(userRes?.message || "获取用户信息失败");

        const user = userRes.data.user;
        const userInfo = {
            username: user.username,
            media: Number(user.media_count || 0),
            isPrivate: !!user.is_private,
            tags: []
        };

        if (userInfo.isPrivate) throw new Error("账户必须为公开状态");
        
        UI.setStatus("识别主题...");
        const configRes = await API.request("api.php", { username: userInfo.username });
        const initialTags = extractUniqueHashtagsFromConfig(configRes);
        if (!initialTags.length) throw new Error("未能识别到有效标签");

        const rankedTags = await expandAndRankTags(initialTags);
        if (!rankedTags.length) throw new Error("无有效高热度标签");

        userInfo.tags = rankedTags;
        return userInfo;
    }

    UI.btnFloat.onclick = () => UI.backdrop.style.display = UI.backdrop.style.display === "flex" ? "none" : "flex";
    UI.backdrop.onclick = (e) => { if (e.target === UI.backdrop) UI.backdrop.style.display = "none"; };
    UI.btnChange.onclick = () => handleLogout();
    
    // 快捷键调试
    document.addEventListener('keydown', async (e) => {
        if (e.key === 'F9') { 
            const liker = await Utils.Db.extractRandomLiker();
            if (liker) UI.toast(`测试提取: ${liker.username}`, "success");
            else UI.toast("数据库为空", "error");
        }
    });

    UI.btnLogin.onclick = async () => {
        const key = UI.inputKey.value.trim();
        if (!key) { UI.errorText.textContent = "请输入卡密"; return; }

        const restoreLoginButton = () => {
            UI.btnLogin.disabled = false;
            if (UI.btnLoginText) UI.btnLoginText.textContent = "登录";
            if (UI.loginSpinner) UI.loginSpinner.style.display = "none";
        };

        UI.errorText.textContent = "";
        UI.btnLogin.disabled = true;
        if (UI.btnLoginText) UI.btnLoginText.textContent = "验证中...";
        if (UI.loginSpinner) UI.loginSpinner.style.display = "inline-block";

        const success = await performLogin(key);

        restoreLoginButton();
        if (!success) UI.errorText.textContent = "登录失败";
    };

    UI.toggle.onchange = async () => {
        if (!UI.toggle.checked) {
            UI.forceOff("已手动关闭");
            return;
        }

        if (!currentKey) {
            UI.forceOff("请先登录卡密");
            UI.toast("请先登录卡密", "error");
            return;
        }

        try {
            const userInfo = await startGrowthTask();
            const allTags = userInfo.tags;

            if (!allTags || allTags.length === 0) throw new Error("没有可用标签");
            UI.toast(`开始遍历 ${allTags.length} 个标签`, "success");

            // ============ 外层循环：遍历标签 ============
            for (let i = 0; i < allTags.length; i++) {
                if (!UI.toggle.checked) break;
                const currentTag = allTags[i];
                UI.setStatus(`[${i + 1}/${allTags.length}] 正在扫描: ${currentTag}`);

                let totalScannedForThisTag = 0;
                let nextMaxId = null;
                let rankToken = null;
                let hasMore = true;
                let pageCount = 0;
                let seenPks = new Set();

                const nowSeconds = Math.floor(Date.now() / 1000);
                const thresholdSeconds = nowSeconds - (CONFIG.FILTER.MAX_HOURS * 3600);

                // ============ 内层循环：翻页 ============
                while (hasMore && totalScannedForThisTag < CONFIG.FILTER.SCAN_LIMIT) {
                    if (!UI.toggle.checked) break;
                    
                    // 数据库满暂停
                    if (Object.keys(likersDatabase).length > 1000) {
                         // 这里的 countdown 仅更新UI，逻辑上没有阻塞 ActionWorker
                         await Utils.sleepWithCountdown(CONFIG.DELAY.DB_FULL_MIN, CONFIG.DELAY.DB_FULL_MAX, "数据库满，暂停采集");
                         // 唤醒后再次检查
                         if (!UI.toggle.checked) break;
                         if (Object.keys(likersDatabase).length > 1000) continue;
                    }

                    if (pageCount >= 30) break;
                    pageCount++;
                    UI.setStatus(`Tag ${currentTag}: P${pageCount}, 已扫${totalScannedForThisTag}...`);

                    try {
                        const tagData = await fetchTagMediaByName(currentTag, nextMaxId, rankToken);
                        const grid = tagData?.media_grid;
                        const sections = grid?.sections || [];

                        // 没有任何媒体数据
                        if (!sections.length) {
                             hasMore = false;
                             break;
                        }

                        for (const section of sections) {
                            const medias = section?.layout_content?.medias || [];
                            for (const item of medias) {
                                if (!UI.toggle.checked) break;

                                const media = item.media;
                                if (!media) continue;
                                totalScannedForThisTag++;

                                const likeCount = media.like_count || 0;
                                const takenAt = media.taken_at || 0;
                                const pk = media.pk;
                                const code = media.code;

                                const isRecent = takenAt > thresholdSeconds;
                                const isPopular = likeCount > CONFIG.FILTER.MIN_LIKES;
                                const isNew = !seenPks.has(pk);

                                if (isRecent && isPopular && pk && code && isNew) {
                                    seenPks.add(pk);
                                    if (likersDatabase.hasOwnProperty(pk)) continue;

                                    UI.setStatus(`命中热帖 (${code}), 提取中...`);
                                    const likers = await fetchLikers(pk, code);

                                    if (likers.length > 0 && UI.toggle.checked) {
                                        await deepFilterAndFetchPosts(pk, code, likers);
                                        await Utils.sleep(3000, 6000); // 降低请求频率
                                    }
                                }
                                if (totalScannedForThisTag >= CONFIG.FILTER.SCAN_LIMIT) break;
                            }
                            if (!UI.toggle.checked || totalScannedForThisTag >= CONFIG.FILTER.SCAN_LIMIT) break;
                        }

                        if (grid) {
                            nextMaxId = grid.next_max_id;
                            rankToken = grid.rank_token;
                            hasMore = grid.has_more && !!nextMaxId;
                        } else { hasMore = false; }

                        // 翻页冷却
                        if (hasMore && UI.toggle.checked) {
                            await Utils.sleepWithCountdown(CONFIG.DELAY.PAGE_MIN, CONFIG.DELAY.PAGE_MAX, "翻页冷却");
                        }
                    } catch (err) {
                        console.error("Scanning Error:", err);
                        await Utils.sleep(5000, 10000); // 出错后等待
                        break; 
                    }
                } 

                if (!UI.toggle.checked) break;
                
                // 标签切换冷却
                if (i < allTags.length - 1) {
                    await Utils.sleepWithCountdown(CONFIG.DELAY.TAG_SWITCH_MIN, CONFIG.DELAY.TAG_SWITCH_MAX, "标签切换冷却");
                }
            } 

            if (!UI.toggle.checked) UI.forceOff("已手动停止");
            else {
                UI.setStatus("所有标签扫描完成");
                setTimeout(() => UI.forceOff("任务完成"), 3000);
            }

        } catch (error) {
            UI.toast(error.message || "未知错误", "error");
            UI.forceOff("运行出错: " + error.message);
        }
    };

    // ================= 任务2：执行者 (Worker) =================
    // 这是一个独立循环，专门负责点赞，不应该和采集的 sleep 互相阻塞
    async function startActionWorker() {
        while (true) {
            try {
                if (!UI.toggle.checked) {
                    await Utils.sleep(2000, 2000);
                    continue;
                }

                // 检查数据库是否有数据
                const pks = Object.keys(likersDatabase);
                if (pks.length === 0) {
                    // 数据库为空，等待采集填入
                    // 这里的 log 不上屏，避免覆盖采集进度的显示
                    console.log("Waiting for data..."); 
                    await Utils.sleep(5000, 10000); 
                    continue;
                }

                const targetUser = await Utils.Db.extractRandomLiker();
                if (!targetUser) {
                    await Utils.sleep(1000, 2000);
                    continue;
                }

                // 处理该用户的所有帖子
                for (let i = 0; i < targetUser.posts.length; i++) {
                    if (!UI.toggle.checked) break;

                    const post = targetUser.posts[i];
                    
                    // 执行点赞
                    const success = await ActionAPI.like(post.pk, post.code);
                    
                    if (success) {
                        UI.incrementLikes();
                        UI.toast(`已点赞 ${targetUser.username}`, "success");
                    } else {
                        console.warn(`Like failed for ${targetUser.username}`);
                    }

                    // 帖子间冷却：1~2 分钟
                    if (i < targetUser.posts.length - 1) {
                        // 【关键】这里 updateUI 设为 false，不占用顶部状态栏，避免与采集状态打架
                        // 用户可以通过 UI.statLikesTotal 的变化看到进度
                         await Utils.sleepWithCountdown(CONFIG.ACTION.LIKE_MIN_DELAY, CONFIG.ACTION.LIKE_MAX_DELAY, "", false);
                    }
                }

                // 概率关注
                if (UI.toggle.checked && Math.random() < CONFIG.ACTION.FOLLOW_RATE) {
                    await Utils.sleep(2000, 4000);
                    const followSuccess = await ActionAPI.follow(targetUser.id);
                    if (followSuccess) {
                        UI.toast(`已关注: ${targetUser.username}`, "success");
                    }
                }

                // 处理完一个用户后，休息 10~20秒
                await Utils.sleep(10000, 20000);

            } catch (e) {
                console.error("Worker Error:", e);
                await Utils.sleep(10000, 20000);
            }
        }
    }

    // ================= 启动流程 =================
    (async () => {
        const saved = await new Promise((r) => chrome.storage.local.get(CONFIG.STORAGE_KEY, (res) => r(res[CONFIG.STORAGE_KEY])));
        if (saved?.key) {
            // 自动登录
            const success = await performLogin(saved.key);
            if (!success) handleLogout("登录已失效");
        } else {
            // 仅加载本地数据
            await Utils.Db.load();
        }

        // 启动后台点赞线程（独立于 UI 主线程）
        startActionWorker();
    })();
})();