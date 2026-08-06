import { Node, Vec3, UITransform, Color, tween, Graphics, Sprite, SpriteFrame, ImageAsset, Texture2D, assetManager } from 'cc';
import { fetchSignInConfig, SignInRewardItem, ResourceCodeTypeEnum } from './api';
import { PropStore } from './PropStore';
import type { GameManager } from './GameManager';

declare const wx: any;

/** 领取后横幅提示文案：按 RewardType 区分，新增类型只需加一行 */
const CLAIM_TIPS: Partial<Record<ResourceCodeTypeEnum, string>> = {
    [ResourceCodeTypeEnum.RAINBOW]: '彩虹果可以适配任意果篮',
    [ResourceCodeTypeEnum.BOMB]: '炸弹果可以炸毁板子'
};

/**
 * 七日签到弹窗：Banner「七日签到领好礼」+ 3×2 天卡 + 第 7 天通栏大卡。
 * 奖励图由后端配置下发（OSS CDN），奖励状态全存前端本地：
 * - signInState = { days: 累计已签天数(1~7，满 7 轮回), lastDate: 最后签到日期 }
 * - 断签只累加不重置；删除小程序（存储清空）从第 1 天重新签
 * 发放全部纯前端：sun→小太阳；smash/clear/add→道具背包；rainbow/bomb→特殊果背包（PropStore）。
 */
export class SignInPage {

    constructor(private gm: GameManager) {}

    /** 打开签到弹窗（先画面板再异步拉配置填格子） */
    open() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.removeAllChildren();

        const screenW = this.gm.screenWidth;
        const screenH = this.gm.screenHeight;

        // 遮罩：点击关闭（今天不领，之后再点签到按钮还能领）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, screenW, screenH, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, screenW, screenH, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 面板：手搬圆角卡片（无专用底图）
        const panelW = 320;
        const panelH = 470;
        const panelNode = this.gm.createNode('SignInPanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
        const panelBg = this.gm.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        this.gm.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(252, 250, 242, 255), 24);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => { e.propagationStopped = true; }, this);

        // 顶部横幅条：绿底圆角 + 标题艺术字
        const bannerW = panelW - 32;
        const bannerH = 52;
        const bannerY = panelH / 2 - 16 - bannerH / 2;
        const bannerNode = this.gm.createNode('Banner', panelNode, 0, bannerY, bannerW, bannerH);
        this.gm.drawRoundedRect(bannerNode.addComponent(Graphics), bannerW, bannerH, new Color(120, 190, 90, 255), 16);
        const titleLabel = this.gm.createLabel(bannerNode, '七日签到 领好礼', 0, 0, 22, new Color(255, 255, 255, 255), true);
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
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 天数状态
        const state = SignInPage.readState();
        const todayStr = this.gm.getTodayStr();
        const claimedToday = state.lastDate === todayStr;
        // 已签满天数：今天领过 = days；没领过 = 满 7 轮回后为 0（从第 1 天重新签），否则 days
        const signedCount = claimedToday ? state.days : (state.days >= 7 ? 0 : state.days);
        const nextDay = signedCount + 1; // 今日可领的天数（1~7）

        // 格子容器：3 列 × 2 行（第 1~6 天）+ 第 7 天通栏
        const gridTopY = bannerY - bannerH / 2 - 14;
        const cols = 3;
        const cellW = 86;
        const cellH = 106;
        const gapX = 10;
        // 行距要大于「领取」按钮骑卡片下缘的探出量（约15px），否则按钮被下一行盖住
        const gapY = 24;
        const gridW = cols * cellW + (cols - 1) * gapX;
        const gridNode = this.gm.createNode('SignInGrid', panelNode, 0, gridTopY, gridW, cellH * 2 + gapY);

        const rewards = new Map<number, SignInRewardItem>();

        // 渲染单个天卡（第 1~6 天）
        const renderCell = (item: SignInRewardItem, index: number) => {
            const r = Math.floor(index / cols);
            const c = index % cols;
            const cx = -gridW / 2 + cellW / 2 + c * (cellW + gapX);
            const cy = -cellH / 2 - r * (cellH + gapY);
            this.renderDayCard(gridNode, item, cx, cy, cellW, cellH, signedCount, nextDay, claimedToday, rewards);
        };

        // 第 7 天通栏大卡（网格下方，间距同样要大于领取按钮探出量）
        const renderWide = (item: SignInRewardItem) => {
            const wideW = gridW;
            const wideH = 92;
            const wy = -(cellH * 2 + gapY) - 22 - wideH / 2;
            this.renderDayCard(gridNode, item, 0, wy, wideW, wideH, signedCount, nextDay, claimedToday, rewards, true);
        };

        // 先拉配置：有 7 天奖励才渲染格子；失败/缺配置给提示
        fetchSignInConfig().then((items) => {
            if (!panelNode.isValid) return;
            const list = (items || []).slice().sort((a, b) => a.dayNum - b.dayNum);
            if (list.length === 0) {
                this.gm.createLabel(gridNode, '签到奖励配置加载中\n请稍后再试', 0, -cellH, 15, new Color(140, 120, 90, 255), true);
                return;
            }
            list.forEach((item) => rewards.set(item.dayNum, item));
            list.filter((item) => item.dayNum >= 1 && item.dayNum <= 6).forEach((item) => renderCell(item, item.dayNum - 1));
            const day7 = rewards.get(7);
            if (day7) renderWide(day7);
        });

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(panelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /**
     * 天卡：圆角底 + 「第N天」+ 远程奖励图 + 数量。
     * 三态：已签（绿底+勾）/ 今日可领（金边高亮+领取按钮）/ 未来（灰）
     */
    private renderDayCard(
        parent: Node, item: SignInRewardItem,
        x: number, y: number, w: number, h: number,
        signedCount: number, nextDay: number, claimedToday: boolean,
        rewards: Map<number, SignInRewardItem>, wide = false
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
        this.loadRemoteImage(item.imageUrl, imgSprite, () => {
            // 加载失败兜底：画个浅色圆占位
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, imgSize / 2 - 2);
            ph.fill();
        });
        if (!signed && !claimable) imgSprite.color = new Color(205, 205, 205, 255);

        // 数量文案：图标下方白字+深色描边粗体（照参考图样式），统一 x{数量} 格式
        const amountLabel = this.gm.createLabel(card, `x${item.amount}`, wide ? 34 : 0, wide ? 4 : -h / 2 + 22, 16,
            signed || claimable ? new Color(255, 255, 255, 255) : new Color(200, 195, 185, 255), true);
        amountLabel.enableOutline = true;
        amountLabel.outlineColor = new Color(70, 45, 20, 255);
        amountLabel.outlineWidth = 3;

        // 已签：右下角绿勾
        if (signed) {
            const check = card.addComponent(Graphics);
            const gx = w / 2 - 12;
            const gy = -h / 2 + 12;
            check.fillColor = new Color(90, 170, 60, 255);
            check.circle(gx, gy, 9);
            check.fill();
            check.strokeColor = Color.WHITE;
            check.lineWidth = 2;
            check.moveTo(gx - 4, gy);
            check.lineTo(gx - 1, gy - 3);
            check.lineTo(gx + 4, gy + 3);
            check.stroke();
        }

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
                this.claimReward(card, item, rewards);
            }, this);
        }
    }

    /** 领取：纯前端发放 → 天数+1 满 7 轮回 → 卡片反馈后关闭 */
    private claimReward(card: Node, item: SignInRewardItem, rewards: Map<number, SignInRewardItem>) {
        const state = SignInPage.readState();
        if (state.lastDate === this.gm.getTodayStr()) return; // 今天已领（防重）
        const newDays = state.days >= 7 ? 1 : state.days + 1;
        SignInPage.writeState({ days: newDays, lastDate: this.gm.getTodayStr() });

        // 按奖励类型发放（全部存前端）
        const gainText = this.grantReward(card, item);

        // 领取提示：按 RewardType 查映射表（彩虹果/炸弹果等），命中则关弹窗后用通用横幅提示用法
        const claimTip = CLAIM_TIPS[item.rewardType];
        if (claimTip) {
            if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid) {
                this.gm.modalLayerNode.removeAllChildren();
            }
            this.gm.showSunShortageTip(claimTip);
            return;
        }

        // 卡片弹一下 + 到账文案上飘，然后关闭弹窗（状态已变，下次打开自动刷新）
        if (gainText && this.gm.modalLayerNode && this.gm.modalLayerNode.isValid) {
            const gainLabel = this.gm.createLabel(this.gm.modalLayerNode, gainText, 0, 0, 24, new Color(255, 220, 80, 255), true);
            tween(gainLabel.node)
                .by(0.8, { position: new Vec3(0, 70, 0) })
                .start();
        }
        tween(card)
            .to(0.12, { scale: new Vec3(1.15, 1.15, 1) })
            .to(0.12, { scale: new Vec3(1, 1, 1) })
            .delay(0.5)
            .call(() => {
                if (this.gm.modalLayerNode) this.gm.modalLayerNode.removeAllChildren();
            })
            .start();
    }

    /** 按 rewardType 发放奖励，返回上飘文案（太阳类型走飞行动画不飘字） */
    private grantReward(card: Node, item: SignInRewardItem): string {
        const amount = item.amount || 0;
        switch (item.rewardType) {
            case ResourceCodeTypeEnum.SUN: {
                if (amount <= 0) return '';
                const startSuns = this.gm.totalSuns;
                this.gm.totalSuns += amount;
                if (typeof wx !== 'undefined' && wx.setStorageSync) {
                    wx.setStorageSync('totalSuns', this.gm.totalSuns.toString());
                } else {
                    localStorage.setItem('totalSuns', this.gm.totalSuns.toString());
                }
                const worldPos = card.getComponent(UITransform)!.convertToWorldSpaceAR(new Vec3(0, 0, 0));
                this.gm.playDailyRewardSunFly(worldPos, startSuns, amount, () => {});
                return '';
            }
            case ResourceCodeTypeEnum.SMASH:
                PropStore.addTools('smash', amount);
                return `+${amount} 砸板子道具`;
            case ResourceCodeTypeEnum.CLEAR:
                PropStore.addTools('clear', amount);
                return `+${amount} 清空果盘道具`;
            case ResourceCodeTypeEnum.ADD:
                PropStore.addTools('addBasket', amount);
                return `+${amount} 加果篮道具`;
            case ResourceCodeTypeEnum.RAINBOW:
                PropStore.addFruits('rainbow', amount);
                return `+${amount} 彩虹果`;
            case ResourceCodeTypeEnum.BOMB:
                PropStore.addFruits('bomb', amount);
                return `+${amount} 炸弹果`;
            case ResourceCodeTypeEnum.COMBO:
                PropStore.addFruits('rainbow', amount);
                PropStore.addFruits('bomb', amount);
                return `+${amount} 彩虹果 +${amount} 炸弹果`;
            default:
                return '';
        }
    }

    /** 远程图加载：OSS CDN 地址 -> SpriteFrame；失败走 fallback */
    private loadRemoteImage(url: string, sprite: Sprite, onFail: () => void) {
        const trimmed = (url || '').trim();
        if (!trimmed.startsWith('http')) {
            onFail();
            return;
        }
        const dotIdx = trimmed.lastIndexOf('.');
        const ext = dotIdx > 0 ? trimmed.substring(dotIdx) : '.png';
        assetManager.loadRemote<ImageAsset>(trimmed, { ext }, (err, imageAsset) => {
            if (!err && imageAsset && sprite.isValid) {
                const texture = new Texture2D();
                texture.image = imageAsset;
                const frame = new SpriteFrame();
                frame.texture = texture;
                sprite.spriteFrame = frame;
            } else if (sprite.isValid) {
                onFail();
            }
        });
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

    /** 读签到状态：{ days: 累计已签天数(1~7), lastDate: 最后签到日期 }；存储清空（删小程序）即从第 1 天重签 */
    public static readState(): { days: number; lastDate: string } {
        try {
            const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
                ? (wx.getStorageSync('signInState') || '')
                : (localStorage.getItem('signInState') || '');
            const parsed = raw ? JSON.parse(raw) : null;
            const days = Number(parsed?.days) || 0;
            return { days: Math.min(Math.max(days, 0), 7), lastDate: String(parsed?.lastDate || '') };
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
