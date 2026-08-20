import { Node, Color, Graphics, Sprite, Label, UITransform, ScrollView, Mask, Vec3, tween } from 'cc';
import { fetchMyStorage, MyStorageItem } from './api';
import { CollectStore } from './CollectStore';
import { SoundManager } from './SoundManager';
import type { GameManager } from './GameManager';

/**
 * 「我的仓库」弹窗：对局中点击玩偶进度图标打开，查看并切换当前应用的收集品。
 * 弹窗壳与 FeedbackPage 同款（挂 modalLayerNode、遮罩点击关闭、backOut 入场），对局不暂停。
 * 数据走 /backpack/my-storage（与仓库页同接口，后端已拼好目录+持有状态并分页下发）；
 * 底部「上一页/下一页」按钮整批翻页（非滚动自动加载），有没有下一页以接口 total 权威判断
 * （「满一页≠有下一页」：总数恰为整页倍数时会多翻出空白页）。
 * 分组 tab 暂不展示（当前收集品只有水果一个分组，没分组可切）：请求不带 groupCode，全部混排。
 * 收集卡本身不可点，点卡片底部「应用于游戏」换当前展示：本地先改 isCurrent 立刻重画
 * （防读写竞态，与仓库页同思路），后端写失败回滚重试提示；成功后关弹窗并刷新对局玩偶图标。
 */

/** 每页条数，与仓库页/后端默认值一致 */
const PAGE_SIZE = 10;

/** 收集卡高（名称/图/数量/按钮上下排布），行距 = 卡高 + 间隙 */
const CARD_H = 160;
const GAP_Y = 10;

const BROWN = new Color(110, 75, 45, 255);
const BEIGE = new Color(240, 230, 205, 255);
const BEIGE_LINE = new Color(150, 110, 60, 255);
const ORANGE = new Color(255, 150, 0, 255);
/** 「使用中」按钮的置灰底色（当前展示项不可再点） */
const DISABLED_GRAY = new Color(190, 190, 180, 255);

export class MyStoragePopup {

    /** 弹窗面板（挂在 modalLayerNode 下，关闭即整层清空） */
    private panelNode: Node | null = null;
    /** 面板内容层：网格+翻页区都画在这里 */
    private contentNode: Node | null = null;
    /** 网格+翻页区的容器（翻页/本地换装重画时整块销毁重建） */
    private gridAreaNode: Node | null = null;

    /** 当前页条目（翻页整批替换） */
    private items: MyStorageItem[] = [];
    /** 当前页码，从 1 开始；0 表示还没加载过 */
    private page = 0;
    /** 还有没有下一页：以接口 total 判断（页码×每页 < 总数），不用「满一页」推断避免整页倍数时空白页 */
    private hasNextPage = false;
    /** 请求飞行中标记：防止连点翻页按钮触发多次重叠请求 */
    private loading = false;
    /** 「应用于游戏」写后端飞行中标记：防止连点重复提交 */
    private applying = false;
    /** 网格可视区上边缘（面板局部坐标），open 里算好供网格/占位复用 */
    private gridTopY = 0;

    constructor(private gm: GameManager) {}

    open() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.destroyAllChildren();

        const screenW = this.gm.screenWidth;
        const screenH = this.gm.screenHeight;

        // 遮罩：点空白处关闭（对局继续，与现有对局弹窗一致）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, screenW, screenH, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, screenW, screenH, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        const panelW = Math.min(340, screenW - 30);
        const panelH = Math.min(screenH * 0.85, 540);
        const panelNode = this.gm.createNode('MyStoragePanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
        this.panelNode = panelNode;
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 面板外框：米黄奶油圆角卡 + 棕色粗描边 + 白色内描边（与项目弹窗家族同语言，商城购买弹窗同款）
        const frame = this.gm.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        const fg = frame.getComponent(Graphics)!;
        fg.fillColor = new Color(251, 243, 219, 255);
        fg.roundRect(-panelW / 2, -panelH / 2, panelW, panelH, 20);
        fg.fill();
        fg.strokeColor = new Color(150, 110, 60, 255);
        fg.lineWidth = 4;
        fg.roundRect(-panelW / 2, -panelH / 2, panelW, panelH, 20);
        fg.stroke();
        fg.strokeColor = new Color(255, 255, 255, 200);
        fg.lineWidth = 2;
        fg.roundRect(-panelW / 2 + 6, -panelH / 2 + 6, panelW - 12, panelH - 12, 16);
        fg.stroke();

        // 标题 + 关闭按钮（FeedbackPage 同款位置）
        this.gm.createLabel(panelNode, '我的仓库', 0, panelH / 2 - 34, 22, new Color(96, 64, 32, 255), true);
        const closeBtn = this.gm.createNode('CloseBtn', panelNode, panelW / 2 - 28, panelH / 2 - 30, 44, 44);
        this.gm.createLabel(closeBtn, '×', 0, 2, 26, new Color(150, 130, 110, 255), true);
        closeBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            SoundManager.getInstance()?.playSystemClick();
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 内容层：网格+翻页区
        this.contentNode = this.gm.createNode('MyStorageContent', panelNode, 0, 0, panelW, panelH);
        this.gridAreaNode = null;

        // 分页状态复位（同一实例重复 open 也正确），从第一页拉起
        this.items = [];
        this.page = 0;
        this.hasNextPage = false;
        this.loading = false;
        this.applying = false;
        this.gridTopY = panelH / 2 - 60;
        this.loadPage(1);

        panelNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(panelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 关闭弹窗：对局弹窗互斥共用 modalLayerNode，整层清空即关（项目弹窗惯例） */
    private close() {
        if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid) {
            this.gm.modalLayerNode.destroyAllChildren();
        }
        this.panelNode = null;
        this.contentNode = null;
        this.gridAreaNode = null;
    }

    // ===== 数据加载 =====

    /**
     * 拉取指定页码并整批替换当前展示内容（不带 groupCode，全部收集品混排）。
     * loading 兜住连点：按钮点击后到数据回来之前再点无效。
     */
    private loadPage(targetPage: number) {
        if (this.loading) return;
        if (targetPage < 1) return;

        this.loading = true;
        fetchMyStorage(undefined, targetPage, PAGE_SIZE).then((data) => {
            this.loading = false;
            if (!this.contentNode || !this.contentNode.isValid) return; // 弹窗已关

            this.page = targetPage;
            this.items = data.items;
            // 有没有下一页用 total 权威判断（仓库页同思路）：满一页≠有下一页，
            // 总数恰为整页倍数时「满页判断」会多翻出一个空白页
            this.hasNextPage = this.page * PAGE_SIZE < data.total;
            this.renderGridArea(data.items);
        }).catch(() => {
            this.loading = false;
        });
    }

    // ===== 内容渲染 =====

    /** 网格+翻页整块重画（翻页/本地换装都走这）；空列表显示占位文案（仓库页同款文案） */
    private renderGridArea(items: MyStorageItem[]) {
        if (!this.contentNode || !this.contentNode.isValid) return;
        const old = this.contentNode.getChildByName('GridArea');
        if (old) old.destroy();
        const area = this.gm.createNode('GridArea', this.contentNode, 0, 0, 1, 1);
        this.gridAreaNode = area;

        if (items.length === 0) {
            this.gm.createLabel(area, '暂未收集到玩偶', 0, this.gridTopY - 60, 15, new Color(150, 160, 140, 255), true);
            return;
        }
        this.buildGridContainer(area, items);
        this.drawPager(area);
    }

    /**
     * 卡片网格：一行两卡，ScrollView+Mask 裁切纯为兼容小屏内容超高时能手动滚一下看完整页，
     * 翻页只靠底部按钮点击触发（商城 buildGridContainer 同款）。
     */
    private buildGridContainer(area: Node, items: MyStorageItem[]) {
        const panelW = this.panelNode!.getComponent(UITransform)!.width;
        const panelH = this.panelNode!.getComponent(UITransform)!.height;
        const cardW = Math.floor((panelW - 48) / 2); // 左右边距 20 + 中缝 8
        const pitch = CARD_H + GAP_Y;
        const rowCount = Math.ceil(items.length / 2);
        const contentH = Math.max(rowCount * pitch + GAP_Y, 100);

        // 底部留出翻页按钮行空间，网格可视区在它上方
        const pagerAreaH = 56;
        const bottomY = -panelH / 2 + 10 + pagerAreaH;
        const viewH = Math.max(this.gridTopY - bottomY, 100);
        const viewY = (this.gridTopY + bottomY) / 2;
        const viewW = panelW - 40;

        const scrollNode = this.gm.createNode('GridScroll', area, 0, viewY, viewW, viewH);
        const scrollView = scrollNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;
        const viewNode = this.gm.createNode('View', scrollNode, 0, 0, viewW, viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;
        const gridNode = this.gm.createNode('GridContent', viewNode, 0, 0, viewW, Math.max(contentH, viewH));
        gridNode.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
        gridNode.setPosition(0, viewH / 2, 0);
        scrollView.content = gridNode;

        items.forEach((item, i) => {
            const r = Math.floor(i / 2);
            const c = i % 2;
            const x = c === 0 ? -(cardW / 2 + 4) : (cardW / 2 + 4);
            const y = -r * pitch - CARD_H / 2;
            this.drawCollectCard(gridNode, item, x, y, cardW);
        });
    }

    /** 底部翻页条：上一页 | 第 N 页 | 下一页，固定在面板底部，首页/末页对应按钮置灰不可点（商城同款） */
    private drawPager(area: Node) {
        const panelH = this.panelNode!.getComponent(UITransform)!.height;
        const pagerY = -panelH / 2 + 30;

        this.gm.createLabel(area, `第 ${this.page} 页`, 0, pagerY, 14, BROWN, true);
        this.drawPagerBtn(area, pagerY, -85, '❮ 上一页', this.page > 1, () => {
            this.loadPage(this.page - 1);
        });
        this.drawPagerBtn(area, pagerY, 85, '下一页 ❯', this.hasNextPage, () => {
            this.loadPage(this.page + 1);
        });
    }

    /** 单个翻页按钮：enabled=false 时置灰且不挂点击事件 */
    private drawPagerBtn(area: Node, y: number, x: number, text: string, enabled: boolean, onTap: () => void) {
        const btnW = 100, btnH = 36;
        const btn = this.gm.createNode(`PagerBtn_${text}`, area, x, y, btnW, btnH);
        const g = btn.addComponent(Graphics);
        g.fillColor = enabled ? BEIGE : new Color(230, 228, 220, 255);
        g.roundRect(-btnW / 2, -btnH / 2, btnW, btnH, 10);
        g.fill();
        g.strokeColor = enabled ? BEIGE_LINE : DISABLED_GRAY;
        g.lineWidth = 2;
        g.roundRect(-btnW / 2, -btnH / 2, btnW, btnH, 10);
        g.stroke();
        this.gm.createLabel(btn, text, 0, 0, 14, enabled ? BROWN : DISABLED_GRAY, true);
        if (enabled) {
            btn.on(Node.EventType.TOUCH_END, (e: any) => {
                e.propagationStopped = true;
                onTap();
            }, this);
        }
    }

    /**
     * 单张收集卡：米色圆角框（仓库格子同款色），自上而下 名称→彩色图→x数量→按钮。
     * 卡片本身不挂点击事件；底部「应用于游戏」按钮换当前展示，当前项显示「使用中」置灰 + 左上角金星。
     */
    private drawCollectCard(parent: Node, item: MyStorageItem, x: number, y: number, cardW: number) {
        const card = this.gm.createNode(`CollectCard_${item.collectId}`, parent, x, y, cardW, CARD_H);
        const g = card.addComponent(Graphics);
        g.fillColor = BEIGE;
        g.roundRect(-cardW / 2, -CARD_H / 2, cardW, CARD_H, 12);
        g.fill();
        g.strokeColor = BEIGE_LINE;
        g.lineWidth = 2;
        g.roundRect(-cardW / 2, -CARD_H / 2, cardW, CARD_H, 12);
        g.stroke();

        // 名称（顶部居中）
        this.gm.createLabel(card, item.name, 0, CARD_H / 2 - 18, 15, BROWN, true);

        // 彩色图（远程图，加载完成前灰圆占位）
        const imgNode = this.gm.createNode('Icon', card, 0, 24, 56, 56);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.gm.loadRemoteImage(item.colorUrl, imgSprite, () => {
            if (!imgNode.isValid) return;
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, 24);
            ph.fill();
        });

        // 拥有数量
        this.gm.createLabel(card, `x${item.count}`, 0, -22, 14, BROWN, true);

        // 当前应用于游戏的角标：卡片左上角一颗金色五角星（仓库页同款）
        if (item.isCurrent) {
            const starNode = this.gm.createNode('StarBadge', card, -cardW / 2 + 10, CARD_H / 2 - 10, 20, 20);
            const starG = starNode.addComponent(Graphics);
            this.gm.drawStar(starG, 20, new Color(255, 200, 40, 255));
        }

        // 应用于游戏按钮：当前项置灰「使用中」，其余橙色可点
        const btnW = 96, btnH = 28;
        const btn = this.gm.createNode('ApplyBtn', card, 0, -CARD_H / 2 + 26, btnW, btnH);
        const bg = btn.addComponent(Graphics);
        bg.fillColor = item.isCurrent ? DISABLED_GRAY : ORANGE;
        bg.roundRect(-btnW / 2, -btnH / 2, btnW, btnH, btnH / 2);
        bg.fill();
        this.gm.createLabel(btn, item.isCurrent ? '使用中' : '应用于游戏', 0, 0, 13, new Color(255, 255, 255, 255), true);
        if (!item.isCurrent) {
            btn.on(Node.EventType.TOUCH_END, (e: any) => {
                e.propagationStopped = true;
                this.onApply(item);
            }, this);
        }
    }

    // ===== 换装 =====

    /**
     * 应用于游戏：本地先改 isCurrent 立刻重画当前页（视觉秒响应，不发新请求避免读写竞态，
     * 与仓库页同思路）；后端写失败回滚星标并提示。成功后关弹窗让玩家直接看到对局玩偶换新形象。
     */
    private onApply(item: MyStorageItem) {
        if (this.applying) return;
        SoundManager.getInstance()?.playSystemClick();
        this.applying = true;

        const prevCurrent = this.items.find((it) => it.isCurrent);
        if (prevCurrent) prevCurrent.isCurrent = false;
        item.isCurrent = true;
        this.renderGridArea(this.items);

        CollectStore.setCurrent(item.collectId).then((ok) => {
            this.applying = false;
            if (!ok) {
                if (!this.contentNode || !this.contentNode.isValid) return; // 弹窗已关：视图已销毁，回滚无意义
                // 后端写入失败：回滚星标，提示用户重试
                if (prevCurrent) prevCurrent.isCurrent = true;
                item.isCurrent = false;
                this.renderGridArea(this.items);
                this.gm.showCoinShortageTip('设置失败，请重试');
                return;
            }
            this.gm.refreshCatIconImage();
            if (!this.contentNode || !this.contentNode.isValid) return; // 弹窗已被用户手动关：人物已刷新，无需再关/提示
            this.close();
            this.gm.showCoinShortageTip('已应用于游戏');
        });
    }
}
