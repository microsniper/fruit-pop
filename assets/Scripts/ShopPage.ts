import { Node, Color, Graphics, Sprite, SpriteFrame, Label, UITransform, UIOpacity, tween, ScrollView, Mask } from 'cc';
import { fetchShopList, ShopItem, ShopGroup, ShopPage as ShopPageData, ItemTypeEnum, RewardItem } from './api';
import { BundleManager } from './BundleManager';
import { CollectStore } from './CollectStore';
import { drawTitlePlate, drawSegmentedTabs } from './PageTabs';
import type { GameManager } from './GameManager';

/**
 * 商城页：整页切换（与仓库页同款架构），纯代码绘制、无底图素材。
 * 目录来自后端 game_shop（道具关联资源表、收集关联收集表，价格表内配置），道具/收集各自独立分页，
 * 底部「上一页/下一页」按钮点击翻页（不是滚动自动加载）；切主 tab / 子 tab 时回到第一页重新拉取。
 * 购买纯前端扣币入账（totalCoins/PropStore），与道具/金币存储边界一致。
 * 收集页按 group_code 分子 tab；收集表暂无数据时占位「敬请期待」。
 */

const BROWN = new Color(110, 75, 45, 255);
const BEIGE = new Color(240, 230, 205, 255);
const BEIGE_LINE = new Color(150, 110, 60, 255);
const BLUE = new Color(30, 136, 229, 255);
const ORANGE = new Color(255, 150, 0, 255);
/** 翻页按钮不可点时的置灰色（首页无上一页/末页无下一页） */
const DISABLED_GRAY = new Color(190, 190, 180, 255);

/** 商城每页条数 */
const PAGE_SIZE = 10;

/** 收集分组占位（收集表暂无上架商品时展示，仅视觉，不代表真实分组） */
const COLLECT_GROUP_FALLBACK = [
    { key: 'animal', name: '动物' },
    { key: 'car', name: '豪车' },
    { key: 'house', name: '房子' },
];

export class ShopPage {
    private pageNode: Node | null = null;
    private contentNode: Node | null = null;
    private balanceLabel: Label | null = null;
    private mainTab: 'tools' | 'collect' = 'tools';
    /** 收集页子 tab：按 group_code 分组，空串=还没拿到后端分组列表，首次请求不带 groupCode（返回全部） */
    private subTab = '';
    /** 顶栏 tab 的 Y 坐标（render 里算好，内容层布局复用） */
    private tabY = 0;

    // ===== 分页状态（切主 tab / 子 tab 时由 resetPaging 清空回第一页；道具/收集各自独立计数，互不共享） =====
    /** 当前页的条目（点击翻页整批替换，不是滚动追加） */
    private items: ShopItem[] = [];
    /** 当前页码，从 1 开始；0 表示还没加载过 */
    private page = 0;
    /**
     * 是否还有下一页：以「当前页实际返回条数 = pageSize」判断，不用 total 计算页数。
     * 原因：total 和明细查询若存在偏差（如排序不稳定导致翻页漏行/重复），按 total 算出的页数会不准，
     * 「实际返回满一页」是唯一能直接验证、不依赖 total 的信号。
     */
    private hasNextPage = false;
    /** 请求飞行中标记：防止连点翻页按钮触发多次重叠请求 */
    private loading = false;
    /** 收集页的分组列表（后端下发，与 groupCode 筛选无关，tab 栏用） */
    private groups: ShopGroup[] = [];
    /** 上一页/下一页按钮节点：每次翻页 buildContentView 整块重画，这里只留引用供 renderContent 清空用 */
    private prevBtnNode: Node | null = null;
    private nextBtnNode: Node | null = null;
    /** 页码提示文字（第 X 页） */
    private pageIndicator: Label | null = null;
    /** 网格容器（每次翻页整块重画） */
    private gridNode: Node | null = null;

    constructor(private gm: GameManager) {}

    open() {
        this.render();
    }

    close() {
        if (this.pageNode && this.pageNode.isValid) {
            this.pageNode.destroy();
            this.pageNode = null;
        }
        this.contentNode = null;
        this.balanceLabel = null;
    }

    // ===== 页面骨架 =====

    private render() {
        this.close();
        if (this.gm.rootNode) this.gm.rootNode.destroyAllChildren();
        this.gm.teardownGameView();

        // 收集品购买（CollectStore.own）需要背包内存缓存已就位；不阻塞页面渐染，
        // 缓存本身有去重保护，正常情况下用户点购买按钮前早已加载完成
        CollectStore.ensureLoaded();

        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        this.pageNode = this.gm.createNode('ShopPage', this.gm.rootNode!, 0, 0, pageW, pageH);

        // 弹窗层：购买弹窗/横幅挂载在此（整页切换销毁了游戏界面的弹窗层，需重建，与 HomePage 同款）
        this.gm.modalLayerNode = this.gm.createNode('ModalLayer', this.gm.rootNode!, 0, 0, pageW, pageH);
        this.gm.modalLayerNode.setSiblingIndex(999);

        // 背景（与排行榜/仓库页同色）
        const bg = this.gm.createGraphicsNode('ShopBg', this.pageNode, pageW, pageH, 0, 0);
        bg.getComponent(Graphics)!.fillColor = new Color(245, 248, 240, 255);
        bg.getComponent(Graphics)!.rect(-pageW / 2, -pageH / 2, pageW, pageH);
        bg.getComponent(Graphics)!.fill();

        // 顶栏：返回 + 标题 + 金币余额
        const headerY = pageH / 2 - 80;
        const backBtn = this.gm.createNode('BackBtn', this.pageNode, -pageW / 2 + 30, headerY, 40, 40);
        this.gm.createLabel(backBtn, '❮', 0, 0, 24, new Color(100, 120, 90, 255), true);
        backBtn.on(Node.EventType.TOUCH_END, () => {
            this.close();
            this.gm.homePage.render();
        }, this);
        drawTitlePlate(this.gm, this.pageNode, headerY, '商城');
        this.balanceLabel = this.gm.createLabel(this.pageNode, `金币 x${this.gm.totalCoins}`, pageW / 2 - 20, headerY, 15, new Color(200, 140, 30, 255), true);
        this.balanceLabel.horizontalAlign = 2; // RIGHT
        this.balanceLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);

        // 主 tab
        this.tabY = headerY - 56;
        this.renderMainTabs();

        // 掉落提示：主 tab 下方、内容列表上方，页面级别只画一次（不随 tab 切换重画），橙色呼吸小字
        const dropLabel = this.gm.createLabel(this.pageNode, '可通过每日挑战/无限模式掉落', 0, this.tabY - 50, 15, ORANGE, false);
        const dropOpacity = dropLabel.node.addComponent(UIOpacity);
        tween(dropOpacity)
            .to(0.9, { opacity: 100 }, { easing: 'sineInOut' })
            .to(0.9, { opacity: 255 }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();

        // 内容层
        this.contentNode = this.gm.createNode('ShopContent', this.pageNode, 0, 0, pageW, pageH);
        this.renderContent();
    }

    private renderMainTabs() {
        drawSegmentedTabs(
            this.gm, this.pageNode!, 'MainSegBar', this.tabY,
            [{ key: 'tools', name: '道具' }, { key: 'collect', name: '收集' }],
            this.mainTab, 'main',
            (key) => {
                this.mainTab = key as 'tools' | 'collect';
                this.subTab = '';
                this.renderMainTabs();
                this.renderContent(); // 内部会 resetPaging，回到第一页
            }
        );
    }

    // ===== 内容层 =====

    private renderContent() {
        if (!this.contentNode || !this.contentNode.isValid) return;
        this.contentNode.destroyAllChildren();
        this.gridNode = null;
        this.prevBtnNode = null;
        this.nextBtnNode = null;
        this.resetPaging();
        this.loadPage(1);
    }

    /** 切主 tab / 子 tab / 重进商城页：清空条目回到第一页，节点引用由 renderContent 负责清 */
    private resetPaging() {
        this.items = [];
        this.page = 0;
        this.hasNextPage = false;
        this.loading = false;
        this.groups = [];
    }

    /**
     * 拉取指定页码并整批替换当前展示内容。
     * loading 兜住连点：按钮点击后到数据回来之前再点无效。
     */
    private loadPage(targetPage: number) {
        if (this.loading) return;
        if (targetPage < 1) return;

        this.loading = true;
        const category = this.mainTab === 'tools' ? 1 : 2;
        const requestedMainTab = this.mainTab;
        const requestedSubTab = this.subTab;
        fetchShopList(category, this.mainTab === 'collect' ? (this.subTab || undefined) : undefined, targetPage, PAGE_SIZE).then((data) => {
            this.loading = false;
            if (!this.contentNode || !this.contentNode.isValid) return;
            // 请求飞行期间用户切了 tab：这批数据已经不属于当前筛选，丢弃
            if (requestedMainTab !== this.mainTab || requestedSubTab !== this.subTab) return;

            this.page = targetPage;
            this.groups = data.groups;
            this.items = data.items;
            // 权威判断：实际返回条数满一页才可能有下一页，不依赖 total 算页数
            this.hasNextPage = data.items.length >= PAGE_SIZE;

            this.buildContentView(data);
        }).catch(() => {
            this.loading = false;
        });
    }

    /** 数据到位：先清空旧内容（翻页/切子 tab 都会走到这），道具直接铺网格；收集需先画子 tab 再铺网格 */
    private buildContentView(data: ShopPageData) {
        if (!this.contentNode || !this.contentNode.isValid) return;
        this.contentNode.destroyAllChildren();
        this.gridNode = null;
        this.prevBtnNode = null;
        this.nextBtnNode = null;
        if (this.mainTab === 'tools') {
            this.buildToolsView(data);
        } else {
            this.buildCollectView(data);
        }
    }

    /** 道具商城：一行两卡（名称/图片/价格/购买），底部「上一页/下一页」按钮翻页 */
    private buildToolsView(data: ShopPageData) {
        const topY = this.tabY - 70;
        if (data.items.length === 0) {
            this.gm.createLabel(this.contentNode!, '暂无上架道具', 0, topY - 40, 15, new Color(150, 160, 140, 255), true);
            return;
        }
        this.buildGridContainer(topY, data.items);
        this.drawPager();
    }

    /** 收集商城：按 groupCode 分子 tab；无上架分组时占位分组+敬请期待 */
    private buildCollectView(data: ShopPageData) {
        const subY = this.tabY - 80;
        const groups = this.groups.length > 0
            ? this.groups.map((g) => ({ key: g.groupCode, name: g.groupName }))
            : COLLECT_GROUP_FALLBACK;

        // 首次进页 subTab 为空（不带 groupCode 拿第一个分组的数据），或当前分组已不存在：锁到第一个分组重来一次
        if (this.groups.length > 0 && !groups.some((g) => g.key === this.subTab)) {
            this.subTab = groups[0].key;
            this.renderContent();
            return;
        }

        // 子 tab 分段条（二级导航：小一号、米色容器、橙色选中段）
        drawSegmentedTabs(
            this.gm, this.contentNode!, 'SubSegBar', subY,
            groups, this.subTab, 'sub',
            (key) => {
                this.subTab = key;
                this.renderContent(); // 内部会 resetPaging，回到第一页
            }
        );

        const topY = subY - 40;
        if (data.items.length === 0) {
            this.gm.createLabel(this.contentNode!, '敬请期待', 0, topY - 40, 15, new Color(150, 160, 140, 255), true);
            return;
        }
        this.buildGridContainer(topY, data.items);
        this.drawPager();
    }

    /**
     * 商品卡片网格：一行两张，内容自上而下 名称→图片→价格→购买按钮。
     * 每页固定 PAGE_SIZE 条，用 ScrollView+Mask 裁切纯为兼容小屏内容超高时能手动滚一下看完整页，
     * 不再有「触底自动加载下一页」的逻辑——翻页只靠底部按钮点击触发。
     */
    private buildGridContainer(topY: number, items: ShopItem[]) {
        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        const cardW = 160, cardH = 176, gapX = 12, gapY = 12;
        const pitch = cardH + gapY;
        const rowCount = Math.ceil(items.length / 2);
        const contentH = Math.max(rowCount * pitch + gapY, 100);

        // 底部留出翻页按钮行的空间（PAGER_AREA_H），网格可视区在它上方
        const pagerAreaH = 60;
        const bottomY = -pageH / 2 + 8 + pagerAreaH;
        const viewH = Math.max(topY - bottomY, 100);
        const viewY = (topY + bottomY) / 2;
        const viewW = pageW - 24;

        const scrollNode = this.gm.createNode('GridScroll', this.contentNode!, 0, viewY, viewW, viewH);
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

        this.gridNode = gridNode;

        items.forEach((item, i) => {
            const r = Math.floor(i / 2);
            const c = i % 2;
            const x = c === 0 ? -(cardW / 2 + gapX / 2) : (cardW / 2 + gapX / 2);
            const y = -r * pitch - cardH / 2;
            this.drawShopCard(gridNode, item, x, y);
        });
    }

    /** 底部翻页条：上一页 | 第 N 页 | 下一页，固定在内容层底部，首页/末页对应按钮置灰不可点 */
    private drawPager() {
        const pageH = this.gm.screenHeight;
        const pagerY = -pageH / 2 + 30;

        this.pageIndicator = this.gm.createLabel(this.contentNode!, `第 ${this.page} 页`, 0, pagerY, 14, BROWN, true);

        this.prevBtnNode = this.drawPagerBtn(pagerY, -80, '❮ 上一页', this.page > 1, () => {
            this.loadPage(this.page - 1);
        });
        this.nextBtnNode = this.drawPagerBtn(pagerY, 80, '下一页 ❯', this.hasNextPage, () => {
            this.loadPage(this.page + 1);
        });
    }

    /** 单个翻页按钮：enabled=false 时置灰且不挂点击事件 */
    private drawPagerBtn(y: number, x: number, text: string, enabled: boolean, onTap: () => void): Node {
        const btnW = 100, btnH = 36;
        const btn = this.gm.createNode(`PagerBtn_${text}`, this.contentNode!, x, y, btnW, btnH);
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
            btn.on(Node.EventType.TOUCH_END, onTap, this);
        }
        return btn;
    }

    /** 单张商品卡：米色圆角框，自上而下 名称→图片→价格→购买按钮 */
    private drawShopCard(parent: Node, item: ShopItem, x: number, y: number) {
        const cardW = 160, cardH = 176;
        const card = this.gm.createNode(`ShopCard_${item.id}`, parent, x, y, cardW, cardH);
        const g = card.addComponent(Graphics);
        g.fillColor = BEIGE;
        g.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 14);
        g.fill();
        g.strokeColor = BEIGE_LINE;
        g.lineWidth = 2;
        g.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 14);
        g.stroke();

        // 名称（顶部居中）
        this.gm.createLabel(card, item.name, 0, 66, 15, BROWN, true);

        // 图片：收集品（category=2）点击可放大查看，道具不加此交互
        const imgNode = this.gm.createNode('Icon', card, 0, 16, 64, 64);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.gm.loadRemoteImage(item.imageUrl, imgSprite, () => {
            if (!imgNode.isValid) return;
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, 27);
            ph.fill();
        });
        if (item.category === 2 && item.imageUrl) {
            imgNode.on(Node.EventType.TOUCH_END, (e: any) => {
                e.propagationStopped = true;
                this.gm.renderImagePreview(item.imageUrl);
            }, this);

            // 右下角放大镜角标：纯视觉提示"这张图可以点开看大图"，本身不挂点击事件
            const hintNode = this.gm.createNode('ZoomHint', card, 28, -10, 16, 16);
            const hintG = hintNode.addComponent(Graphics);
            hintG.strokeColor = ORANGE;
            hintG.lineWidth = 2;
            hintG.circle(-2, 2, 4.5);
            hintG.stroke();
            hintG.moveTo(1.5, -1.5);
            hintG.lineTo(5, -5);
            hintG.stroke();
        }

        // 商品说明小字（后端 game_shop.item_desc 配置，如彩虹果「可任意匹配果篮」）
        if (item.itemDesc) {
            this.gm.createLabel(card, item.itemDesc, 0, -26, 11, BEIGE_LINE, true);
        }

        // 价格
        this.gm.createLabel(card, `${item.price}金币`, 0, -44, 14, new Color(200, 140, 30, 255), true);

        // 购买按钮
        const buyBtn = this.gm.createNode('BuyBtn', card, 0, -70, 84, 30);
        const bg2 = buyBtn.addComponent(Graphics);
        bg2.fillColor = ORANGE;
        bg2.roundRect(-42, -15, 84, 30, 15);
        bg2.fill();
        this.gm.createLabel(buyBtn, '购买', 0, 0, 15, new Color(255, 255, 255, 255), true);
        buyBtn.on(Node.EventType.TOUCH_END, () => this.onBuy(item), this);
    }

    /** 购买：弹数量弹窗（- 1 + 调数量，上限=余额/单价；确认购买再校验扣币） */
    private onBuy(item: ShopItem) {
        this.renderBuyModal(item);
    }

    /** 购买数量弹窗：商品图 + 「− 数量 ＋」+ 合计 + btn_action「确认购买」；遮罩点击关闭 */
    private renderBuyModal(item: ShopItem) {
        const layer = this.gm.modalLayerNode;
        if (!layer || !layer.isValid) return;
        layer.destroyAllChildren();

        const mask = this.gm.createGraphicsNode('Mask', layer, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        mask.getComponent(Graphics)!.fillColor = new Color(0, 0, 0, 160);
        mask.getComponent(Graphics)!.rect(-this.gm.screenWidth / 2, -this.gm.screenHeight / 2, this.gm.screenWidth, this.gm.screenHeight);
        mask.getComponent(Graphics)!.fill();
        mask.on(Node.EventType.TOUCH_END, () => {
            layer.destroyAllChildren();
        }, this);

        const panel = this.gm.createNode('BuyPanel', layer, 0, 0, 320, 360);
        panel.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 弹窗外框：米黄奶油圆角卡 + 棕色粗描边 + 白色内描边（与项目弹窗家族同语言）
        const frame = this.gm.createGraphicsNode('Frame', panel, 260, 340, 0, -5);
        const fg = frame.getComponent(Graphics)!;
        fg.fillColor = new Color(251, 243, 219, 255);
        fg.roundRect(-130, -170, 260, 340, 20);
        fg.fill();
        fg.strokeColor = new Color(150, 110, 60, 255);
        fg.lineWidth = 4;
        fg.roundRect(-130, -170, 260, 340, 20);
        fg.stroke();
        fg.strokeColor = new Color(255, 255, 255, 200);
        fg.lineWidth = 2;
        fg.roundRect(-124, -164, 248, 328, 16);
        fg.stroke();

        // 商品图
        const imgNode = this.gm.createNode('ItemImg', panel, 0, 95, 130, 130);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.gm.loadRemoteImage(item.imageUrl, imgSprite, () => {
            if (!imgNode.isValid) return;
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, 55);
            ph.fill();
        });

        // 数量行：− | 数量 | ＋（上限=余额/单价，到顶点+不涨；下限 1）
        let qty = 1;
        const maxQty = () => Math.max(1, Math.floor(this.gm.totalCoins / item.price));

        // 数量底板：橙色小圆角托底，白字才清晰
        const qtyBg = this.gm.createGraphicsNode('QtyBg', panel, 64, 36, 0, 0);
        const qg = qtyBg.getComponent(Graphics)!;
        qg.fillColor = ORANGE;
        qg.roundRect(-32, -18, 64, 36, 12);
        qg.fill();
        const qtyLabel = this.gm.createLabel(panel, '1', 0, 0, 22, new Color(255, 255, 255, 255), true);
        const totalLabel = this.gm.createLabel(panel, `合计：${item.price}金币`, 0, -52, 16, new Color(200, 140, 30, 255), true);
        const refresh = () => {
            qtyLabel.string = `${qty}`;
            totalLabel.string = `合计：${qty * item.price}金币`;
        };

        const mkStepBtn = (x: number, text: string, onTap: () => void) => {
            const btn = this.gm.createNode('StepBtn', panel, x, 0, 44, 44);
            const g = btn.addComponent(Graphics);
            g.fillColor = BEIGE;
            g.roundRect(-22, -22, 44, 44, 12);
            g.fill();
            g.strokeColor = BEIGE_LINE;
            g.lineWidth = 2;
            g.roundRect(-22, -22, 44, 44, 12);
            g.stroke();
            this.gm.createLabel(btn, text, 0, 0, 24, BROWN, true);
            btn.on(Node.EventType.TOUCH_END, () => {
                onTap();
                refresh();
            }, this);
        };
        mkStepBtn(-70, '−', () => { if (qty > 1) qty--; });
        mkStepBtn(70, '＋', () => { if (qty < maxQty()) qty++; });

        // 确认购买：btn_action 橙钮
        const buyBtn = this.gm.createNode('ConfirmBuy', panel, 0, -125, 140, 61);
        const buySprite = buyBtn.addComponent(Sprite);
        buySprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/btn_action/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && buySprite.isValid) buySprite.spriteFrame = sf;
        }).catch(() => {});
        this.gm.createLabel(buyBtn, '确认购买', 0, 0, 20, new Color(255, 255, 255, 255), true);
        buyBtn.on(Node.EventType.TOUCH_END, () => {
            const total = qty * item.price;
            // 再校验一次（防弹窗开着期间余额变化）
            if (this.gm.totalCoins < total) {
                this.gm.showCoinShortageTip('金币数量不足');
                return;
            }
            this.gm.totalCoins -= total;
            try {
                localStorage.setItem('totalCoins', this.gm.totalCoins.toString());
            } catch (e) {}
            if (this.balanceLabel && this.balanceLabel.isValid) {
                this.balanceLabel.string = `金币 x${this.gm.totalCoins}`;
            }
            if (item.category === 1 && item.resourceCode != null) {
                const reward: RewardItem = { itemType: ItemTypeEnum.PROP, resourceCode: item.resourceCode, amount: qty, imageUrl: item.imageUrl };
                this.gm.grantRewardSilently(reward);
            } else if (item.category === 2 && item.collectId != null) {
                CollectStore.own(item.collectId, qty);
            }
            this.gm.renderTools();
            layer.destroyAllChildren();
            this.gm.showCoinShortageTip(`购买成功：${item.name}x${qty}`);
        }, this);
    }
}
