import { Node, Color, Label, UITransform, UIOpacity, tween, Graphics } from 'cc';
import { fetchBubbleTips, BubbleTipConfig, BubbleTipItem } from './api';
import type { GameManager } from './GameManager';

/** 文案字号 */
const FONT_SIZE = 15;
/** 行高 */
const LINE_HEIGHT = 21;
/** 气泡内边距（左右），仅用于撑开文字容器尺寸留白 */
const PAD_X = 12;
/** 气泡内边距（上下），仅用于撑开文字容器尺寸留白 */
const PAD_Y = 9;
/** 文字区最大宽度：超过就折行，避免文字横着压掉半个棋盘 */
const MAX_TEXT_WIDTH = 190;
/** 淡入时长（秒） */
const FADE_IN = 0.3;
/** 淡出时长（秒） */
const FADE_OUT = 0.4;
/** 被弹窗压制时的重试间隔（秒）：不白等一整轮 */
const RETRY_DELAY = 5;

/**
 * 游戏区猫咪进度提示：猫咪进度图标头顶时不时冒一条后台配置的文案（橙色文字，垫暖白色半透明气泡底，不带尾巴）。
 *
 * 文案池进关拉一次存内存（api 层做会话级缓存），之后本地按权重随机挑，不再请求后端。
 * 文案全部后台写死，前端不做任何变量替换。
 *
 * 猫咪在游戏区右侧（x=145，屏宽 375），文字朝左下方展开：
 * 往左是躲开右边界（文案再长也往屏幕中间伸），往下是落进棋盘区顶部那段空白
 * （暂存区果盘下边、板子上边之间），既不压果篮那排也不压棋盘上的盘子。
 */
export class BubbleTip {

    /** 文案池与节奏参数；null=未配置/拉取失败，功能整体静默跳过 */
    private config: BubbleTipConfig | null = null;
    /** 当前显示中的气泡节点 */
    private bubbleNode: Node | null = null;
    /** 是否在运行中（stop 后所有回调都要认这个标志失效） */
    private running = false;
    /** 挂在 GameManager 上的待触发定时回调，stop 时要 unschedule 掉 */
    private pendingCb: (() => void) | null = null;
    /** 上一条文案在池子里的下标，避免同一条连着出两次 */
    private lastIndex = -1;
    /**
     * 气泡序号，每冒一个 +1。用来认领 tween 收尾回调：
     * 情景提示会中途顶掉正在显示的随机气泡，旧气泡那条 tween 的收尾回调若还能跑到，
     * 会把刚建好的新气泡一起销毁。回调里比对序号，只有还是自己那一轮才清。
     */
    private bubbleSeq = 0;
    /** 当前模式，用来过滤 mode 不匹配的文案 */
    private mode: 'endless' | 'daily' = 'endless';

    constructor(private gm: GameManager) {}

    /**
     * 进关时调用：拉一次文案池（会话级缓存，实际只有首次真的发请求），然后排第一个气泡。
     * 重复调用先停掉上一轮，不会叠出两个定时器。
     * 拉取失败或没配文案就什么都不做，不影响游戏。
     */
    public async start(mode: 'endless' | 'daily') {
        this.stop();
        this.mode = mode;

        const config = await fetchBubbleTips();
        // await 期间玩家可能已经退出这一局，或又调了一次 start，两种情况都不该继续。
        // 这里只判「还在游戏页」，不能用 canShowBubbleTip：冷启动时新手弹窗正开着，
        // 拿弹窗当门槛会让气泡系统整局都启不起来。弹窗压制是 tick 里每次触发前才判的。
        if (!config || this.running || !this.gm.isGameViewAlive()) return;

        this.config = config;
        this.running = true;
        this.lastIndex = -1;
        // 随机池可能整个为空（后台只配了情景提示），那就不排轮播，但情景提示照样能触发
        if (this.randomCandidates(config).length > 0) {
            this.scheduleNext(config.firstDelaySeconds);
        }
    }

    /**
     * 情景提示：局面命中时由 GameManager 直接调，立刻冒，不排队也不受随机间隔限制。
     * 后台没配这个 scene 的文案就什么都不做。
     * 冒完把下一个随机气泡推后一整轮，免得情景提示和随机提示挤在一起。
     */
    public showSceneTip(scene: string) {
        if (!this.running || !this.config) return;
        if (!this.gm.canShowBubbleTip()) return;

        const candidates = this.sceneCandidates(this.config, scene);
        if (candidates.length === 0) return;
        this.showBubble(candidates[this.pickByWeight(candidates)].content);

        if (this.randomCandidates(this.config).length > 0) {
            this.scheduleNext(this.randomInterval());
        }
    }

    /** 离开游戏页/重开一局时调用：停定时器 + 清气泡节点，必须在 teardownGameView 里走一遍 */
    public stop() {
        this.running = false;
        this.clearTimer();
        this.clearBubble();
    }

    /** 取消待触发的定时回调 */
    private clearTimer() {
        if (this.pendingCb) {
            this.gm.unschedule(this.pendingCb);
            this.pendingCb = null;
        }
    }

    /** 销毁当前气泡节点（tween 会随节点销毁一起停） */
    private clearBubble() {
        if (this.bubbleNode && this.bubbleNode.isValid) {
            this.bubbleNode.destroy();
        }
        this.bubbleNode = null;
        // 气泡没了呼吸也一起停（自然消失/被顶掉/离开对局三条路径都走这里）
        this.gm.stopCatIconPulse();
    }

    /** 排下一次触发 */
    private scheduleNext(delay: number) {
        this.clearTimer();
        const cb = () => {
            this.pendingCb = null;
            this.tick();
        };
        this.pendingCb = cb;
        this.gm.scheduleOnce(cb, delay);
    }

    /**
     * 一次触发：能冒就冒一个，被压制（弹窗/结算/广告中）就过一小会儿再试。
     * 玩家已离开游戏页则整体停掉，不留悬空定时器。
     */
    private tick() {
        if (!this.running || !this.config) return;
        if (!this.gm.canShowBubbleTip()) {
            // 已经不在游戏页了就彻底停；只是被弹窗挡住则稍后重试
            if (!this.gm.isGameViewAlive()) {
                this.stop();
                return;
            }
            this.scheduleNext(RETRY_DELAY);
            return;
        }

        const tip = this.pickTip();
        if (tip) {
            this.showBubble(tip.content);
        }

        this.scheduleNext(this.randomInterval());
    }

    /** 这条文案在当前模式下能不能用（mode 缺省或 all 视为通用） */
    private modeMatch(t: BubbleTipItem): boolean {
        if (!t || !t.content) return false;
        const m = t.mode;
        return !m || m === 'all' || m === this.mode;
    }

    /** 随机轮播池：当前模式可用、且没标情景码的文案（带 scene 的只在局面命中时出，不参与轮播） */
    private randomCandidates(config: BubbleTipConfig): BubbleTipItem[] {
        return config.tips.filter((t) => this.modeMatch(t) && !t.scene);
    }

    /** 某个情景下可用的文案（同一情景配多条就按权重挑一条） */
    private sceneCandidates(config: BubbleTipConfig, scene: string): BubbleTipItem[] {
        return config.tips.filter((t) => this.modeMatch(t) && t.scene === scene);
    }

    /** 两个随机气泡之间的间隔 */
    private randomInterval(): number {
        if (!this.config) return RETRY_DELAY;
        const min = this.config.minIntervalSeconds;
        const max = this.config.maxIntervalSeconds;
        return min + Math.random() * Math.max(0, max - min);
    }

    /** 按权重抽一条，返回下标 */
    private pickByWeight(list: BubbleTipItem[]): number {
        const total = list.reduce((sum, t) => sum + Math.max(1, t.weight || 1), 0);
        let r = Math.random() * total;
        for (let i = 0; i < list.length; i++) {
            r -= Math.max(1, list[i].weight || 1);
            if (r <= 0) return i;
        }
        return list.length - 1;
    }

    /**
     * 从随机池按权重挑一条，尽量不和上一条重复。
     * 候选只剩一条时就只能重复，此时不再强求。
     */
    private pickTip(): BubbleTipItem | null {
        if (!this.config) return null;
        const candidates = this.randomCandidates(this.config);
        if (candidates.length === 0) return null;

        let index = this.pickByWeight(candidates);
        if (candidates.length > 1 && index === this.lastIndex) {
            index = this.pickByWeight(candidates);
            // 两次都撞上就顺移一位，避免小概率下连续重复
            if (index === this.lastIndex) {
                index = (index + 1) % candidates.length;
            }
        }
        this.lastIndex = index;
        return candidates[index];
    }

    /**
     * 估算文字像素宽度：中日韩字符按满字号算，其余（数字/英文/标点）按 0.6 字号算。
     * 用估算而不是等 Label 布局完再量，是为了同步算出气泡尺寸、一次画完，不出现先画错再重排。
     * 文案以中文为主时这个估算基本等于实际宽度；ASCII 按偏大算，宁可气泡宽一点也不让文字被裁。
     */
    private estimateTextWidth(text: string, fontSize: number): number {
        let width = 0;
        for (let i = 0; i < text.length; i++) {
            width += text.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.6;
        }
        return width;
    }

    /**
     * 展示一条橙色文字：朝左下方展开，不带背景框和尾巴。
     * 锚点（右上角原点）由 GameManager 按猫咪图标位置给出，层级也一并给，
     * 保证压在三块区域背景之上、弹窗之下。
     */
    private showBubble(content: string) {
        const anchor = this.gm.getBubbleAnchor();
        if (!anchor) return;
        // 顶掉上一个气泡（情景提示插队时就走这里），序号 +1 让旧 tween 的收尾回调失效
        this.clearBubble();
        const seq = ++this.bubbleSeq;

        const estWidth = this.estimateTextWidth(content, FONT_SIZE);
        const lines = Math.max(1, Math.ceil(estWidth / MAX_TEXT_WIDTH));
        const textW = lines > 1 ? MAX_TEXT_WIDTH : estWidth;
        const textH = lines * LINE_HEIGHT;

        // 不画尾巴，橙色文字浮在猫咪图标附近，底下垫一层暖白色半透明气泡底；
        // 容器尺寸=文字尺寸，坐标口径与原气泡一致（右上角贴锚点、朝左下展开），
        // 换算方式沿用旧的 bodyW/bodyH 逻辑（加内边距充当留白）
        const bodyW = textW + PAD_X * 2;
        const bodyH = textH + PAD_Y * 2;

        const container = this.gm.createNode('BubbleTip', anchor.parent, anchor.x, anchor.y, bodyW, bodyH);
        container.setSiblingIndex(anchor.siblingIndex);
        this.bubbleNode = container;

        // 暖白色半透明气泡底：文字实际落在容器左下象限（右上角贴锚点口径），背景节点
        // 中心对齐到 (-bodyW/2, -bodyH/2) 才能正好盖住文字 + 内边距区域；先加的子节点渲染在文字之下
        const bgNode = this.gm.createGraphicsNode('BubbleBg', container, bodyW, bodyH, -bodyW / 2, -bodyH / 2);
        const bgGfx = bgNode.getComponent(Graphics)!;
        bgGfx.fillColor = new Color(255, 250, 240, 160);
        bgGfx.roundRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH, 12);
        bgGfx.fill();

        const label = this.gm.createLabel(
            container, content, -bodyW / 2, -bodyH / 2,
            FONT_SIZE, new Color(255, 140, 0, 255), false, LINE_HEIGHT
        );
        label.node.getComponent(UITransform)!.setContentSize(textW + 1, textH);
        label.overflow = Label.Overflow.CLAMP;
        label.enableWrapText = true;

        // 淡入 → 停留 → 淡出 → 销毁，一条 tween 串完，不再额外占定时器。
        // 收尾回调带序号校验：这条气泡若已被后来的气泡顶掉，就不要去销毁别人的节点。
        const opacity = container.addComponent(UIOpacity);
        opacity.opacity = 0;
        const stay = this.config ? this.config.displaySeconds : 4;
        // 这条文案出现时让玩偶图标跟着呼吸，提示图标可点；后台改这条文案要同步这里的判断串
        if (content === '点我可以切换形象哦') {
            this.gm.startCatIconPulse(FADE_IN + stay + FADE_OUT + 0.2);
        }
        tween(opacity)
            .to(FADE_IN, { opacity: 255 })
            .delay(stay)
            .to(FADE_OUT, { opacity: 0 })
            .call(() => {
                if (this.bubbleSeq === seq) this.clearBubble();
            })
            .start();
    }
}
