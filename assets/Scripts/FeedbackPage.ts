import { Node, Vec3, UITransform, Color, tween, Graphics, EditBox, Label } from 'cc';
import { submitFeedback, FeedbackTypeEnum } from './api';
import { SoundManager } from './SoundManager';
import type { GameManager } from './GameManager';

/** 反馈类型 Tab 文案，跟后端 FeedbackTypeEnum 一一对应（左=意见反馈 右=游戏反馈） */
const TYPE_TABS: { type: FeedbackTypeEnum; label: string }[] = [
    { type: FeedbackTypeEnum.SUGGESTION, label: '意见反馈' },
    { type: FeedbackTypeEnum.GAME, label: '游戏反馈' }
];

/** 反馈内容字符白名单：汉字/数字/英文字母/空白/常见中英文标点；不允许表情及其他特殊字符（与后端校验同一套规则） */
const CONTENT_WHITELIST = /^[一-龥a-zA-Z0-9\s,.!?;:'"()\[\]{}\-_+=@#$%^*~，。！？；：“”‘’（）【】《》「」～、…·]*$/;
const MAX_CONTENT_LENGTH = 200;

/** 过滤掉不在白名单里的字符（逐字符过滤，保留合法字符原有顺序） */
function filterContent(text: string): string {
    let result = '';
    for (const ch of text) {
        if (CONTENT_WHITELIST.test(ch)) result += ch;
    }
    return result.slice(0, MAX_CONTENT_LENGTH);
}

/**
 * 用户反馈弹窗：设置页"游戏反馈"按钮点开，选类型 + 填文字 + 提交。
 * 无专用设计图，纯代码手搬圆角面板 + Label + EditBox，先能用，后续换图片面板。
 */
export class FeedbackPage {

    private selectedType: FeedbackTypeEnum = FeedbackTypeEnum.SUGGESTION;
    private tabNodes: { bg: Node; label: Label; type: FeedbackTypeEnum }[] = [];
    private editBox: EditBox | null = null;
    private submitting = false;
    private panelNode: Node | null = null;

    constructor(private gm: GameManager) {}

    /** 打开弹窗；onSubmitted 在提交成功关闭弹窗后调用，用于外部弹提示 */
    open(onSubmitted?: () => void) {
        if (!this.gm.modalLayerNode || !this.gm.modalLayerNode.isValid) return;
        this.gm.modalLayerNode.destroyAllChildren();

        const screenW = this.gm.screenWidth;
        const screenH = this.gm.screenHeight;

        const mask = this.gm.createGraphicsNode('Mask', this.gm.modalLayerNode, screenW, screenH, 0, 0);
        this.gm.drawRoundedRect(mask.getComponent(Graphics)!, screenW, screenH, new Color(0, 0, 0, 150), 0);
        mask.on(Node.EventType.TOUCH_END, () => {
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        const panelW = 300;
        const panelH = 380;
        const panelNode = this.gm.createNode('FeedbackPanel', this.gm.modalLayerNode, 0, 0, panelW, panelH);
        this.panelNode = panelNode;
        const panelBg = this.gm.createGraphicsNode('PanelBg', panelNode, panelW, panelH, 0, 0);
        this.gm.drawRoundedRect(panelBg.getComponent(Graphics)!, panelW, panelH, new Color(250, 248, 240, 255), 24);
        panelNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
        }, this);

        this.gm.createLabel(panelNode, '意见反馈', 0, panelH / 2 - 34, 22, new Color(96, 64, 32, 255), true);

        const closeBtn = this.gm.createNode('CloseBtn', panelNode, panelW / 2 - 28, panelH / 2 - 30, 44, 44);
        this.gm.createLabel(closeBtn, '×', 0, 2, 26, new Color(150, 130, 110, 255), true);
        closeBtn.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            SoundManager.getInstance()?.playSystemClick();
            this.gm.modalLayerNode!.destroyAllChildren();
        }, this);

        // 类型 Tab：两个并排，点击切换选中态（选中=深绿底白字，未选=浅灰底深字）
        const tabW = 120;
        const tabH = 40;
        const tabY = panelH / 2 - 90;
        this.tabNodes = [];
        TYPE_TABS.forEach((tab, i) => {
            const tabX = (i === 0 ? -1 : 1) * (tabW / 2 + 6);
            const tabNode = this.gm.createNode(`Tab_${tab.type}`, panelNode, tabX, tabY, tabW, tabH);
            const tabBg = this.gm.createGraphicsNode('TabBg', tabNode, tabW, tabH, 0, 0);
            const label = this.gm.createLabel(tabNode, tab.label, 0, 0, 16, new Color(96, 64, 32, 255), true);
            this.tabNodes.push({ bg: tabBg, label, type: tab.type });
            tabNode.on(Node.EventType.TOUCH_END, (e: any) => {
                e.propagationStopped = true;
                if (this.selectedType === tab.type) return;
                SoundManager.getInstance()?.playSystemClick();
                this.selectedType = tab.type;
                this.refreshTabStyle();
            }, this);
        });
        this.refreshTabStyle();

        // 输入框：手搬浅色圆角底 + EditBox 多行输入
        const editBoxH = 160;
        const editBoxY = panelH / 2 - 210;
        const editBoxBg = this.gm.createGraphicsNode('EditBoxBg', panelNode, panelW - 40, editBoxH, 0, editBoxY);
        this.gm.drawRoundedRect(editBoxBg.getComponent(Graphics)!, panelW - 40, editBoxH, new Color(255, 255, 255, 255), 12, 2, new Color(220, 210, 195, 255));
        const editBoxNode = this.gm.createNode('EditBox', panelNode, 0, editBoxY, panelW - 56, editBoxH - 16);
        const editBox = editBoxNode.addComponent(EditBox);
        editBox.inputMode = EditBox.InputMode.ANY;
        editBox.maxLength = MAX_CONTENT_LENGTH;

        // 手动建 text/placeholder 两个 Label 并显式挂到 EditBox 上（引擎运行时默认子节点定位会飘到面板外）
        const mkBoxLabel = (name: string, color: Color) => {
            const n = this.gm.createNode(name, editBoxNode, 4, 4, panelW - 64, editBoxH - 24);
            const l = n.addComponent(Label);
            l.fontSize = 16;
            l.lineHeight = 22;
            l.color = color;
            l.horizontalAlign = Label.HorizontalAlign.LEFT;
            l.verticalAlign = Label.VerticalAlign.TOP;
            l.overflow = Label.Overflow.CLAMP;
            return l;
        };
        editBox.textLabel = mkBoxLabel('Text', new Color(60, 50, 40, 255));
        editBox.placeholderLabel = mkBoxLabel('Placeholder', new Color(180, 170, 160, 255));
        // 引擎给 EditBox 自动挂的默认 Label（白字"Label"）会飘在面板外，清掉只留我们自建的两个
        editBoxNode.children.forEach((c) => {
            if (c.name !== 'Text' && c.name !== 'Placeholder') c.destroy();
        });
        editBox.placeholder = '请描述你遇到的问题或建议...';
        // 实时过滤：只保留白名单字符（汉字/数字/字母/常见标点），表情及其他特殊字符边输入边被清掉
        editBox.node.on(EditBox.EventType.TEXT_CHANGED, (text: string) => {
            const filtered = filterContent(text);
            if (filtered !== text) editBox.string = filtered;
        }, this);
        this.editBox = editBox;

        // 提交按钮
        const btnY = panelH / 2 - 330;
        const btnNode = this.gm.createNode('BtnSubmit', panelNode, 0, btnY, panelW * 0.6, 48);
        const btnBg = this.gm.createGraphicsNode('BtnBg', btnNode, panelW * 0.6, 48, 0, 0);
        this.gm.drawRoundedRect(btnBg.getComponent(Graphics)!, panelW * 0.6, 48, new Color(255, 150, 60, 255), 24);
        this.gm.createLabel(btnNode, '提交', 0, 0, 18, new Color(255, 255, 255, 255), true);
        btnNode.on(Node.EventType.TOUCH_END, (e: any) => {
            e.propagationStopped = true;
            this.onSubmit(onSubmitted);
        }, this);

        panelNode.setScale(new Vec3(0.7, 0.7, 1));
        tween(panelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    private refreshTabStyle() {
        this.tabNodes.forEach(({ bg, label, type }) => {
            const selected = type === this.selectedType;
            this.gm.drawRoundedRect(
                bg.getComponent(Graphics)!,
                bg.getComponent(UITransform)!.width,
                bg.getComponent(UITransform)!.height,
                selected ? new Color(80, 140, 90, 255) : new Color(235, 230, 220, 255),
                18
            );
            label.color = selected ? new Color(255, 255, 255, 255) : new Color(96, 64, 32, 255);
        });
    }

    private async onSubmit(onSubmitted?: () => void) {
        if (this.submitting || !this.editBox) return;
        // 提交前再过滤一遍：防止粘贴等个别输入路径没触发 TEXT_CHANGED 实时过滤
        const content = filterContent(this.editBox.string).trim();
        if (!content) {
            this.showInlineTip('请先填写反馈内容');
            return;
        }
        this.submitting = true;
        const result = await submitFeedback(this.selectedType, content);
        this.submitting = false;
        if (result.success) {
            this.gm.modalLayerNode!.destroyAllChildren();
            if (onSubmitted) onSubmitted();
        } else {
            this.showInlineTip(result.message || '提交失败，请重试');
        }
    }

    /**
     * 面板内轻提示：短暂浮现后自动消失。不用 gm.renderCommonTip 是因为它会整个清空
     * modalLayerNode，拿来在本弹窗内报错会把面板和用户已输入的文字一起清掉。
     */
    private showInlineTip(text: string) {
        if (!this.panelNode || !this.panelNode.isValid) return;
        const existing = this.panelNode.getChildByName('InlineTip');
        if (existing) existing.destroy();
        const tipNode = this.gm.createNode('InlineTip', this.panelNode, 0, -this.panelNode.getComponent(UITransform)!.height / 2 - 34, 260, 36);
        const tipBg = this.gm.createGraphicsNode('TipBg', tipNode, 260, 36, 0, 0);
        this.gm.drawRoundedRect(tipBg.getComponent(Graphics)!, 260, 36, new Color(60, 80, 50, 210), 18);
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
