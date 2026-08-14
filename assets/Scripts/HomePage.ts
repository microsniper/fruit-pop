import { Node, Vec3, UITransform, Color, tween, Graphics, Mask, Sprite, SpriteFrame, Label, resources, ScrollView, director, UIOpacity } from 'cc';
import { getGameConfig, isNewUserThisLogin, getLocalRegionId, fetchRegionList, saveUserRegion, RegionItem, getDailyRankConfig, DailyRankResponse, fetchRandomFruits, CollectItem, getDailyStatus } from './api';
import { SoundManager } from './SoundManager';
import { BundleManager } from './BundleManager';
import { LoadingPage } from './LoadingPage';
import { SignInPage } from './SignInPage';
import { FeedbackPage } from './FeedbackPage';
import { CollectStore } from './CollectStore';
import type { GameManager } from './GameManager';

/** 首页排行牌圆盘水果人群：固定摆放数量，与通关人数无关，保证每个圆盘都站满 */
const HOME_FRUIT_CROWD_MAX = 20;
/** rank_disc.png 实际高宽比（512x395），几何计算要用真实比例，不能拿占位比例算位置 */
const DISC_ASPECT = 395 / 512;

declare const wx: any;

/**
 * 首页：模式选择页（无限模式/每日挑战）及只在首页出现的功能——
 * 签到入口、首页设置弹窗、免费金币、新人礼弹窗。
 * 纯逻辑类（非组件），共享工具与状态通过 GameManager 引用访问。
 */
export class HomePage {
    /** 首页节点：模式选择页（无限模式/每日挑战） */
    private pageNode: Node | null = null;
    /** 首页免费金币按钮（领满置灰用） */
    private freeCoinBtnNode: Node | null = null;
    /** 免费金币每日限领次数 */
    private readonly FREE_COIN_DAILY_LIMIT = 3;
    /** 本次登录是否已标记过新人礼待领取（防止领取后同会话重复标记） */
    private newUserGiftMarked = false;
    /** 签到引导手指（今天未签到时压在签到按钮上） */
    private signInGuideNode: Node | null = null;
    /** 每日挑战省份榜数据缓存（本次 render 有效，随首页销毁失效） */
    private dailyRankCache: DailyRankResponse | null = null;
    /** 水果目录（game_collect 里 groupCode=fruit 的子集），供排行牌人群贴图随机挑选用 */
    private fruitCatalog: CollectItem[] | null = null;

    constructor(private gm: GameManager) {}

    /** 首页：模式选择页（无限模式 / 每日挑战），与排行榜页同样的整页切换方式 */
    render() {
        this.close();
        this.gm.rankPage.close();
        this.gm.storagePage.close();
        this.gm.shopPage.close();
        if (this.gm.rootNode) {
            this.gm.rootNode.destroyAllChildren();
        }
        this.gm.teardownGameView();

        const pageW = this.gm.screenWidth;
        const pageH = this.gm.screenHeight;
        this.pageNode = this.gm.createNode('HomePage', this.gm.rootNode!, 0, 0, pageW, pageH);

        // 兜底纯色背景（背景图加载完成前避免露底）
        const bgColor = this.gm.createGraphicsNode('HomeBgColor', this.pageNode, pageW, pageH, 0, 0);
        this.gm.drawRoundedRect(bgColor.getComponent(Graphics)!, pageW, pageH, new Color(232, 237, 220, 255), 0);

        // 背景图：等比缩放填满（cover-fit），裁切层防止溢出
        const bgClip = this.gm.createNode('HomeBgClip', this.pageNode, 0, 0, pageW, pageH);
        bgClip.addComponent(Mask);
        const bgNode = this.gm.createNode('HomeBg', bgClip, 0, 0, pageW, pageH);
        const bgSprite = bgNode.addComponent(Sprite);
        bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('ui/home_bg/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && bgSprite && bgSprite.isValid) {
                bgSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    const scale = Math.max(pageW / rect.width, pageH / rect.height);
                    bgNode.getComponent(UITransform)!.setContentSize(rect.width * scale, rect.height * scale);
                }
            }
        });

        // 每日挑战省份排行牌+水果人群：铺在背景之上、所有按钮之下（图层意义上的"下面"）。
        // 容器节点必须在这里同步创建（占好兄弟节点顺序），内容数据异步拉到后再往里填——
        // 否则等异步回调触发时标题/按钮早已作为后续兄弟节点加入，反而会盖在它们上面。
        this.renderRegionRankBoard(pageW, pageH);

        // 顶部标题「摘呀摘」（title_home.png，分包；启动时分包已随水果预载，此时必定可用）
        const titleW = pageW * 0.62;
        const titleNode = this.gm.createNode('HomeTitle', this.pageNode, 0, pageH * 0.34, titleW, titleW * 0.41);
        const titleSprite = titleNode.addComponent(Sprite);
        titleSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/title_home/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && titleSprite.isValid) {
                titleSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    titleNode.getComponent(UITransform)!.setContentSize(titleW, titleW * (rect.height / rect.width));
                }
            }
        }).catch(() => {});
        // 标题轻微呼吸动画
        tween(titleNode)
            .to(1.2, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'sineInOut' })
            .to(1.2, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();

        // 两个模式入口按钮（每日挑战在上，无限模式在下）：
        // 无限模式离屏幕底边约 50px，每日挑战在无限模式上方 120px（两者按钮中心的距离）
        const dailyBtnW = 125;
        const dailyBtnH = dailyBtnW * (225 / 420); // btn_daily.png 实际宽高比
        const endlessBtnW = 125;
        const endlessBtnH = endlessBtnW * (252 / 420); // btn_endless.png 实际宽高比
        const endlessBtnY = -pageH / 2 + 50 + endlessBtnH / 2;
        const dailyBtnY = endlessBtnY + 120;
        this.createHomeButton('btn_daily', 0, dailyBtnY, dailyBtnW, () => this.onDailyChallengeClick());
                // 今日状态小字：叠在按钮图上，往下调 30px（26px 基础上再下移 4px 避开按钮文字），金色突出提醒。
                // 查后端真实通关状态（不同设备/环境登录同一账号结果一致），不用本地缓存判断
                const dailyStatusNode = this.pageNode;
                getDailyStatus().then((res) => {
                    if (!dailyStatusNode || !dailyStatusNode.isValid || !res?.cleared) return;
                    this.gm.createLabel(dailyStatusNode, '今日已通关', 0, dailyBtnY + dailyBtnH * 0.18 - 30, 14, new Color(255, 200, 60, 255), true);
                }).catch(() => {});
        this.createHomeButton('btn_endless', 0, endlessBtnY, endlessBtnW, () => this.enterEndlessMode());

        // 左右两侧功能图标：每日签到（左）、排行榜（右）；两侧整组按钮下移 80px 让位给排行牌板
        const sideBtnW = 58;
        const sideBtnYOffset = 80;
        const sideBtnY = pageH * 0.10 - sideBtnYOffset;
        const signInBtnNode = this.createHomeButton('btn_signin', -pageW / 2 + 42, sideBtnY, sideBtnW, () => this.onSignInClick());
        // 个人仓库（签到按钮下方，间距与「设置-签到」间距同款 0.12*pageH）：整页切换，看道具与收集品
        this.createHomeButton('btn_storage', -pageW / 2 + 42, sideBtnY - pageH * 0.12, sideBtnW, () => this.gm.storagePage.open());
        // 今天未签到：签到按钮右上角红点提醒
        if (signInBtnNode && !SignInPage.isSignedToday()) {
            const dot = signInBtnNode.addComponent(Graphics);
            dot.fillColor = new Color(235, 60, 50, 255);
            dot.circle(sideBtnW * 0.42, sideBtnW * 0.26, 6);
            dot.fill();
        }
        // 未授权用户：签到按钮也叠加微信原生授权按钮，授权成功后再继续签到流程
        if (signInBtnNode) {
            this.gm.setupAuthOverlay('signin', signInBtnNode, () => this.onSignInClick());
        }
        const rankBtnNode = this.createHomeButton('btn_rank', pageW / 2 - 42, sideBtnY, sideBtnW, () => {
            this.gm.rankPage.open(true);
        });
        // 商城（排行榜按钮正下方，与左列仓库对称）：整页切换，金币买道具/收集品
        this.createHomeButton('btn_shop', pageW / 2 - 42, sideBtnY - pageH * 0.12, sideBtnW, () => this.gm.shopPage.open());
        // 未授权用户：微信原生授权按钮叠在排行榜按钮上（游戏内排行榜入口已移除，授权只在首页完成），
        // 点击即由微信自动串起「官方隐私弹窗 → 昵称头像授权弹窗」
        if (rankBtnNode) {
            this.gm.rankPage.setupAuthOverlay(rankBtnNode);
        }

        // 左上角设置按钮：放在树冠下方，避免遮挡背景上的树；同样下移 80px 与两侧按钮组保持一致
        const topSideBtnY = pageH * 0.22 - sideBtnYOffset;
        this.createHomeButton('btn_home_settings', -pageW / 2 + 42, topSideBtnY, sideBtnW, () => this.renderHomeSettingsModal());

        // 免费金币（排行榜上方，与设置按钮同高）：看广告领金币，每天限 3 次
        this.freeCoinBtnNode = this.createHomeButton('btn_free_coin', pageW / 2 - 42, topSideBtnY, sideBtnW, () => this.onFreeCoinClick());
        if (this.freeCoinBtnNode && this.getFreeCoinClaimsToday() >= this.FREE_COIN_DAILY_LIMIT) {
            const sp = this.freeCoinBtnNode.getComponent(Sprite);
            if (sp) sp.grayscale = true;
        }

        // 金币余额：图标+文字平铺（方形 coin.png，无底框），位置独立于两侧按钮组（不跟着下移），
        // 图标和数字都调大、数字加粗，比之前更醒目。引用挂到 gm.coinCountLabel/coinIconNode 上，
        // 新人礼的金币飞行动画自动飞向这里
        const balIconH = 36;
        const balY = pageH * 0.22 - 30; // 金币条整体下移 30px
        const balCoinNode = this.gm.createNode('HomeCoinIcon', this.pageNode, -balIconH / 2 - 4, balY, balIconH, balIconH);
        this.gm.coinIconNode = balCoinNode;
        const balCoinSprite = balCoinNode.addComponent(Sprite);
        balCoinSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/coin/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && balCoinSprite.isValid) {
                balCoinSprite.spriteFrame = sf;
            }
        }).catch(() => {});
        // 数字紧贴图标右侧，左锚点+不缩放，数字变大时向右撑
        const balLabelNode = this.gm.createNode('HomeCoinCount', this.pageNode, balIconH / 2 + 2, balY, balIconH * 2, balIconH);
        const balLabel = balLabelNode.addComponent(Label);
        balLabel.fontSize = 22;
        balLabel.lineHeight = balIconH;
        balLabel.isBold = true;
        balLabel.color = new Color(46, 110, 30, 255);
        balLabel.string = `${this.gm.totalCoins}`;
        const balTransform = balLabelNode.getComponent(UITransform);
        if (balTransform) balTransform.setAnchorPoint(0, 0.5);
        balLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        balLabel.verticalAlign = Label.VerticalAlign.CENTER;
        balLabel.overflow = Label.Overflow.NONE;
        this.gm.coinCountLabel = balLabel;

        // 弹窗层：设置弹窗等挂载在此，盖在首页之上（首页销毁了游戏界面的弹窗层，需重建）
        this.gm.modalLayerNode = this.gm.createNode('ModalLayer', this.gm.rootNode!, 0, 0, pageW, pageH);
        this.gm.modalLayerNode.setSiblingIndex(999);
        // 原生授权按钮浮在 Canvas 之上，任何弹窗（签到/设置/新人礼）打开期间需隐藏，防止透明按钮误拦截点击
        this.gm.modalLayerNode.on(Node.EventType.CHILD_ADDED, () => {
            this.gm.setAuthOverlayVisible('rank', false);
            this.gm.setAuthOverlayVisible('signin', false);
        }, this);
        this.gm.modalLayerNode.on(Node.EventType.CHILD_REMOVED, () => {
            if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid && this.gm.modalLayerNode.children.length === 0) {
                this.gm.setAuthOverlayVisible('rank', true);
                this.gm.setAuthOverlayVisible('signin', true);
            }
        }, this);

        // 今天未签到：手指引导指向签到按钮
        this.showSignInGuideIfNeeded(-pageW / 2 + 42, sideBtnY);

        // 新人礼弹窗改在首页弹出（已领取的不会再弹）
        this.gm.scheduleOnce(() => this.tryShowRewards(), 0.6);

        // 商城/道具远程图改为按需加载（点商城/仓库入口时才预热），不在首页无差别全量下载解码，
        // 避免不进商城/仓库的玩家也白白背上这份内存开销
    }

    /** 首页按钮：整图 Sprite + 按压缩放反馈，高度按图片比例自适应 */
    private createHomeButton(imgName: string, x: number, y: number, width: number, onTap: () => void): Node | null {
        if (!this.pageNode) return null;
        const btnNode = this.gm.createNode(`HomeBtn_${imgName}`, this.pageNode, x, y, width, width * 0.55);
        const sprite = btnNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        // 主页按钮图已挪 bundle_late 分包（主包瘦身），用 BundleManager 加载
        BundleManager.getInstance().loadAsset<SpriteFrame>(`ui/${imgName}/spriteFrame`, SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    btnNode.getComponent(UITransform)!.setContentSize(width, width * (rect.height / rect.width));
                }
            }
        }).catch(() => {});
        btnNode.on(Node.EventType.TOUCH_START, () => {
            tween(btnNode).to(0.06, { scale: new Vec3(0.94, 0.94, 1) }).start();
        }, this);
        btnNode.on(Node.EventType.TOUCH_CANCEL, () => {
            tween(btnNode).to(0.08, { scale: new Vec3(1, 1, 1) }).start();
        }, this);
        btnNode.on(Node.EventType.TOUCH_END, () => {
            tween(btnNode).to(0.08, { scale: new Vec3(1, 1, 1) }).start();
            SoundManager.getInstance()?.playSystemClick();
            onTap();
        }, this);
        return btnNode;
    }

    // ===== 首页省份排行牌 + 水果人群：铺满全页，垫在按钮之下（图层顺序），可上下滑动 =====

    /**
     * 排行牌容器节点同步创建（占好兄弟节点顺序，保证垫在后续标题/按钮之下），
     * 数据（省份榜+水果目录）异步拉取，拿到后再往容器里填内容。
     */
    private renderRegionRankBoard(pageW: number, pageH: number) {
        if (!this.pageNode) return;
        const boardParent = this.pageNode;
        const boardNode = this.gm.createNode('RegionRankBoard', boardParent, 0, 0, pageW, pageH);
        Promise.all([getDailyRankConfig(), this.ensureFruitCatalog(), CollectStore.ensureLoaded()]).then(([rank]) => {
            if (!boardNode.isValid) return;
            this.dailyRankCache = rank;
            this.buildRegionRankList(boardNode, pageW, pageH);
        }).catch(() => { /* 榜拉取失败：首页其余内容照常展示，静默跳过这块 */ });
    }

    /** 水果目录（后端随机抽取 30 个 fruit，每次进首页结果不同），会话内缓存一次 */
    private async ensureFruitCatalog(): Promise<CollectItem[]> {
        if (this.fruitCatalog) return this.fruitCatalog;
        this.fruitCatalog = await fetchRandomFruits();
        return this.fruitCatalog;
    }

    /** 一个排名人群贴图用的水果图标：随机挑一个装饰用；preferMine 时优先取玩家真实展示的水果 */
    private pickFruitIconUrl(preferMine: boolean): string | null {
        const catalog = this.fruitCatalog;
        if (!catalog || catalog.length === 0) return null;
        if (preferMine) {
            const mine = CollectStore.getCurrentCollect(catalog);
            if (mine) return mine.colorUrl;
        }
        return catalog[Math.floor(Math.random() * catalog.length)].colorUrl;
    }

    /**
     * 可滑动的省份排行列表：每个排名一块「悬浮排名牌 + 圆盘水果人群」，居中片宽（两侧让给功能按钮），
     * 外层滚动容器仍铺满整页高度撑滑动手势范围，行内容只占中间一列。
     */
    private buildRegionRankList(parent: Node, pageW: number, pageH: number) {
        const data = this.dailyRankCache;
        const list = data?.list || [];
        if (list.length === 0) return;

        const plateOverlap = -20; // 牌子底边与圆盘顶边的间距（负值=拉开距离，避免猫群贴着牌子挡字）
        const plateH = 40;
        const rowGap = 20;
        const columnW = pageW * 0.6; // 居中片宽，两侧留给签到/仓库/排行榜/商城等按钮
        const plateW = columnW * 0.86;
        const discW = columnW;
        const discH = discW * DISC_ASPECT; // 圆盘实际高度，按真实图片比例算，不用占位猜测值
        // 单行总高 = 牌子 + 圆盘 - 重叠量 + 行间距
        const itemH = plateH + discH - plateOverlap + rowGap;
        // 列表起点：金币余额条下方留出间隙，不从屏幕最顶部开始（金币在 pageH*0.22，图标半高14）；第一名再整体下移 80px
        const topPad = pageH * 0.28 + 14 + 24 + 80;

        const scrollView = parent.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;

        const viewNode = this.gm.createNode('RegionRankView', parent, 0, 0, pageW, pageH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;

        const contentH = Math.max(list.length * itemH + topPad, pageH);
        const contentNode = this.gm.createNode('RegionRankContent', viewNode, 0, 0, pageW, contentH);
        contentNode.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
        contentNode.setPosition(0, pageH / 2, 0);
        scrollView.content = contentNode;

        // 分帧建行：每行含圆盘+牌子+3文字+20个水果头像（约24个节点/行），省份数多时一次同步建完
        // 会在首页刚进入时卡住主线程一整帧，与排行榜页列表同款分帧手法，摊到多帧完成
        const ROW_CHUNK = 2;
        let rowIndex = 0;
        const buildRowStep = () => {
            if (!contentNode.isValid) {
                this.gm.unschedule(buildRowStep);
                return;
            }
            const end = Math.min(rowIndex + ROW_CHUNK, list.length);
            for (; rowIndex < end; rowIndex++) {
                const item = list[rowIndex];
                const rowTopY = -topPad - rowIndex * itemH; // 本行最顶部（牌子顶边）
                const plateY = rowTopY - plateH / 2;
                const discTopY = plateY - plateH / 2 + plateOverlap; // 圆盘顶边：牌子底边往上收 plateOverlap 像素，制造重叠悬浮感
                const discCenterY = discTopY - discH / 2;
                const isMe = !!item.isMe;

                // 圆盘贴图：宽高按真实比例（DISC_ASPECT）设置
                const discNode = this.gm.createNode('RankDisc', contentNode, 0, discCenterY, discW, discH);
                const discSprite = discNode.addComponent(Sprite);
                discSprite.sizeMode = Sprite.SizeMode.CUSTOM;
                BundleManager.getInstance().loadAsset<SpriteFrame>('ui/rank_disc/spriteFrame', SpriteFrame).then((sf) => {
                    if (sf && discSprite.isValid) {
                        discSprite.spriteFrame = sf;
                    }
                }).catch(() => {});

                // 悬浮排名牌：压在圆盘上沿之上（完全脱出圆盘范围，不会被圆盘或人群遮挡）；
                // 每个名次给不同颜色（不止前三名），isMe 保留橙色高亮优先于名次配色
                const plateBg = this.gm.createGraphicsNode('RankPlate', contentNode, plateW, plateH, 0, plateY);
                const plateColor = isMe ? new Color(255, 150, 0, 255) : this.getRankPlateColor(item.rank);
                const textColor = isMe || item.rank <= 3 ? new Color(90, 60, 30, 255) : new Color(255, 255, 255, 255);
                this.gm.drawRoundedRect(plateBg.getComponent(Graphics)!, plateW, plateH, plateColor, plateH / 2, 2, new Color(255, 255, 255, 200));

                const leftX = -plateW / 2 + 10;
                const rl = this.gm.createLabel(contentNode, `第${item.rank}名`, leftX, plateY, 14, textColor, true);
                rl.horizontalAlign = 0;
                rl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

                const nl = this.gm.createLabel(contentNode, item.regionName || '未知', 0, plateY + 9, 13, textColor, isMe);
                nl.horizontalAlign = 1;
                const vl = this.gm.createLabel(contentNode, `今日已通关${item.clearCount}`, 0, plateY - 9, 11, textColor, false);
                vl.horizontalAlign = 1;

                // 圆盘上的水果人群：按椭圆范围站位（贴合圆盘轮廓，不用矩形避免站出圆盘外），
                // 不管 clearCount 多少，固定按圆盘容量站满；plateBottomY 传入用于夹住人群顶部，不让猫头顶穿排名牌
                const plateBottomY = plateY - plateH / 2;
                this.renderFruitCrowd(contentNode, 0, discCenterY, discW, discH, plateBottomY, isMe);
            }
            if (rowIndex >= list.length) {
                this.gm.unschedule(buildRowStep);
            }
        };
        this.gm.schedule(buildRowStep, 0);
    }

    /** 排名牌配色：前三名金/银/铜，其余按名次循环取一套鲜艳色板，不再是清一色白底 */
    private getRankPlateColor(rank: number): Color {
        if (rank === 1) return new Color(255, 200, 60, 255);   // 金
        if (rank === 2) return new Color(192, 200, 210, 255);  // 银
        if (rank === 3) return new Color(226, 168, 110, 255);  // 铜
        const palette = [
            new Color(90, 170, 230, 255),  // 蓝
            new Color(235, 110, 110, 255), // 红
            new Color(110, 200, 140, 255), // 绿
            new Color(230, 170, 70, 255),  // 橙黄
            new Color(170, 130, 220, 255), // 紫
            new Color(90, 200, 200, 255)   // 青
        ];
        return palette[(rank - 4) % palette.length];
    }

    /**
     * 圆盘上的水果人群：一群水果图标乱站、前后叠压，固定按区域容量站满（与通关人数无关，
     * 没人通关的省份也照样站满一圈随机水果）。isMe 的圆盘里固定一个位置换成玩家自己真实展示的水果。
     * discW/discH 是圆盘贴图的完整宽高——站位按椭圆（贴合圆盘轮廓）取点，不用矩形，
     * 避免矩形四角超出圆盘边界；半径按图标半径内缩，保证图标中心到边界的留白够放下整个图标。
     * plateBottomY：排名牌下沿的绝对 Y 坐标，用来夹住每个点的最高位置（点的 y + 图标半高 不能超过它），
     * 防止图标本身有半个身子的高度，最上面几个贴图头顶顶穿排名牌。
     */
    private renderFruitCrowd(parent: Node, centerX: number, centerY: number, discW: number, discH: number, plateBottomY: number, isMe: boolean) {
        if (!this.fruitCatalog || this.fruitCatalog.length === 0) return;
        const count = HOME_FRUIT_CROWD_MAX;
        const baseSize = 90; // 放大 3 倍（原 30）
        const halfIcon = baseSize / 2;

        // 站位落在圆盘视觉主体的上半区域（圆盘是俯视透视的扁圆台，站人应站在顶面偏上，不站到下边缘露馅）
        const standCenterY = centerY + discH * 0.06;
        const radiusX = Math.max(0, discW / 2 - baseSize * 0.15);
        // 上下半区用不同的纵向半径（上大下小的椭圆拼接，不是简单夹逼）：
        // 上半区受牌子下沿硬约束，能留多少空间就用多少；下半区没有遮挡，按原有比例放开，
        // 这样上半区不会被压扁成一条线，下半区也不会因为让位而变得空旷
        const maxPointY = plateBottomY - halfIcon - 4; // 图标顶部不超过牌子下沿，留 4px 安全间隙
        const upRadiusY = Math.max(10, standCenterY - maxPointY);
        const downRadiusY = Math.max(0, discH * 0.4 - baseSize * 0.08);

        // 上下半椭圆拼接采样：sin(angle)<0（上半）用 upRadiusY，>=0（下半）用 downRadiusY，
        // 两者在 angle=0/180 处都收于 standCenterY，拼接处连续不突变
        const points: { x: number; y: number }[] = [];
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random());
            const sinA = Math.sin(angle);
            const radiusY = sinA < 0 ? upRadiusY : downRadiusY;
            const x = centerX + Math.cos(angle) * radiusX * r;
            const y = standCenterY + sinA * radiusY * r;
            points.push({ x, y });
        }
        points.sort((a, b) => b.y - a.y); // y 大（靠后）先放，y 小（靠前）后放，压在别人上层

        const meIndex = isMe ? points.length - 1 : -1;
        const maxRadiusY = Math.max(upRadiusY, downRadiusY);
        points.forEach((p, idx) => {
            const depth = maxRadiusY > 0 ? (standCenterY - p.y) / maxRadiusY : 0; // >0 越往前（下半区），<0 越往后（上半区）
            const scale = 1.05 - depth * 0.2 + (Math.random() * 0.1 - 0.05);
            const url = this.pickFruitIconUrl(idx === meIndex);
            if (url) this.createFruitIconNode(parent, p.x, p.y, baseSize * scale, url);
        });
    }

    private createFruitIconNode(parent: Node, x: number, y: number, size: number, colorUrl: string): Node {
        const node = this.gm.createNode('FruitIcon', parent, x, y, size, size);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        this.gm.loadRemoteImage(colorUrl, sprite, () => { /* 加载失败留空位，不影响其余水果展示 */ });
        return node;
    }

    /**
     * 签到引导手指：今天还没签到时，手指压在签到按钮上朝按钮方向反复轻戳。
     * 点签到按钮即销毁；挂在 pageNode 下随首页销毁，下次回首页仍未签再出现。
     */
    private showSignInGuideIfNeeded(btnX: number, btnY: number) {
        if (!this.pageNode) return;
        if (SignInPage.isSignedToday()) return;

        // 图 144x256，指尖朝左上（位于图上约 30%/8% 处），手放按钮右下让指尖落在按钮中心
        const handH = 64;
        const handW = Math.round(handH * 144 / 256);
        const hx = btnX + handW * 0.2;
        const hy = btnY - handH * 0.42;
        const handNode = this.gm.createNode('SignInGuideHand', this.pageNode, hx, hy, handW, handH);
        this.signInGuideNode = handNode;
        const handSprite = handNode.addComponent(Sprite);
        handSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/hand_guide/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && handSprite.isValid) {
                handSprite.spriteFrame = sf;
            }
        }).catch(() => {});

        // 朝按钮方向（左上）反复轻戳；手指节点不挂触摸事件，不挡按钮点击
        tween(handNode)
            .to(0.45, { position: new Vec3(hx - 5, hy + 7, 0) }, { easing: 'sineInOut' })
            .to(0.45, { position: new Vec3(hx, hy, 0) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }

    close() {
        if (this.pageNode && this.pageNode.isValid) {
            this.pageNode.destroy();
        }
        this.pageNode = null;
        this.signInGuideNode = null;
        // 首页金币余额引用随页面销毁置空（进游戏时 ensureTempSlotViews 检测到空引用会重建游戏内版本）
        this.gm.coinCountLabel = null;
        this.gm.coinIconNode = null;
        // 授权叠层只服务首页按钮，离开首页即销毁（重新 render 时会再创建）
        this.gm.destroyAuthOverlay('rank');
        this.gm.destroyAuthOverlay('signin');
    }

    /** 进入无限模式：重开一局全新局面（关卡号不变），首次进入时补触发新手引导 */
    private enterEndlessMode() {
        // 经 Loading 场景进入无限模式：加载页展示真实进度，完成后由 GameManager 直接进对局
        LoadingPage.target = 'endless';
        director.loadScene('Loading');
    }

    /** 新人礼是否待领取（本地存储标记，领取成功才清除，跨会话有效） */
    private isNewUserGiftPending(): boolean {
        try {
            if (typeof wx !== 'undefined') {
                return wx.getStorageSync('newUserGiftPending') === 'true';
            }
            return localStorage.getItem('newUserGiftPending') === 'true';
        } catch (e) {
            return false;
        }
    }

    private setNewUserGiftPending(pending: boolean) {
        try {
            if (typeof wx !== 'undefined') {
                wx.setStorageSync('newUserGiftPending', pending ? 'true' : '');
            } else {
                localStorage.setItem('newUserGiftPending', pending ? 'true' : '');
            }
        } catch (e) {}
    }

    /** 首页奖励弹窗轮询：登录数据可能晚于首页渲染返回，反复检查直到弹出或超次（离开首页即停止） */
    private tryShowRewards(attempt = 0) {
        if (!this.pageNode || !this.pageNode.isValid) return;
        if (attempt > 15) return;
        const retry = () => this.gm.scheduleOnce(() => this.tryShowRewards(attempt + 1), 2);
        // 有其他弹窗开着（签到/设置等）先等
        if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid && this.gm.modalLayerNode.children.length > 0) {
            retry();
            return;
        }
        // 新用户本次登录：标记新人礼待领取（仅标记一次，领取后不再重标）
        if (isNewUserThisLogin() && !this.newUserGiftMarked) {
            this.newUserGiftMarked = true;
            this.setNewUserGiftPending(true);
        }
        if (this.isNewUserGiftPending()) {
            this.showNewUserGiftModal();
            return;
        }
        retry();
    }

    /** 新人见面礼弹窗：仅创建用户的那次登录弹出，金额来自 game_config 的 new_user_reward */
    private showNewUserGiftModal() {
        const amount = getGameConfig()?.newUserReward ?? 1000;
        this.renderNewUserGiftModal(amount);
    }

    private renderNewUserGiftModal(amount: number) {
        if (!this.gm.modalLayerNode) return;
        this.gm.modalLayerNode.destroyAllChildren();

        // 遮罩（点击不关闭，仅拦截穿透；新人礼无 X，必须点宝箱领取）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 宝箱整图面板：panel_new_user_gift.png（标题、打开的宝箱、金色光芒都画在图里，1:1 方图）
        const panelW = Math.min(340, this.gm.screenWidth * 0.92);
        const panelNode = this.gm.createNode('NewUserGiftPanel', this.gm.modalLayerNode, 0, 0, panelW, panelW);
        const panelTransform = panelNode.getComponent(UITransform)!;
        const sprite = panelNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_new_user_gift/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && sprite && sprite.isValid) {
                sprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    panelTransform.setContentSize(panelW, panelW * rect.height / rect.width);
                }
            }
        }).catch(() => {});

        const ph = panelTransform.height;

        // 提示文案：面板下方
        this.gm.createLabel(this.gm.modalLayerNode, `点击宝箱领取 +${amount} 金币`, 0, -ph / 2 - 36, 20, new Color(255, 235, 160, 255), true);

        // 整个面板都是领取热区（无 X 按钮，不能错过）
        let claiming = false;
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            if (claiming) return;
            claiming = true;

            const startCoins = this.gm.totalCoins;
            this.gm.totalCoins += amount;
            if (typeof wx !== 'undefined' && wx.setStorageSync) {
                wx.setStorageSync('totalCoins', this.gm.totalCoins.toString());
            } else {
                localStorage.setItem('totalCoins', this.gm.totalCoins.toString());
            }
            // 领取成功，清除待领取标记（之后不再弹新人礼）
            this.setNewUserGiftPending(false);

            // 宝箱弹一下 + "+N 金币" 上飘 + 金色金币飞向顶部计数
            if (breathTween) breathTween.stop();
            tween(panelNode)
                .to(0.12, { scale: new Vec3(1.15, 1.15, 1) })
                .to(0.12, { scale: new Vec3(1, 1, 1) })
                .start();
            const gainLabel = this.gm.createLabel(this.gm.modalLayerNode!, `+${amount} 金币`, 0, ph * 0.18, 30, new Color(255, 220, 80, 255), true);
            tween(gainLabel.node)
                .by(0.8, { position: new Vec3(0, 70, 0) })
                .start();

            // 起飞点取宝箱主体中心（面板中心略偏下）
            const chestWorldPos = panelTransform.convertToWorldSpaceAR(new Vec3(0, -ph * 0.1, 0));
            this.gm.playDailyRewardCoinFly(chestWorldPos, startCoins, amount, () => {
                if (this.gm.modalLayerNode) this.gm.modalLayerNode.destroyAllChildren();
            });
        }, this);

        // 入场：从小到大弹出；播完后再启动独立的循环呼吸 tween
        let breathTween: ReturnType<typeof tween> | null = null;
        panelNode.setScale(new Vec3(0.6, 0.6, 1));
        tween(panelNode)
            .to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            .call(() => {
                if (!panelNode.isValid) return;
                breathTween = tween(panelNode)
                    .to(0.55, { scale: new Vec3(1.09, 1.09, 1) }, { easing: 'sineInOut' })
                    .to(0.55, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
                    .union()
                    .repeatForever();
                breathTween.start();
            })
            .start();
    }

    /** 免费金币：看广告领金币（额度与每日签到一致），每天限 FREE_COIN_DAILY_LIMIT 次 */
    private onFreeCoinClick() {
        const used = this.getFreeCoinClaimsToday();
        if (used >= this.FREE_COIN_DAILY_LIMIT) {
            this.gm.renderCommonTip('免费金币', '今天的免费金币已经领完啦\n明天再来哦～');
            return;
        }
        this.gm.showAdThen(() => {
            const amount = getGameConfig()?.freeCoinReward ?? 200;
            this.gm.totalCoins += amount;
            if (typeof wx !== 'undefined' && wx.setStorageSync) {
                wx.setStorageSync('totalCoins', this.gm.totalCoins.toString());
            } else {
                localStorage.setItem('totalCoins', this.gm.totalCoins.toString());
            }
            const newUsed = used + 1;
            this.setFreeCoinClaimsToday(newUsed);
            // 首页金币余额同步刷新
            if (this.gm.coinCountLabel && this.gm.coinCountLabel.isValid) {
                this.gm.coinCountLabel.string = `${this.gm.totalCoins}`;
            }
            const left = this.FREE_COIN_DAILY_LIMIT - newUsed;
            // 看完广告：panel_tip_common 横幅「恭喜获得金币xN」，停 2 秒飞出
            this.gm.showCoinShortageTip(`恭喜获得金币x${amount}`);
            if (left <= 0 && this.freeCoinBtnNode && this.freeCoinBtnNode.isValid) {
                const sp = this.freeCoinBtnNode.getComponent(Sprite);
                if (sp) sp.grayscale = true;
            }
        }, 'free_coin');
    }

    /** 今日免费金币已领次数（本地存储，格式 "日期:count"，跨天自动归零） */
    private getFreeCoinClaimsToday(): number {
        const raw = (typeof wx !== 'undefined' && wx.getStorageSync)
            ? (wx.getStorageSync('freeCoinClaims') || '')
            : (localStorage.getItem('freeCoinClaims') || '');
        const [date, cnt] = String(raw).split(':');
        return date === this.gm.getTodayStr() ? (parseInt(cnt, 10) || 0) : 0;
    }

    private setFreeCoinClaimsToday(count: number) {
        const val = `${this.gm.getTodayStr()}:${count}`;
        if (typeof wx !== 'undefined' && wx.setStorageSync) {
            wx.setStorageSync('freeCoinClaims', val);
        } else {
            localStorage.setItem('freeCoinClaims', val);
        }
    }

    /** 首页设置弹窗：音量/震动开关，面板图 panel_home_settings.png */
    private renderHomeSettingsModal() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.destroyAllChildren();

        // 遮罩：点击关闭
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 面板：panel_home_settings.png（640x674，分包；2026-08-12 重出三行版：音乐/音效/震动）
        const panelW = 300;
        const panelH = panelW * 674 / 640;
        // 分离式布局（面板+下方按钮）：整体上移 40 居中
        const panelNode = this.gm.createNode('HomeSettingsPanel', this.gm.modalLayerNode, 0, 40, panelW, panelH);
        const panelSprite = panelNode.addComponent(Sprite);
        panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/panel_home_settings/spriteFrame', SpriteFrame).then((sf) => {
            if (sf && panelSprite && panelSprite.isValid) {
                panelSprite.spriteFrame = sf;
            }
        }).catch(() => {});
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        // 图内相对定位
        const px = (fx: number) => (fx - 0.5) * panelW;
        const py = (fy: number) => (0.5 - fy) * panelH;

        // 右上角 X 关闭热区（新图实测 0.930/0.073）
        const closeBtn = this.gm.createNode('CloseBtn', panelNode, px(0.930), py(0.073), 48, 48);
        closeBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            SoundManager.getInstance()?.playSystemClick();
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 开关 X：空槽中心 fx≈0.754 → 面板本地 76，createToggle 内部 +60，故传 16
        const toggleX = 16;
        // 音乐开关：第一行（音符图标同一水平线），只管 BGM
        this.gm.createToggle(panelNode, toggleX, py(0.325), this.gm.soundEnabled, (isOn) => {
            this.gm.soundEnabled = isOn;
            localStorage.setItem('soundEnabled', String(isOn));
            SoundManager.getInstance()?.setMute(!isOn);
            if (isOn) {
                SoundManager.getInstance()?.playBGM();
            } else {
                SoundManager.getInstance()?.stopBGM();
            }
        });

        // 音效开关：第二行（喇叭图标同一水平线），只管点击音效
        this.gm.createToggle(panelNode, toggleX, py(0.552), localStorage.getItem('sfxEnabled') !== 'false', (isOn) => {
            localStorage.setItem('sfxEnabled', String(isOn));
            SoundManager.getInstance()?.setSfxMute(!isOn);
            if (isOn) SoundManager.getInstance()?.playSystemClick();
        });

        // 震动开关：第三行（震动图标同一水平线）
        this.gm.createToggle(panelNode, toggleX, py(0.779), this.gm.vibrationEnabled, (isOn) => {
            this.gm.vibrationEnabled = isOn;
            localStorage.setItem('vibrationEnabled', String(isOn));
            if (isOn) this.gm.triggerVibration('light');
        });

        // 面板下方唯一按钮：btn_action「游戏反馈」，打开现有 FeedbackPage
        const feedbackBtn = this.gm.createSeparatedActionButton(
            panelNode, panelH, { text: '游戏反馈', pay: 'free' }, false,
            { width: 160, name: 'BtnFeedback' },
        );
        feedbackBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            new FeedbackPage(this.gm).open(() => this.showTip('提交成功，感谢反馈'));
        }, this);
    }

    /** 点击签到按钮：打开签到弹窗（签到状态/今日已领判断都在弹窗内） */
    private onSignInClick() {
        // 点了签到按钮即撤掉引导手指
        if (this.signInGuideNode && this.signInGuideNode.isValid) {
            this.signInGuideNode.destroy();
        }
        this.signInGuideNode = null;
        new SignInPage(this.gm).open();
    }

    /**
     * 点「每日挑战」：先检测是否选过地区。没选过→弹选地区（选完确定直接进）；选过→经 Loading 直进对局。
     */
    private onDailyChallengeClick() {
        if (getLocalRegionId() == null) {
            // 未选省份：先选省（省份榜按省统计通关人数，选完再进）
            this.renderRegionSelectModal();
            return;
        }
        // 经 Loading 场景进入每日挑战：GameManager 按 target='daily' 实例化 DailyDriver 并直进对局
        LoadingPage.target = 'daily';
        director.loadScene('Loading');
    }

    /**
     * 地区选择弹窗：手搬圆角面板 + 三列网格（ScrollView）+ 底部确定。
     * 拉起时先请后端拿 34 省列表（后端缓存优先）；点省份先高亮，点确定才落定。
     * 点遮罩/关闭 = 放弃，不存，下次还问（每日挑战本体还没做，不强制）。
     */
    private async renderRegionSelectModal() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        const items = await fetchRegionList();
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return; // 等网络期间可能已离页
        if (items.length === 0) {
            this.showTip('网络不好，稍后再试');
            return;
        }
        this.gm.modalLayerNode.destroyAllChildren();

        const screenW = this.gm.screenWidth;
        const screenH = this.gm.screenHeight;

        // 遮罩：点空白处关闭（放弃选择）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, screenW, screenH, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, screenW, screenH, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 面板：手搬圆角卡片（无专用底图）
        const panelW = 320;
        const panelH = 464;
        const panelNode = this.gm.createNode('RegionPanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
        const panelBg = this.gm.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        this.gm.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(252, 250, 242, 255), 24);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => { e.propagationStopped = true; }, this);

        // 标题
        this.gm.createLabel(panelNode, '选择你的地区', 0, panelH / 2 - 34, 22, new Color(96, 64, 32, 255), true);

        // 网格参数：3 列
        const cols = 3;
        const cellW = 92;
        const cellH = 42;
        const gapX = 8;
        const gapY = 10;
        const gridW = cols * cellW + (cols - 1) * gapX;
        const rows = Math.ceil(items.length / cols);
        const contentH = rows * cellH + (rows - 1) * gapY;

        // ScrollView 可视区（标题下、确定钮上）。去掉副标题小字后，网格上移 20、高度补 20，不留空当
        const viewW = panelW - 24;
        const viewH = panelH - 130;
        const viewY = 18;
        const scrollNode = this.gm.createNode('RegionScroll', panelNode, 0, viewY, viewW, viewH);
        const scrollView = scrollNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;
        const viewNode = this.gm.createNode('View', scrollNode, 0, 0, viewW, viewH);
        const viewMask = viewNode.addComponent(Mask);
        viewMask.type = Mask.Type.GRAPHICS_RECT;
        const realContentH = Math.max(contentH, viewH);
        const contentNode = this.gm.createNode('Content', viewNode, 0, 0, viewW, realContentH);
        contentNode.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
        contentNode.setPosition(0, viewH / 2, 0);
        scrollView.content = contentNode;

        // 选中态：记住选中 id 和对应格子，重画高亮
        let selectedId: number | null = null;
        const cellBgMap = new Map<number, Graphics>();
        const paintCell = (id: number, on: boolean) => {
            const g = cellBgMap.get(id);
            if (!g) return;
            this.gm.drawRoundedRect(g, cellW, cellH,
                on ? new Color(120, 190, 90, 255) : new Color(238, 234, 224, 255), 12);
        };

        items.forEach((item: RegionItem, i: number) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            const cx = -gridW / 2 + cellW / 2 + c * (cellW + gapX);
            const cy = -cellH / 2 - r * (cellH + gapY);
            const cell = this.gm.createNode(`Region_${item.id}`, contentNode, cx, cy, cellW, cellH);
            const cellBg = this.gm.createGraphicsNode('bg', cell, cellW, cellH, 0, 0);
            const g = cellBg.getComponent(Graphics)!;
            cellBgMap.set(item.id, g);
            this.gm.drawRoundedRect(g, cellW, cellH, new Color(238, 234, 224, 255), 12);
            const nameLabel = this.gm.createLabel(cell, item.name, 0, 0, 15, new Color(90, 70, 45, 255), false);
            nameLabel.node.getComponent(UITransform)!.setContentSize(cellW, cellH);
            cell.on(Node.EventType.TOUCH_END, (e: any) => {
                e.propagationStopped = true;
                if (selectedId === item.id) return;
                const prevId = selectedId;
                selectedId = item.id;
                if (prevId != null) paintCell(prevId, false);
                paintCell(item.id, true);
            }, this);
        });

        // 底部确定按钮
        const btnW = 160;
        const btnH = 46;
        const btnY = -panelH / 2 + 40;
        const confirmBtn = this.gm.createNode('ConfirmBtn', panelNode, 0, btnY, btnW, btnH);
        const confirmBg = this.gm.createGraphicsNode('bg', confirmBtn, btnW, btnH, 0, 0);
        this.gm.drawRoundedRect(confirmBg.getComponent(Graphics)!, btnW, btnH, new Color(250, 170, 60, 255), 23);
        this.gm.createLabel(confirmBtn, '确定', 0, 0, 18, new Color(255, 255, 255, 255), true);
        let submitting = false;
        confirmBtn.on(Node.EventType.TOUCH_END, async (e: any) => {
            e.propagationStopped = true;
            if (submitting) return;
            const chosenId = selectedId;
            if (chosenId == null) {
                this.showTip('请先选择地区');
                return;
            }
            submitting = true;
            const ok = await saveUserRegion(chosenId);
            if (!ok) {
                submitting = false;
                this.showTip('保存失败，网络不好请重试');
                return;
            }
            if (this.gm.modalLayerNode && this.gm.modalLayerNode.isValid) {
                this.gm.modalLayerNode.destroyAllChildren();
            }
            // 选省完成：直接进入每日挑战（与已选省点按钮同路径，无需再点一次）
            LoadingPage.target = 'daily';
            director.loadScene('Loading');
        }, this);

        // 从小到大弹出
        panelNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(panelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 首页轻提示：短暂浮现后自动消失 */
    private showTip(text: string) {
        if (!this.pageNode || !this.pageNode.isValid) return;
        const existing = this.pageNode.getChildByName('HomeTip');
        if (existing) existing.destroy();
        const tipNode = this.gm.createNode('HomeTip', this.pageNode, 0, -this.gm.screenHeight * 0.33, 280, 40);
        const tipBg = this.gm.createGraphicsNode('TipBg', tipNode, 280, 40, 0, 0);
        this.gm.drawRoundedRect(tipBg.getComponent(Graphics)!, 280, 40, new Color(60, 80, 50, 210), 20);
        this.gm.createLabel(tipNode, text, 0, 0, 14, new Color(255, 255, 255, 255), true);
        tween(tipNode)
            .delay(1.6)
            .to(0.25, { scale: new Vec3(0.8, 0.8, 1) })
            .call(() => {
                if (tipNode.isValid) tipNode.destroy();
            })
            .start();
    }
}
