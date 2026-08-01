import { _decorator, Component } from 'cc';
import { SoundManager } from './SoundManager';

const { ccclass } = _decorator;

declare const wx: any;
declare const tt: any;

const platform = typeof wx !== 'undefined' ? wx : (typeof tt !== 'undefined' ? tt : null);

const AD_UNIT_ID = 'adunit-af01cf5530e8b278';

// 模块级：广告实例与事件绑定状态跨场景复用，避免对微信广告单例重复绑事件
let sharedRewardedAd: any = null;
let adEventsBound = false;

@ccclass('AdManager')
export class AdManager extends Component {
    private static instance: AdManager | null = null;
    private isAdReady = false;
    private pendingResolve: (() => void) | null = null;
    private pendingReject: ((reason: string) => void) | null = null;

    static getInstance(): AdManager | null {
        return AdManager.instance;
    }

    onLoad() {
        // 单例保护：已存在则销毁自身。广告初始化延迟到首次 showRewardedAd 时按需进行，
        // 避免场景切换重建 AdManager 时对微信广告单例重复绑定事件
        if (AdManager.instance) {
            this.node.destroy();
            return;
        }
        AdManager.instance = this;
    }

    /**
     * 懒加载激励视频广告：首次看广告时才创建实例+绑定事件+加载，后续复用。
     * 广告实例与事件绑定状态放在模块级，跨场景复用，事件只绑一次。
     */
    private ensureAd(): boolean {
        if (!platform || !platform.createRewardedVideoAd) return false;
        if (!AD_UNIT_ID || AD_UNIT_ID.indexOf('xxxx') !== -1) return false;

        if (!sharedRewardedAd) {
            try {
                sharedRewardedAd = platform.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });
            } catch (e) {
                console.warn('AdManager create failed:', e);
                return false;
            }
        }

        if (!adEventsBound) {
            adEventsBound = true;
            sharedRewardedAd.onLoad(() => {
                this.isAdReady = true;
            });
            sharedRewardedAd.onError((err: any) => {
                this.isAdReady = false;
                console.warn('AdManager rewardedVideoAd error:', err);
            });
            sharedRewardedAd.onClose((res: any) => {
                // 广告关闭后恢复 BGM（微信广告会暂停音频）
                SoundManager.getInstance()?.playBGM();

                // 绑定事件的实例可能已随场景销毁，通过当前活跃实例中转处理回调
                const inst = AdManager.instance;
                if (!inst?.pendingResolve || !inst?.pendingReject) return;

                if (res && res.isEnded) {
                    inst.pendingResolve();
                } else {
                    inst.pendingReject('用户中途关闭广告');
                }
                inst.pendingResolve = null;
                inst.pendingReject = null;
            });
            sharedRewardedAd.load();
        }
        return true;
    }

    showRewardedAd(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.ensureAd()) {
                // 无广告环境（编辑器/未配置 adUnitId）直接放行，不影响功能流程
                resolve();
                return;
            }

            this.pendingResolve = resolve;
            this.pendingReject = reject;

            const ad = sharedRewardedAd;
            ad.show()
                .then(() => {
                    this.isAdReady = false;
                })
                .catch(() => {
                    // show 失败（广告未就绪）：重新 load 后再 show，避免用户卡住
                    ad.load()
                        .then(() => ad.show())
                        .catch(() => {
                            if (this.pendingReject) {
                                this.pendingReject('广告加载失败');
                                this.pendingResolve = null;
                                this.pendingReject = null;
                            }
                        });
                });
        });
    }

    onDestroy() {
        if (AdManager.instance === this) {
            AdManager.instance = null;
        }
    }
}
