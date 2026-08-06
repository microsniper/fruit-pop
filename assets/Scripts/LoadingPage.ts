import { _decorator, Component, Node, Vec3, Layers, UITransform, Color, Graphics, Sprite, SpriteFrame, Label, Mask, resources, director, UIOpacity, tween } from 'cc';
import { BundleManager } from './BundleManager';
import { loginAndGetProgress, fetchGameConfig, getDefaultGameConfig, GameConfig, getDailyHelpStatus, DailyHelpResponse, HelpMode } from './api';

const { ccclass } = _decorator;

/** 加载页跳转目标：进主页 / 直接进无限模式 */
export type LoadingTarget = 'home' | 'endless' | 'daily';

/** Loading 场景预热的请求，Main 场景 GameManager 启动时复用，避免重复 wx.login/拉配置/拉资源 */
interface WarmupRequests {
    login: Promise<number>;
    config: Promise<GameConfig>;
    /** 果篮/板子灰度底图 SpriteFrame（GameManager.loadBasketBase 同一批资源） */
    basket: Promise<{ basket: SpriteFrame | null; plate: SpriteFrame | null }>;
    /** 求助状态查询（GameManager.fetchDailyHelpStatus 同一个接口，进无限/每日挑战对局时才需要） */
    help: Promise<DailyHelpResponse | null> | null;
}

/**
 * 通用加载页（独立 Loading 场景）：
 * 果园背景 + 摘呀摘 logo + 一圈蹦跳转圈的水果 + 健康游戏忠告 + 适龄提示。
 * 两个入口：① 游戏启动（进主页）② 首页点无限模式（直接进对局）。
 * 展示期间并发完成真实加载：分包、水果图、果篮板子底图、登录/配置/求助状态预热、Main 场景预载，
 * 各任务加权汇总算真实进度，全部完成且满最短展示时长后切到 Main 场景；
 * 转圈动画只是氛围展示，不再对应具体百分比——真实进度仍在内部统计，只是不再画进度条。
 * 覆盖全部这些任务是为了让「加载完成」真正等价于「进入对局可以立即玩」，
 * 避免 GameManager.start() 里还有未预热的加载在跳转之后才悄悄执行（体感上就是走完加载还要再等一会）。
 */
@ccclass('LoadingPage')
export class LoadingPage extends Component {
    /** 逻辑分辨率（与 GameManager.setupLayout 一致） */
    private readonly W = 375;
    private readonly H = 812;
    /** 最短展示时长：资源全缓存时也不一闪而过 */
    private readonly MIN_SHOW_MS = 1200;

    private static _target: LoadingTarget = 'home';
    private static _warmup: WarmupRequests | null = null;
    private static _launched = false;

    /** 首页切场景前设置目标，Loading 完成后由 GameManager 消费并自动复位 */
    /** 读取目标不清除（GameManager 实例化驱动时用；enter 分流仍走 consumeTarget） */
    static get target(): LoadingTarget { return LoadingPage._target; }
    static set target(t: LoadingTarget) { LoadingPage._target = t; }
    static consumeTarget(): LoadingTarget {
        const t = LoadingPage._target;
        LoadingPage._target = 'home';
        return t;
    }
    /** GameManager 启动时取走预热请求 */
    static consumeWarmup(): WarmupRequests | null {
        const w = LoadingPage._warmup;
        LoadingPage._warmup = null;
        return w;
    }
    /** Main 场景是否经由 Loading 页进入（决定 GameManager 是否再显示旧转圈与 2 秒等待） */
    static consumeLaunched(): boolean {
        const v = LoadingPage._launched;
        LoadingPage._launched = false;
        return v;
    }

    /** 各加载任务权重（合计 100），仅用于判断真实加载是否完成，不再驱动进度条 UI */
    private readonly weights = { bundle: 24, fruits: 20, login: 16, config: 8, scene: 12, basket: 10, help: 10 };
    private readonly done = { bundle: 0, fruits: 0, login: 0, config: 0, scene: 0, basket: 0, help: 0 };
    private startTs = 0;
    private finished = false;
    private logoShown = false;

    /** 环形转圈的水果节点，每个记录自己的角度相位与跳动相位，update 里驱动位置 */
    private fruitRing: { node: Node; angleOffset: number; bounceOffset: number }[] = [];
    private ringAngle = 0;
    private ringRadius = 100;

    start() {
        this.startTs = Date.now();
        this.buildUI();
        this.runTasks();
    }

    update(dt: number) {
        this.renderFruitRing(dt);
        if (this.finished) return;
        if (this.computeProgress() >= 1 && Date.now() - this.startTs >= this.MIN_SHOW_MS) {
            this.finished = true;
            LoadingPage._launched = true;
            director.loadScene('Main');
        }
    }

    private computeProgress(): number {
        const w = this.weights;
        const d = this.done;
        return (w.bundle * d.bundle + w.fruits * d.fruits + w.login * d.login + w.config * d.config
            + w.scene * d.scene + w.basket * d.basket + w.help * d.help) / 100;
    }

    // ---------------- 加载任务 ----------------

    private runTasks() {
        // ① 分包（bundle_late）：logo 与游戏内 UI 图都在里面，拿到 logo 后淡入标题
        BundleManager.getInstance().loadAsset<SpriteFrame>('ui/title_home/spriteFrame', SpriteFrame)
            .then((sf) => {
                this.done.bundle = 1;
                this.showLogo(sf);
            })
            .catch(() => { this.done.bundle = 1; });

        // ② 分包水果图预载（与 GameManager.loadFruitSprites 同一批，进 Main 后秒完成）
        const fruits = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot', 'Pomegranate', 'Potato', 'Grape', 'Banana', 'Watermelon', 'Cherry'];
        let fruitLoaded = 0;
        fruits.forEach((name) => {
            BundleManager.getInstance().loadAsset<SpriteFrame>(`fruits/${name}/spriteFrame`, SpriteFrame).then(() => {
                fruitLoaded++;
                this.done.fruits = fruitLoaded / fruits.length;
            }).catch(() => {
                fruitLoaded++;
                this.done.fruits = fruitLoaded / fruits.length;
            });
        });

        // ③④ 登录 → 配置（串行：无 token 时 fetchGameConfig 内部会再登录一次，链式避免重复 wx.login）
        const loginP: Promise<number> = loginAndGetProgress()
            .then((lv) => { this.done.login = 1; return lv; })
            .catch(() => { this.done.login = 1; return 1; });
        const configP: Promise<GameConfig> = loginP
            .then(() => fetchGameConfig())
            .then((c) => { this.done.config = 1; return c; })
            .catch(() => { this.done.config = 1; return getDefaultGameConfig(); });

        // ⑤ Main 场景预载：进度 100% 后切换场景不掉帧
        director.preloadScene('Main', () => {
            this.done.scene = 1;
        });

        // ⑥ 果篮/板子灰度底图（GameManager.loadBasketBase 同一批资源，进对局渲染板子/果篮就要用）
        let basketLoaded = 0;
        const checkBasketDone = () => { basketLoaded++; this.done.basket = basketLoaded / 2; };
        const basketP = BundleManager.getInstance().loadAsset<SpriteFrame>('ui/basket/spriteFrame', SpriteFrame)
            .catch(() => null).then((sf) => { checkBasketDone(); return sf; });
        const plateP = BundleManager.getInstance().loadAsset<SpriteFrame>('ui/plate/spriteFrame', SpriteFrame)
            .catch(() => null).then((sf) => { checkBasketDone(); return sf; });
        const basketAllP = Promise.all([basketP, plateP]).then(([basket, plate]) => ({ basket, plate }));

        // ⑦ 求助状态查询（GameManager.fetchDailyHelpStatus 同一个接口）：
        // 两种模式的 driver 都有求助机制（EndlessDriver 是默认 driver，进主页也会用到），
        // 用 target 直接映射 HelpMode，不必等 GameManager 实例化 driver
        const helpMode: HelpMode = LoadingPage.target === 'daily' ? 'dailyChallenge' : 'endlessChallenge';
        const helpP = loginP.then(() => getDailyHelpStatus(helpMode))
            .then((res) => { this.done.help = 1; return res; })
            .catch(() => { this.done.help = 1; return null; });

        LoadingPage._warmup = { login: loginP, config: configP, basket: basketAllP, help: helpP };
    }

    // ---------------- UI 搭建 ----------------

    private buildUI() {
        const pageW = this.W;
        const pageH = this.H;

        // 兜底纯色背景（背景图加载完成前避免露底），与首页同色
        const bgColor = this.createGraphicsNode('BgColor', this.node, pageW, pageH, 0, 0);
        this.drawRoundedRect(bgColor.getComponent(Graphics)!, pageW, pageH, new Color(232, 237, 220, 255), 0);

        // 背景图：等比缩放填满（cover-fit），裁切层防止溢出（与首页同款处理）
        const bgClip = this.createNode('BgClip', this.node, 0, 0, pageW, pageH);
        bgClip.addComponent(Mask);
        const bgNode = this.createNode('Bg', bgClip, 0, 0, pageW, pageH);
        const bgSprite = bgNode.addComponent(Sprite);
        bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        resources.load('ui/home_welcome_bg/spriteFrame', SpriteFrame, (err, sf) => {
            if (!err && sf && bgSprite && bgSprite.isValid) {
                bgSprite.spriteFrame = sf;
                const rect = sf.rect;
                if (rect && rect.width > 0) {
                    const scale = Math.max(pageW / rect.width, pageH / rect.height);
                    bgNode.getComponent(UITransform)!.setContentSize(rect.width * scale, rect.height * scale);
                }
            }
        });

        // 一圈蹦跳转圈的水果，取代原来的进度条（放在屏幕中上部分，标题下方）
        this.buildFruitRing(0, 90, 100);

        // 健康游戏忠告
        const tipColor = new Color(96, 76, 52, 255);
        this.createLabel(this.node, '《健康游戏忠告》', 0, -150, 15, tipColor, true);
        const tips = [
            '抵制不良游戏，拒绝盗版游戏。',
            '注意自我保护，谨防受骗上当。',
            '适度游戏益脑，沉迷游戏伤身。',
            '合理安排时间，享受健康生活。'
        ];
        tips.forEach((text, i) => {
            this.createLabel(this.node, text, 0, -178 - i * 24, 13, tipColor, false);
        });

        // 适龄提示（右下角）
        this.buildAgeBadge(this.node, pageW / 2 - 36, -pageH / 2 + 42);
    }

    /** 适龄提示标识：白底圆角块 + 蓝色 12+ 区块 + CADPA + 适龄提示 */
    private buildAgeBadge(parent: Node, x: number, y: number) {
        const badge = this.createNode('AgeBadge', parent, x, y, 52, 62);
        const bg = this.createGraphicsNode('BadgeBg', badge, 52, 62, 0, 0);
        this.drawRoundedRect(bg.getComponent(Graphics)!, 52, 62, new Color(255, 255, 255, 255), 8, 2, new Color(210, 210, 210, 255));
        const blue = this.createGraphicsNode('BadgeBlue', badge, 44, 32, 0, 11);
        this.drawRoundedRect(blue.getComponent(Graphics)!, 44, 32, new Color(38, 122, 193, 255), 5, 0);
        this.createLabel(badge, '12+', 0, 16, 16, new Color(255, 255, 255, 255), true);
        this.createLabel(badge, 'CADPA', 0, 4, 6.5, new Color(255, 255, 255, 230), true);
        this.createLabel(badge, '适龄提示', 0, -19, 10, new Color(90, 90, 90, 255), true);
    }

    /** 标题 logo：分包就绪后淡入（与首页同款 title_home 图与呼吸动画） */
    private showLogo(sf: SpriteFrame | null) {
        if (this.logoShown || !sf || !this.node || !this.node.isValid) return;
        this.logoShown = true;
        const titleW = this.W * 0.62;
        const titleNode = this.createNode('Title', this.node, 0, this.H * 0.34, titleW, titleW * 0.41);
        const sp = titleNode.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.spriteFrame = sf;
        const rect = sf.rect;
        if (rect && rect.width > 0) {
            titleNode.getComponent(UITransform)!.setContentSize(titleW, titleW * (rect.height / rect.width));
        }
        const op = titleNode.addComponent(UIOpacity);
        op.opacity = 0;
        tween(op).to(0.4, { opacity: 255 }).start();
        tween(titleNode)
            .delay(0.4)
            .to(1.2, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'sineInOut' })
            .to(1.2, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }

    /**
     * 一圈水果转圈动画：14 种水果均匀分布在圆周上，整体绕中心慢速旋转，
     * 每个水果再叠加自己的小幅上下跳动（相位错开，避免整齐划一显得死板）。
     * 纯氛围动画，不对应具体加载进度——真实进度仍在 done/weights 里统计，只是不再画出来。
     */
    private buildFruitRing(centerX: number, centerY: number, radius: number) {
        const fruits = ['Red Apple', 'Lemon', 'Peach', 'Orange', 'Pear', 'Eggplant', 'Сorn', 'Carrot',
            'Pomegranate', 'Potato', 'Grape', 'Banana', 'Watermelon', 'Cherry'];
        const ringNode = this.createNode('FruitRing', this.node, centerX, centerY, 1, 1);
        const iconSize = 34;
        this.fruitRing = fruits.map((name, i) => {
            const angleOffset = (i / fruits.length) * Math.PI * 2;
            const node = this.createNode(`FruitIcon_${i}`, ringNode, 0, 0, iconSize, iconSize);
            const sprite = node.addComponent(Sprite);
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            BundleManager.getInstance().loadAsset<SpriteFrame>(`fruits/${name}/spriteFrame`, SpriteFrame).then((sf) => {
                if (sf && sprite && sprite.isValid) {
                    sprite.spriteFrame = sf;
                    const rect = sf.rect;
                    if (rect && rect.height > 0) {
                        node.getComponent(UITransform)!.setContentSize(iconSize * (rect.width / rect.height), iconSize);
                    }
                }
            }).catch(() => {});
            // 跳动相位错开，避免所有水果同步蹦跳显得整齐死板
            return { node, angleOffset, bounceOffset: (i / fruits.length) * Math.PI * 2 };
        });
        this.ringAngle = 0;
        this.ringRadius = radius;
        this.renderFruitRing(0);
    }

    /** 每帧驱动：整体绕中心转圈（ringAngle 累加）+ 各自小幅跳动（sin 波形，相位错开） */
    private renderFruitRing(dt: number) {
        if (this.fruitRing.length === 0) return;
        this.ringAngle += dt * 0.6; // 转圈角速度：约 10 秒转一圈
        const now = this.ringAngle;
        const radius = this.ringRadius;
        this.fruitRing.forEach(({ node, angleOffset, bounceOffset }) => {
            if (!node.isValid) return;
            const angle = now + angleOffset;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            const bounce = Math.sin(now * 4 + bounceOffset) * 6; // 小幅上下跳动
            node.setPosition(new Vec3(x, y + bounce, 0));
        });
    }

    // ---------------- 小工具（与 GameManager 同款风格） ----------------

    private createNode(name: string, parent: Node, x: number, y: number, width: number, height: number) {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);
        node.setPosition(new Vec3(x, y, 0));
        parent.addChild(node);
        return node;
    }

    private createGraphicsNode(name: string, parent: Node, width: number, height: number, x: number, y: number) {
        const node = this.createNode(name, parent, x, y, width, height);
        node.addComponent(Graphics);
        return node;
    }

    private createLabel(parent: Node, text: string, x: number, y: number, fontSize: number, color: Color, bold = false, lineHeight?: number) {
        const node = this.createNode('Label', parent, x, y, 200, 60);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = lineHeight || fontSize + 6;
        label.color = color;
        label.horizontalAlign = 1;
        label.verticalAlign = 1;
        label.isBold = bold;
        return label;
    }

    private drawRoundedRect(graphics: Graphics, width: number, height: number, fill: Color, radius: number, lineWidth = 0, stroke?: Color) {
        graphics.clear();
        graphics.fillColor = fill;
        graphics.roundRect(-width / 2, -height / 2, width, height, radius);
        graphics.fill();
        if (lineWidth > 0 && stroke) {
            graphics.lineWidth = lineWidth;
            graphics.strokeColor = stroke;
            graphics.roundRect(-width / 2, -height / 2, width, height, radius);
            graphics.stroke();
        }
    }
}
