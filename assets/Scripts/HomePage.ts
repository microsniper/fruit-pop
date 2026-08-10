import { Node, Vec3, UITransform, Color, tween, Graphics, Mask, Sprite, SpriteFrame, Label, resources, ScrollView, director, UIOpacity } from 'cc';
import { getGameConfig, isNewUserThisLogin, getLocalRegionId, fetchRegionList, saveUserRegion, RegionItem } from './api';
import { SoundManager } from './SoundManager';
import { BundleManager } from './BundleManager';
import { LoadingPage } from './LoadingPage';
import { DailyDriver } from './DailyDriver';
import { SignInPage } from './SignInPage';
import { FeedbackPage } from './FeedbackPage';
import type { GameManager } from './GameManager';

declare const wx: any;

/**
 * 首页：模式选择页（无限模式/每日挑战）及只在首页出现的功能——
 * 七日签到入口、首页设置弹窗、免费金币、新人礼弹窗。
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

    constructor(private gm: GameManager) {}

    /** 首页：模式选择页（无限模式 / 每日挑战），与排行榜页同样的整页切换方式 */
    render() {
        this.close();
        this.gm.rankPage.close();
        this.gm.storagePage.close();
        this.gm.shopPage.close();
        if (this.gm.rootNode) {
            this.gm.rootNode.removeAllChildren();
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

        // 两个模式入口按钮（每日挑战在上，无限模式在下）
        this.createHomeButton('btn_daily', 0, -pageH * 0.08, 125, () => this.onDailyChallengeClick());
                // 每日挑战按钮下方：今日状态小字（仅展示通关标记，不再有续玩进度）
                const dailyStatusText = DailyDriver.readTodayCleared()
                    ? '今日已通关·继续挑战'
                    : '';
                if (dailyStatusText) {
                    this.gm.createLabel(this.pageNode!, dailyStatusText, 0, -pageH * 0.08 - 48, 14, new Color(120, 85, 45, 255), true);
                }
        this.createHomeButton('btn_endless', 0, -pageH * 0.22, 125, () => this.enterEndlessMode());

        // 左右两侧功能图标：每日签到（左）、排行榜（右）
        const sideBtnW = 58;
        const sideBtnY = pageH * 0.10;
        const signInBtnNode = this.createHomeButton('btn_signin', -pageW / 2 + 42, sideBtnY, sideBtnW, () => this.onSignInClick());
        // 个人仓库（签到按钮正下方，间距与「设置-签到」间距同款 0.12*pageH）：整页切换，看道具与收集品
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

        // 左上角设置按钮：放在树冠下方，避免遮挡背景上的树
        this.createHomeButton('btn_home_settings', -pageW / 2 + 42, pageH * 0.22, sideBtnW, () => this.renderHomeSettingsModal());

        // 免费金币（排行榜上方，与设置按钮同高）：看广告领金币，每天限 3 次
        this.freeCoinBtnNode = this.createHomeButton('btn_free_coin', pageW / 2 - 42, pageH * 0.22, sideBtnW, () => this.onFreeCoinClick());
        if (this.freeCoinBtnNode && this.getFreeCoinClaimsToday() >= this.FREE_COIN_DAILY_LIMIT) {
            const sp = this.freeCoinBtnNode.getComponent(Sprite);
            if (sp) sp.grayscale = true;
        }

        // 金币余额（设置与免费金币之间，居中）：图标+文字平铺（方形 coin.png，无底框），
        // 引用挂到 gm.coinCountLabel/coinIconNode 上，新人礼的金币飞行动画自动飞向这里
        const balIconH = 28;
        const balY = pageH * 0.22;
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
        balLabel.fontSize = 16;
        balLabel.lineHeight = balIconH;
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

        // 后台预热商城/道具远程图，用户之后点进商城/仓库时基本秒显示（不阻塞首页渲染）
        this.gm.preloadShopAndResourceImages();
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
            onTap();
        }, this);
        return btnNode;
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
        this.gm.modalLayerNode.removeAllChildren();

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
                if (this.gm.modalLayerNode) this.gm.modalLayerNode.removeAllChildren();
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
            this.showTip(left > 0 ? `+${amount} 金币 今日还可领 ${left} 次` : `+${amount} 金币 今日次数已用完`);
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

    /** 首页设置弹窗：只有音量/震动开关 + 游戏反馈按钮（暂不可点击），面板图 panel_home_settings.png */
    private renderHomeSettingsModal() {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.removeAllChildren();

        // 遮罩：点击关闭
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, this.gm.screenWidth, this.gm.screenHeight, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, this.gm.screenWidth, this.gm.screenHeight, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 面板：panel_home_settings.png（640x841，分包）
        const panelW = 300;
        const panelH = panelW * 841 / 640;
        const panelNode = this.gm.createNode('HomeSettingsPanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
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

        // 右上角 X 关闭热区
        const closeBtn = this.gm.createNode('CloseBtn', panelNode, px(0.901), py(0.061), 48, 48);
        closeBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            this.gm.modalLayerNode!.removeAllChildren();
        }, this);

        // 音量开关：与图上喇叭图标同一水平线，开关放右侧（createToggle 内部会 +60 偏移）
        const toggleX = 28;
        this.gm.createToggle(panelNode, toggleX, py(0.361), this.gm.soundEnabled, (isOn) => {
            this.gm.soundEnabled = isOn;
            localStorage.setItem('soundEnabled', String(isOn));
            SoundManager.getInstance()?.setMute(!isOn);
            if (isOn) {
                SoundManager.getInstance()?.playBGM();
            } else {
                SoundManager.getInstance()?.stopBGM();
            }
        });

        // 震动开关：与图上震动图标同一水平线
        this.gm.createToggle(panelNode, toggleX, py(0.577), this.gm.vibrationEnabled, (isOn) => {
            this.gm.vibrationEnabled = isOn;
            localStorage.setItem('vibrationEnabled', String(isOn));
            if (isOn) this.gm.triggerVibration('light');
        });

        // 游戏反馈按钮（图里的橙色立体按钮）：位置为估算值，跟美术图核对后如有偏差再微调坐标
        const feedbackBtn = this.gm.createNode('FeedbackBtn', panelNode, 0, py(0.75), panelW * 0.6, 56);
        feedbackBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            new FeedbackPage(this.gm).open(() => this.showTip('提交成功，感谢反馈'));
        }, this);
    }

    /** 点击签到按钮：打开七日签到弹窗（签到状态/今日已领判断都在弹窗内） */
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
        this.gm.modalLayerNode.removeAllChildren();

        const screenW = this.gm.screenWidth;
        const screenH = this.gm.screenHeight;

        // 遮罩：点空白处关闭（放弃选择）
        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, screenW, screenH, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, screenW, screenH, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.removeAllChildren();
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
                this.gm.modalLayerNode.removeAllChildren();
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
