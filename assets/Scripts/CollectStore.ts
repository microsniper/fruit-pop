/**
 * 收集品仓库（纯前端存储，不存后端）：
 * - owned：collectId -> 拥有数量，支持重复拥有累加（比如小猫买两次显示 x2）
 * - currentId：当前指定展示的 collect.id，null=未指定，取已拥有里最早的一个兜底
 * 目录配置（game_collect）由后端下发只读数据，拥有/当前展示状态口径与 PropStore（道具/特殊果）一致：
 * 删除小程序即清零。
 */
import { CollectItem } from './api';

declare const wx: any;

interface CollectState {
    owned: Record<number, number>;
    currentId: number | null;
}

const STORAGE_KEY = 'collectBag';

const defaultState = (): CollectState => ({
    owned: {},
    currentId: null
});

function readState(): CollectState {
    try {
        const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
            ? (wx.getStorageSync(STORAGE_KEY) || '')
            : (localStorage.getItem(STORAGE_KEY) || '');
        if (!raw) return defaultState();
        const parsed = JSON.parse(raw);
        const state = defaultState();
        // owned 结构变过（原是 ownedIds: number[]），旧格式数据直接回落成空仓库，不做迁移兼容
        if (parsed?.owned && typeof parsed.owned === 'object' && !Array.isArray(parsed.owned)) {
            Object.keys(parsed.owned).forEach((key) => {
                const id = Number(key);
                const count = Number(parsed.owned[key]);
                if (Number.isFinite(id) && Number.isFinite(count) && count > 0) {
                    state.owned[id] = count;
                }
            });
        }
        if (typeof parsed?.currentId === 'number') {
            state.currentId = parsed.currentId;
        }
        return state;
    } catch (e) {
        return defaultState();
    }
}

function writeState(state: CollectState) {
    try {
        const val = JSON.stringify(state);
        if (typeof wx !== 'undefined' && wx.setStorageSync) {
            wx.setStorageSync(STORAGE_KEY, val);
        } else {
            localStorage.setItem(STORAGE_KEY, val);
        }
    } catch (e) {}
}

export const CollectStore = {
    /** 已拥有的收集品 id 列表（数量>0的） */
    getOwnedIds(): number[] {
        const owned = readState().owned;
        return Object.keys(owned).map(Number);
    },

    /** 结合目录数据把已拥有的 id 列表转成 collectCode 列表（供过关抽奖排除已拥有用） */
    getOwnedCodes(catalog: CollectItem[]): string[] {
        const ownedIds = new Set(this.getOwnedIds());
        if (ownedIds.size === 0) return [];
        return catalog.filter((item) => ownedIds.has(item.id)).map((item) => item.collectCode);
    },

    /** 指定收集品拥有数量，未拥有为 0 */
    getCount(collectId: number): number {
        return readState().owned[collectId] || 0;
    },

    /** 当前指定展示的收集品 id，未指定为 null */
    getCurrentId(): number | null {
        return readState().currentId;
    },

    /** 拥有一个收集品：累加数量（支持重复拥有），默认加1 */
    own(collectId: number, amount: number = 1) {
        if (amount <= 0) return;
        const state = readState();
        state.owned[collectId] = (state.owned[collectId] || 0) + amount;
        writeState(state);
    },

    /** 指定当前展示的收集品（需先拥有，否则忽略） */
    setCurrent(collectId: number) {
        const state = readState();
        if (!state.owned[collectId]) return;
        state.currentId = collectId;
        writeState(state);
    },

    /**
     * 新用户首次进首页时补领默认玩偶：本地仓库为空且目录里有 isStarterGift 的一条才发放，
     * 已经拥有任意收集品（说明不是第一次，或已经手动获得过）则不再重复判断。
     */
    grantIfEmpty(catalog: CollectItem[]) {
        const state = readState();
        if (Object.keys(state.owned).length > 0) return;
        const starter = catalog.find((item) => item.isStarterGift);
        if (!starter) return;
        state.owned[starter.id] = 1;
        writeState(state);
    },

    /** 结合目录数据取出当前展示项的完整信息；本地为空或目录未命中返回 null（调用方走本地图兜底） */
    getCurrentCollect(catalog: CollectItem[]): CollectItem | null {
        const state = readState();
        const ownedIds = Object.keys(state.owned).map(Number);
        if (ownedIds.length === 0) return null;
        const targetId = (state.currentId != null && state.owned[state.currentId])
            ? state.currentId
            : ownedIds[0];
        return catalog.find((item) => item.id === targetId) || null;
    }
};
