/**
 * 道具与特殊果背包（纯前端存储，不存后端）：
 * - 道具：加果篮(addBasket)/砸板子(smash)/清空果盘(clear)/加果盘(addTray) 的免费使用次数
 * - 特殊果：彩虹果(rainbow)/炸弹果(bomb) 的持有数量
 * 来源：七日签到发放（SignInPage）；消耗：游戏内道具按钮（免费优先）与特殊果按钮。
 * 删除小程序即清零，与签到状态口径一致。
 */

declare const wx: any;

export type ToolKey = 'addBasket' | 'smash' | 'clear' | 'addTray';
export type FruitKey = 'rainbow' | 'bomb';

interface PropBag {
    tools: Record<ToolKey, number>;
    fruits: Record<FruitKey, number>;
}

const STORAGE_KEY = 'propBag';

const defaultBag = (): PropBag => ({
    tools: { addBasket: 0, smash: 0, clear: 0, addTray: 0 },
    fruits: { rainbow: 0, bomb: 0 }
});

function readBag(): PropBag {
    try {
        const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
            ? (wx.getStorageSync(STORAGE_KEY) || '')
            : (localStorage.getItem(STORAGE_KEY) || '');
        if (!raw) return defaultBag();
        const parsed = JSON.parse(raw);
        const bag = defaultBag();
        (['addBasket', 'smash', 'clear', 'addTray'] as ToolKey[]).forEach((k) => {
            bag.tools[k] = Math.max(0, Number(parsed?.tools?.[k]) || 0);
        });
        (['rainbow', 'bomb'] as FruitKey[]).forEach((k) => {
            bag.fruits[k] = Math.max(0, Number(parsed?.fruits?.[k]) || 0);
        });
        return bag;
    } catch (e) {
        return defaultBag();
    }
}

function writeBag(bag: PropBag) {
    try {
        const val = JSON.stringify(bag);
        if (typeof wx !== 'undefined' && wx.setStorageSync) {
            wx.setStorageSync(STORAGE_KEY, val);
        } else {
            localStorage.setItem(STORAGE_KEY, val);
        }
    } catch (e) {}
}

export const PropStore = {
    /** 道具剩余次数 */
    getToolCount(key: ToolKey): number {
        return readBag().tools[key];
    },

    /** 签到发道具：累加 n 个 */
    addTools(key: ToolKey, n: number) {
        if (n <= 0) return;
        const bag = readBag();
        bag.tools[key] += n;
        writeBag(bag);
    },

    /** 使用道具：有库存则扣 1 返回 true，否则返回 false */
    consumeTool(key: ToolKey): boolean {
        const bag = readBag();
        if (bag.tools[key] <= 0) return false;
        bag.tools[key]--;
        writeBag(bag);
        return true;
    },

    /** 特殊果持有数量 */
    getFruitCount(key: FruitKey): number {
        return readBag().fruits[key];
    },

    /** 签到发特殊果：累加 n 个 */
    addFruits(key: FruitKey, n: number) {
        if (n <= 0) return;
        const bag = readBag();
        bag.fruits[key] += n;
        writeBag(bag);
    },

    /** 使用特殊果：有库存则扣 1 返回 true，否则返回 false */
    consumeFruit(key: FruitKey): boolean {
        const bag = readBag();
        if (bag.fruits[key] <= 0) return false;
        bag.fruits[key]--;
        writeBag(bag);
        return true;
    }
};
