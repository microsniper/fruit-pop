import { Node, Color, Graphics, Sprite, SpriteFrame, Label, UITransform } from 'cc';
import { fetchShopList, ShopItem, ItemTypeEnum, RewardItem } from './api';
import { BundleManager } from './BundleManager';
import type { GameManager } from './GameManager';

/**
 * 商城页：整页切换（与仓库页同款架构），纯代码绘制、无底图素材。
 * 目录来自后端 game_shop（道具关联资源表、收集关联收集表，价格表内配置）；
 * 购买纯前端扣币入账（totalCoins/PropStore），与道具/金币存储边界一致。
 * 收集页按 group_code 分子 tab；收集表暂无数据时占位「敬请期待」。
 */

const BROWN = new Color(110, 75, 45, 255);
const BEIGE = new Color(240, 230, 205, 255);
const BEIGE_LINE = new Color(150, 110, 60, 255);
const BLUE = new Color(30, 136, 229, 255);
const ORANGE = new Color(255, 150, 0, 255);

/** 收集分组占位（收集表有数据后按返回的 groupCode 动态出 tab） */
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
    private subTab = 'animal';
    private shopList: ShopItem[] = [];
    private tabY = 0;

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
        if (this.gm.rootNode) this.gm.rootNode.removeAllChildren();
        this.gm.teardownGameView();

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
        this.gm.createLabel(this.pageNode, '商城', 0, headerY, 26, BROWN, true);
        this.balanceLabel = this.gm.createLabel(this.pageNode, `金币 x${this.gm.totalCoins}`, pageW / 2 - 20, headerY, 15, new Color(200, 140, 30, 255), true);
        this.balanceLabel.horizontalAlign = 2; // RIGHT
        this.balanceLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);

        // 主 tab
        this.tabY = headerY - 56;
        this.renderMainTabs();

        // 内容层（目录异步拉取后填充）
        this.contentNode = this.gm.createNode('ShopContent', this.pageNode, 0, 0, pageW, pageH);
        fetchShopList().then((list) => {
            if (!this.contentNode || !this.contentNode.isValid) return;
            this.shopList = list;
            this.renderContent();
        });
        this.renderContent();
    }

    private renderMainTabs() {
        ['MainTab_tools', 'MainTab_collect'].forEach((n) => {
            const old = this.pageNode?.getChildByName(n);
            if (old) old.destroy();
        });
        const tabs: { key: 'tools' | 'collect'; name: string; x: number }[] = [
            { key: 'tools', name: '道具', x: -62 },
            { key: 'collect', name: '收集', x: 62 },
        ];
        tabs.forEach((tab) => {
            const active = this.mainTab === tab.key;
            const pill = this.gm.createNode(`MainTab_${tab.key}`, this.pageNode!, tab.x, this.tabY, 112, 38);
            const g = pill.addComponent(Graphics);
            g.fillColor = active ? BLUE : BEIGE;
            g.roundRect(-56, -19, 112, 38, 19);
            g.fill();
            if (!active) {
                g.strokeColor = BEIGE_LINE;
                g.lineWidth = 2;
                g.roundRect(-56, -19, 112, 38, 19);
                g.stroke();
            }
            this.gm.createLabel(pill, tab.name, 0, 0, 18, active ? new Color(255, 255, 255, 255) : BROWN, true);
            pill.on(Node.EventType.TOUCH_END, () => {
                if (this.mainTab !== tab.key) {
                    this.mainTab = tab.key;
                    this.renderMainTabs();
                    this.renderContent();
                }
            }, this);
        });
    }

    // ===== 内容层 =====

    private renderContent() {
        if (!this.contentNode || !this.contentNode.isValid) return;
        this.contentNode.removeAllChildren();
        if (this.mainTab === 'tools') {
            this.renderToolsShop();
        } else {
            this.renderCollectShop();
        }
    }

    /** 道具商城行：图标 + 名称 + 价格 + 购买按钮 */
    private renderToolsShop() {
        const items = this.shopList.filter((s) => s.category === 1);
        const firstRowY = this.tabY - 66;
        items.forEach((item, i) => {
            const y = firstRowY - i * 76;
            this.drawShopRow(item, y);
        });
        if (items.length === 0) {
            this.gm.createLabel(this.contentNode!, '暂无上架道具', 0, firstRowY - 40, 15, new Color(150, 160, 140, 255), true);
        }
    }

    /** 收集商城：按 groupCode 分子 tab；无数据时占位分组+敬请期待 */
    private renderCollectShop() {
        const collectItems = this.shopList.filter((s) => s.category === 2);
        const groups = collectItems.length > 0
            ? Array.from(new Map(collectItems.map((c) => [c.groupCode, { key: c.groupCode, name: this.groupName(c.groupCode) }])).values())
            : COLLECT_GROUP_FALLBACK;
        if (!groups.some((g) => g.key === this.subTab)) this.subTab = groups[0]?.key || 'animal';

        const subY = this.tabY - 56;
        const gap = 8;
        const pillW = Math.min(100, (300 - gap * (groups.length - 1)) / groups.length);
        const startX = -((pillW * groups.length + gap * (groups.length - 1)) / 2) + pillW / 2;
        groups.forEach((group, gi) => {
            const active = this.subTab === group.key;
            const pill = this.gm.createNode(`SubTab_${group.key}`, this.contentNode!, startX + gi * (pillW + gap), subY, pillW, 34);
            const g = pill.addComponent(Graphics);
            g.fillColor = active ? BLUE : BEIGE;
            g.roundRect(-pillW / 2, -17, pillW, 34, 17);
            g.fill();
            if (!active) {
                g.strokeColor = BEIGE_LINE;
                g.lineWidth = 2;
                g.roundRect(-pillW / 2, -17, pillW, 34, 17);
                g.stroke();
            }
            this.gm.createLabel(pill, group.name, 0, 0, 16, active ? new Color(255, 255, 255, 255) : BROWN, true);
            pill.on(Node.EventType.TOUCH_END, () => {
                if (this.subTab !== group.key) {
                    this.subTab = group.key;
                    this.renderContent();
                }
            }, this);
        });

        const rows = collectItems.filter((c) => c.groupCode === this.subTab);
        const firstRowY = subY - 62;
        if (rows.length === 0) {
            this.gm.createLabel(this.contentNode!, '敬请期待', 0, firstRowY - 20, 15, new Color(150, 160, 140, 255), true);
            return;
        }
        rows.forEach((item, i) => {
            const y = firstRowY - i * 76;
            this.drawShopRow(item, y);
        });
    }

    private groupName(code: string): string {
        const map: Record<string, string> = { animal: '动物', car: '豪车', house: '房子', doll: '公仔' };
        return map[code] || code;
    }

    /** 商品行：卡片 + 图标 + 名称 + 价格 + 购买按钮 */
    private drawShopRow(item: ShopItem, y: number) {
        const pageW = this.gm.screenWidth;
        const rowW = pageW - 40;
        const row = this.gm.createNode(`ShopRow_${item.id}`, this.contentNode!, 0, y, rowW, 64);
        const g = row.addComponent(Graphics);
        g.fillColor = BEIGE;
        g.roundRect(-rowW / 2, -32, rowW, 64, 12);
        g.fill();
        g.strokeColor = BEIGE_LINE;
        g.lineWidth = 2;
        g.roundRect(-rowW / 2, -32, rowW, 64, 12);
        g.stroke();

        // 图标
        const imgNode = this.gm.createNode('Icon', row, -rowW / 2 + 34, 0, 44, 44);
        const imgSprite = imgNode.addComponent(Sprite);
        imgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.gm.loadRemoteImage(item.imageUrl, imgSprite, () => {
            if (!imgNode.isValid) return;
            const ph = imgNode.addComponent(Graphics);
            ph.fillColor = new Color(220, 214, 198, 255);
            ph.circle(0, 0, 19);
            ph.fill();
        });

        // 名称
        const nameLabel = this.gm.createLabel(row, item.name, -rowW / 2 + 62, 0, 15, BROWN, true);
        nameLabel.horizontalAlign = 0;
        nameLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

        // 价格
        const priceLabel = this.gm.createLabel(row, `${item.price}金币`, rowW / 2 - 84, 0, 14, new Color(200, 140, 30, 255), true);
        priceLabel.horizontalAlign = 2;
        priceLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);

        // 购买按钮
        const buyBtn = this.gm.createNode('BuyBtn', row, rowW / 2 - 40, 0, 64, 32);
        const bg2 = buyBtn.addComponent(Graphics);
        bg2.fillColor = ORANGE;
        bg2.roundRect(-32, -16, 64, 32, 16);
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
        layer.removeAllChildren();

        const mask = this.gm.createGraphicsNode('Mask', layer, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        mask.getComponent(Graphics)!.fillColor = new Color(0, 0, 0, 160);
        mask.getComponent(Graphics)!.rect(-this.gm.screenWidth / 2, -this.gm.screenHeight / 2, this.gm.screenWidth, this.gm.screenHeight);
        mask.getComponent(Graphics)!.fill();
        mask.on(Node.EventType.TOUCH_END, () => {
            layer.removeAllChildren();
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
            }
            this.gm.renderTools();
            layer.removeAllChildren();
            this.gm.showCoinShortageTip(`购买成功：${item.name}x${qty}`);
        }, this);
    }
}
