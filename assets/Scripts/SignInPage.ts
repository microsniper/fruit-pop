import { Node, Vec3, Color, tween, Graphics, Sprite } from 'cc';
import { fetchSignInConfig, SignInRewardItem, ResourceCodeTypeEnum, ItemTypeEnum } from './api';
import { PropStore } from './PropStore';
import { CollectStore } from './CollectStore';
import { SoundManager } from './SoundManager';
import { drawSegmentedTabs } from './PageTabs';
import type { GameManager } from './GameManager';

declare const wx: any;

/** 领取后横幅提示文案：按 RewardType 区分，新增类型只需加一行 */
const CLAIM_TIPS: Partial<Record<ResourceCodeTypeEnum, string>> = {
    [ResourceCodeTypeEnum.RAINBOW]: '彩虹果可以适配任意果篮',
    [ResourceCodeTypeEnum.BOMB]: '炸弹果可以炸毁板子'
};

/** 每周天数（固定 7 天一组：3×2 格子 + 第 7 天通栏） */
const DAYS_PER_WEEK = 7;
/** 签到总周期天数：4 周签完回到第 1 天重新循环，需与后端 sign_in_reward 配置的行数（28 行）一致 */
const TOTAL_DAYS = 28;
/** 总周数，tab 数量 */
const TOTAL_WEEKS = TOTAL_DAYS / DAYS_PER_WEEK;

/**
 * 四周签到弹窗：Banner「签到领好礼」+ 周 tab（第1~4周）+ 3×2 天卡 + 每周第 7 天通栏大卡。
 * 奖励图由后端配置下发（OSS CDN），奖励状态全存前端本地：
 * - signInState = { days: 累计已签天数(1~28，满 28 轮回), lastDate: 最后签到日期 }
 * - 断签只累加不重置；删除小程序（存储清空）从第 1 天重新签
 * - 周 tab 默认定位到当前可领天数所在的周，可自由切换查看已签过的早期周（仅展示，不可在非当前周领取）
 * 发放全部纯前端：itemType=PROP 时 sun→金币（枚举值 SUN 为后端契约字符串，不改）；smash/clear/add→道具背包；
 * rainbow/bomb→特殊果背包（PropStore）；itemType=COLLECT 时→收集品背包（CollectStore.own）。
 */
export class SignInPage {
    /** 当前选中查看的周（1~TOTAL_WEEKS），open() 时按签到进度算出默认值 */
    private currentWeek = 1;
    /** 本次 open() 拉到的配置全量（按 dayNum 建索引），供切周重画时复用，不必重复请求 */
    private rewardsByDay: Map<number, SignInRewardItem> = new Map();
    /** 面板/网格节点引用，切周时复用同一批容器重画内容 */
    private panelNode: Node | null = null;
    private gridNode: Node | null = null;
    private weekTabY = 0;
    private gridTopY = 0;

    constructor(private gm: GameManager) {}

    /** 打开签到弹窗（先画面板再异步拉配置填格子），默认定位到当前可领天数所在的周 */
    open() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.destroyAllChildren();

        // 收集品奖励（CollectStore.own）需要背包内存缓存已就位；不阻塞弹窗渲染，
        // 缓存本身有去重保护，正常情况下用户点领取按钮前早已加载完成
        CollectStore.ensureLoaded();

        const screenW = this.gm.screenWidth;
        const screenH = this.gm.screenHeight;

        // 遮罩：点击关闭（今天不领，之后再点签到按钮还能领）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, screenW, screenH, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, screenW, screenH, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 面板：手搬圆角卡片（无专用底图），比旧版加高 20px 给周 tab 腾位置
        const panelW = 320;
        const panelH = 490;
        const panelNode = this.gm.createNode('SignInPanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
        this.panelNode = panelNode;
        const panelBg = this.gm.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        this.gm.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(252, 250, 242, 255), 24);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => { e.propagationStopped = true; }, this);

        // 顶部横幅条：绿底圆角 + 标题艺术字
        const bannerW = panelW - 32;
        const bannerH = 52;
        const bannerY = panelH / 2 - 16 - bannerH / 2;
        const bannerNode = this.gm.createNode('Banner', panelNode, 0, bannerY, bannerW, bannerH);
        this.gm.drawRoundedRect(bannerNode.addComponent(Graphics), bannerW, bannerH, new Color(120, 190, 90, 255), 16);
        const titleLabel = this.gm.createLabel(bannerNode, '签到领好礼', 0, 0, 22, new Color(255, 255, 255, 255), true);
        titleLabel.enableOutline = true;
        titleLabel.outlineColor = new Color(70, 120, 45, 255);
        titleLabel.outlineWidth = 2;

        // 右上角 X 关闭热区
        const closeBtn = this.gm.createNode('CloseBtn', panelNode, panelW / 2 - 30, panelH / 2 - 30, 44, 44);
        const closeG = closeBtn.addComponent(Graphics);
        closeG.strokeColor = new Color(140, 120, 90, 255);
        closeG.lineWidth = 3;
        closeG.moveTo(-8, -8); closeG.lineTo(8, 8);
        closeG.moveTo(8, -8); closeG.lineTo(-8, 8);
        closeG.stroke();
        closeBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            SoundManager.getInstance()?.playSystemClick();
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 默认定位到当前可领天数所在的周（今天已领：用刚领到的天数算；未领：用下一个可领天数算）
        const state = SignInPage.readState();
        const claimedToday = state.lastDate === this.gm.getTodayStr();
        const signedCount = claimedToday ? state.days : (state.days >= TOTAL_DAYS ? 0 : state.days);
        const nextDay = signedCount + 1;
        this.currentWeek = Math.min(TOTAL_WEEKS, Math.ceil(nextDay / DAYS_PER_WEEK));

        this.weekTabY = bannerY - bannerH / 2 - 24;
        this.gridTopY = this.weekTabY - 24;

        // 先拉全量配置建索引，切周时复用同一份数据重画，不重复请求
        fetchSignInConfig().then((items) => {
            if (!panelNode.isValid) return;
            this.rewardsByDay = new Map();
            (items || []).forEach((item) => this.rewardsByDay.set(item.dayNum, item));
            this.renderWeekTabs();
            this.renderWeekContent();
        });

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(panelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 周 tab：第1~TOTAL_WEEKS周，复用 PageTabs 的分段条组件，切周只重画内容不重建弹窗 */
    private renderWeekTabs() {
        if (!this.panelNode || !this.panelNode.isValid) return;
        const tabs = Array.from({ length: TOTAL_WEEKS }, (_, i) => ({ key: String(i + 1), name: `第${i + 1}周` }));
        drawSegmentedTabs(
            this.gm, this.panelNode, 'WeekTabBar', this.weekTabY,
            tabs, String(this.currentWeek), 'sub',
            (key) => {
                this.currentWeek = Number(key);
                this.renderWeekTabs(); // 重画 tab 条本身，让高亮跟着 currentWeek 更新
                this.renderWeekContent();
            }
        );
    }

    /** 按 currentWeek 重画格子内容：3 列 × 2 行（本周第1~6天）+ 第7天通栏大卡 */
    private renderWeekContent() {
        if (!this.panelNode || !this.panelNode.isValid) return;
        const old = this.panelNode.getChildByName('SignInGrid');
        if (old) old.destroy();

        const cols = 3;
        const cellW = 86;
        const cellH = 106;
        const gapX = 10;
        // 行距要大于「领取」按钮骑卡片下缘的探出量（约15px），否则按钮被下一行盖住
        const gapY = 24;
        const gridW = cols * cellW + (cols - 1) * gapX;
        const gridNode = this.gm.createNode('SignInGrid', this.panelNode, 0, this.gridTopY, gridW, cellH * 2 + gapY);
        this.gridNode = gridNode;

        const state = SignInPage.readState();
        const claimedToday = state.lastDate === this.gm.getTodayStr();
        const signedCount = claimedToday ? state.days : (state.days >= TOTAL_DAYS ? 0 : state.days);
        const nextDay = signedCount + 1; // 今日可领的天数（1~TOTAL_DAYS）

        // 当前周对应的 dayNum 区间：第1周=1~7，第2周=8~14，以此类推
        const weekStartDay = (this.currentWeek - 1) * DAYS_PER_WEEK + 1;

        if (this.rewardsByDay.size === 0) {
            this.gm.createLabel(gridNode, '签到奖励配置加载中\n请稍后再试', 0, -cellH, 15, new Color(140, 120, 90, 255), true);
            return;
        }

        // 本周前 6 天：3×2 格子
        for (let i = 0; i < DAYS_PER_WEEK - 1; i++) {
            const item = this.rewardsByDay.get(weekStartDay + i);
            if (!item) continue;
            const r = Math.floor(i / cols);
            const c = i % cols;
            const cx = -gridW / 2 + cellW / 2 + c * (cellW + gapX);
            const cy = -cellH / 2 - r * (cellH + gapY);
            this.renderDayCard(gridNode, item, cx, cy, cellW, cellH, signedCount, nextDay, claimedToday);
        }

        // 本周第 7 天：通栏大卡（网格下方，间距同样要大于领取按钮探出量）
        const lastDayItem = this.rewardsByDay.get(weekStartDay + DAYS_PER_WEEK - 1);
        if (lastDayItem) {
            const wideW = gridW;
            const wideH = 92;
            const wy = -(cellH * 2 + gapY) - 22 - wideH / 2;
            this.renderDayCard(gridNode, lastDayItem, 0, wy, wideW, wideH, signedCount, nextDay, claimedToday, true);
        }
    }

    /**
     * 天卡：圆角底 + 「第N天」+ 远程奖励图 + 数量。
     * 三态：已签（绿底+勾）/ 今日可领（金边高亮+领取按钮）/ 未来（灰）
     */
    private renderDayCard(
        parent: Node, item: SignInRewardItem,
        x: number, y: number, w: number, h: number,
        signedCount: number, nextDay: number, claimedToday: boolean, wide = false
    ) {
        const day = item.dayNum;
        const signed = day <= signedCount;
        const claimable = !claimedToday && day === nextDay;

        const card = this.gm.createNode(`Day_${day}`, parent, x, y, w, h);
        const bg = card.addComponent(Graphics);
        const bgFill = signed ? new Color(214, 236, 200, 255) : (claimable ? new Color(255, 246, 214, 255) : new Color(238, 234, 224, 255));
        this.gm.drawRoundedRect(bg, w, h, bgFill, 14);
        if (claimable) {
            // 今日可领：金色描边高亮
            bg.strokeColor = new Color(250, 170, 60, 255);
            bg.lineWidth = 3;
            bg.roundRect(-w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3, 13);
            bg.stroke();
        }

        // 「第N天」顶部小字
        this.gm.createLabel(card, `第${day}天`, 0, h / 2 - 14, 13,
            signed ? new Color(70, 120, 45, 255) : (claimable ? new Color(200, 120, 30, 255) : new Color(150, 140, 120, 255)), true);

        // 奖励图：远程 OSS 图（失败显示占位圆）；未来天置灰
        const imgSize = wide ? 52 : 48;
        const imgY = 4;
        const imgNode = this.gm.createNode('RewardImg', card, wide ? -34 : 0, imgY, imgSize, imgSize);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        if (!signed && !claimable) imgSprite.grayscale = true;
        this.gm.loadRemoteImage(item.imageUrl, imgSprite, () => {
            // 加载失败兜底：画个浅色圆占位
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, imgSize / 2 - 2);
            ph.fill();
        });
        if (!signed && !claimable) imgSprite.color = new Color(205, 205, 205, 255);

        // 已签：图片上斜盖「已签」戳（半透明黑遮罩 + 白字斜体描边，仿「已售罄」盖印样式）
        if (signed) {
            const stampMaskNode = this.gm.createNode('SignedMask', card, imgNode.position.x, imgY, imgSize, imgSize);
            const stampMask = stampMaskNode.addComponent(Graphics);
            stampMask.fillColor = new Color(0, 0, 0, 110);
            stampMask.circle(0, 0, imgSize / 2 - 2);
            stampMask.fill();
            const stampLabel = this.gm.createLabel(stampMaskNode, '已签', 0, 0, wide ? 16 : 14, new Color(255, 255, 255, 255), true);
            stampLabel.enableOutline = true;
            stampLabel.outlineColor = new Color(60, 100, 40, 255);
            stampLabel.outlineWidth = 2;
            stampLabel.node.angle = -18;
        }

        // 数量文案：图标下方白字+深色描边粗体（照参考图样式），统一 x{数量} 格式
        const amountLabel = this.gm.createLabel(card, `x${item.amount}`, wide ? 34 : 0, wide ? 4 : -h / 2 + 22, 16,
            signed || claimable ? new Color(255, 255, 255, 255) : new Color(200, 195, 185, 255), true);
        amountLabel.enableOutline = true;
        amountLabel.outlineColor = new Color(70, 45, 20, 255);
        amountLabel.outlineWidth = 3;

        // 今日可领：领取按钮骑在卡片下边缘（点卡片任意处即领）
        if (claimable) {
            const btnW = 64;
            const btnH = 24;
            const btnY = wide ? -24 : -h / 2 - 3;
            const btnNode = this.gm.createNode('ClaimBtn', card, wide ? w / 4 : 0, btnY, btnW, btnH);
            this.gm.drawRoundedRect(btnNode.addComponent(Graphics), btnW, btnH, new Color(250, 170, 60, 255), btnH / 2);
            this.gm.createLabel(btnNode, '领取', 0, 0, 14, new Color(255, 255, 255, 255), true);
            card.on(Node.EventType.TOUCH_END, (e: any) => {
                e.propagationStopped = true;
                this.claimReward(item);
            }, this);
        }
    }

    /** 领取：纯前端发放 → 天数+1 满 TOTAL_DAYS 轮回 → 弹「恭喜获得」结果弹窗 → 关闭后刷新当前周格子状态 */
    private claimReward(item: SignInRewardItem) {
        const state = SignInPage.readState();
        if (state.lastDate === this.gm.getTodayStr()) return; // 今天已领（防重）
        const newDays = state.days >= TOTAL_DAYS ? 1 : state.days + 1;
        SignInPage.writeState({ days: newDays, lastDate: this.gm.getTodayStr() });

        // 按奖励类型发放（全部存前端）
        this.grantReward(item);

        // 领取提示：按 RewardType 查映射表（彩虹果/炸弹果等），命中则额外补一条通用横幅提示
        const claimTip = CLAIM_TIPS[item.rewardType];
        this.renderClaimResultModal(item, () => {
            if (claimTip) this.gm.showCoinShortageTip(claimTip);
        });
    }

    /**
     * 领取结果弹窗：物品图 + 「恭喜获得xxx」文案，点任意区域关闭。
     * 取代旧版「卡片弹一下+文案上飘」，金币类型也统一走这个展示，不再走飞金币动画。
     */
    private renderClaimResultModal(item: SignInRewardItem, onClosed: () => void) {
        const layer = this.gm.modalLayerNode;
        if (!layer || !layer.isValid) return;
        layer.destroyAllChildren();

        const mask = this.gm.createGraphicsNode('ClaimMask', layer, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 170), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            layer.destroyAllChildren();
            onClosed();
        }, this);

        const panelNode = this.gm.createNode('ClaimResultPanel', layer, 0, 0, 320, 360);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => { e.propagationStopped = true; }, this);

        // 物品图：入场 backOut 放大，加载失败兜底占位金圆
        const imgNode = this.gm.createNode('ClaimImg', panelNode, 0, 40, 150, 150);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.gm.loadRemoteImage(item.imageUrl, imgSprite, () => {
            if (!imgNode.isValid) return;
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(255, 214, 90, 255);
            ph.circle(0, 0, 60);
            ph.fill();
        });
        imgNode.setScale(0.5, 0.5, 1);
        tween(imgNode).to(0.3, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();

        // 恭喜文案：白字深描边，与过关奖励弹窗同款样式
        const text = this.gm.createLabel(panelNode, `恭喜获得${this.rewardDisplayName(item)}`, 0, -78, 22, new Color(255, 255, 255, 255), true);
        text.enableOutline = true;
        text.outlineColor = new Color(122, 74, 20, 255);
        text.outlineWidth = 3;

        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 展示名：按 itemType/rewardType 组出「名称x数量」，与后端下发的 imageUrl 配套展示 */
    private rewardDisplayName(item: SignInRewardItem): string {
        const amount = item.amount || 0;
        if (item.itemType === ItemTypeEnum.COLLECT) {
            return `${item.name || '玩偶'}x${amount}`;
        }
        switch (item.rewardType) {
            case ResourceCodeTypeEnum.COIN: return `金币x${amount}`;
            case ResourceCodeTypeEnum.ADD_TRAY: return `加果盘道具x${amount}`;
            case ResourceCodeTypeEnum.CLEAR: return `清空果盘道具x${amount}`;
            case ResourceCodeTypeEnum.ADD: return `加果篮道具x${amount}`;
            case ResourceCodeTypeEnum.RAINBOW: return `彩虹果x${amount}`;
            case ResourceCodeTypeEnum.BOMB: return `炸弹果x${amount}`;
            case ResourceCodeTypeEnum.RAINBOW_BOMB: return `彩虹果x${amount} 炸弹果x${amount}`;
            default: return `奖励x${amount}`;
        }
    }

    /** 按 itemType/rewardType 纯发放（不返回展示文案，展示由 renderClaimResultModal 统一负责） */
    private grantReward(item: SignInRewardItem) {
        const amount = item.amount || 0;
        if (item.itemType === ItemTypeEnum.COLLECT) {
            if (item.collectId == null) return;
            CollectStore.own(item.collectId, amount);
            return;
        }
        switch (item.rewardType) {
            case ResourceCodeTypeEnum.COIN:
                if (amount <= 0) return;
                this.gm.totalCoins += amount;
                if (typeof wx !== 'undefined' && wx.setStorageSync) {
                    wx.setStorageSync('totalCoins', this.gm.totalCoins.toString());
                } else {
                    localStorage.setItem('totalCoins', this.gm.totalCoins.toString());
                }
                return;
            case ResourceCodeTypeEnum.ADD_TRAY:
                PropStore.addTools('addTray', amount);
                return;
            case ResourceCodeTypeEnum.CLEAR:
                PropStore.addTools('clear', amount);
                return;
            case ResourceCodeTypeEnum.ADD:
                PropStore.addTools('addBasket', amount);
                return;
            case ResourceCodeTypeEnum.RAINBOW:
                PropStore.addFruits('rainbow', amount);
                return;
            case ResourceCodeTypeEnum.BOMB:
                PropStore.addFruits('bomb', amount);
                return;
            case ResourceCodeTypeEnum.RAINBOW_BOMB:
                PropStore.addFruits('rainbow', amount);
                PropStore.addFruits('bomb', amount);
                return;
        }
    }

    // ---------- 签到状态存储（全前端） ----------

    /** 今日是否已签到（首页红点/引导手指判断用） */
    public static isSignedToday(): boolean {
        return SignInPage.readState().lastDate === SignInPage.todayStr();
    }

    /** 与 GameManager.getTodayStr() 同格式（YYYYMD 拼接），保证两处日期比较口径一致 */
    private static todayStr(): string {
        const d = new Date();
        return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}`;
    }

    /** 读签到状态：{ days: 累计已签天数(1~TOTAL_DAYS), lastDate: 最后签到日期 }；存储清空（删小程序）即从第 1 天重签 */
    public static readState(): { days: number; lastDate: string } {
        try {
            const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
                ? (wx.getStorageSync('signInState') || '')
                : (localStorage.getItem('signInState') || '');
            const parsed = raw ? JSON.parse(raw) : null;
            const days = Number(parsed?.days) || 0;
            return { days: Math.min(Math.max(days, 0), TOTAL_DAYS), lastDate: String(parsed?.lastDate || '') };
        } catch (e) {
            return { days: 0, lastDate: '' };
        }
    }

    private static writeState(state: { days: number; lastDate: string }) {
        const val = JSON.stringify(state);
        try {
            if (typeof wx !== 'undefined' && wx.setStorageSync) {
                wx.setStorageSync('signInState', val);
            } else {
                localStorage.setItem('signInState', val);
            }
        } catch (e) {}
    }
}
