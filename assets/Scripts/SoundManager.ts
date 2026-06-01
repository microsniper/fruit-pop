import { _decorator, Component } from 'cc';

const { ccclass } = _decorator;

declare const wx: any;
declare const tt: any;

const platform = typeof wx !== 'undefined' ? wx : (typeof tt !== 'undefined' ? tt : null);

@ccclass('SoundManager')
export class SoundManager extends Component {
    private static instance: SoundManager | null = null;
    private innerAudio: any = null;
    private bgmVolume = 1;

    static getInstance(): SoundManager | null {
        return SoundManager.instance;
    }

    onLoad() {
        if (SoundManager.instance) {
            this.node.destroy();
            return;
        }
        SoundManager.instance = this;

        try {
            if (platform && platform.createInnerAudioContext) {
                this.innerAudio = platform.createInnerAudioContext();
                this.innerAudio.loop = true;
                this.innerAudio.volume = this.bgmVolume;
                this.innerAudio.autoplay = false;
                this.innerAudio.src = 'bgm.mp3';
                this.innerAudio.onError((err: any) => {
                    console.warn('BGM innerAudio error:', err);
                });
                this.playBGM();
            }
        } catch (e) {
            console.warn('BGM wx init failed:', e);
        }
    }

    playBGM() {
        try {
            if (this.innerAudio && !this.innerAudio.paused) return;
            if (this.innerAudio) {
                this.innerAudio.play();
            }
        } catch (e) {
            console.warn('BGM play failed:', e);
        }
    }

    stopBGM() {
        try {
            if (this.innerAudio) {
                this.innerAudio.stop();
            }
        } catch (e) {
            console.warn('BGM stop failed:', e);
        }
    }

    toggleMute(): boolean {
        if (!this.innerAudio) return false;
        try {
            if (this.innerAudio.volume > 0) {
                this.innerAudio.volume = 0;
                return false;
            } else {
                this.innerAudio.volume = this.bgmVolume;
                return true;
            }
        } catch (e) {
            return false;
        }
    }
}
