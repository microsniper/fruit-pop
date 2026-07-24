import { _decorator, Component } from 'cc';
import { SoundManager } from './SoundManager';

const { ccclass } = _decorator;

declare const wx: any;
declare const tt: any;

const platform = typeof wx !== 'undefined' ? wx : (typeof tt !== 'undefined' ? tt : null);

const AD_UNIT_ID = 'adunit-af01cf5530e8b278';

@ccclass('AdManager')
export class AdManager extends Component {
    private static instance: AdManager | null = null;
    private rewardedVideoAd: any = null;
    private isAdReady = false;
    private pendingResolve: (() => void) | null = null;
    private pendingReject: ((reason: string) => void) | null = null;

    static getInstance(): AdManager | null {
        return AdManager.instance;
    }

    onLoad() {
        if (AdManager.instance) {
            this.node.destroy();
            return;
        }
        AdManager.instance = this;
        this.initRewardedVideoAd();
    }

    private initRewardedVideoAd() {
        try {
            if (!platform || !platform.createRewardedVideoAd) return;
            if (!AD_UNIT_ID || AD_UNIT_ID.indexOf('xxxx') !== -1) return;

            this.rewardedVideoAd = platform.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });

            this.rewardedVideoAd.onLoad(() => {
                this.isAdReady = true;
            });

            this.rewardedVideoAd.onError((err: any) => {
                this.isAdReady = false;
                console.warn('AdManager rewardedVideoAd error:', err);
            });

            this.rewardedVideoAd.onClose((res: any) => {
                // 广告关闭后恢复 BGM（微信广告会暂停音频）
                SoundManager.getInstance()?.playBGM();

                if (!this.pendingResolve || !this.pendingReject) return;

                if (res && res.isEnded) {
                    this.pendingResolve();
                } else {
                    this.pendingReject('用户中途关闭广告');
                }
                this.pendingResolve = null;
                this.pendingReject = null;
            });

            this.rewardedVideoAd.load();
        } catch (e) {
            console.warn('AdManager init failed:', e);
        }
    }

    showRewardedAd(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.rewardedVideoAd) {
                resolve();
                return;
            }

            this.pendingResolve = resolve;
            this.pendingReject = reject;

            this.rewardedVideoAd.show()
                .then(() => {
                    this.isAdReady = false;
                })
                .catch(() => {
                    // show() 失败时静默处理，由 onClose 决定实际结果
                    // 避免在用户关闭广告时触发 operateWXDataForAd 错误
                });
        });
    }

    onDestroy() {
        if (AdManager.instance === this) {
            AdManager.instance = null;
        }
    }
}
