/**
 * 收集品仓库：内存缓存 + 后端同步（user_backpack 表）。
 * - owned：collectId -> 拥有数量，支持重复拥有累加（比如小猫买两次显示 x2）
 * - currentId：当前指定展示的 collect.id，null=未指定，取已拥有里最早的一个兜底
 * 目录配置（game_collect）由后端下发只读数据，与本文件的拥有/当前展示状态是两张表。
 *
 * 时序：内存缓存只在首次 ensureLoaded() 时从后端拉取一次（会话内只拉一次，避免每次打开仓库
 * 页都重新请求）。所有同步方法（getOwnedIds/getCount/own 等）读写的都是这份内存缓存，调用方
 * 必须先 await ensureLoaded() 确保缓存已就位，否则可能读到还没拉取完成的初始空状态。
 * own/setCurrent 会同步更新内存缓存（保证前端立刻看到变化），同时异步把变更同步给后端，
 * 失败静默丢弃不阻塞游戏体验——这与 PropStore 的“本地为准、最终写入”思路一致，只是持久化目标
 * 从 localStorage 换成了后端。
 */
import { CollectItem, fetchBackpackList, fetchCollectByIds, ownBackpackItem, setBackpackCurrent } from './api';

interface CollectState {
    owned: Record<number, number>;
    currentId: number | null;
}

const defaultState = (): CollectState => ({
    owned: {},
    currentId: null
});

let state: CollectState = defaultState();
let loadPromise: Promise<void> | null = null;
let loaded = false;
// 后端快照返回前发生的 own/setCurrent（比如页面 render() 里 fire-and-forget 调用 ensureLoaded，
// 用户手速快在请求返回前就点了购买）：先记下来，等快照到达后重放在快照之上，避免被整体覆盖丢失
let pendingOwn: { collectId: number; amount: number }[] = [];
let pendingCurrentId: number | null = null;

/** 会话内只从后端拉取一次背包数据灌入内存缓存；重复调用直接复用同一个 Promise，不重复发请求 */
function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
        loadPromise = fetchBackpackList().then((items) => {
            const next = defaultState();
            items.forEach((item) => {
                if (item.count > 0) next.owned[item.collectId] = item.count;
                if (item.isCurrent) next.currentId = item.collectId;
            });
            pendingOwn.forEach(({ collectId, amount }) => {
                next.owned[collectId] = (next.owned[collectId] || 0) + amount;
            });
            if (pendingCurrentId != null && next.owned[pendingCurrentId]) {
                next.currentId = pendingCurrentId;
            }
            pendingOwn = [];
            pendingCurrentId = null;
            state = next;
            loaded = true;
        }).catch(() => {
            // 拉取失败保持当前状态（含快照到达前已发生的本地变更），不阻塞调用方；
            // 下次不会自动重试（避免反复打后端），仅在页面重新进入游戏（脚本重新加载）时才有机会再拉一次
            loaded = true;
        });
    }
    return loadPromise;
}

export const CollectStore = {
    /** 首次使用前必须先 await 这个方法，确保内存缓存已从后端拉取完成 */
    ensureLoaded,

    /** 已拥有的收集品 id 列表（数量>0的） */
    getOwnedIds(): number[] {
        return Object.keys(state.owned).map(Number);
    },

    /**
     * 已拥有的 collectCode 列表（供过关抽奖排除已拥有用）。
     * 按本地已拥有的 id 批量查目录（/collect/by-ids），不必整表拉取再内存过滤。
     */
    getOwnedCodes(): Promise<string[]> {
        const ownedIds = this.getOwnedIds();
        if (ownedIds.length === 0) return Promise.resolve([]);
        return fetchCollectByIds(ownedIds).then((items) => items.map((item) => item.collectCode));
    },

    /** 指定收集品拥有数量，未拥有为 0 */
    getCount(collectId: number): number {
        return state.owned[collectId] || 0;
    },

    /** 当前指定展示的收集品 id，未指定为 null */
    getCurrentId(): number | null {
        return state.currentId;
    },

    /** 拥有一个收集品：累加数量（支持重复拥有），默认加1。同步更新内存缓存，异步同步给后端 */
    own(collectId: number, amount: number = 1) {
        if (amount <= 0) return;
        state.owned[collectId] = (state.owned[collectId] || 0) + amount;
        if (!loaded) pendingOwn.push({ collectId, amount });
        ownBackpackItem(collectId, amount);
    },

    /** 指定当前展示的收集品（需先拥有，否则忽略）。同步更新内存缓存，异步同步给后端 */
    setCurrent(collectId: number) {
        if (!state.owned[collectId]) return;
        state.currentId = collectId;
        if (!loaded) pendingCurrentId = collectId;
        setBackpackCurrent(collectId);
    },

    /**
     * 新用户首次进首页时补领默认玩偶：本地仓库为空且传入了 starter 配置才发放，
     * 已经拥有任意收集品（说明不是第一次，或已经手动获得过）则不再重复判断。
     * starter 由调用方按需查询取得（/collect/starter-gift），不必再拉整表目录。
     * 调用前必须已 ensureLoaded，否则可能把「还没拉取完成」误判成「新用户」。
     */
    grantIfEmpty(starter: CollectItem | null) {
        if (Object.keys(state.owned).length > 0) return;
        if (!starter) return;
        this.own(starter.id, 1);
    },

    /** 当前应展示的收集品 id：优先 currentId（须已拥有），否则取已拥有里最早的一个，都没有返回 null */
    getCurrentTargetId(): number | null {
        const ownedIds = Object.keys(state.owned).map(Number);
        if (ownedIds.length === 0) return null;
        return (state.currentId != null && state.owned[state.currentId])
            ? state.currentId
            : ownedIds[0];
    },

    /** 结合目录数据取出当前展示项的完整信息；本地为空或目录未命中返回 null（调用方走本地图兜底） */
    getCurrentCollect(catalog: CollectItem[]): CollectItem | null {
        const targetId = this.getCurrentTargetId();
        if (targetId == null) return null;
        return catalog.find((item) => item.id === targetId) || null;
    }
};
