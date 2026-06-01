import { _decorator, Component } from 'cc';

const { ccclass } = _decorator;

declare const wx: any;
declare const tt: any;

const platform = typeof wx !== 'undefined' ? wx : (typeof tt !== 'undefined' ? tt : null);

const AD_UNIT_ID = 'adunit-xxxxxxxxxxxxxxxx';

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

            this.rewardedVideoAd = platform.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });

            this.rewardedVideoAd.onLoad(() => {
                this.isAdReady = true;
            });

            this.rewardedVideoAd.onError((err: any) => {
                this.isAdReady = false;
                console.warn('AdManager rewardedVideoAd error:', err);
            });

            this.rewardedVideoAd.onClose((res: any) => {
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
                    this.rewardedVideoAd.load()
                        .then(() => this.rewardedVideoAd.show())
                        .catch(() => {
                            this.pendingResolve = null;
                            this.pendingReject = null;
                            resolve();
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
